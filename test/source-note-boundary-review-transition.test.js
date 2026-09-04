'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSourceNoteIssue, parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const {
  sha256Text,
  parseSourceNoteBoundaryReviewTransition,
  validateTransitionRequest,
  planSourceNoteBoundaryReviewTransition,
  buildAppliedReceipt,
  MULTI_SCHEMA_VERSION,
} = require('../scripts/lib/source-note-boundary-review-transition');
const { childInterviewNoteId } = require('../scripts/lib/interview-note-identity');

const v2Body = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
const v1Body = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue.valid.md'), 'utf8');
const pendingLabels = ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review'];

function v2Request(overrides = {}) {
  const parsed = parseSourceNoteIssue(v2Body);
  return {
    schema_version: 'source-note-boundary-review-transition.v1',
    transition_id: 'boundary-runtime-fixture-1-review-1',
    repository: 'liqiangcc/interview-lab',
    issue_number: 910,
    source_note_id: parsed.record.source_note_id,
    expected_body_sha256: sha256Text(v2Body),
    expected_boundary_status: 'pending',
    expected_source_revision_id: parsed.record.source_revision.id,
    expected_manifest_sha256: parsed.record.source_revision.manifest_sha256,
    expected_source_repository_ref: null,
    decision: 'single-interview',
    reviewed_at: '2026-09-04T04:00:00Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 910, comment_id: 123456789 },
    checks: [
      { check_id: 'source_identity', result: 'pass', note: 'stable XHS source identity' },
      { check_id: 'source_revision_binding', result: 'pass', note: 'exact SourceRevision and manifest digest' },
      { check_id: 'source_content_coverage', result: 'pass', note: 'source projection is traceable to Raw' },
      { check_id: 'event_boundary', result: 'pass', note: 'one bounded interview case' },
      { check_id: 'no_cross_source_mixing', result: 'pass' },
      { check_id: 'no_fabrication', result: 'pass' },
    ],
    limitations: ['fixture review only'],
    ...overrides,
  };
}

function v1Request(overrides = {}) {
  const parsed = parseSourceNoteIssue(v1Body);
  return v2Request({
    transition_id: 'boundary-v1-fixture-review-1',
    issue_number: 77,
    source_note_id: parsed.record.source_note_id,
    expected_body_sha256: sha256Text(v1Body),
    expected_source_revision_id: parsed.record.source_revision.id,
    expected_manifest_sha256: null,
    expected_source_repository_ref: parsed.record.source_revision.source_repository_ref,
    decision: 'not-interview',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 77, comment_id: 987654321 },
    ...overrides,
  });
}

function multiRequest(overrides = {}) {
  const parsed = parseSourceNoteIssue(v2Body);
  const rawRef = parsed.record.artifacts.find((item) => item.provenance === 'raw_capture').ref;
  const projectionRef = parsed.record.artifacts.find((item) => item.provenance === 'source_projection').ref;
  return v2Request({
    schema_version: MULTI_SCHEMA_VERSION,
    transition_id: 'boundary-runtime-fixture-1-multi-review-1',
    decision: 'multi-interview',
    interview_cases: [
      { case_key: 'company-a-process', evidence: [{ ref: rawRef, locator: 'raw-span:company-a' }] },
      { case_key: 'company-b-process', evidence: [{ ref: projectionRef, locator: 'projection-span:company-b' }] },
    ],
    ...overrides,
  });
}

function evidenceComment(request) {
  const binding = [
    '[BOUNDARY REVIEW EVIDENCE]',
    `transition_id: ${request.transition_id}`,
    `source_note_id: ${request.source_note_id}`,
    `source_revision_id: ${request.expected_source_revision_id}`,
    `manifest_sha256: ${request.expected_manifest_sha256 || 'n/a'}`,
    `source_repository_ref: ${request.expected_source_repository_ref || 'n/a'}`,
    `recommended_decision: ${request.decision}`,
    ...(request.interview_cases || []).flatMap((item) => [
      `case_key: ${item.case_key}`,
      ...(item.evidence || []).flatMap((reference) => [`evidence_ref: ${reference.ref}`, `locator: ${reference.locator}`]),
    ]),
    ...request.checks.map((check) => `${check.check_id}: ${check.result}`),
  ];
  return { id: request.review_evidence.comment_id, body: binding.join('\n') };
}

