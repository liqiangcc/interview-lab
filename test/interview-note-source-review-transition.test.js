'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { validateInterviewNoteIssue, parseInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');
const { buildInterviewProjection } = require('../scripts/lib/source-note-interview-materialization');
const {
  sha256Text,
  parseRequest,
  validateRequest,
  buildReceipt,
  planSourceReview,
} = require('../scripts/lib/interview-note-source-review-transition');

const baseBody = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
const CHECK_IDS = [
  'source_identity','source_revision_binding','artifact_reference_integrity','raw_projection_traceability',
  'known_limitations_recorded','duplicate_ownership','no_fabrication',
];

function replaceRecord(body, oldRecord, newRecord) {
  return body.replace(JSON.stringify(oldRecord, null, 2), JSON.stringify(newRecord, null, 2));
}
function makeSourceIssue(overrides = {}) {
  const parsed = parseSourceNoteIssue(baseBody);
  const old = parsed.record;
  const record = JSON.parse(JSON.stringify(old));
  const interviewId = `${record.source.system}:${record.source.external_id}`;
  const rawRef = `source-capture:${interviewId}:r1#raw/page.html`;
  const projectionRef = `source-capture:${interviewId}:r1#projection/readable.txt`;
  record.boundary_review = { status: 'single-interview', reviewed_at: '2026-09-04T05:00:00Z', interview_note_ids: [interviewId] };
  record.artifacts = [
    {
      kind: 'html', ref: rawRef, git_blob_sha: null, sha256: '1'.repeat(64), provenance: 'raw_capture',
      byte_size: 100, integrity: 'present', content_type: 'text/html',
    },
    {
      kind: 'text_projection', ref: projectionRef, git_blob_sha: null, sha256: '2'.repeat(64), provenance: 'source_projection',
      byte_size: 50, integrity: 'present', content_type: 'text/plain', derived_from: [rawRef],
    },
  ];
  if (overrides.record) overrides.record(record);
  const body = replaceRecord(baseBody, old, record);
  const labels = ['type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview'];
  const issue = { number: 910, state: 'open', body, labels, ...(overrides.issue || {}) };
  const validation = validateSourceNoteIssue({ body: issue.body, labels: issue.labels, state: issue.state });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  return { issue, validation };
}
function makeScenario(options = {}) {
  const source = makeSourceIssue(options.source || {});
  const projection = buildInterviewProjection(source.issue, source.validation);
  const interviewIssue = {
    number: 915, state: 'open', title: projection.title, body: projection.body, labels: [...projection.labels],
  };
  if (options.interviewBody) interviewIssue.body = options.interviewBody(interviewIssue.body);
  if (options.interviewLabels) interviewIssue.labels = options.interviewLabels(interviewIssue.labels);
  const sourceRecord = source.validation.parsed.record;
  const request = {
    schema_version: 'interview-note-source-review-transition.v1',
    transition_id: 'runtime-fixture-source-review-1',
    repository: 'liqiangcc/interview-lab',
    issue_number: 915,
    interview_note_id: `${sourceRecord.source.system}:${sourceRecord.source.external_id}`,
    expected_interview_body_sha256: sha256Text(interviewIssue.body),
    expected_initial_status: 'captured',
    expected_source_revision_id: sourceRecord.source_revision.id,
    source_note_issue_number: 910,
    expected_source_note_body_sha256: sha256Text(source.issue.body),
    expected_manifest_sha256: sourceRecord.source_revision.manifest_sha256,
    decision: 'source-ready',
    reviewed_at: '2026-09-04T05:05:00Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 915, comment_id: 123456789 },
    checks: CHECK_IDS.map((check_id) => ({ check_id, result: 'pass' })),
    limitations: ['fixture only'],
    ...(options.request || {}),
  };
  const evidenceComment = {
    id: request.review_evidence.comment_id,
    body: [
      '[SOURCE REVIEW EVIDENCE]', request.transition_id, request.interview_note_id,
      String(request.source_note_issue_number), request.expected_source_revision_id,
      request.expected_manifest_sha256, request.decision,
      ...request.checks.map((c) => `${c.check_id}: ${c.result}`),
    ].join('\n'),
  };
  const allIssues = options.allIssues || [interviewIssue];
  return { sourceIssue: source.issue, interviewIssue, request, evidenceComment, allIssues };
}
function plan(scenario, receipts = []) {
  return planSourceReview(scenario.request, scenario.interviewIssue, {
    sourceIssue: scenario.sourceIssue,
    allIssues: scenario.allIssues,
    evidenceComment: scenario.evidenceComment,
    receipts,
  });
}

test('request marker parser returns exact request', () => {
  const s = makeScenario();
  const body = `<!-- interview-note-source-review-transition\n${JSON.stringify(s.request, null, 2)}\n-->`;
  const parsed = parseRequest(body);
  assert.deepEqual(parsed.request, s.request);
  assert.deepEqual(parsed.errors, []);
});

test('valid captured InterviewNote plans explicit source-review then source-ready', () => {
  const s = makeScenario();
  const result = plan(s);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.current_status, 'captured');
  assert.equal(result.needs_begin, true);
  assert.equal(result.begin_labels.includes('status:source-review'), true);
  assert.equal(result.begin_labels.includes('task:source-review'), true);
  assert.equal(result.final_labels.includes('status:source-ready'), true);
  assert.equal(result.final_labels.includes('task:source-review'), false);
  assert.equal(result.computed_checks.every((c) => c.result === 'pass'), true);
});

