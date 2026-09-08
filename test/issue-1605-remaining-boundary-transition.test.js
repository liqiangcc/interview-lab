'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const evidenceCoordinator = require('../scripts/issue-1605-full-boundary-coordinator');
const {
  REMAINING_COUNT, ACTIONABLE_COUNT, BLOCKED_COUNT, REMAINING_SCOPE_DIGEST, REMAINING_MANIFEST_DIGEST, FROZEN_SNAPSHOT_DIGEST,
  canonical, sha256Text, readRegularJson, validateFrozenSnapshot, validateRemainingManifest, validateEvidencePlan,
  buildTransitionPlan, initialJournal, validateJournal, persistJournal, mutationWritersDisabled,
  assertApplyGuards, transitionItem, applyBatch,
} = require('../scripts/lib/issue-1605-remaining-boundary-transition');
const { atomicWriteJson, acquireExclusiveLock } = require('../scripts/lib/issue-1605-full-boundary-transition');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { main: transitionCli } = require('../scripts/apply-issue-1605-remaining-boundary-transition');

const manifest = readRegularJson('data/pilot/issue-1605/remaining-boundary.manifest.json');
const snapshot = readRegularJson('data/pilot/issue-1605/pending-inventory.snapshot.json');

function evidencePlan() {
  const directory = tempDir();
  const cacheFile = path.join(directory, 'source-notes.json');
  fs.writeFileSync(cacheFile, JSON.stringify(snapshot.items.map((item) => ({
    number: item.issue_number, body_sha256: item.body_sha256, labels: item.labels,
  }))));
  return evidenceCoordinator.buildPlan({ cache: cacheFile });
}
function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-remaining-transition-')); }

test('remaining inputs are pinned to the 1397 snapshot, fixed ref, manifest digest, and exact 978 scope', () => {
  assert.equal(validateFrozenSnapshot(snapshot).ok, true);
  assert.equal(validateFrozenSnapshot(snapshot).digest, FROZEN_SNAPSHOT_DIGEST);
  assert.equal(validateRemainingManifest(manifest).ok, true);
  const plan = evidencePlan();
  const check = validateEvidencePlan(plan, manifest, snapshot);
  assert.equal(check.ok, true, check.errors.join('; '));
  assert.equal(plan.scope.remaining_scope_digest, REMAINING_SCOPE_DIGEST);
  assert.equal(plan.pending_inventory.digest, REMAINING_MANIFEST_DIGEST);
  assert.equal(plan.counts.actionable_total, ACTIONABLE_COUNT);
  assert.equal(plan.coverage.blocked_total, BLOCKED_COUNT);
  assert.equal(plan.items.filter((item) => item.decision === 'not-interview').length, 152);
  const subset = { ...plan, items: plan.items.slice(0, -1) };
  subset.canonical_digest = sha256Text(canonical(Object.fromEntries(Object.entries(subset).filter(([key]) => key !== 'canonical_digest'))));
  assert.match(validateEvidencePlan(subset, manifest, snapshot).errors.join('\n'), /557 actionable/);
});

