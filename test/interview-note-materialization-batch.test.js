'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { buildInterviewProjection } = require('../scripts/lib/source-note-interview-materialization');
const {
  materializationId,
  buildMaterializationRequest,
  dependencyGateStatus,
  planBatchMaterialization,
} = require('../scripts/lib/interview-note-materialization-batch');

const pendingBody = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');

function makeSourceIssue(status, issueNumber = 910, ids = null, externalId = 'runtime-fixture-1') {
  const parsed = parseSourceNoteIssue(pendingBody);
  const record = JSON.parse(JSON.stringify(parsed.record));
  record.boundary_review = {
    status,
    reviewed_at: status === 'pending' ? null : '2026-09-04T04:00:00Z',
    interview_note_ids: ids == null
      ? status === 'single-interview'
        ? [`${record.source.system}:${record.source.external_id}`]
        : []
      : ids,
  };
  const body = pendingBody.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(record, null, 2));
  const uniqueBody = externalId === 'runtime-fixture-1' ? body : body.replaceAll('runtime-fixture-1', externalId);
  return {
    number: issueNumber,
    state: 'open',
    body: uniqueBody,
    labels: ['type:source-note', 'source:xhs', 'status:captured', `boundary:${status}`]
      .concat(status === 'pending' ? ['task:boundary-review'] : []),
  };
}

function gate() {
  return {
    '917': { state: 'closed', acceptance: 'pass', evidence: 'https://github.com/liqiangcc/interview-lab/issues/917#issuecomment-1' },
    '920': { state: 'closed', acceptance: 'pass', evidence: 'https://github.com/liqiangcc/interview-lab/issues/920#issuecomment-2' },
    '921': { state: 'closed', acceptance: 'pass', evidence: 'https://github.com/liqiangcc/interview-lab/issues/921#issuecomment-3' },
  };
}

function existingInterviewIssue(sourceIssue, issueNumber = 915) {
  const validation = parseSourceNoteIssue(sourceIssue.body);
  const projection = buildInterviewProjection(sourceIssue, {
    ok: true,
    parsed: validation,
  });
  return {
    number: issueNumber,
    state: 'open',
    body: projection.body,
    labels: projection.labels,
  };
}

test('single SourceNote builds a source-derived request with no caller identity', () => {
  const sourceIssue = makeSourceIssue('single-interview');
  const request = buildMaterializationRequest(sourceIssue, 'liqiangcc/interview-lab');
  assert.equal(request.source_note_id, 'xhs-note:runtime-fixture-1');
  assert.equal(request.materialization_id, materializationId(parseSourceNoteIssue(sourceIssue.body).record));
  assert.equal(Object.hasOwn(request, 'interview_note_id'), false);
});

test('batch planner keeps not-interview at zero and blocks pending/multi', () => {
  const result = planBatchMaterialization({
    repository: 'liqiangcc/interview-lab',
    sourceIssues: [
      makeSourceIssue('not-interview', 910, null, 'runtime-not-interview'),
      makeSourceIssue('pending', 911, null, 'runtime-pending'),
      makeSourceIssue('multi-interview', 912, ['xhs:a', 'xhs:b'], 'runtime-multi'),
    ],
    interviewIssues: [],
    dependencyGate: gate(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.ready_for_apply, false);
  assert.equal(result.counts['skip-not-interview'], 1);
  assert.equal(result.counts.blocked, 2);
  assert.equal(result.materialization_candidates, 0);
  assert.equal(result.source_ready, 0);
});

test('not-interview with an existing InterviewNote owner fails closed without deletion', () => {
  const sourceIssue = makeSourceIssue('not-interview');
  const single = makeSourceIssue('single-interview');
  const owner = existingInterviewIssue(single);
  const result = planBatchMaterialization({
    repository: 'liqiangcc/interview-lab',
    sourceIssues: [sourceIssue],
    interviewIssues: [owner],
    dependencyGate: gate(),
  });
  assert.equal(result.counts.blocked, 1);
  assert.equal(result.results[0].reason_code, 'not-interview-has-interview-owner');
});

test('valid single case is only a materialization candidate and not source-ready', () => {
  const sourceIssue = makeSourceIssue('single-interview');
  const result = planBatchMaterialization({
    repository: 'liqiangcc/interview-lab',
    sourceIssues: [sourceIssue],
    interviewIssues: [],
    dependencyGate: gate(),
  });
  assert.equal(result.counts['would-materialize'], 1);
  assert.equal(result.results[0].source_review, 'not-started');
  assert.equal(result.source_ready, 0);
  assert.equal(result.mutation_performed, false);
});

test('duplicate SourceNote identity blocks every duplicate before materialization', () => {
  const sourceIssue = makeSourceIssue('single-interview');
  const result = planBatchMaterialization({
    repository: 'liqiangcc/interview-lab',
    sourceIssues: [sourceIssue, { ...sourceIssue, number: 911 }],
    interviewIssues: [],
    dependencyGate: gate(),
  });
  assert.equal(result.counts.blocked, 2);
  assert.equal(result.counts['would-materialize'] || 0, 0);
  assert.equal(result.results.every((item) => item.reason_code === 'duplicate-source-note-identity'), true);
});

test('existing exact owner plus receipt is idempotent in the batch plan', () => {
  const sourceIssue = makeSourceIssue('single-interview');
  const owner = existingInterviewIssue(sourceIssue);
  const request = buildMaterializationRequest(sourceIssue, 'liqiangcc/interview-lab');
  const parsed = parseSourceNoteIssue(sourceIssue.body);
  const ownerId = `${parsed.record.source.system}:${parsed.record.source.external_id}`;
  const receipt = {
    schema_version: 'source-note-interview-materialized.v1',
    materialization_id: request.materialization_id,
    request_sha256: require('../scripts/lib/source-note-interview-materialization').requestSha256(request),
    source_note_id: request.source_note_id,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    manifest_sha256: request.expected_manifest_sha256,
    source_repository_ref: request.expected_source_repository_ref,
    interview_note_id: ownerId,
    interview_issue_number: owner.number,
    comment_id: 1,
  };
  const result = planBatchMaterialization({
    repository: 'liqiangcc/interview-lab',
    sourceIssues: [sourceIssue],
    interviewIssues: [owner],
    receiptsBySourceIssue: new Map([[sourceIssue.number, [receipt]]]),
    dependencyGate: gate(),
  });
  assert.equal(result.counts['already-materialized'], 1);
  assert.equal(result.ready_for_apply, true);
});

test('dependency gate requires closed accepted issues with durable evidence', () => {
  const result = dependencyGateStatus({
    '917': { state: 'closed', acceptance: 'pass', evidence: 'evidence' },
    '920': { state: 'open', acceptance: 'pass', evidence: 'evidence' },
    '921': { state: 'closed', acceptance: 'pass', evidence: '' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
});