test('source-review state is resumable with the same request', () => {
  const s = makeScenario({ interviewLabels: (labels) => labels.filter((x) => !x.startsWith('status:')).concat(['status:source-review','task:source-review']) });
  const result = plan(s);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.resumable_review, true);
  assert.equal(result.needs_begin, false);
});

test('stale InterviewNote body digest fails closed', () => {
  const s = makeScenario();
  s.request.expected_interview_body_sha256 = '0'.repeat(64);
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale InterviewNote body digest/);
});

test('unsupported lifecycle state fails closed', () => {
  const s = makeScenario({ interviewLabels: (labels) => labels.filter((x) => !x.startsWith('status:')).concat(['status:discovered']) });
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsupported current lifecycle status/);
});

test('stale SourceNote body, revision, or manifest fails closed', () => {
  for (const mutate of [
    (r) => { r.expected_source_note_body_sha256 = '0'.repeat(64); },
    (r) => { r.expected_source_revision_id = 'xhs:stale:r0'; },
    (r) => { r.expected_manifest_sha256 = '0'.repeat(64); },
  ]) {
    const s = makeScenario(); mutate(s.request);
    const result = plan(s);
    assert.equal(result.ok, false);
  }
});

test('artifact hash/provenance mismatch blocks source-ready', () => {
  const s = makeScenario({ interviewBody: (body) => body.replace('1'.repeat(64), '3'.repeat(64)) });
  s.request.expected_interview_body_sha256 = sha256Text(s.interviewIssue.body);
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /artifact_reference_integrity|source-ready requires/);
});

test('missing Raw projection traceability blocks source-ready', () => {
  const s = makeScenario({ source: { record: (record) => { delete record.artifacts[1].derived_from; } } });
  s.request.expected_source_note_body_sha256 = sha256Text(s.sourceIssue.body);
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /raw_projection_traceability|source-ready requires/);
});

test('dropped Source limitation blocks source-ready', () => {
  const s = makeScenario({ interviewBody: (body) => {
    const parsed = parseInterviewNoteIssue(body);
    const record = JSON.parse(JSON.stringify(parsed.record));
    record.limitations = [];
    return body.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(record, null, 2));
  }});
  s.request.expected_interview_body_sha256 = sha256Text(s.interviewIssue.body);
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /known_limitations_recorded|source-ready requires/);
});

test('duplicate InterviewNote ownership blocks source-ready', () => {
  const s = makeScenario();
  s.allIssues = [s.interviewIssue, { ...s.interviewIssue, number: 999 }];
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate_ownership|source-ready requires/);
});

test('fabricated interview time blocks source-ready', () => {
  const s = makeScenario({ interviewBody: (body) => {
    const parsed = parseInterviewNoteIssue(body);
    const record = JSON.parse(JSON.stringify(parsed.record));
    record.interview_occurred_at = { precision: 'exact', value: '2026-01-01' };
    return body.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(record, null, 2));
  }});
  s.request.expected_interview_body_sha256 = sha256Text(s.interviewIssue.body);
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /no_fabrication|source-ready requires/);
});

test('caller cannot lie about machine-computed check result', () => {
  const s = makeScenario();
  s.request.checks = s.request.checks.map((c) => c.check_id === 'source_identity' ? { ...c, result: 'fail' } : c);
  s.evidenceComment.body = s.evidenceComment.body.replace('source_identity: pass', 'source_identity: fail');
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /requested check result does not match machine evidence/);
});

test('blocked decision is valid only when at least one machine check fails', () => {
  const s = makeScenario({ interviewBody: (body) => body.replace('1'.repeat(64), '3'.repeat(64)), request: { decision: 'blocked' } });
  s.request.expected_interview_body_sha256 = sha256Text(s.interviewIssue.body);
  s.request.checks = s.request.checks.map((c) => c.check_id === 'artifact_reference_integrity' ? { ...c, result: 'fail' } : c);
  s.evidenceComment.body = [
    '[SOURCE REVIEW EVIDENCE]', s.request.transition_id, s.request.interview_note_id, '910',
    s.request.expected_source_revision_id, s.request.expected_manifest_sha256, 'blocked',
    ...s.request.checks.map((c) => `${c.check_id}: ${c.result}`),
  ].join('\n');
  const result = plan(s);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.final_labels.includes('status:blocked'), true);
  assert.equal(result.final_labels.includes('task:source-recovery'), true);
});

test('blocked with all checks passing is rejected', () => {
  const s = makeScenario({ request: { decision: 'blocked' } });
  s.evidenceComment.body = s.evidenceComment.body.replace('source-ready', 'blocked');
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /blocked requires at least one failed/);
});

test('final source-ready without receipt requests receipt repair', () => {
  const s = makeScenario({ interviewLabels: (labels) => labels.filter((x) => !x.startsWith('status:')).concat(['status:source-ready']) });
  const result = plan(s);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.needs_receipt_repair, true);
  assert.equal(result.already_applied, false);
});

test('final source-ready with matching receipt is idempotent', () => {
  const s = makeScenario({ interviewLabels: (labels) => labels.filter((x) => !x.startsWith('status:')).concat(['status:source-ready']) });
  const receipt = buildReceipt(s.request, 'source-ready', '2026-09-04T05:06:00Z');
  const result = plan(s, [receipt]);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.already_applied, true);
  assert.equal(result.needs_receipt_repair, false);
});

test('request rejects injected unsupported fields', () => {
  const s = makeScenario();
  s.request.next_status = 'source-ready';
  const result = validateRequest(s.request);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsupported transition request field/);
});
