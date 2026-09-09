'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { buildInterviewProjection, sha256Text, requestSha256 } = require('../scripts/lib/source-note-interview-materialization');
const { buildMaterializationRequest, issueSourceRecord } = require('../scripts/lib/interview-note-materialization-batch');
const { canonicalDigest } = require('../scripts/lib/aggregate-downstream-pipeline');
const { parseArgs, ghGet } = require('../scripts/issue-1658-materialization-runner');
const {
  AUTH_MARKER, ZERO_WRITES, RUNNER_SCHEMA, REPOSITORY,
  buildRunnerPlan, validateFreshArtifacts, validateRunnerPlan, parseAuthorizationComment,
  receiptBody, receiptObject, reconcileReceipt, reconcileOwner, initialJournal, validateJournal,
  applyOne, acquireExclusiveLock, assertNoExistingMutation,
} = require('../scripts/lib/issue-1658-materialization-runner');

function load(file) { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8')); }

const sourceSnapshot = load('data/pilot/issue-1611/source-note-live.snapshot.json');
const boundaryReport = load('data/pilot/issue-1611/live-boundary.materialization-report.json');
const boundaryManifest = load('data/pilot/issue-1611/live-boundary.materialization-manifest.json');
const ownershipInventory = load('data/pilot/issue-1611/interview-note-ownership.inventory.json');
const materializationPlan = load('data/pilot/issue-1611/materialization.live.dry-run.json');

test('real fresh-boundary inputs build a controller-bound, zero-write runner plan', () => {
  const plan = buildRunnerPlan({ sourceSnapshot, boundaryReport, boundaryManifest, ownershipInventory, materializationPlan });
  assert.equal(plan.schema_version, RUNNER_SCHEMA);
  assert.deepEqual({ parent_issue: plan.parent_issue, controller_issue: plan.controller_issue, boundary_parent_issue: plan.boundary_parent_issue }, { parent_issue: 1611, controller_issue: 1658, boundary_parent_issue: 1605 });
  assert.deepEqual(plan.counts, { 'skip-not-interview': 247, 'already-materialized': 47, 'would-materialize': 789, blocked: 424 });
  assert.equal(plan.ok, false);
  assert.equal(plan.ready_for_apply, false);
  assert.deepEqual(plan.write_operations, ZERO_WRITES);
  assert.equal(plan.mutation_performed, false);
  assert.equal(plan.results.filter((item) => item.request).length, 838);
  assert.equal(plan.results.filter((item) => item.request && item.request_sha256 === requestSha256(item.request)).length, 838);
  assert.match(plan.errors.join('\n'), /#910/);
  assert.equal(validateRunnerPlan(plan).ok, false);
});

test('fresh artifact binding detects resealed request, manifest, source, and plan tampering', () => {
  const base = { sourceSnapshot, boundaryReport, boundaryManifest, ownershipInventory, materializationPlan };
  const cases = [
    ['source', () => ({ ...base, sourceSnapshot: { ...sourceSnapshot, issues: sourceSnapshot.issues.slice(1) } }), /source snapshot canonical digest|count\/issues/],
    ['manifest', () => ({ ...base, boundaryManifest: { ...boundaryManifest, items: boundaryManifest.items.slice(1), canonical_digest: null } }), /boundary manifest/],
    ['request', () => {
      const tampered = JSON.parse(JSON.stringify(materializationPlan));
      const row = tampered.results.find((item) => item.request);
      row.request.expected_source_note_body_sha256 = '0'.repeat(64);
      delete tampered.dry_run_sha256;
      const { dry_run_sha256: ignored, ...digestInput } = tampered;
      tampered.dry_run_sha256 = canonicalDigest(digestInput);
      return { ...base, materializationPlan: tampered };
    }, /request SourceNote CAS binding/],
  ];
  for (const [label, make, expected] of cases) {
    const result = validateFreshArtifacts(make());
    assert.equal(result.ok, false, `${label} must fail closed`);
    assert.match(result.errors.join('\n'), expected, label);
  }
});

function authorizationPlan() {
  const plan = {
    schema_version: RUNNER_SCHEMA, repository: REPOSITORY, parent_issue: 1611, controller_issue: 1658, boundary_parent_issue: 1605,
    source_snapshot: { digest: '1'.repeat(64) }, boundary_report: { digest: '2'.repeat(64) }, boundary_manifest: { digest: '3'.repeat(64) }, ownership: { digest: '4'.repeat(64) },
    counts: { 'would-materialize': 1, 'already-materialized': 0, 'skip-not-interview': 0, blocked: 0 },
    errors: [], ready_for_apply: true, ok: true, mutation_performed: false, write_operations: { ...ZERO_WRITES }, results: [],
  };
  plan.plan_digest = canonicalDigest(plan);
  return plan;
}

function authorizationBody(plan, extra = {}) {
  const value = {
    schema_version: 'issue-1658-interview-note-materialization-authorization.v1', repository: REPOSITORY, parent_issue: 1611, controller_issue: 1658, boundary_parent_issue: 1605,
    action: 'materialize-interview-notes', allow_live_github: true, comment_id: 123, authorized_by: 'controller/root',
    plan_digest: plan.plan_digest || '0'.repeat(64), source_snapshot_digest: plan.source_snapshot.digest, boundary_report_digest: plan.boundary_report.digest, boundary_manifest_digest: plan.boundary_manifest.digest, ownership_digest: plan.ownership.digest,
    max_create: 1, max_receipts: 1, ...extra,
  };
  return `<!-- ${AUTH_MARKER}\n${JSON.stringify(value, null, 2)}\n-->`;
}

test('authorization requires exact marker/comment, fresh digests, allow flag, and ceilings', () => {
  const plan = authorizationPlan();
  const controllerComment = { id: 123, issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/1658', issue_number: 1658, url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/comments/123', body: authorizationBody(plan) };
  const valid = parseAuthorizationComment(controllerComment, plan, { authorizationCommentId: 123, allowLiveGithub: true, maxCreate: 1, maxReceipts: 1 });
  assert.equal(valid.ok, true);
  const missing = parseAuthorizationComment({ id: 123, body: '' }, plan, { authorizationCommentId: 123, allowLiveGithub: true, maxCreate: 1, maxReceipts: 1 });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /exactly one/);
  const badFlag = parseAuthorizationComment({ id: 123, body: authorizationBody(plan, { allow_live_github: false }) }, plan, { authorizationCommentId: 123, allowLiveGithub: false, maxCreate: 1, maxReceipts: 1 });
  assert.equal(badFlag.ok, false);
  const extra = parseAuthorizationComment({ id: 123, body: authorizationBody(plan, { unsafe: true }) }, plan, { authorizationCommentId: 123, allowLiveGithub: true, maxCreate: 1, maxReceipts: 1 });
  assert.equal(extra.ok, false);
  const wrongIssue = parseAuthorizationComment({ ...controllerComment, issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/1611', issue_number: 1611 }, plan, { authorizationCommentId: 123, allowLiveGithub: true, maxCreate: 1, maxReceipts: 1 });
  assert.equal(wrongIssue.ok, false);
  assert.match(wrongIssue.errors.join('\n'), /controller Issue #1658/);
});

test('CLI is plan-only by default and its GET helper refuses mutation-shaped arguments', () => {
  assert.equal(parseArgs([]).apply, false);
  assert.throws(() => ghGet(['api', '--method', 'POST', 'repos/x/y']), /refuses mutation/);
  assert.throws(() => ghGet(['api', '--input', '-', 'repos/x/y']), /refuses mutation/);
});

test('bounded unknown owner/receipt responses fail closed and never retry POST', () => {
  let ownerReads = 0;
  assert.throws(() => reconcileOwner(() => { ownerReads += 1; return []; }, 'xhs:missing', 2), /unknown.*owner|no exact owner/);
  assert.equal(ownerReads, 2);
  let receiptReads = 0;
  const request = { materialization_id: 'm', request_sha256: 'a'.repeat(64), interview_note_id: 'xhs:id', interview_issue_number: 99 };
  assert.throws(() => reconcileReceipt(() => { receiptReads += 1; return []; }, request, request, 2), /unknown.*marker|no exact marker/);
  assert.equal(receiptReads, 2);
});

test('untrusted create response is reconciled once and never retried', () => {
  const source = singleFixture();
  const request = buildMaterializationRequest(source, REPOSITORY);
  const sourceValidation = issueSourceRecord(source);
  const projection = buildInterviewProjection(source, sourceValidation.validation);
  const planResult = { action: 'would-materialize', request, request_sha256: requestSha256(request), derived_interview_note_id: projection.interview_note_id, projection: { projected_body_sha256: sha256Text(projection.body), projected_title: projection.title, projected_labels: projection.labels } };
  const plan = { plan_digest: 'd'.repeat(64), results: [planResult] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1658-unknown-create-'));
  const journal = initialJournal(plan, 1, 1);
  const journalFile = path.join(dir, 'journal.json');
  const ownerIssue = () => ({ number: 3001, state: 'open', body: projection.body, labels: projection.labels });
  let owner = false;
  let creates = 0;
  let comments = [];
  const api = {
    plan,
    readIssue: (number) => Number(number) === source.number ? source : ownerIssue(),
    readOwners: () => owner ? [ownerIssue()] : [],
    readComments: () => comments,
    createInterviewNote: () => { creates += 1; owner = true; return null; },
    addReceipt: (_number, body) => { comments = [{ id: 4001, body }]; return { id: 4001 }; },
  };
  const result = applyOne({ planResult, api, journalItem: journal.items[0], journal, journalFile, lock: { assertHeld() {} }, maxCreate: 1, maxReceipts: 1, now: () => '2026-09-09T00:00:00Z' });
  assert.equal(result.created, true);
  assert.equal(creates, 1);
  assert.equal(journal.items[0].phase, 'complete');
});

test('created InterviewNote labels are an exact sorted CAS: missing or extra labels fail closed', () => {
  const source = singleFixture();
  const request = buildMaterializationRequest(source, REPOSITORY);
  const sourceValidation = issueSourceRecord(source);
  const projection = buildInterviewProjection(source, sourceValidation.validation);
  for (const labels of [projection.labels.slice(0, -1), [...projection.labels, 'unexpected:label']]) {
    const planResult = { action: 'would-materialize', request, request_sha256: requestSha256(request), derived_interview_note_id: projection.interview_note_id, projection: { projected_body_sha256: sha256Text(projection.body), projected_title: projection.title, projected_labels: projection.labels } };
    const plan = { plan_digest: 'e'.repeat(64), results: [planResult] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1658-label-cas-'));
    const journal = initialJournal(plan, 1, 1);
    const journalFile = path.join(dir, 'journal.json');
    let owner = false;
    let creates = 0;
    let comments = [];
    const ownerIssue = () => ({ number: 3002, state: 'open', body: projection.body, labels });
    const api = {
      plan,
      readIssue: (number) => Number(number) === source.number ? source : ownerIssue(),
      readOwners: () => owner ? [ownerIssue()] : [],
      readComments: () => comments,
      createInterviewNote: () => { creates += 1; owner = true; return { number: 3002 }; },
      addReceipt: (_number, body) => { comments = [{ id: 4002, body }]; return { id: 4002 }; },
    };
    assert.throws(() => applyOne({ planResult, api, journalItem: journal.items[0], journal, journalFile, lock: { assertHeld() {} }, maxCreate: 1, maxReceipts: 1 }), /exact body\/label validation/);
    assert.equal(creates, 1);
    assert.equal(journal.items[0].mutation_count, 1);
  }
});

test('exclusive lock refuses replacement and journal tamper', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1658-lock-'));
  const lockFile = path.join(dir, 'runner.lock');
  const lock = acquireExclusiveLock(lockFile, 'a'.repeat(64));
  assert.throws(() => acquireExclusiveLock(lockFile, 'a'.repeat(64)), /held|unavailable/);
  fs.writeFileSync(lockFile, JSON.stringify({ lock_id: 'replaced' }));
  assert.throws(() => lock.assertHeld(), /ownership|inode/);
  fs.unlinkSync(lockFile);

  const plan = { plan_digest: 'b'.repeat(64), results: [] };
  const journal = initialJournal(plan, 0, 0);
  assert.equal(validateJournal(journal, plan, 0, 0).ok, true);
  assert.equal(validateJournal({ ...journal, mutation_count: 1 }, plan, 0, 0).ok, false);
});

function singleFixture() {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8').replaceAll('runtime-fixture-1', 'issue-1658-runtime');
  const parsed = parseSourceNoteIssue(fixture);
  const record = JSON.parse(JSON.stringify(parsed.record));
  record.source.external_id = 'issue-1658-runtime';
  record.source_note_id = 'xhs-note:issue-1658-runtime';
  record.source_revision.id = 'xhs-note:issue-1658-runtime:snapshot-test';
  record.boundary_review = { status: 'single-interview', reviewed_at: '2026-09-09T00:00:00Z', interview_note_ids: ['xhs:issue-1658-runtime'] };
  return { number: 2000, state: 'open', body: fixture.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(record, null, 2)), labels: ['type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview'] };
}

test('simulated authorized row uses one create and one receipt, with no existing-owner modification', () => {
  const source = singleFixture();
  const request = buildMaterializationRequest(source, REPOSITORY);
  const sourceValidation = issueSourceRecord(source);
  const projection = buildInterviewProjection(source, sourceValidation.validation && sourceValidation.validation.ok ? sourceValidation.validation : sourceValidation);
  const planResult = { action: 'would-materialize', request, request_sha256: requestSha256(request), derived_interview_note_id: projection.interview_note_id, projection: { projected_body_sha256: sha256Text(projection.body), projected_title: projection.title, projected_labels: projection.labels } };
  const plan = { plan_digest: 'c'.repeat(64), results: [planResult] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1658-apply-'));
  const journal = initialJournal(plan, 1, 1);
  const journalFile = path.join(dir, 'journal.json');
  const lock = { assertHeld() {} };
  let owner = null;
  let comments = [];
  let creates = 0;
  let receipts = 0;
  const ownerIssue = () => ({ number: 3000, state: 'open', body: projection.body, labels: projection.labels });
  const api = {
    plan,
    readIssue: (number) => Number(number) === source.number ? source : ownerIssue(),
    readOwners: () => owner ? [ownerIssue()] : [],
    readComments: () => comments,
    createInterviewNote: () => { creates += 1; owner = true; return { number: 3000 }; },
    addReceipt: (_number, body) => { receipts += 1; comments = [{ id: 4000, body }]; return { id: 4000 }; },
  };
  const result = applyOne({ planResult, api, journalItem: journal.items[0], journal, journalFile, lock, maxCreate: 1, maxReceipts: 1, now: () => '2026-09-09T00:00:00Z' });
  assert.equal(result.created, true);
  assert.equal(creates, 1);
  assert.equal(receipts, 1);
  assert.equal(journal.items[0].phase, 'complete');
  assert.equal(journal.mutation_count, 2);
  assert.equal(journal.create_count, 1);
  assert.equal(journal.receipt_count, 1);
  assertNoExistingMutation('owner', ownerIssue(), ownerIssue());
  assert.match(comments[0].body, /source-note-interview-materialized/);
  assert.equal(receiptObject(request, { ...projection, interview_note_id: projection.interview_note_id, projection }, 3000, '2026-09-09T00:00:00Z').request_sha256, requestSha256(request));
  assert.match(receiptBody(receiptObject(request, { ...projection, interview_note_id: projection.interview_note_id, projection }, 3000)), /source-note-interview-materialized/);
});