test('plan-only transition plan expands the 557/421 audit into the full 978 scope and keeps #735 fail-closed', () => {
  const directory = tempDir();
  const plan = buildTransitionPlan({ evidencePlan: evidencePlan(), evidencePlanPath: 'remaining-boundary-evidence-plan.json', manifest, manifestPath: 'remaining-boundary.manifest.json', snapshot, snapshotPath: 'pending-inventory.snapshot.json', requestDir: path.join(directory, 'requests') });
  assert.equal(plan.items.length, REMAINING_COUNT);
  assert.equal(plan.counts.actionable_total, ACTIONABLE_COUNT);
  assert.equal(plan.counts.blocked_total, BLOCKED_COUNT);
  assert.equal(plan.items.filter((item) => item.scope_status === 'actionable').length, ACTIONABLE_COUNT);
  assert.equal(plan.items.filter((item) => item.scope_status === 'actionable' && item.decision === 'not-interview').length, 152);
  assert.equal(plan.items.filter((item) => item.status === 'blocked').length, BLOCKED_COUNT);
  assert.equal(plan.items.find((item) => item.issue_number === 735).blocked_reason, 'insufficient multi-case evidence');
  assert.equal(plan.ok, false);
  assert.equal(plan.mutation_count, 0);
  assert.equal(plan.possibly_performed, false);
  assert.match(plan.blocked_errors.join('\n'), /#735 multi-interview/);
  assert.equal(plan.errors.some((error) => /#735/.test(error)), false);
  assert.equal(plan.errors.some((error) => /live|PATCH|POST/i.test(error)), false);
});

test('durable journal requires exact item counters and lock ownership before every persist', () => {
  const directory = tempDir();
  const plan = buildTransitionPlan({ evidencePlan: evidencePlan(), manifest, snapshot, requestDir: path.join(directory, 'requests') });
  const journal = initialJournal(plan);
  assert.equal(validateJournal(journal, plan, 25).ok, true);
  const bad = JSON.parse(JSON.stringify(journal));
  bad.mutation_count = -1;
  assert.equal(validateJournal(bad, plan, 25).ok, false);
  const nan = JSON.parse(JSON.stringify(journal));
  nan.mutation_count = NaN;
  assert.equal(validateJournal(nan, plan, 25).ok, false);
  const badItem = JSON.parse(JSON.stringify(journal));
  badItem.items[0].mutation_count = 1;
  assert.equal(validateJournal(badItem, plan, 25).ok, false);
  const lockFile = path.join(directory, 'transition.lock');
  const journalFile = path.join(directory, 'transition.journal.json');
  const lock = acquireExclusiveLock(lockFile);
  try {
    persistJournal(journalFile, journal, plan, lock, 25);
    assert.deepEqual(readRegularJson(journalFile), journal);
    lock.assertHeld();
  } finally { lock.release(); }
  assert.throws(() => persistJournal(journalFile, journal, plan, null, 25), /exclusive lock/);
});

test('atomic JSON persistence fsyncs both file and parent directory', () => {
  const directory = tempDir();
  const target = path.join(directory, 'nested', 'plan.json');
  const original = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = (...args) => { calls += 1; return original(...args); };
  try { atomicWriteJson(target, { schema: 'read-only', mutation_count: 0 }); }
  finally { fs.fsyncSync = original; }
  assert.ok(calls >= 2, `expected file and directory fsync, got ${calls}`);
});

test('plan-only mutation writers are explicit fail-closed stubs', () => {
  const writers = mutationWritersDisabled();
  assert.throws(() => writers.patchIssue(42, {}), /PATCH is disabled/);
  assert.throws(() => writers.postReceipt(42, ''), /POST is disabled/);
});

test('transition planner passes v2 multi-interview cases through the existing validator', () => {
  const body = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
  const parsed = parseSourceNoteIssue(body);
  const raw = parsed.record.artifacts.find((item) => item.provenance === 'raw_capture').ref;
  const projection = parsed.record.artifacts.find((item) => item.provenance === 'source_projection').ref;
  const request = {
    schema_version: 'source-note-boundary-review-transition.v2', transition_id: 'remaining-v2-fixture', repository: 'liqiangcc/interview-lab', issue_number: 910,
    source_note_id: parsed.record.source_note_id, expected_body_sha256: sha256Text(body), expected_boundary_status: 'pending', expected_source_revision_id: parsed.record.source_revision.id,
    expected_manifest_sha256: parsed.record.source_revision.manifest_sha256, expected_source_repository_ref: null, decision: 'multi-interview', reviewed_at: '2026-09-09T00:00:00Z', reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 910, comment_id: 123 },
    checks: ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication'].map((check_id) => ({ check_id, result: 'pass' })),
    limitations: ['fixture'], interview_cases: [
      { case_key: 'company-a-process', evidence: [{ ref: raw, locator: 'raw-span:a' }] },
      { case_key: 'company-b-process', evidence: [{ ref: projection, locator: 'projection-span:b' }] },
    ],
  };
  const evidence = { id: 123, body: [request.transition_id, request.source_note_id, request.expected_source_revision_id, request.decision, request.expected_manifest_sha256, 'company-a-process', 'company-b-process', raw, projection, 'raw-span:a', 'projection-span:b', ...request.checks.map((item) => item.check_id)].join('\n') };
  const result = transitionItem({ request }, { issue: { number: 910, state: 'open', body, labels: ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review'] }, comments: [evidence] }, null);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.status, 'ready');
  assert.equal(result.interview_note_cases.length, 2);
});

test('authorized applyBatch simulation calls PATCH and POST once, validates receipt, and persists the journal', () => {
  const body = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue.valid.md'), 'utf8');
  const parsed = parseSourceNoteIssue(body);
  const request = {
    schema_version: 'source-note-boundary-review-transition.v1', transition_id: 'remaining-apply-fixture', repository: 'liqiangcc/interview-lab', issue_number: 77,
    source_note_id: parsed.record.source_note_id, expected_body_sha256: sha256Text(body), expected_boundary_status: 'pending', expected_source_revision_id: parsed.record.source_revision.id,
    expected_manifest_sha256: null, expected_source_repository_ref: '95b77bb261048059846273688e4b90a2e108b437', decision: 'single-interview', reviewed_at: '2026-09-09T00:00:00Z', reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 77, comment_id: 456 },
    checks: ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication'].map((check_id) => ({ check_id, result: 'pass' })), limitations: ['fixture'],
  };
  const evidence = { id: 456, body: [request.transition_id, request.source_note_id, request.expected_source_revision_id, request.expected_source_repository_ref, request.decision, ...request.checks.map((item) => item.check_id)].join('\n') };
  let issue = { number: 77, state: 'open', body, labels: ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk', 'source-year:2022'] };
  let comments = [evidence];
  const record = { request };
  const plan = { ok: true, ready_for_apply: true, canonical_digest: 'a'.repeat(64), remaining_manifest: { digest: REMAINING_MANIFEST_DIGEST, scope_digest: REMAINING_SCOPE_DIGEST }, items: [{ issue_number: 77, transition_id: request.transition_id, scope_status: 'actionable', item_digest: 'item-digest' }] };
  const calls = { patch: 0, post: 0 };
  const liveLoader = () => ({ issue, comments });
  const patchIssue = (number, payload) => { calls.patch += 1; assert.equal(number, 77); issue = { ...issue, body: payload.body, labels: payload.labels }; };
  const postReceipt = (number, receiptBody) => { calls.post += 1; assert.equal(number, 77); comments = [...comments, { id: 789, body: receiptBody }]; return { id: 789 }; };
  const directory = tempDir();
  const lock = acquireExclusiveLock(path.join(directory, 'lock'));
  try {
    const journalFile = path.join(directory, 'journal.json');
    const result = applyBatch({ plan, records: [record], liveLoader, patchIssue, postReceipt, lock, journalFile, maxMutations: 2, authorization: { max_mutations: 2 }, apply: true, confirmPlan: plan.canonical_digest, writeJournal: (state) => persistJournal(journalFile, state, plan, lock, 2) });
    assert.equal(result.ok, true);
    assert.equal(result.mutation_count, 2);
    assert.equal(calls.patch, 1);
    assert.equal(calls.post, 1);
    assert.equal(result.journal.items[0].phase, 'complete');
    assert.equal(result.journal.items[0].mutation_count, 2);
    const persisted = readRegularJson(journalFile);
    assert.equal(persisted.status, 'complete');
    assert.equal(persisted.mutation_count, 2);
    assert.equal(persisted.items[0].phase, 'complete');
  } finally { lock.release(); }
});

test('apply guards require explicit confirmation and never permit a ceiling above proof', () => {
  const directory = tempDir();
  const plan = buildTransitionPlan({ evidencePlan: evidencePlan(), manifest, snapshot, requestDir: path.join(directory, 'requests') });
  assert.throws(() => assertApplyGuards({ apply: false, confirmPlan: plan.canonical_digest, plan, authorization: { max_mutations: 25 }, maxMutations: 1 }), /explicit --apply/);
  assert.throws(() => assertApplyGuards({ apply: true, confirmPlan: plan.canonical_digest, plan, authorization: { max_mutations: 1 }, maxMutations: 2 }), /exceeds authorization/);
});

test('default CLI smoke is plan-only, writes blocked output, and never invokes mutation endpoints', () => {
  const directory = tempDir();
  const code = transitionCli([
    '--output', path.join(directory, 'plan.json'),
    '--journal', path.join(directory, 'journal.json'),
    '--lock', path.join(directory, 'lock'),
    '--request-dir', path.join(directory, 'requests'),
  ], { manifest, snapshot, evidencePlan: evidencePlan() });
  assert.equal(code, 1);
  const plan = readRegularJson(path.join(directory, 'plan.json'));
  assert.equal(plan.items.length, REMAINING_COUNT);
  assert.equal(plan.mutation_count, 0);
  assert.equal(fs.existsSync(path.join(directory, 'lock')), false);
  assert.throws(() => transitionCli(['--apply'], { manifest, snapshot, evidencePlan: evidencePlan() }), /--authorization-proof/);
});
