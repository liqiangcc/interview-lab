'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sourceFixture = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue.valid.md'), 'utf8');
const fullManifest = require('../data/pilot/issue-1605/full-boundary-manifest.json');
const {
  REPOSITORY, SOURCE_REF, PARENT_ISSUE, AUTHORIZATION_MARKER,
  canonical, sha256Text, manifestDigest, validateManifest, requestFiles,
  validateAuthorization, assertBoundaryOnly, buildPlan, applyBatch, buildReceipt,
  validateReceipt, planItem, acquireExclusiveLock,
} = require('../scripts/lib/issue-1605-full-boundary-transition');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-transition-'));
  const parsed = parseSourceNoteIssue(sourceFixture);
  const sourceNoteId = parsed.record.source_note_id;
  const revisionId = parsed.record.source_revision.id;
  const request = {
    schema_version: 'source-note-boundary-review-transition.v1',
    transition_id: 'issue-1605-boundary-fixture-a', repository: REPOSITORY,
    issue_number: 42, source_note_id: sourceNoteId,
    expected_body_sha256: sha256Text(sourceFixture), expected_boundary_status: 'pending',
    expected_source_revision_id: revisionId, expected_manifest_sha256: null,
    expected_source_repository_ref: SOURCE_REF, decision: 'single-interview',
    reviewed_at: '2026-09-08T00:00:00.000Z', reviewer_kind: 'ai-assisted',
    review_evidence: { repository: REPOSITORY, issue_number: 42, comment_id: 101 },
    checks: ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication']
      .map((check_id) => ({ check_id, result: 'pass', note: 'fixture evidence' })),
    limitations: ['fixture only'],
  };
  const requestBody = `<!-- source-note-boundary-review-transition\n${JSON.stringify(request, null, 2)}\n-->\n`;
  const requestFile = path.join(directory, 'requests', '42.md');
  fs.mkdirSync(path.dirname(requestFile), { recursive: true });
  fs.writeFileSync(requestFile, requestBody);
  const manifest = {
    schema_version: 'source-note-boundary-review-batch.v1', repository: REPOSITORY,
    parent_issue: PARENT_ISSUE, source_snapshot: { repository: 'liqiangcc/xhs', ref: SOURCE_REF },
    plan_digest: 'a'.repeat(64), items: [{ issue_number: 42, transition_id: request.transition_id, request_file: 'requests/42.md' }],
  };
  manifest.canonical_digest = manifestDigest(manifest);
  const issue = {
    number: 42, state: 'open', body: sourceFixture,
    labels: ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk', 'source-year:2022'],
  };
  const evidence = {
    id: 101,
    body: [request.transition_id, sourceNoteId, revisionId, SOURCE_REF, 'single-interview', ...request.checks.map((item) => item.check_id)].join('\n'),
  };
  const records = requestFiles(manifest, path.join(directory, 'full-boundary-manifest.json'));
  assert.deepEqual(records.errors, []);
  return { directory, manifest, request, requestFile, issue, comments: [evidence], records: records.records };
}

function planFixture() {
  const value = fixture();
  const records = value.records.map((record) => ({ ...record, manifest_digest: value.manifest.canonical_digest, plan_digest: value.manifest.plan_digest }));
  const plan = buildPlan({ manifest: value.manifest, manifestFile: path.join(value.directory, 'full-boundary-manifest.json'), records, liveLoader: () => ({ issue: value.issue, comments: value.comments }) });
  assert.equal(plan.ok, true, plan.errors.join('; '));
  return { ...value, records, plan };
}

function journalHarness(value) {
  const journalFile = path.join(value.directory, 'journal.json');
  let journal = null;
  const writes = [];
  const lock = { assertHeld() {}, release() {} };
  return {
    journalFile, lock, writes,
    readJournal: () => journal,
    writeJournal: (next) => { journal = JSON.parse(JSON.stringify(next)); writes.push(journal); },
  };
}

