'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { validateInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');
const {
  sha256Text: boundarySha256,
  planSourceNoteBoundaryReviewTransition,
} = require('../scripts/lib/source-note-boundary-review-transition');
const {
  sha256Text,
  requestSha256,
  parseMaterializationRequest,
  validateRequest,
  planMaterialization,
} = require('../scripts/lib/source-note-interview-materialization');

const pendingBody = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
const pendingLabels = ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review'];

function makeSingleSourceIssue() {
  const parsed = parseSourceNoteIssue(pendingBody);
  const reviewRequest = {
    schema_version: 'source-note-boundary-review-transition.v1',
    transition_id: 'fixture-boundary-review-1',
    repository: 'liqiangcc/interview-lab',
    issue_number: 910,
    source_note_id: parsed.record.source_note_id,
    expected_body_sha256: boundarySha256(pendingBody),
    expected_boundary_status: 'pending',
    expected_source_revision_id: parsed.record.source_revision.id,
    expected_manifest_sha256: parsed.record.source_revision.manifest_sha256,
    expected_source_repository_ref: null,
    decision: 'single-interview',
    reviewed_at: '2026-09-04T04:00:00Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 910, comment_id: 123456789 },
    checks: [
      { check_id: 'source_identity', result: 'pass' },
      { check_id: 'source_revision_binding', result: 'pass' },
      { check_id: 'source_content_coverage', result: 'pass' },
      { check_id: 'event_boundary', result: 'pass' },
      { check_id: 'no_cross_source_mixing', result: 'pass' },
      { check_id: 'no_fabrication', result: 'pass' },
    ],
    limitations: ['fixture only'],
  };
  const evidenceBody = [
    reviewRequest.transition_id,
    reviewRequest.source_note_id,
    reviewRequest.expected_source_revision_id,
    reviewRequest.expected_manifest_sha256,
    reviewRequest.decision,
    ...reviewRequest.checks.map((check) => check.check_id),
  ].join('\n');
  const planned = planSourceNoteBoundaryReviewTransition(reviewRequest, {
    number: 910,
    state: 'open',
    body: pendingBody,
    labels: pendingLabels,
  }, {
    evidenceComment: { id: 123456789, body: evidenceBody },
    receipts: [],
  });
  assert.equal(planned.ok, true, planned.errors.join('\n'));
  return {
    number: 910,
    state: 'open',
    body: planned.next_body,
    labels: planned.next_labels,
  };
}

function makeRequest(sourceIssue, overrides = {}) {
  const parsed = parseSourceNoteIssue(sourceIssue.body);
  return {
    schema_version: 'source-note-interview-materialization.v1',
    materialization_id: 'fixture-materialization-1',
    repository: 'liqiangcc/interview-lab',
    source_note_issue_number: 910,
    source_note_id: parsed.record.source_note_id,
    expected_source_note_body_sha256: sha256Text(sourceIssue.body),
    expected_boundary_status: 'single-interview',
    expected_source_revision_id: parsed.record.source_revision.id,
    expected_manifest_sha256: parsed.record.source_revision.manifest_sha256,
    expected_source_repository_ref: null,
    ...overrides,
  };
}

function plan(request, sourceIssue, issues = [], receipts = []) {
  return planMaterialization(request, {
    repository: 'liqiangcc/interview-lab',
    sourceIssue,
    issues,
    receipts,
  });
}

function existingIssueFrom(planResult, number = 920) {
  return {
    number,
    state: 'open',
    body: planResult.projection.body,
    labels: planResult.projection.labels.map((name) => ({ name })),
  };
}

function receiptFor(request, planResult, issueNumber = 920) {
  return {
    schema_version: 'source-note-interview-materialized.v1',
    materialization_id: request.materialization_id,
    request_sha256: requestSha256(request),
    source_note_id: request.source_note_id,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    manifest_sha256: request.expected_manifest_sha256,
    source_repository_ref: request.expected_source_repository_ref,
    interview_note_id: planResult.interview_note_id,
    interview_issue_number: issueNumber,
    comment_id: 555,
  };
}

test('request marker parser returns exact request', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue);
  const body = `<!-- source-note-interview-materialization\n${JSON.stringify(request, null, 2)}\n-->`;
  const parsed = parseMaterializationRequest(body);
  assert.deepEqual(parsed.request, request);
  assert.deepEqual(parsed.errors, []);
});

test('valid single-interview SourceNote plans exactly one InterviewNote create', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue);
  const result = plan(request, sourceIssue);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.action, 'create');
  assert.equal(result.ownership_count, 0);
  assert.equal(result.interview_note_id, 'xhs:runtime-fixture-1');
  assert.equal(result.projection.title, '[XHS] runtime-');
  assert.deepEqual(result.projection.labels, ['type:interview-note', 'source:xhs', 'status:captured']);
  assert.equal(result.projection.record.interview_occurred_at.precision, 'unknown');
  assert.equal(result.projection.record.interview_occurred_at.value, null);
  assert.equal(result.projection.record.artifacts.some((item) => item.kind === 'other'), true);
  const validation = validateInterviewNoteIssue({ body: result.projection.body, labels: result.projection.labels, state: 'open' });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.match(result.projection.body, /SourceNote：#910/);
  assert.doesNotMatch(result.projection.title, /携程|美团|offer|面经/i);
});