function planV2(request = v2Request(), issueOverrides = {}, options = {}) {
  const issue = {
    number: 910,
    state: 'open',
    body: v2Body,
    labels: [...pendingLabels],
    ...issueOverrides,
  };
  return planSourceNoteBoundaryReviewTransition(request, issue, {
    evidenceComment: evidenceComment(request),
    receipts: [],
    ...options,
  });
}

test('transition marker parser returns exact request', () => {
  const request = v2Request();
  const requestComment = `<!-- source-note-boundary-review-transition\n${JSON.stringify(request, null, 2)}\n-->`;
  const parsed = parseSourceNoteBoundaryReviewTransition(requestComment);
  assert.deepEqual(parsed.request, request);
  assert.deepEqual(parsed.errors, []);
});

test('valid single-interview transition derives identity and produces valid SourceNote', () => {
  const request = v2Request();
  const result = planV2(request);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.already_applied, false);
  assert.deepEqual(result.interview_note_ids, ['xhs:runtime-fixture-1']);
  assert.equal(result.next_labels.includes('boundary:single-interview'), true);
  assert.equal(result.next_labels.includes('boundary:pending'), false);
  assert.equal(result.next_labels.includes('task:boundary-review'), false);
  const validation = validateSourceNoteIssue({ body: result.next_body, labels: result.next_labels, state: 'open' });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(validation.parsed.record.boundary_review.status, 'single-interview');
  assert.equal(validation.parsed.record.boundary_review.reviewed_at, request.reviewed_at);
  assert.deepEqual(validation.parsed.record.boundary_review.interview_note_ids, ['xhs:runtime-fixture-1']);
  assert.match(result.next_body, /状态：`single-interview`/);
});

test('not-interview transition produces zero InterviewNote identities and remains valid', () => {
  const request = v2Request({ decision: 'not-interview' });
  const result = planV2(request);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.interview_note_ids, []);
  const validation = validateSourceNoteIssue({ body: result.next_body, labels: result.next_labels, state: 'open' });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(validation.parsed.record.boundary_review.status, 'not-interview');
});

test('stale expected body digest fails closed', () => {
  const request = v2Request({ expected_body_sha256: '0'.repeat(64) });
  const result = planV2(request);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale SourceNote body/);
});

test('stale boundary label fails closed', () => {
  const result = planV2(v2Request(), { labels: ['type:source-note', 'source:xhs', 'status:captured', 'boundary:not-interview'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale boundary label/);
  assert.match(result.errors.join('\n'), /task:boundary-review/);
});

test('stale SourceRevision fails closed', () => {
  const request = v2Request({ expected_source_revision_id: 'xhs:runtime-fixture-1:r0' });
  const result = planV2(request);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale SourceRevision/);
});

test('v2 manifest mismatch fails closed', () => {
  const request = v2Request({ expected_manifest_sha256: '0'.repeat(64) });
  const result = planV2(request);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale SourceCapture manifest/);
});

test('caller cannot inject InterviewNote ids into transition request', () => {
  const request = v2Request();
  request.interview_note_ids = ['xhs:forged'];
  const validation = validateTransitionRequest(request);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /unsupported transition request field: interview_note_ids/);
});

test('required evidence check failure keeps boundary pending', () => {
  const request = v2Request();
  request.checks = request.checks.map((check) => check.check_id === 'event_boundary' ? { ...check, result: 'fail' } : check);
  const result = planV2(request);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /required boundary review check must pass: event_boundary/);
});

