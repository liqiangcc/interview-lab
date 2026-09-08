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
  renderAppliedReceiptComment, validateReceipt, planItem, acquireExclusiveLock, initialJournal, validateJournal, atomicWriteJson,
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

test('read-only issue GET and comments page retry transient EOF/TLS failures within the five-attempt bound', () => {
  const { buildLiveLoader } = require('../scripts/apply-issue-1605-full-boundary-transition');
  const calls = new Map();
  const delays = [];
  const read = (args) => {
    const endpoint = args[1];
    const count = (calls.get(endpoint) || 0) + 1;
    calls.set(endpoint, count);
    if (count === 1) throw Object.assign(new Error('TLS handshake EOF'), { code: 'ECONNRESET' });
    if (endpoint.includes('/comments?')) return [{ id: 101 }];
    return { number: 42, state: 'open', body: sourceFixture, labels: [] };
  };
  const live = buildLiveLoader(read, { sleep: (milliseconds) => delays.push(milliseconds) })({ issue_number: 42 });
  assert.equal(live.issue.number, 42);
  assert.deepEqual(live.comments, [{ id: 101 }]);
  assert.deepEqual([...calls.values()], [2, 2]);
  assert.deepEqual(delays, [100, 100]);
});

test('a permanently failing read exhausts five attempts and remains blocked in the plan', () => {
  const value = fixture();
  const { buildLiveLoader } = require('../scripts/apply-issue-1605-full-boundary-transition');
  let attempts = 0;
  const plan = buildPlan({
    manifest: value.manifest,
    manifestFile: path.join(value.directory, 'full-boundary-manifest.json'),
    records: [value.records[0]],
    liveLoader: buildLiveLoader(() => {
      attempts += 1;
      throw Object.assign(new Error('unexpected EOF'), { code: 'ECONNRESET' });
    }, { sleep: () => {} }),
  });
  assert.equal(attempts, 5);
  assert.equal(plan.ok, false);
  assert.equal(plan.items[0].status, 'blocked');
  assert.match(plan.errors.join('\n'), /live read failed: unexpected EOF/);
});

test('read retry rejects attempts above five and non-transient failures immediately', () => {
  const { readGhJson } = require('../scripts/apply-issue-1605-full-boundary-transition');
  assert.throws(() => readGhJson(['api', 'repos/example'], null, { maxAttempts: 6 }), /from 1 to 5/);
  let attempts = 0;
  assert.throws(() => readGhJson(['api', 'repos/example'], null, {
    read: () => { attempts += 1; throw new Error('HTTP 404 not found'); },
    sleep: () => { throw new Error('non-transient failure must not sleep'); },
  }), /HTTP 404 not found/);
  assert.equal(attempts, 1);
});

test('default live loader and mutation writers resolve the strict repository endpoints', () => {
  const { buildLiveLoader, buildMutationWriters, assertMutationCeiling } = require('../scripts/apply-issue-1605-full-boundary-transition');
  const calls = [];
  const read = (args, input) => {
    calls.push({ args, input });
    if (args[1].includes('/comments?')) return [];
    return { number: 42, state: 'open', body: sourceFixture, labels: [] };
  };
  const live = buildLiveLoader(read)({ issue_number: 42 });
  assert.equal(live.issue.number, 42);
  assert.equal(live.comments.length, 0);
  const writers = buildMutationWriters(read);
  writers.patchIssue(42, { body: 'next', labels: ['boundary:single-interview'] });
  writers.postReceipt(42, 'receipt');
  assert.equal(calls[0].args[1], `repos/${REPOSITORY}/issues/42`);
  assert.match(calls[1].args[1], /repos\/liqiangcc\/interview-lab\/issues\/42\/comments\?per_page=100&page=1/);
  assert.deepEqual(calls.slice(2).map((call) => call.args.slice(0, 4)), [
    ['api', '--method', 'PATCH', `repos/${REPOSITORY}/issues/42`],
    ['api', '--method', 'POST', `repos/${REPOSITORY}/issues/42/comments`],
  ]);
  assert.throws(() => assertMutationCeiling(3, { max_mutations: 2 }), /exceeds authorization proof ceiling/);
});