test('caller cannot inject InterviewNote identity', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue);
  request.interview_note_id = 'xhs:forged';
  const result = validateRequest(request);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsupported request field: interview_note_id/);
});

test('stale SourceNote body digest fails closed', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue, { expected_source_note_body_sha256: '0'.repeat(64) });
  const result = plan(request, sourceIssue);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale SourceNote body digest/);
});

test('pending boundary fails closed even with matching body digest', () => {
  const pendingIssue = { number: 910, state: 'open', body: pendingBody, labels: pendingLabels };
  const parsed = parseSourceNoteIssue(pendingBody);
  const request = {
    schema_version: 'source-note-interview-materialization.v1',
    materialization_id: 'fixture-pending',
    repository: 'liqiangcc/interview-lab',
    source_note_issue_number: 910,
    source_note_id: parsed.record.source_note_id,
    expected_source_note_body_sha256: sha256Text(pendingBody),
    expected_boundary_status: 'single-interview',
    expected_source_revision_id: parsed.record.source_revision.id,
    expected_manifest_sha256: parsed.record.source_revision.manifest_sha256,
    expected_source_repository_ref: null,
  };
  const result = plan(request, pendingIssue);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /boundary must remain single-interview/);
});

test('stale SourceRevision and manifest fail closed', () => {
  const sourceIssue = makeSingleSourceIssue();
  let result = plan(makeRequest(sourceIssue, { expected_source_revision_id: 'xhs:stale:r0' }), sourceIssue);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale SourceRevision id/);
  result = plan(makeRequest(sourceIssue, { expected_manifest_sha256: '0'.repeat(64) }), sourceIssue);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale SourceCapture manifest SHA/);
});

test('declared boundary identity must equal source-derived InterviewNote identity', () => {
  const sourceIssue = makeSingleSourceIssue();
  const parsed = parseSourceNoteIssue(sourceIssue.body);
  const mutated = JSON.parse(JSON.stringify(parsed.record));
  mutated.boundary_review.interview_note_ids = ['xhs:forged'];
  const mutatedBody = sourceIssue.body.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(mutated, null, 2));
  const mutatedIssue = { ...sourceIssue, body: mutatedBody };
  const request = makeRequest(mutatedIssue);
  const result = plan(request, mutatedIssue);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /declared InterviewNote id must equal source-derived identity/);
});

test('one exact existing owner is idempotent candidate and requests receipt repair', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue);
  const first = plan(request, sourceIssue);
  const existing = existingIssueFrom(first, 920);
  const second = plan(request, sourceIssue, [existing]);
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.equal(second.action, 'existing');
  assert.equal(second.existing_issue_number, 920);
  assert.equal(second.needs_receipt_repair, true);
  assert.equal(second.already_materialized, false);
});

test('one exact existing owner plus matching receipt is fully idempotent', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue);
  const first = plan(request, sourceIssue);
  const existing = existingIssueFrom(first, 920);
  const receipt = receiptFor(request, first, 920);
  const second = plan(request, sourceIssue, [existing], [receipt]);
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.equal(second.already_materialized, true);
  assert.equal(second.needs_receipt_repair, false);
});

test('existing owner with conflicting SourceRevision fails closed', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue);
  const first = plan(request, sourceIssue);
  const existing = existingIssueFrom(first, 920);
  const parsed = require('../scripts/lib/interview-note-issue').parseInterviewNoteIssue(existing.body);
  const mutated = JSON.parse(JSON.stringify(parsed.record));
  mutated.source_revision.id = 'xhs:other:r9';
  existing.body = existing.body.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(mutated, null, 2));
  const result = plan(request, sourceIssue, [existing]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /existing InterviewNote SourceRevision mismatch/);
});

test('multiple primary owners for one identity fail closed', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue);
  const first = plan(request, sourceIssue);
  const a = existingIssueFrom(first, 920);
  const b = existingIssueFrom(first, 921);
  const result = plan(request, sourceIssue, [a, b]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate ownership conflict: 2/);
});

test('receipt without any existing owner fails closed', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue);
  const first = plan(request, sourceIssue);
  const receipt = receiptFor(request, first, 920);
  const result = plan(request, sourceIssue, [], [receipt]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /receipt exists but no InterviewNote owner exists/);
});

test('receipt pointing to another owner fails closed', () => {
  const sourceIssue = makeSingleSourceIssue();
  const request = makeRequest(sourceIssue);
  const first = plan(request, sourceIssue);
  const existing = existingIssueFrom(first, 920);
  const receipt = receiptFor(request, first, 999);
  const result = plan(request, sourceIssue, [existing], [receipt]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /receipt points to a different InterviewNote Issue/);
});
