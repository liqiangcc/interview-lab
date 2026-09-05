'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { buildInterviewProjection } = require('../scripts/lib/source-note-interview-materialization');
const {
  ISSUE_NUMBERS,
  PACKET_SET_SHA256,
  interviewNoteId,
  buildMaterializationRequest,
  validateFixedSet,
  targetPreflight,
  requestSha256,
  applyBatch,
  initialProgress,
  validateProgress,
  renderMaterializationReceipt,
  buildMaterializationReceipt,
  validateMaterializationReceipt,
  makeIntent,
  acquireProgressLock,
} = require('../scripts/lib/issue-1556-materialization-batch');
const { sha256Text } = require('../scripts/lib/source-note-interview-materialization');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue.valid.md'), 'utf8');

function gitBlob(bytes) {
  const buffer = Buffer.from(bytes);
  const sha = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer])).digest('hex');
  return { sha, content: buffer.toString('base64') };
}

function sourceIssue(number = 158, external = '625564d70000000001025e46') {
  const parsed = parseSourceNoteIssue(fixture);
  const record = JSON.parse(JSON.stringify(parsed.record));
  record.source_note_id = `xhs-note:${external}`;
  record.source.external_id = external;
  record.source_revision.id = `xhs-note:${external}:snapshot-95b77bb26104`;
  const projection = `source projection for ${external}`;
  const blob = gitBlob(projection);
  record.artifacts = [{
    kind: 'text_projection',
    ref: `liqiangcc/xhs:note_desc/${external}.txt@95b77bb261048059846273688e4b90a2e108b437`,
    git_blob_sha: blob.sha,
    sha256: null,
    provenance: 'source_projection',
    byte_size: Buffer.byteLength(projection),
    integrity: 'present',
  }];
  const targetId = `xhs:${external}`;
  record.boundary_review = { status: 'single-interview', reviewed_at: '2026-09-05T04:37:00Z', interview_note_ids: [targetId] };
  const body = fixture.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(record, null, 2)).replace('id=xhs-note:625564d70000000001025e46', `id=xhs-note:${external}`);
  return { number, state: 'open', body, labels: ['type:source-note', 'source:xhs', 'status:captured', 'source-year:2022', 'boundary:single-interview'], blob };
}

function transitionFor(issue) {
  const parsed = parseSourceNoteIssue(issue.body);
  return {
    schema_version: 'source-note-boundary-review-transition.v1',
    transition_id: `issue-1549-boundary-review-${issue.number}`,
    repository: 'liqiangcc/interview-lab',
    issue_number: issue.number,
    source_note_id: parsed.record.source_note_id,
    expected_body_sha256: 'a'.repeat(64),
    expected_boundary_status: 'pending',
    expected_source_revision_id: parsed.record.source_revision.id,
    expected_manifest_sha256: null,
    expected_source_repository_ref: '95b77bb261048059846273688e4b90a2e108b437',
    decision: 'single-interview',
    reviewed_at: '2026-09-05T04:37:00Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: issue.number, comment_id: 1 },
    checks: ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication'].map((check_id) => ({ check_id, result: 'pass' })),
    limitations: [],
  };
}