test('multi-interview derives stable child identities from source identity and case keys', () => {
  const request = multiRequest();
  const result = planV2(request);
  assert.equal(result.ok, true, result.errors.join('\n'));
  const parsed = parseSourceNoteIssue(v2Body);
  assert.deepEqual(result.interview_note_ids, [
    childInterviewNoteId(parsed.record.source, 'company-a-process'),
    childInterviewNoteId(parsed.record.source, 'company-b-process'),
  ]);
  assert.equal(result.next_labels.includes('boundary:multi-interview'), true);
  assert.match(result.next_body, /company-a-process/);
  const validation = validateSourceNoteIssue({ body: result.next_body, labels: result.next_labels, state: 'open' });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(validation.parsed.record.boundary_review.interview_note_cases.length, 2);
});

test('multi-interview identity is stable across display reordering and wording edits', () => {
  const request = multiRequest();
  const reordered = multiRequest({
    reviewed_at: request.reviewed_at,
    interview_cases: [...request.interview_cases].reverse(),
  });
  const first = planV2(request);
  const second = planV2(reordered);
  assert.equal(first.ok, true, first.errors.join('\n'));
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.deepEqual(second.interview_note_ids, first.interview_note_ids);
  assert.deepEqual(second.interview_note_cases, first.interview_note_cases);

  const displayEdited = multiRequest({
    reviewed_at: request.reviewed_at,
    review_evidence: { ...request.review_evidence },
  });
  displayEdited.checks = displayEdited.checks.map((check) => ({ ...check, note: `display wording changed: ${check.check_id}` }));
  const edited = planV2(displayEdited);
  assert.equal(edited.ok, true, edited.errors.join('\n'));
  assert.deepEqual(edited.interview_note_ids, first.interview_note_ids);
});

test('multi-interview rejects a locator reused by two child cases', () => {
  const request = multiRequest({
    interview_cases: [
      { case_key: 'company-a-process', evidence: [{ ref: 'source-capture:xhs:runtime-fixture-1:r1#raw/page.a11y.txt', locator: 'same-locator' }] },
      { case_key: 'company-b-process', evidence: [{ ref: 'source-capture:xhs:runtime-fixture-1:r1#raw/images/1.webp', locator: 'same-locator' }] },
    ],
  });
  const result = planV2(request);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate interview evidence locator: same-locator/);
});

test('multi-interview rejects caller-supplied child identity and Derived-only evidence', () => {
  const request = multiRequest({
    interview_cases: [
      { case_key: 'company-a-process', interview_note_id: 'xhs:forged', evidence: [{ ref: 'missing', locator: 'derived-only' }] },
      { case_key: 'company-b-process', evidence: [{ ref: 'missing', locator: 'derived-only' }] },
    ],
  });
  const result = planV2(request);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsupported interview_cases\[0\] field: interview_note_id/);
  assert.match(result.errors.join('\n'), /not an exact SourceNote artifact/);
});

test('multi-interview rejects duplicate or unstable case keys', () => {
  const request = multiRequest({
    interview_cases: [
      { case_key: 'company-a-process', evidence: [{ ref: 'source-capture:xhs:runtime-fixture-1:r1#raw/page.a11y.txt', locator: 'a' }] },
      { case_key: 'company-a-process', evidence: [{ ref: 'source-capture:xhs:runtime-fixture-1:r1#raw/page.a11y.txt', locator: 'b' }] },
    ],
  });
  const result = planV2(request);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate interview case_key/);
});

test('multi-interview transition is idempotent with exact case mapping receipt', () => {
  const request = multiRequest();
  const first = planV2(request);
  assert.equal(first.ok, true, first.errors.join('\n'));
  const receipt = buildAppliedReceipt(request, first, '2026-09-04T04:01:00Z');
  const second = planSourceNoteBoundaryReviewTransition(request, {
    number: 910, state: 'open', body: first.next_body, labels: first.next_labels,
  }, { evidenceComment: evidenceComment(request), receipts: [receipt] });
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.equal(second.already_applied, true);
  assert.deepEqual(second.interview_note_ids, first.interview_note_ids);
});