test('manifest and formal request marker are strictly pinned to #1605 and fixed source ref', () => {
  const value = fixture();
  assert.equal(validateManifest(value.manifest).ok, false);
  assert.equal(validateManifest(fullManifest).ok, true);
  assert.equal(fullManifest.items.length, 419);
  assert.equal(fullManifest.plan_digest, 'ad3e3974c21415e2371b8fe77a2ae54b65dd7783516ed6a68ef61bb070877781');
  assert.equal(value.records[0].request.repository, REPOSITORY);
  const wrongParent = { ...value.manifest, parent_issue: 1604 };
  wrongParent.canonical_digest = manifestDigest(wrongParent);
  assert.equal(validateManifest(wrongParent).ok, false);
  const tampered = fs.readFileSync(value.requestFile, 'utf8').replace(SOURCE_REF, '0'.repeat(40));
  fs.writeFileSync(value.requestFile, tampered);
  assert.throws(() => {
    const result = requestFiles(value.manifest, path.join(value.directory, 'full-boundary-manifest.json'));
    if (result.errors.length) throw new Error(result.errors.join('; '));
  }, /fixed approved ref|source ref/);
});

test('explicit comments pagination requires a short terminal page', () => {
  const calls = [];
  const pages = new Map([[1, Array.from({ length: 100 }, (_, index) => ({ id: index }))], [2, [{ id: 100 }]]]);
  const { readCommentsPaged } = require('../scripts/apply-issue-1605-full-boundary-transition');
  const result = readCommentsPaged(REPOSITORY, 42, (args) => {
    calls.push(args[1]);
    return pages.get(Number(args[1].match(/page=(\d+)$/)[1]));
  });
  assert.equal(result.length, 101);
  assert.deepEqual(calls, [`repos/${REPOSITORY}/issues/42/comments?per_page=100&page=1`, `repos/${REPOSITORY}/issues/42/comments?per_page=100&page=2`]);
  assert.throws(() => readCommentsPaged(REPOSITORY, 42, () => Array(100).fill({})), /short terminal page/);
});

test('planner calls the formal transition parser/planner path and records a zero-mutation plan', () => {
  const value = planFixture();
  const item = value.plan.items[0];
  assert.equal(value.plan.mutation_count, 0);
  assert.equal(item.status, 'ready');
  assert.equal(item.current_body_sha256, value.request.expected_body_sha256);
  assert.equal(item.next_labels.includes('boundary:single-interview'), true);
  assert.equal(item.next_labels.includes('task:boundary-review'), false);
  assert.equal(assertBoundaryOnly(value.issue.body, item.next_body, value.issue.labels, item.next_labels, 'single-interview').ok, true);
});

test('CLI defaults to plan-only and the plan path never invokes PATCH or POST', () => {
  const value = fixture();
  const { parseArgs } = require('../scripts/apply-issue-1605-full-boundary-transition');
  assert.equal(parseArgs([]).apply, false);
  let writes = 0;
  const plan = buildPlan({ manifest: value.manifest, manifestFile: path.join(value.directory, 'full-boundary-manifest.json'), records: value.records.map((record) => ({ ...record, manifest_digest: value.manifest.canonical_digest })), liveLoader: () => ({ issue: value.issue, comments: value.comments }) });
  if (writes) throw new Error('mutation writer was invoked');
  assert.equal(plan.ok, true);
  assert.equal(writes, 0);
  assert.equal(plan.mutation_count, 0);
});

