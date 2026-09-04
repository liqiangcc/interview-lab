'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const {
  MULTI_SCHEMA_VERSION,
  planSourceNoteBoundaryReviewTransition,
  sha256Text,
  buildAppliedReceipt,
} = require('../scripts/lib/source-note-boundary-review-transition');
const {
  BATCH_SCHEMA_VERSION,
  GATE_SCHEMA_VERSION,
  planBoundaryReviewBatch,
  validateBatchManifest,
  validateDependencyGate,
} = require('../scripts/lib/source-note-boundary-review-batch');

const body = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
const source = parseSourceNoteIssue(body).record;
const labels = ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review'];

function request(issueNumber, overrides = {}) {
  return {
    schema_version: 'source-note-boundary-review-transition.v1',
    transition_id: `batch-fixture-${issueNumber}`,
    repository: 'liqiangcc/interview-lab',
    issue_number: issueNumber,
    source_note_id: source.source_note_id,
    expected_body_sha256: sha256Text(body),
    expected_boundary_status: 'pending',
    expected_source_revision_id: source.source_revision.id,
    expected_manifest_sha256: source.source_revision.manifest_sha256,
    expected_source_repository_ref: null,
    decision: 'single-interview',
    reviewed_at: '2026-09-04T04:00:00Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: issueNumber, comment_id: 800000000 + issueNumber },
    checks: [
      { check_id: 'source_identity', result: 'pass' },
      { check_id: 'source_revision_binding', result: 'pass' },
      { check_id: 'source_content_coverage', result: 'pass' },
      { check_id: 'event_boundary', result: 'pass' },
      { check_id: 'no_cross_source_mixing', result: 'pass' },
      { check_id: 'no_fabrication', result: 'pass' },
    ],
    limitations: ['batch fixture'],
    ...overrides,
  };
}

function evidence(requestValue) {
  return {
    id: requestValue.review_evidence.comment_id,
    body: [
      requestValue.transition_id,
      requestValue.source_note_id,
      requestValue.expected_source_revision_id,
      requestValue.expected_manifest_sha256,
      requestValue.decision,
      ...(requestValue.interview_cases || []).flatMap((item) => [
        item.case_key,
        ...(item.evidence || []).flatMap((reference) => [reference.ref, reference.locator]),
      ]),
      ...requestValue.checks.map((item) => item.check_id),
    ].join('\n'),
  };
}

function manifest(items) {
  return { schema_version: BATCH_SCHEMA_VERSION, repository: 'liqiangcc/interview-lab', items };
}

test('batch manifest rejects duplicate Issues before any live planning', () => {
  const result = validateBatchManifest(manifest([
    { issue_number: 910, request_file: 'a.md' },
    { issue_number: 910, request_file: 'b.md' },
  ]));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate batch issue_number/);
});

test('batch dry-run is all-or-nothing and reports blocked items without mutation', () => {
  const first = request(910);
  const second = request(911, { expected_body_sha256: '0'.repeat(64) });
  const result = planBoundaryReviewBatch(manifest([
    { issue_number: 910, request_file: 'a.md', transition_id: first.transition_id },
    { issue_number: 911, request_file: 'b.md', transition_id: second.transition_id },
  ]), [
    { request: first, issue: { number: 910, state: 'open', body, labels }, evidenceComment: evidence(first) },
    { request: second, issue: { number: 911, state: 'open', body, labels }, evidenceComment: evidence(second) },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.report.counts.ready, 1);
  assert.equal(result.report.counts.blocked, 1);
  assert.equal(result.report.items[0].status, 'ready');
  assert.equal(result.report.items[1].status, 'blocked');
  assert.match(result.report.blocked[0].errors.join('\n'), /stale SourceNote body/);
  assert.match(result.report.dry_run_sha256, /^[0-9a-f]{64}$/);
});

test('batch accepts multi-interview and resumes an already-applied item idempotently', () => {
  const rawRef = source.artifacts.find((item) => item.provenance === 'raw_capture').ref;
  const multi = request(910, {
    schema_version: MULTI_SCHEMA_VERSION,
    transition_id: 'batch-multi-fixture',
    decision: 'multi-interview',
    interview_cases: [
      { case_key: 'process-a', evidence: [{ ref: rawRef, locator: 'raw-span:a' }] },
      { case_key: 'process-b', evidence: [{ ref: rawRef, locator: 'raw-span:b' }] },
    ],
  });
  const first = planSourceNoteBoundaryReviewTransition(multi, {
    number: 910, state: 'open', body, labels,
  }, { evidenceComment: evidence(multi), receipts: [] });
  assert.equal(first.ok, true, first.errors.join('\n'));
  const receipt = buildAppliedReceipt(multi, first, '2026-09-04T04:01:00Z');
  const result = planBoundaryReviewBatch(manifest([
    { issue_number: 910, request_file: 'multi.md', transition_id: multi.transition_id },
  ]), [{
    request: multi,
    issue: { number: 910, state: 'open', body: first.next_body, labels: first.next_labels },
    evidenceComment: evidence(multi),
    receipts: [receipt],
  }]);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.report.counts.already_applied, 1);
  assert.deepEqual(result.report.items[0].interview_note_ids, first.interview_note_ids);
});

test('dependency gate stays closed until both predecessor acceptances are proven live', () => {
  const gate = {
    schema_version: GATE_SCHEMA_VERSION,
    parent_issue: 919,
    dependencies: [
      { issue_number: 917, acceptance: 'pass', evidence_url: 'https://github.com/liqiangcc/interview-lab/issues/917#issuecomment-1' },
      { issue_number: 920, acceptance: 'pass', evidence_url: 'https://github.com/liqiangcc/interview-lab/issues/920#issuecomment-2' },
    ],
  };
  const result = validateDependencyGate(gate, [{ number: 917, state: 'open' }, { number: 920, state: 'open' }]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /dependency #917 is not closed/);
  assert.match(result.errors.join('\n'), /dependency #920 is not closed/);
});
