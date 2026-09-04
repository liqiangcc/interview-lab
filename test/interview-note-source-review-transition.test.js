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
  evidenceSubjectSha256,
  computeChecks,
  parseRequest,
  parseReceipts,
  validateRequest,
  validateReceipt,
  buildReceipt,
  planSourceReview,
  RECOVERY_MODES,
} = require('../scripts/lib/interview-note-source-review-transition');
const { buildManifest: buildPinnedArtifactManifest } = require('../scripts/lib/issue-1539-pinned-artifact-manifest');

const baseBody = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
const pinnedBaseBody = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue.valid.md'), 'utf8');
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
    repository_url: 'https://api.github.com/repos/liqiangcc/interview-lab',
    issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/915',
    html_url: 'https://github.com/liqiangcc/interview-lab/issues/915#issuecomment-123456789',
    body: [
      '[SOURCE REVIEW EVIDENCE]', request.transition_id, request.interview_note_id,
      String(request.source_note_issue_number), request.expected_source_revision_id,
      request.expected_manifest_sha256, request.decision,
      ...request.checks.map((c) => `${c.check_id}: ${c.result}`),
    ].join('\n'),
  };
  const allIssues = options.allIssues || [interviewIssue];
  if (request.recovery_mode && !request.evidence_subject_sha256) {
    request.evidence_subject_sha256 = evidenceSubjectSha256(request, computeChecks(request, interviewIssue, source.issue, allIssues));
    evidenceComment.body += `\n${request.evidence_subject_sha256}`;
  }
  return { sourceIssue: source.issue, interviewIssue, request, evidenceComment, allIssues };
}
function plan(scenario, receipts = []) {
  return planSourceReview(scenario.request, scenario.interviewIssue, {
    sourceIssue: scenario.sourceIssue,
    allIssues: scenario.allIssues,
    evidenceComment: scenario.evidenceComment,
    pinnedArtifactManifest: scenario.pinnedArtifactManifest,
    receipts,
  });
}