function makeBatchHarness() {
  const issues = ISSUE_NUMBERS.map((number, index) => sourceIssue(number, `${String(number).padStart(3, '0')}75564d70000000001025e46`));
  const transitions = issues.map(transitionFor);
  const transitionReceipts = issues.map((issue, index) => ({ schema_version: 'source-note-boundary-review-applied.v1', transition_id: transitions[index].transition_id, repository: transitions[index].repository, issue_number: issue.number, source_note_id: transitions[index].source_note_id, decision: 'single-interview', reviewed_at: transitions[index].reviewed_at, applied_at: transitions[index].reviewed_at, previous_body_sha256: transitions[index].expected_body_sha256, new_body_sha256: sha256Text(issue.body), interview_note_ids: [interviewNoteId(transitions[index].source_note_id)], interview_note_cases: null }));
  const packets = issues.map((issue, index) => {
    const external = transitions[index].source_note_id.slice('xhs-note:'.length);
    return { issue_number: issue.number, source_note_id: transitions[index].source_note_id, artifact: { ref: `liqiangcc/xhs:note_desc/${external}.txt@95b77bb261048059846273688e4b90a2e108b437`, git_blob_sha: issue.blob.sha, anchor: `source projection for ${external}` } };
  });
  const items = issues.map((issue, index) => {
    const request = buildMaterializationRequest(transitions[index], transitionReceipts[index]);
    return { issue_number: issue.number, source_note_issue_number: issue.number, source_note_id: request.source_note_id, interview_note_id: interviewNoteId(request.source_note_id), request_sha256: requestSha256(request) };
  });
  const report = { schema_version: 'issue-1556-interview-note-materialization-plan.v1', items };
  const planSha = sha256Text(require('../scripts/lib/issue-1556-materialization-batch').canonicalJson(report));
  const planResult = { ok: true, plan_sha256: planSha, authorization_sha256: planSha, items, report: { ...report, plan_sha256: planSha, authorization_sha256: planSha } };
  const owners = new Map(issues.map((issue) => {
    const parsed = parseSourceNoteIssue(issue.body);
    const projection = buildInterviewProjection(issue, { ok: true, parsed });
    return [issue.number, [{ number: 4000 + issue.number, state: 'open', body: projection.body, labels: projection.labels }]];
  }));
  const comments = new Map(issues.map((issue) => [issue.number, []]));
  const calls = { create: [], receipt: [] };
  const loadLive = (request) => ({ sourceIssue: issues.find((issue) => issue.number === request.source_note_issue_number), comments: comments.get(request.source_note_issue_number), allIssues: owners.get(request.source_note_issue_number) });
  const evidenceReceipts = ISSUE_NUMBERS.map((issue_number, index) => ({ issue_number, packet_set_sha256: PACKET_SET_SHA256, transition_id: transitions[index].transition_id }));
  const makeOptions = (overrides = {}) => {
    const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1556-apply-'));
    const lock = acquireProgressLock(path.join(lockDir, 'progress.lock'));
    return ({
    expectedPlanSha256: planSha, expectedAuthorizationSha256: planSha, lock, planBatch: () => planResult, transitionRequests: transitions, transitionReceipts, evidenceReceipts, loadLive,
    readBlob: (sha) => { const issue = issues.find((candidate) => candidate.blob.sha === sha); return { sha, encoding: 'base64', content: issue.blob.content }; },
    persistProgress: () => {}, writeRequest: () => {}, writeReceipt: () => {}, beforeMutation: () => {},
    createInterviewIssue: (request, projection) => { calls.create.push(request.source_note_issue_number); owners.set(request.source_note_issue_number, [{ number: 4000 + request.source_note_issue_number, state: 'open', body: projection.body, labels: projection.labels }]); },
    postReceipt: (request, receipt) => { calls.receipt.push(request.source_note_issue_number); comments.set(request.source_note_issue_number, [{ id: 8000 + request.source_note_issue_number, issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${request.source_note_issue_number}`, body: renderMaterializationReceipt(receipt) }]); },
    ...overrides,
    _releaseLock: () => { lock.release(); fs.rmSync(lockDir, { recursive: true, force: true }); },
  });
  };
  return { issues, transitions, transitionReceipts, packets, items, planResult, owners, comments, calls, loadLive, evidenceReceipts, makeOptions };
}

test('fixed materialization scope is exactly the 17 ordered SourceNotes', () => {
  assert.equal(validateFixedSet(ISSUE_NUMBERS.map((issue_number) => ({ issue_number })), 'items').length, 0);
  assert.match(validateFixedSet(ISSUE_NUMBERS.slice(0, 16).map((issue_number) => ({ issue_number })), 'items')[0], /exactly the fixed 17/);
  assert.match(validateFixedSet([...ISSUE_NUMBERS].reverse().map((issue_number) => ({ issue_number })), 'items')[0], /fixed 17 Issue order/);
  assert.equal(PACKET_SET_SHA256.length, 64);
});

test('target preflight binds #1554 target body, artifact, ownership and forbids source-ready/learning labels', () => {
  const issue = sourceIssue();
  const transition = transitionFor(issue);
  const receipt = { ...transition, schema_version: 'source-note-boundary-review-applied.v1', previous_body_sha256: transition.expected_body_sha256, new_body_sha256: sha256Text(issue.body) };
  // The preflight only needs the receipt target body and the exact pinned artifact.
  const packet = { source_note_id: transition.source_note_id, artifact: { ref: `liqiangcc/xhs:note_desc/625564d70000000001025e46.txt@95b77bb261048059846273688e4b90a2e108b437`, git_blob_sha: issue.blob.sha, anchor: 'source projection for 625564d70000000001025e46' } };
  const gate = targetPreflight(packet, transition, receipt, { sourceIssue: issue, allIssues: [], comments: [] }, { readBlob: () => ({ sha: issue.blob.sha, encoding: 'base64', content: issue.blob.content }) });
  assert.equal(gate.ok, true, gate.errors.join('; '));
  const expected = buildInterviewProjection(issue, parseSourceNoteIssue(issue.body) && { ok: true, parsed: parseSourceNoteIssue(issue.body) });
  assert.equal(expected.interview_note_id, interviewNoteId(transition.source_note_id));
  const forbidden = { ...issue, labels: [...issue.labels, 'status:source-ready'] };
  const forbiddenGate = targetPreflight(packet, transition, receipt, { sourceIssue: forbidden, allIssues: [], comments: [] }, { readBlob: () => ({ sha: issue.blob.sha, encoding: 'base64', content: issue.blob.content }) });
  assert.ok(forbiddenGate.errors.some((error) => /forbidden/.test(error)));
  const badProvenance = { ...transition, expected_source_repository_ref: null };
  const provenanceGate = targetPreflight(packet, badProvenance, receipt, { sourceIssue: issue, allIssues: [], comments: [] }, { readBlob: () => ({ sha: issue.blob.sha, encoding: 'base64', content: issue.blob.content }) });
  assert.ok(provenanceGate.errors.some((error) => /repository ref/.test(error)));
  const missingCommentsGate = targetPreflight(packet, transition, receipt, { sourceIssue: issue, allIssues: [] }, { readBlob: () => ({ sha: issue.blob.sha, encoding: 'base64', content: issue.blob.content }) });
  assert.ok(missingCommentsGate.errors.some((error) => /comments inventory/.test(error)));
});

test('projection is source-faithful and has no learning or source-ready labels', () => {
  const issue = sourceIssue();
  const parsed = parseSourceNoteIssue(issue.body);
  const projection = buildInterviewProjection(issue, { ok: true, parsed });
  assert.equal(projection.interview_note_id, 'xhs:625564d70000000001025e46');
  assert.deepEqual(projection.labels, ['type:interview-note', 'source:xhs', 'status:captured']);
  assert.match(projection.body, /SourceNote：#158/);
  assert.equal(projection.labels.includes('status:source-ready'), false);
  assert.match(requestSha256({ a: 1 }), /^[0-9a-f]{64}$/);
});

test('apply rejects synthetic partial inputs before any mutation', () => {
  const issues = ISSUE_NUMBERS.map((number, index) => sourceIssue(number, `${String(number).padStart(3, '0')}25564d70000000001025e46`));
  const transitions = issues.map(transitionFor);
  const transitionReceipts = issues.map((issue, index) => ({ schema_version: 'source-note-boundary-review-applied.v1', transition_id: transitions[index].transition_id, repository: transitions[index].repository, issue_number: issue.number, source_note_id: transitions[index].source_note_id, decision: 'single-interview', reviewed_at: transitions[index].reviewed_at, applied_at: transitions[index].reviewed_at, previous_body_sha256: transitions[index].expected_body_sha256, new_body_sha256: sha256Text(issue.body), interview_note_ids: [interviewNoteId(transitions[index].source_note_id)], interview_note_cases: null }));
  const packets = issues.map((issue) => {
    const transition = transitions.find((item) => item.issue_number === issue.number);
    const external = transition.source_note_id.slice('xhs-note:'.length);
    return { issue_number: issue.number, source_note_id: transition.source_note_id, artifact: { ref: `liqiangcc/xhs:note_desc/${external}.txt@95b77bb261048059846273688e4b90a2e108b437`, git_blob_sha: issue.blob.sha, anchor: `source projection for ${external}` } };
  });
  const items = issues.map((issue, index) => {
    const request = buildMaterializationRequest(transitions[index], transitionReceipts[index]);
    return { issue_number: issue.number, source_note_issue_number: issue.number, source_note_id: request.source_note_id, interview_note_id: interviewNoteId(request.source_note_id), request_sha256: requestSha256(request) };
  });
  const report = { schema_version: 'issue-1556-interview-note-materialization-plan.v1', items };
  const planSha = sha256Text(require('../scripts/lib/issue-1556-materialization-batch').canonicalJson(report));
  const planResult = { ok: true, plan_sha256: planSha, items, report: { ...report, plan_sha256: planSha } };
  const owners = new Map();
  const comments = new Map();
  let createCalls = 0;
  let receiptCalls = 0;
  const snapshots = [];
  const progress = initialProgress(items, planSha);
  const findIssue = (request) => issues.find((issue) => issue.number === request.source_note_issue_number);
  const loadLive = (request) => ({ sourceIssue: findIssue(request), comments: comments.get(request.source_note_issue_number) || [], allIssues: owners.get(request.source_note_issue_number) || [] });
  const evidenceReceipts = ISSUE_NUMBERS.map((issue_number, index) => ({ issue_number, packet_set_sha256: PACKET_SET_SHA256, transition_id: transitions[index].transition_id }));
  const options = {
    expectedPlanSha256: planSha, lock: { assertHeld() {} }, transitionRequests: transitions, transitionReceipts, evidenceReceipts, loadLive,
    readBlob: (sha) => { const issue = issues.find((candidate) => candidate.blob.sha === sha); return { sha, encoding: 'base64', content: issue.blob.content }; },
    persistProgress: (value) => snapshots.push(JSON.parse(JSON.stringify(value))), writeRequest: () => {}, writeReceipt: () => {}, beforeMutation: () => {},
    createInterviewIssue: (request, projection) => { createCalls += 1; owners.set(request.source_note_issue_number, [{ number: 300 + request.source_note_issue_number, state: 'open', body: projection.body, labels: projection.labels }]); throw new Error('simulated create response loss'); },
    postReceipt: (request, receipt) => { receiptCalls += 1; comments.set(request.source_note_issue_number, [{ id: 700 + request.source_note_issue_number, issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${request.source_note_issue_number}`, body: renderMaterializationReceipt(receipt) }]); throw new Error('simulated receipt response loss'); },
  };
  const result = applyBatch({ planResult, packetSet: { packet_set_sha256: PACKET_SET_SHA256, packets }, transitionRequests: transitions, transitionReceipts, evidenceReceipts, progress }, options);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /real candidate manifest/);
  assert.equal(createCalls, 0);
  assert.equal(receiptCalls, 0);
});

