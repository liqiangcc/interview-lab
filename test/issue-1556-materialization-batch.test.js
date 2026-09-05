'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
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
  const body = fixture.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(record, null, 2));
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

test('durable apply journals create-pending and reconciles both response-loss POSTs without retry', () => {
  const issue = sourceIssue();
  const transition = transitionFor(issue);
  const transitionReceipt = { issue_number: issue.number, new_body_sha256: sha256Text(issue.body) };
  const packet = {
    issue_number: issue.number,
    source_note_id: transition.source_note_id,
    artifact: {
      ref: `liqiangcc/xhs:note_desc/625564d70000000001025e46.txt@95b77bb261048059846273688e4b90a2e108b437`,
      git_blob_sha: issue.blob.sha,
      anchor: 'source projection for 625564d70000000001025e46',
    },
  };
  const request = buildMaterializationRequest(transition, transitionReceipt);
  const item = {
    issue_number: issue.number,
    source_note_issue_number: issue.number,
    source_note_id: request.source_note_id,
    interview_note_id: interviewNoteId(request.source_note_id),
    request_sha256: requestSha256(request),
  };
  const planResult = { ok: true, plan_sha256: 'b'.repeat(64), items: [item] };
  let ownerIssues = [];
  let comments = [];
  let createCalls = 0;
  let receiptCalls = 0;
  const snapshots = [];
  const progress = initialProgress([item], planResult.plan_sha256);
  const loadLive = () => ({ sourceIssue: issue, comments, allIssues: ownerIssues });
  const options = {
    expectedPlanSha256: planResult.plan_sha256,
    transitionRequests: [transition],
    transitionReceipts: [transitionReceipt],
    loadLive,
    readBlob: () => ({ sha: issue.blob.sha, encoding: 'base64', content: issue.blob.content }),
    persistProgress: (value) => snapshots.push(JSON.parse(JSON.stringify(value))),
    writeRequest: () => {},
    writeReceipt: () => {},
    beforeMutation: () => {},
    createInterviewIssue: (_request, projection) => {
      createCalls += 1;
      ownerIssues = [{ number: 300, state: 'open', body: projection.body, labels: projection.labels }];
      throw new Error('simulated create response loss');
    },
    postReceipt: (_request, receipt) => {
      receiptCalls += 1;
      comments = [{ id: 700, issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/158', body: renderMaterializationReceipt(receipt) }];
      throw new Error('simulated receipt response loss');
    },
  };
  const result = applyBatch({ planResult, packetSet: { packets: [packet] }, transitionRequests: [transition], transitionReceipts: [transitionReceipt], progress }, options);
  assert.equal(result.ok, true, result.errors && result.errors.join('; '));
  assert.equal(createCalls, 1);
  assert.equal(receiptCalls, 1);
  assert.equal(result.progress.items['158'].phase, 'complete');
  assert.equal(result.progress.possibly_performed, false);
  assert.ok(snapshots.some((value) => value.items['158'].phase === 'create-pending' && value.items['158'].intent.possibly_performed === false));
  assert.ok(snapshots.some((value) => value.items['158'].phase === 'create-pending' && value.items['158'].intent.possibly_performed === true));
  assert.equal(validateProgress(result.progress, [item], planResult.plan_sha256).ok, true);
});