test('mutation writers do not retry PATCH or POST failures', () => {
  const { buildMutationWriters } = require('../scripts/apply-issue-1605-full-boundary-transition');
  let patchAttempts = 0;
  let postAttempts = 0;
  const writers = buildMutationWriters((args) => {
    if (args[3].includes('/comments')) postAttempts += 1;
    else patchAttempts += 1;
    throw Object.assign(new Error('TLS response unknown'), { code: 'ECONNRESET' });
  });
  assert.throws(() => writers.patchIssue(42, { body: 'next', labels: [] }), /TLS response unknown/);
  assert.throws(() => writers.postReceipt(42, 'receipt'), /TLS response unknown/);
  assert.equal(patchAttempts, 1);
  assert.equal(postAttempts, 1);
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

test('live read failures are complete blocked items and fail the whole plan', () => {
  const value = fixture();
  const record = value.records[0];
  const plan = buildPlan({
    manifest: value.manifest,
    manifestFile: path.join(value.directory, 'full-boundary-manifest.json'),
    records: [record],
    liveLoader: () => { throw new Error('live issue GET failed'); },
  });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /#42: live read failed: live issue GET failed/);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].status, 'blocked');
  assert.match(plan.items[0].errors.join('\n'), /live read failed/);
  assert.equal(plan.items[0].decision, value.request.decision);
  assert.equal(typeof plan.items[0].item_digest, 'string');
});

test('missing decision or blocked status cannot produce a plan-ready batch', () => {
  const value = fixture();
  const record = { ...value.records[0], request: { ...value.records[0].request, decision: undefined } };
  const plan = buildPlan({
    manifest: value.manifest,
    manifestFile: path.join(value.directory, 'full-boundary-manifest.json'),
    records: [record],
    liveLoader: () => ({ issue: value.issue, comments: value.comments }),
  });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /decision/);
  assert.equal(plan.items[0].status, 'blocked');
});

test('default CLI reports blocked instead of plan-ready when a live read fails', () => {
  const { main } = require('../scripts/apply-issue-1605-full-boundary-transition');
  const value = fixture();
  const output = path.join(value.directory, 'blocked-plan.json');
  const originalWrite = process.stdout.write;
  let stdout = '';
  process.stdout.write = (chunk, ...args) => { stdout += String(chunk); return true; };
  let exitCode;
  try {
    exitCode = main([
      '--manifest', path.join(__dirname, '..', 'data/pilot/issue-1605/full-boundary-manifest.json'),
      '--output', output,
    ], {
      manifest: fullManifest,
      liveLoader: () => { throw new Error('simulated live GET failure'); },
    });
  } finally { process.stdout.write = originalWrite; }
  assert.equal(exitCode, 1);
  assert.match(stdout, /"status": "blocked"/);
  assert.doesNotMatch(stdout, /plan-ready/);
  assert.match(stdout, /live read failed: simulated live GET failure/);
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

test('rebuilding the plan after the first apply validates the receipt with the transition plan digest', () => {
  const value = planFixture();
  const harness = journalHarness(value);
  applyBatch({
    plan: value.plan, records: value.records, liveLoader: () => ({ issue: value.issue, comments: value.comments }),
    patchIssue(_number, payload) { value.issue.body = payload.body; value.issue.labels = payload.labels; return {}; },
    postReceipt(_number, body) { const comment = { id: 550, body }; value.comments.push(comment); return comment; },
    readComments: () => value.comments, maxMutations: 2, reconcileAttempts: 1,
    now: () => '2026-09-08T00:01:00.000Z', ...harness,
  });
  const replanned = buildPlan({ manifest: value.manifest, manifestFile: path.join(value.directory, 'full-boundary-manifest.json'), records: value.records, liveLoader: () => ({ issue: value.issue, comments: value.comments }) });
  assert.equal(replanned.ok, true, replanned.errors.join('; '));
  assert.equal(replanned.items[0].status, 'already-applied');
  assert.equal(replanned.canonical_digest, value.plan.canonical_digest);
});

test('target-already-applied without a receipt can repair and validate its receipt CAS', () => {
  const value = planFixture();
  const plannedTarget = value.plan.items[0];
  value.issue.body = plannedTarget.next_body;
  value.issue.labels = plannedTarget.next_labels;
  const replanned = buildPlan({
    manifest: value.manifest,
    manifestFile: path.join(value.directory, 'full-boundary-manifest.json'),
    records: value.records,
    liveLoader: () => ({ issue: value.issue, comments: value.comments }),
  });
  assert.equal(replanned.ok, true, replanned.errors.join('; '));
  assert.equal(replanned.items[0].status, 'receipt-needed');
  const targetPlan = planItem({ ...value.records[0], manifest_digest: value.manifest.canonical_digest, plan_digest: replanned.canonical_digest }, { issue: value.issue, comments: value.comments });
  assert.equal(targetPlan.ok, true, targetPlan.errors.join('; '));
  assert.equal(targetPlan.already_applied, true);
  const receipt = buildReceipt(value.request, targetPlan, value.manifest.canonical_digest, replanned.canonical_digest, '2026-09-08T00:01:00.000Z');
  assert.equal(receipt.previous_body_sha256, value.request.expected_body_sha256);
  assert.equal(receipt.new_body_sha256, targetPlan.current_body_sha256);
  assert.equal(validateReceipt(receipt, value.request, targetPlan, value.manifest.canonical_digest, replanned.canonical_digest).ok, true);
  value.comments.push({ id: 552, body: renderAppliedReceiptComment(receipt) });
  const resumed = buildPlan({
    manifest: value.manifest,
    manifestFile: path.join(value.directory, 'full-boundary-manifest.json'),
    records: value.records,
    liveLoader: () => ({ issue: value.issue, comments: value.comments }),
  });
  assert.equal(resumed.ok, true, resumed.errors.join('; '));
  assert.equal(resumed.items[0].status, 'already-applied');
});

test('resuming from the frozen plan ignores REST label ordering without changing its digest', () => {
  const value = planFixture();
  const frozen = JSON.parse(JSON.stringify(value.plan));
  value.issue.body = frozen.items[0].next_body;
  value.issue.labels = [...frozen.items[0].next_labels].reverse();
  const resumed = buildPlan({
    manifest: value.manifest,
    manifestFile: path.join(value.directory, 'full-boundary-manifest.json'),
    records: value.records,
    priorPlan: frozen,
    liveLoader: () => ({ issue: value.issue, comments: value.comments }),
  });
  assert.equal(resumed.ok, true, resumed.errors.join('; '));
  assert.equal(resumed.items[0].status, 'receipt-needed');
  assert.deepEqual(resumed.items[0].next_labels, frozen.items[0].next_labels);
  assert.equal(resumed.canonical_digest, frozen.canonical_digest);
});

test('complete resume performs read-only target/receipt verification before skipping', () => {
  const value = planFixture();
  const harness = journalHarness(value);
  let patches = 0; let posts = 0; let reads = 0;
  applyBatch({
    plan: value.plan, records: value.records, liveLoader: () => ({ issue: value.issue, comments: value.comments }),
    patchIssue(_number, payload) { patches += 1; value.issue.body = payload.body; value.issue.labels = payload.labels; return {}; },
    postReceipt(_number, body) { posts += 1; const comment = { id: 551, body }; value.comments.push(comment); return comment; },
    readComments: () => value.comments, maxMutations: 2, reconcileAttempts: 1,
    now: () => '2026-09-08T00:01:00.000Z', ...harness,
  });
  const resumed = applyBatch({
    plan: value.plan, records: value.records,
    liveLoader: () => { reads += 1; return { issue: value.issue, comments: value.comments }; },
    patchIssue() { patches += 1; }, postReceipt() { posts += 1; }, readComments: () => value.comments,
    maxMutations: 2, reconcileAttempts: 1, ...harness,
  });
  assert.equal(resumed.ok, true);
  assert.equal(reads, 1);
  assert.equal(patches, 1);
  assert.equal(posts, 1);
});

test('journal counters, types, sum, and max ceiling are fail-closed before mutation', () => {
  const value = planFixture();
  const valid = initialJournal(value.plan);
  assert.equal(validateJournal(valid, value.plan, 2).ok, true);
  const seal = (journal) => ({ ...journal, canonical_digest: sha256Text(canonical(Object.fromEntries(Object.entries(journal).filter(([key]) => key !== 'canonical_digest')))) });
  const cases = [
    [Object.assign({}, valid, { mutation_count: NaN }), /safe non-negative integer/],
    [Object.assign({}, valid, { mutation_count: -1 }), /safe non-negative integer/],
    [Object.assign({}, valid, { mutation_count: 1 }), /sum of item/],
    [Object.assign({}, valid, { items: [{ ...valid.items[0], mutation_count: '1' }] }), /safe non-negative integer/],
    [Object.assign({}, valid, { items: [{ ...valid.items[0], possibly_performed: 'false' }] }), /possibly_performed/],
    [Object.assign({}, valid, { mutation_count: 3, items: [{ ...valid.items[0], mutation_count: 3 }] }), /exceeds max mutation ceiling/],
  ];
  for (const [candidate, pattern] of cases) assert.throws(() => {
    const result = validateJournal(seal(candidate), value.plan, 2);
    if (result.ok) throw new Error('tampered journal unexpectedly validated');
    throw new Error(result.errors.join('; '));
  }, pattern);
  let patches = 0;
  const tampered = seal(Object.assign({}, valid, { mutation_count: -1 }));
  assert.throws(() => applyBatch({
    plan: value.plan, records: value.records, liveLoader: () => ({ issue: value.issue, comments: value.comments }),
    patchIssue() { patches += 1; }, postReceipt() {}, readComments: () => value.comments,
    maxMutations: 2, readJournal: () => tampered, writeJournal() {}, lock: { assertHeld() {} },
  }), /journal validation failed/);
  assert.equal(patches, 0);
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
    comment_id: 1605, authorized_by: 'test-controller', max_mutations: 2,
  };
  proof.proof_sha256 = sha256Text(canonical(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'proof_sha256'))));
  const comments = [{ id: 1605, body: `<!-- ${AUTHORIZATION_MARKER}\n${JSON.stringify(proof)}\n-->` }];
  assert.equal(validateAuthorization(proof, value.manifest.canonical_digest, value.plan.canonical_digest, comments).ok, true);
  assert.equal(validateAuthorization({ ...proof, max_mutations: 0 }, value.manifest.canonical_digest, value.plan.canonical_digest, comments).ok, false);
  assert.equal(validateAuthorization({ ...proof, max_mutations: 3, proof_sha256: proof.proof_sha256 }, value.manifest.canonical_digest, value.plan.canonical_digest, comments).ok, false);
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

test('atomic JSON write fsyncs the renamed file and its parent directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-atomic-write-'));
  const target = path.join(directory, 'journal.json');
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const opened = [];
  let fsyncCount = 0;
  fs.openSync = function patchedOpenSync(file, ...args) {
    opened.push(typeof file === 'string' ? path.resolve(file) : file);
    return originalOpenSync.call(fs, file, ...args);
  };
  fs.fsyncSync = function patchedFsyncSync(fd) {
    fsyncCount += 1;
    return originalFsyncSync.call(fs, fd);
  };
  try { atomicWriteJson(target, { status: 'durable' }); }
  finally { fs.openSync = originalOpenSync; fs.fsyncSync = originalFsyncSync; }
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).status, 'durable');
  assert.ok(opened.includes(path.resolve(directory)), `parent directory was not opened: ${opened.join(', ')}`);
  assert.ok(fsyncCount >= 2, `expected file and parent fsync, got ${fsyncCount}`);
});