test('v2 materialization receipts bind manifest and null repository ref', () => {
  const request = {
    schema_version: 'source-note-interview-materialization.v2', materialization_id: 'm-v2', repository: 'liqiangcc/interview-lab',
    source_note_issue_number: 158, source_note_id: 'xhs-note:625564d70000000001025e46', expected_source_note_body_sha256: 'a'.repeat(64),
    expected_boundary_status: 'single-interview', expected_source_revision_id: 'xhs-note:625564d70000000001025e46:r2',
    expected_manifest_sha256: 'b'.repeat(64), expected_source_repository_ref: null,
  };
  const projection = { body: 'source-faithful v2 projection' };
  const receipt = buildMaterializationReceipt(request, { number: 777 }, projection);
  assert.equal(receipt.manifest_sha256, request.expected_manifest_sha256);
  assert.equal(receipt.source_repository_ref, null);
  assert.equal(validateMaterializationReceipt(receipt, request, projection).ok, true);
  assert.equal(validateMaterializationReceipt({ ...receipt, manifest_sha256: 'c'.repeat(64) }, request, projection).ok, false);
  assert.equal(validateMaterializationReceipt({ ...receipt, source_repository_ref: 'd'.repeat(40) }, request, projection).ok, false);
});

test('pending journal phases remain readable for fresh reconcile and preserve intent identity', () => {
  const item = { issue_number: 158, source_note_issue_number: 158, source_note_id: 'xhs-note:625564d70000000001025e46', interview_note_id: 'xhs:625564d70000000001025e46', request_sha256: 'a'.repeat(64) };
  const progress = initialProgress([item], 'b'.repeat(64));
  progress.status = 'failed';
  progress.possibly_performed = true;
  progress.items['158'].phase = 'create-pending';
  progress.items['158'].intent = makeIntent(item, 'create-pending', { mutation_attempted: true, mutation_performed: null, possibly_performed: true });
  assert.equal(validateProgress(progress, [item], 'b'.repeat(64)).ok, true);
  progress.items['158'].phase = 'uncertain';
  progress.items['158'].intent = makeIntent(item, 'uncertain', { prior_phase: 'receipt-pending', mutation_attempted: true, mutation_performed: null, possibly_performed: true });
  assert.equal(validateProgress(progress, [item], 'b'.repeat(64)).ok, true);
});

test('apply requires a real lock API with an owner-token assertion', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1556-lock-'));
  const lock = acquireProgressLock(path.join(directory, 'progress.lock'));
  assert.doesNotThrow(() => lock.assertHeld());
  lock.release();
  assert.throws(() => lock.assertHeld(), /missing/);
  fs.rmSync(directory, { recursive: true, force: true });
});