test('review evidence comment must bind transition facts and required checks', () => {
  const request = v2Request();
  const evidence = evidenceComment(request);
  evidence.body = evidence.body.replace(request.expected_source_revision_id, 'stale-revision').replace('event_boundary: pass', 'event-check-omitted');
  const result = planSourceNoteBoundaryReviewTransition(request, {
    number: 910, state: 'open', body: v2Body, labels: pendingLabels,
  }, { evidenceComment: evidence, receipts: [] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /review evidence comment must bind transition fact/);
  assert.match(result.errors.join('\n'), /review evidence comment must name required check: event_boundary/);
});

test('missing review evidence cannot be treated as an idempotent success', () => {
  const request = v2Request();
  const first = planV2(request);
  const result = planSourceNoteBoundaryReviewTransition(request, {
    number: 910, state: 'open', body: first.next_body, labels: first.next_labels,
  }, { receipts: [buildAppliedReceipt(request, first, '2026-09-04T04:01:00Z')] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /review evidence comment .* is required/);
});

test('v1 Git snapshot SourceNote remains supported for not-interview transition', () => {
  const request = v1Request();
  const result = planSourceNoteBoundaryReviewTransition(request, {
    number: 77,
    state: 'open',
    body: v1Body,
    labels: [...pendingLabels, 'migration:xhs-bulk', 'source-year:2022'],
  }, { evidenceComment: evidenceComment(request), receipts: [] });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.interview_note_ids, []);
  const validation = validateSourceNoteIssue({ body: result.next_body, labels: result.next_labels, state: 'open' });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
});

test('v1 transition remains backward compatible for a single InterviewNote', () => {
  const request = v1Request({ decision: 'single-interview' });
  const result = planSourceNoteBoundaryReviewTransition(request, {
    number: 77,
    state: 'open',
    body: v1Body,
    labels: [...pendingLabels, 'migration:xhs-bulk', 'source-year:2022'],
  }, { evidenceComment: evidenceComment(request), receipts: [] });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.interview_note_ids, ['xhs:625564d70000000001025e46']);
  assert.equal(validateSourceNoteIssue({ body: result.next_body, labels: result.next_labels, state: 'open' }).ok, true);
});

test('same existing decision is idempotent even when case display order changes', () => {
  const request = multiRequest();
  const first = planV2(request);
  assert.equal(first.ok, true, first.errors.join('\n'));
  const reordered = multiRequest({ interview_cases: [...request.interview_cases].reverse() });
  const second = planSourceNoteBoundaryReviewTransition(reordered, {
    number: 910,
    state: 'open',
    body: first.next_body,
    labels: first.next_labels,
  }, { evidenceComment: evidenceComment(reordered), receipts: [] });
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.equal(second.already_applied, true);
  assert.deepEqual(second.interview_note_ids, first.interview_note_ids);
});

test('distinct stable case keys cannot collide in child identity', () => {
  const parsed = parseSourceNoteIssue(v2Body);
  const ids = ['company-a-process', 'company-b-process'].map((key) => childInterviewNoteId(parsed.record.source, key));
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(ids[0], ids[1]);
  const presentationA = { case_key: 'company-a-process', display_label: 'Company A process' };
  const presentationB = { case_key: 'company-a-process', display_label: 'renamed display wording / reordered row' };
  assert.equal(childInterviewNoteId(parsed.record.source, presentationA.case_key), childInterviewNoteId(parsed.record.source, presentationB.case_key));
});

test('same applied transition is idempotent when target state and receipt already exist', () => {
  const request = v2Request();
  const first = planV2(request);
  assert.equal(first.ok, true, first.errors.join('\n'));
  const receipt = buildAppliedReceipt(request, first, '2026-09-04T04:01:00Z');
  const second = planSourceNoteBoundaryReviewTransition(request, {
    number: 910,
    state: 'open',
    body: first.next_body,
    labels: first.next_labels,
  }, { evidenceComment: evidenceComment(request), receipts: [receipt] });
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.equal(second.already_applied, true);
  assert.deepEqual(second.interview_note_ids, ['xhs:runtime-fixture-1']);
});