test('apply patches only the boundary projection, validates it, then posts one applied receipt', () => {
  const value = planFixture();
  const harness = journalHarness(value);
  const calls = [];
  let nextCommentId = 200;
  const liveLoader = () => ({ issue: value.issue, comments: value.comments });
  const result = applyBatch({
    plan: value.plan, records: value.records, liveLoader,
    patchIssue(number, payload) {
      calls.push(['PATCH', number, payload]);
      value.issue.body = payload.body; value.issue.labels = payload.labels;
      return { number };
    },
    postReceipt(number, body) {
      calls.push(['POST', number, body]);
      const comment = { id: nextCommentId++, body }; value.comments.push(comment); return comment;
    },
    readComments: () => value.comments, maxMutations: 2, reconcileAttempts: 2,
    now: () => '2026-09-08T00:01:00.000Z', ...harness,
  });
  assert.equal(result.ok, true, result.errors && result.errors.join('; '));
  assert.deepEqual(calls.map((call) => call[0]), ['PATCH', 'POST']);
  assert.deepEqual(Object.keys(calls[0][2]).sort(), ['body', 'labels']);
  assert.equal(harness.readJournal().status, 'complete');
  assert.equal(parseSourceNoteIssue(value.issue.body).record.boundary_review.status, 'single-interview');
});

test('applied receipt binds the exact plan digest and expected SourceRevision/ref', () => {
  const value = planFixture();
  const item = value.plan.items[0];
  const receipt = buildReceipt(value.request, { ...item, already_applied: false, interview_note_cases: [] }, value.manifest.canonical_digest, value.plan.canonical_digest, '2026-09-08T00:01:00.000Z');
  assert.equal(validateReceipt(receipt, value.request, { ...item, already_applied: false, interview_note_cases: [] }, value.manifest.canonical_digest, value.plan.canonical_digest).ok, true);
  assert.equal(validateReceipt({ ...receipt, plan_digest: 'f'.repeat(64) }, value.request, { ...item, already_applied: false, interview_note_cases: [] }, value.manifest.canonical_digest, value.plan.canonical_digest).ok, false);
  assert.equal(validateReceipt({ ...receipt, expected_source_revision_id: 'stale' }, value.request, { ...item, already_applied: false, interview_note_cases: [] }, value.manifest.canonical_digest, value.plan.canonical_digest).ok, false);
  assert.equal(validateReceipt({ ...receipt, expected_source_repository_ref: '0'.repeat(40) }, value.request, { ...item, already_applied: false, interview_note_cases: [] }, value.manifest.canonical_digest, value.plan.canonical_digest).ok, false);
});

test('the same transition cannot have multiple applied receipts', () => {
  const value = planFixture();
  const harness = journalHarness(value);
  applyBatch({
    plan: value.plan, records: value.records, liveLoader: () => ({ issue: value.issue, comments: value.comments }),
    patchIssue(_number, payload) { value.issue.body = payload.body; value.issue.labels = payload.labels; return {}; },
    postReceipt(_number, body) { const comment = { id: 500, body }; value.comments.push(comment); return comment; },
    readComments: () => value.comments, maxMutations: 2, reconcileAttempts: 1,
    now: () => '2026-09-08T00:01:00.000Z', ...harness,
  });
  value.comments.push({ id: 501, body: value.comments.find((comment) => comment.id === 500).body });
  const replanned = planItem({ ...value.records[0], manifest_digest: value.manifest.canonical_digest, plan_digest: value.plan.canonical_digest }, { issue: value.issue, comments: value.comments });
  assert.equal(replanned.ok, false);
  assert.match(replanned.errors.join('\n'), /multiple applied receipts/);
});

test('unknown PATCH response reconciles once and does not issue a second PATCH', () => {
  const value = planFixture();
  const harness = journalHarness(value);
  let patches = 0; let posts = 0;
  const result = applyBatch({
    plan: value.plan, records: value.records, liveLoader: () => ({ issue: value.issue, comments: value.comments }),
    patchIssue(_number, payload) { patches += 1; value.issue.body = payload.body; value.issue.labels = payload.labels; throw new Error('PATCH response lost'); },
    postReceipt(_number, body) { posts += 1; const comment = { id: 300, body }; value.comments.push(comment); return comment; },
    readComments: () => value.comments, maxMutations: 2, reconcileAttempts: 2,
    now: () => '2026-09-08T00:01:00.000Z', ...harness,
  });
  assert.equal(result.ok, true, result.errors && result.errors.join('; '));
  assert.equal(patches, 1);
  assert.equal(posts, 1);
});