function makePinnedRecoveryScenario(status = 'blocked') {
  const parsed = parseSourceNoteIssue(pinnedBaseBody);
  const oldRecord = parsed.record;
  const sourceRecord = JSON.parse(JSON.stringify(oldRecord));
  const interviewId = `${sourceRecord.source.system}:${sourceRecord.source.external_id}`;
  sourceRecord.boundary_review = { status: 'single-interview', reviewed_at: '2026-09-05T00:00:00Z', interview_note_ids: [interviewId] };
  sourceRecord.artifacts.push({
    kind: 'text_projection',
    ref: `liqiangcc/xhs:note_desc/${sourceRecord.source.external_id}.txt@${sourceRecord.source_revision.source_repository_ref}`,
    git_blob_sha: 'a'.repeat(40), sha256: null, provenance: 'source_projection', byte_size: 100, integrity: 'present',
  });
  const sourceBody = replaceRecord(pinnedBaseBody, oldRecord, sourceRecord);
  const sourceIssue = { number: 910, state: 'open', body: sourceBody, labels: ['type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview', 'source-year:2022'] };
  const sourceValidation = validateSourceNoteIssue({ body: sourceBody, labels: sourceIssue.labels, state: sourceIssue.state });
  assert.equal(sourceValidation.ok, true, sourceValidation.errors.join('\n'));
  const projection = buildInterviewProjection(sourceIssue, sourceValidation);
  const interviewIssue = { number: 915, state: 'open', body: projection.body, labels: projection.labels.filter((label) => !label.startsWith('status:')).concat([`status:${status}`, ...(status === 'blocked' ? ['task:source-recovery'] : status === 'source-review' ? ['task:source-review'] : [])]) };
  const treeEntries = sourceRecord.artifacts.map((artifact) => {
    const match = artifact.ref.match(/^([^:]+):(.+)@([0-9a-f]{40})$/);
    return { type: 'blob', path: match[2], sha: artifact.git_blob_sha };
  });
  const entries = Array.from({ length: 30 }, (_, index) => ({
    interview_issue_number: index === 0 ? 915 : 2000 + index,
    source_note_issue_number: index === 0 ? 910 : 3000 + index,
    source_note_id: sourceRecord.source_note_id,
    source_revision_id: sourceRecord.source_revision.id,
    artifacts: sourceRecord.artifacts,
  }));
  const pinnedArtifactManifest = buildPinnedArtifactManifest({
    repository: 'liqiangcc/interview-lab',
    sourceSnapshot: { repository: sourceRecord.source_revision.source_repository, ref: sourceRecord.source_revision.source_repository_ref },
    entries, treeEntries, treeSha: 'e'.repeat(40),
  });
  const request = {
    schema_version: 'interview-note-source-review-transition.v1',
    transition_id: 'blocked-recovery-test-915', repository: 'liqiangcc/interview-lab', issue_number: 915,
    interview_note_id: interviewId, expected_interview_body_sha256: sha256Text(interviewIssue.body),
    expected_initial_status: 'blocked', expected_source_revision_id: sourceRecord.source_revision.id,
    source_note_issue_number: 910, expected_source_note_body_sha256: sha256Text(sourceBody),
    expected_source_repository_ref: sourceRecord.source_revision.source_repository_ref,
    recovery_mode: RECOVERY_MODES.BLOCKED_SOURCE_RECOVERY,
    provenance_mode: 'pinned-source-artifact', provenance_statement: 'pinned-source-artifact; raw-lineage-unproven',
    pinned_artifact_manifest_sha256: pinnedArtifactManifest.digest, decision: 'source-ready',
    reviewed_at: '2026-09-05T00:05:00Z', reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 915, comment_id: 12345 },
    limitations: sourceRecord.limitations,
  };
  const allIssues = [interviewIssue];
  request.checks = computeChecks(request, interviewIssue, sourceIssue, allIssues);
  request.evidence_subject_sha256 = evidenceSubjectSha256(request, request.checks);
  const evidenceComment = {
    id: 12345,
    repository_url: 'https://api.github.com/repos/liqiangcc/interview-lab',
    issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/915',
    html_url: 'https://github.com/liqiangcc/interview-lab/issues/915#issuecomment-12345',
    body: [request.transition_id, request.interview_note_id, request.expected_source_revision_id,
      String(request.source_note_issue_number), request.expected_source_repository_ref, request.provenance_mode,
      request.provenance_statement, request.pinned_artifact_manifest_sha256, request.decision, request.evidence_subject_sha256,
      ...request.checks.map((check) => `${check.check_id}: ${check.result}`)].join('\n'),
  };
  return { sourceIssue, interviewIssue, request, evidenceComment, allIssues, pinnedArtifactManifest };
}

test('evidence subject digest is deterministic and excludes comment locator/review timestamp', () => {
  const request = {
    schema_version: 'interview-note-source-review-transition.v1',
    transition_id: 'subject-1', repository: 'liqiangcc/interview-lab', issue_number: 915,
    interview_note_id: 'xhs:1', expected_initial_status: 'captured',
    expected_interview_body_sha256: 'a'.repeat(64), expected_source_revision_id: 'revision-1',
    source_note_issue_number: 30, expected_source_note_body_sha256: 'b'.repeat(64),
    expected_source_repository_ref: 'c'.repeat(40), decision: 'source-ready',
    provenance_mode: 'raw-lineage', pinned_artifact_manifest_sha256: 'd'.repeat(64),
    reviewed_at: '2026-09-05T00:00:00Z', review_evidence: { comment_id: 123 },
  };
  const checks = [{ check_id: 'source_identity', result: 'pass' }, { check_id: 'raw_projection_traceability', result: 'fail' }];
  const digest = evidenceSubjectSha256(request, checks);
  assert.equal(digest, evidenceSubjectSha256({ ...request, reviewed_at: '2026-09-06T00:00:00Z', review_evidence: { comment_id: 999 } }, checks));
  assert.notEqual(digest, evidenceSubjectSha256({ ...request, expected_source_note_body_sha256: 'e'.repeat(64) }, checks));
  assert.notEqual(digest, evidenceSubjectSha256(request, [...checks, { check_id: 'no_fabrication', result: 'pass' }]));
  assert.equal(digest, evidenceSubjectSha256({ ...request, checks: [{ result: 'fail', check_id: 'raw_projection_traceability' }, { result: 'pass', check_id: 'source_identity' }] }, checks));
});

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

test('review evidence locator must match the request repository and Issue', () => {
  for (const mutate of [
    (request) => { request.review_evidence.repository = 'other/repo'; },
    (request) => { request.review_evidence.issue_number = 916; },
  ]) {
    const s = makeScenario();
    mutate(s.request);
    const result = plan(s);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /review_evidence\.(repository|issue_number) must equal/);
  }
});

test('review evidence comment must belong to the requested repository and Issue', () => {
  for (const mutate of [
    (comment) => { comment.repository_url = 'https://api.github.com/repos/other/repo'; },
    (comment) => { comment.issue_url = 'https://api.github.com/repos/liqiangcc/interview-lab/issues/916'; },
  ]) {
    const s = makeScenario();
    mutate(s.evidenceComment);
    const result = plan(s);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /review evidence comment (repository|Issue) locator mismatch/);
  }
});

test('GitHub Issue Comment may omit repository_url when issue_url is exact', () => {
  const s = makeScenario();
  delete s.evidenceComment.repository_url;
  const result = plan(s);
  assert.equal(result.ok, true, result.errors.join('\n'));
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

test('stale live blocked status rejects an ordinary captured transition', () => {
  const s = makeScenario({ interviewLabels: (labels) => labels.filter((x) => !x.startsWith('status:')).concat(['status:blocked', 'task:source-recovery']) });
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /live currentStatus blocked does not match expected_initial_status captured/);
});

test('blocked recovery requires an explicit restricted mode and cannot be smuggled as ordinary transition', () => {
  const s = makeScenario({ interviewLabels: (labels) => labels.filter((x) => !x.startsWith('status:')).concat(['status:blocked', 'task:source-recovery']) });
  s.request.expected_initial_status = 'blocked';
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /blocked expected_initial_status requires explicit blocked-source-recovery/);
});

test('blocked recovery begin uses the exact blocked CAS and enters source-review', () => {
  const s = makePinnedRecoveryScenario('blocked');
  const result = plan(s);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.current_status, 'blocked');
  assert.equal(result.needs_begin, true);
  assert.equal(result.resumable_review, false);
  assert.equal(result.begin_labels.includes('status:source-review'), true);
  assert.equal(result.final_labels.includes('status:source-ready'), true);
});

test('blocked recovery begin requires task:source-recovery on the live Issue', () => {
  const s = makePinnedRecoveryScenario('blocked');
  s.interviewIssue.labels = s.interviewIssue.labels.filter((label) => label !== 'task:source-recovery');
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /blocked-source-recovery requires task:source-recovery/);
});

test('blocked recovery resumes only from source-review with the same request facts', () => {
  const s = makePinnedRecoveryScenario('source-review');
  const result = plan(s);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.current_status, 'source-review');
  assert.equal(result.needs_begin, false);
  assert.equal(result.resumable_review, true);
});

test('blocked recovery final with matching receipt is already-applied', () => {
  const s = makePinnedRecoveryScenario('source-ready');
  const receipt = buildReceipt(s.request, 'source-ready', '2026-09-05T00:06:00Z');
  const result = plan(s, [receipt]);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.already_applied, true);
  assert.equal(result.needs_receipt_repair, false);
});