test('unknown POST response reconciles an exact marker, while an unresolved journal is fail-closed', () => {
  const value = planFixture();
  const harness = journalHarness(value);
  let posts = 0;
  const result = applyBatch({
    plan: value.plan, records: value.records, liveLoader: () => ({ issue: value.issue, comments: value.comments }),
    patchIssue(_number, payload) { value.issue.body = payload.body; value.issue.labels = payload.labels; return {}; },
    postReceipt(_number, body) { posts += 1; value.comments.push({ id: 400, body }); throw new Error('POST response lost'); },
    readComments: () => value.comments, maxMutations: 2, reconcileAttempts: 2,
    now: () => '2026-09-08T00:01:00.000Z', ...harness,
  });
  assert.equal(result.ok, true, result.errors && result.errors.join('; '));
  assert.equal(posts, 1);
  const blocked = planFixture();
  const blockedHarness = journalHarness(blocked);
  let blockedPatches = 0;
  assert.throws(() => applyBatch({
    plan: blocked.plan, records: blocked.records, liveLoader: () => ({ issue: blocked.issue, comments: blocked.comments }),
    patchIssue() { blockedPatches += 1; throw new Error('transport'); }, postReceipt() { throw new Error('must not post'); },
    readComments: () => blocked.comments, maxMutations: 2, reconcileAttempts: 1, ...blockedHarness,
  }), /PATCH response unknown/);
  assert.equal(blockedPatches, 1);
  assert.throws(() => applyBatch({
    plan: blocked.plan, records: blocked.records, liveLoader: () => ({ issue: blocked.issue, comments: blocked.comments }),
    patchIssue() { blockedPatches += 1; }, postReceipt() {}, readComments: () => blocked.comments,
    maxMutations: 2, reconcileAttempts: 1, ...blockedHarness,
  }), /refusing blind retry/);
  assert.equal(blockedPatches, 1);
});

test('parent authorization must be a live marker for exact #1605, manifest, and plan', () => {
  const value = planFixture();
  const proof = {
    schema_version: 'issue-1605-full-boundary-transition-authorization.v1', repository: REPOSITORY,
    parent_issue: PARENT_ISSUE, action: 'authorize-full-boundary-transition', allow_live_github: true,
    manifest_digest: value.manifest.canonical_digest, plan_digest: value.plan.canonical_digest,
    comment_id: 1605, authorized_by: 'test-controller',
  };
  proof.proof_sha256 = sha256Text(canonical(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'proof_sha256'))));
  const comments = [{ id: 1605, body: `<!-- ${AUTHORIZATION_MARKER}\n${JSON.stringify(proof)}\n-->` }];
  assert.equal(validateAuthorization(proof, value.manifest.canonical_digest, value.plan.canonical_digest, comments).ok, true);
  assert.equal(validateAuthorization({ ...proof, action: 'authorize-evidence-comments-only' }, value.manifest.canonical_digest, value.plan.canonical_digest, comments).ok, false);
});

test('exclusive lock records and verifies device/inode, and release removes it safely', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-lock-'));
  const lockPath = path.join(directory, 'transition.lock');
  const lock = acquireExclusiveLock(lockPath);
  const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const stat = fs.lstatSync(lockPath);
  assert.equal(record.device, stat.dev);
  assert.equal(record.inode, stat.ino);
  assert.equal(record.dev, stat.dev);
  assert.equal(record.ino, stat.ino);
  lock.assertHeld();
  lock.release();
  assert.equal(fs.existsSync(lockPath), false);

  const replaced = acquireExclusiveLock(lockPath);
  fs.unlinkSync(lockPath);
  fs.writeFileSync(lockPath, JSON.stringify({ schema_version: 'attacker', lock_id: 'other' }));
  assert.throws(() => replaced.assertHeld(), /ownership or inode changed/);
  assert.throws(() => replaced.release(), /ownership or inode changed/);
  fs.unlinkSync(lockPath);
});