test('blocked recovery final without receipt is receipt-repair only', () => {
  const s = makePinnedRecoveryScenario('source-ready');
  const result = plan(s);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.already_applied, false);
  assert.equal(result.needs_receipt_repair, true);
  assert.equal(result.needs_begin, false);
});

test('blocked recovery final with a stale receipt is not already-applied', () => {
  for (const mutateReceipt of [
    (receipt) => { receipt.request_sha256 = '0'.repeat(64); },
    (receipt) => { receipt.final_status = 'blocked'; },
  ]) {
    const s = makePinnedRecoveryScenario('source-ready');
    const receipt = buildReceipt(s.request, 'source-ready', '2026-09-05T00:06:00Z');
    mutateReceipt(receipt);
    const result = plan(s, [receipt]);
    assert.equal(result.ok, false);
    assert.equal(result.already_applied, false);
    assert.equal(result.needs_receipt_repair, false);
    assert.match(result.errors.join('\n'), /receipt (request digest|final status) mismatch/);
  }
});

test('receipt parser rejects old or incomplete receipt identity', () => {
  const s = makePinnedRecoveryScenario('source-ready');
  const receipt = buildReceipt(s.request, 'source-ready', '2026-09-05T00:06:00Z');
  const body = (value) => `<!-- interview-note-source-review-applied\n${JSON.stringify(value)}\n-->`;
  assert.equal(parseReceipts([{ id: 88, body: body(receipt) }]).receipts.length, 1);
  for (const mutate of [
    (value) => { delete value.schema_version; },
    (value) => { delete value.source_note_issue_number; },
    (value) => { value.evidence_subject_sha256 = null; },
    (value) => { value.pinned_artifact_manifest_sha256 = null; },
    (value) => { delete value.interview_body_sha256; },
    (value) => { value.provenance_statement = null; },
  ]) {
    const value = { ...receipt };
    mutate(value);
    const parsed = parseReceipts([{ id: 88, body: body(value) }]);
    assert.equal(parsed.receipts.length, 0);
    assert.match(parsed.errors.join('\n'), /invalid source-review receipt/);
  }
  assert.equal(validateReceipt(receipt).ok, true);
});

test('matching receipt requires the complete transition identity', () => {
  for (const mutate of [
    (receipt) => { receipt.source_note_issue_number = 911; },
    (receipt) => { receipt.case_key = 'other-case'; },
    (receipt) => { receipt.pinned_artifact_manifest_sha256 = '0'.repeat(64); },
    (receipt) => { receipt.evidence_subject_sha256 = '0'.repeat(64); },
    (receipt) => { receipt.provenance_statement = 'forged'; },
  ]) {
    const s = makePinnedRecoveryScenario('source-ready');
    const receipt = buildReceipt(s.request, 'source-ready', '2026-09-05T00:06:00Z');
    mutate(receipt);
    const result = plan(s, [receipt]);
    assert.equal(result.ok, false);
    assert.equal(result.already_applied, false);
    assert.match(result.errors.join('\n'), /receipt (SourceNote Issue|case_key|pinned artifact manifest|evidence subject|provenance statement) mismatch/);
  }
});

test('blocked recovery rejects a stale other live status', () => {
  const s = makePinnedRecoveryScenario('captured');
  const result = plan(s);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /live currentStatus captured does not match expected_initial_status blocked/);
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
  const s = makeScenario({ interviewLabels: (labels) => labels.filter((x) => !x.startsWith('status:')).concat(['status:source-ready']), request: { expected_initial_status: 'source-ready', recovery_mode: 'source-ready-receipt-repair' } });
  const result = plan(s);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.needs_receipt_repair, true);
  assert.equal(result.already_applied, false);
});

test('final source-ready with matching receipt is idempotent', () => {
  const s = makeScenario({ interviewLabels: (labels) => labels.filter((x) => !x.startsWith('status:')).concat(['status:source-ready']), request: { expected_initial_status: 'source-ready', recovery_mode: 'source-ready-receipt-repair' } });
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
