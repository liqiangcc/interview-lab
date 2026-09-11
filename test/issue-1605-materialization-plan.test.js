'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { buildInterviewProjection, findOwnershipMatches } = require('../scripts/lib/source-note-interview-materialization');
const { childInterviewNoteId } = require('../scripts/lib/interview-note-identity');
const { canonicalDigest } = require('../scripts/lib/aggregate-downstream-pipeline');
const {
  canonicalJson,
  sha256Text,
  planIssue1605Materialization,
  reportDigest,
  validateBoundaryManifest,
  validateLiveBoundaryEvidenceComment,
} = require('../scripts/lib/issue-1605-materialization-plan');
const { buildLiveBoundaryReport, buildLiveManifest, exactAppliedBoundaryEvidence, materializationReceiptsBySourceIssue, sourceSnapshotDigest } = require('../scripts/plan-issue-1611-live-materialization');
const { parseArgs } = require('../scripts/plan-issue-1605-interview-note-materialization');

const template = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
const templateRecord = parseSourceNoteIssue(template).record;

test('live boundary materialization adapter validates a complete dynamic manifest and digest', () => {
  const report = {
    total: 2,
    source_snapshot_digest: '1'.repeat(64),
    dry_run_sha256: '2'.repeat(64),
    items: [
      { issue_number: 20, transition_id: 'transition-20' },
      { issue_number: 21, transition_id: null },
    ],
  };
  const manifest = buildLiveManifest(report);
  const validation = validateBoundaryManifest(manifest);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  const tampered = { ...manifest, source_snapshot_digest: '3'.repeat(64) };
  assert.equal(validateBoundaryManifest(tampered).ok, false);
  assert.match(validateBoundaryManifest(tampered).errors.join('\n'), /canonical_digest/);
});

test('live planner binds manifest to the pinned completion proof and actual report/source snapshot digests', () => {
  const source = makeSourceIssue(920, 'pending', 'runtime-fixture-920');
  const parsed = parseSourceNoteIssue(source.body).record;
  const sourceDigest = sourceSnapshotDigest([source]);
  const generatedReport = buildLiveBoundaryReport([source], new Map(), { comment_id: 5596370635 });
  assert.equal(reportDigest(generatedReport).actual, generatedReport.dry_run_sha256);
  const reportInput = {
    schema_version: 'issue-1605-live-boundary-materialization-report.v1',
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    source_repository: 'liqiangcc/xhs',
    source_ref: '95b77bb261048059846273688e4b90a2e108b437',
    mode: 'live-read-plan-only',
    total: 1,
    counts: { 'single-interview': 0, 'multi-interview': 0, 'not-interview': 0, pending: 1 },
    source_snapshot_digest: sourceDigest,
    items: [{
      issue_number: source.number,
      source_note_id: parsed.source_note_id,
      source_note_body_sha256: sha256Text(source.body),
      evidence_body_sha256: null,
      live_source_note_body_sha256: sha256Text(source.body),
      source_revision_id: parsed.source_revision.id,
      source_repository_ref: parsed.source_revision.source_repository_ref,
      decision: 'blocked',
      transition_id: null,
      transition_status: 'pending',
      evidence_comment_id: null,
      receipt_comment_id: null,
      evidence_schema: null,
      interview_note_ids: [],
      interview_note_cases: [],
      labels: source.labels,
    }],
    errors: [],
  };
  const report = { ...reportInput, dry_run_sha256: canonicalDigest(reportInput) };
  const manifest = buildLiveManifest(report);
  const base = {
    boundaryReports: [report],
    boundaryManifest: manifest,
    sourceIssues: [source],
    sourceSnapshot: { mode: 'test', count: 1, digest: sourceDigest },
    requireCompleteScope: true,
  };
  assert.equal(planIssue1605Materialization(base).ok, true);
  const withoutCanonicalDigest = ({ canonical_digest: ignored, ...value }) => value;

  const withBoundaryDigest = { ...manifest, boundary_report_digest: '0'.repeat(64) };
  withBoundaryDigest.canonical_digest = canonicalDigest(withoutCanonicalDigest(withBoundaryDigest));
  const boundaryDigestPlan = planIssue1605Materialization({ ...base, boundaryManifest: withBoundaryDigest });
  assert.equal(boundaryDigestPlan.ok, false);
  assert.match(boundaryDigestPlan.errors.join('\n'), /boundary_report_digest does not equal the actual boundary report digest/);

  const withSourceDigest = { ...manifest, source_snapshot_digest: '1'.repeat(64) };
  withSourceDigest.canonical_digest = canonicalDigest(withoutCanonicalDigest(withSourceDigest));
  const sourceDigestPlan = planIssue1605Materialization({ ...base, boundaryManifest: withSourceDigest });
  assert.equal(sourceDigestPlan.ok, false);
  assert.match(sourceDigestPlan.errors.join('\n'), /source_snapshot_digest does not equal the actual source snapshot digest/);

  const reportWithWrongCompletion = { ...report, completion_proof: { comment_id: 1 } };
  const withoutDryRunDigest = ({ dry_run_sha256: ignored, ...value }) => value;
  reportWithWrongCompletion.dry_run_sha256 = canonicalDigest(withoutDryRunDigest(reportWithWrongCompletion));
  const completionReportPlan = planIssue1605Materialization({ ...base, boundaryReports: [reportWithWrongCompletion] });
  assert.equal(completionReportPlan.ok, false);
  assert.match(completionReportPlan.errors.join('\n'), /report completion_proof.comment_id/);

  const withWrongCompletion = { ...manifest, completion_proof: { ...manifest.completion_proof, comment_id: manifest.completion_proof.comment_id + 1 } };
  withWrongCompletion.canonical_digest = canonicalDigest(withoutCanonicalDigest(withWrongCompletion));
  const completionValidation = validateBoundaryManifest(withWrongCompletion);
  assert.equal(completionValidation.ok, false);
  assert.match(completionValidation.errors.join('\n'), /pinned online #1605 completion proof/);
});

test('live boundary materialization adapter accepts only the explicit legacy #921 evidence contract', () => {
  const source = makeSourceIssue(919, 'single-interview');
  const parsed = parseSourceNoteIssue(source.body).record;
  const checks = ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication']
    .map((check_id) => ({ check_id, result: 'pass' }));
  const payload = { transition_id: 'issue-921-pilot-919-boundary-review-1', issue_number: 919, source_note_id: parsed.source_note_id, checks };
  const comment = {
    id: 9190001,
    issue_url: 'https://api.github.com/repos/interview-lab-placeholder/issues/919',
    body: `<!-- issue-921-pilot-evidence\n${JSON.stringify(payload)}\n-->\nsource_revision_id: ${parsed.source_revision.id}\nsource_repository_ref: 95b77bb261048059846273688e4b90a2e108b437\nrecommended_decision: single-interview\n`,
  };
  const expected = {
    source_note_issue_number: 919,
    source_note_id: parsed.source_note_id,
    source_revision_id: parsed.source_revision.id,
    decision: 'single-interview',
    transition_id: payload.transition_id,
    evidence_comment_id: comment.id,
    evidence_schema: 'issue-921-pilot-evidence',
  };
  comment.issue_url = 'https://api.github.com/repos/liqiangcc/interview-lab/issues/919';
  assert.equal(validateLiveBoundaryEvidenceComment(comment, expected, source).ok, true);
  const tampered = { ...comment, body: comment.body.replace('source_repository_ref: 95b77bb261048059846273688e4b90a2e108b437', 'source_repository_ref: wrong/ref') };
  assert.equal(validateLiveBoundaryEvidenceComment(tampered, expected, source).ok, false);
});

test('live materialization adapter normalizes the explicit #1556 receipt schema without dropping bindings', () => {
  const comments = new Map([[158, [{
    id: 1580001,
    body: `<!-- source-note-interview-materialized\n${JSON.stringify({
      schema_version: 'issue-1556-materialization-receipt.v1',
      materialization_id: 'fixture-materialization',
      source_note_issue_number: 158,
      source_note_id: 'xhs-note:fixture',
      interview_note_id: 'xhs:fixture',
    })}\n-->`,
  }]]]);
  const receipts = materializationReceiptsBySourceIssue(comments).get(158);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].schema_version, 'source-note-interview-materialized.v1');
  assert.equal(receipts[0].legacy_schema_version, 'issue-1556-materialization-receipt.v1');
  assert.equal(receipts[0].source_note_id, 'xhs-note:fixture');
});

function makeSourceIssue(number, status, externalId = `runtime-fixture-${number}`) {
  const record = JSON.parse(JSON.stringify(templateRecord));
  record.source_note_id = `xhs-note:${externalId}`;
  record.source.external_id = externalId;
  record.source.url = `https://www.xiaohongshu.com/explore/${externalId}`;
  record.source_revision.id = `xhs:${externalId}:r1`;
  record.source_revision.manifest_ref = `source-capture:xhs:${externalId}:r1#manifest.json`;
  for (const artifact of record.artifacts) artifact.ref = artifact.ref.replaceAll('runtime-fixture-1', externalId);
  record.boundary_review = { status, reviewed_at: '2026-09-08T00:00:00Z', interview_note_ids: [] };
  const labels = ['type:source-note', 'source:xhs', 'status:captured', `boundary:${status}`];
  if (status === 'pending') labels.push('task:boundary-review');
  if (status === 'single-interview') record.boundary_review.interview_note_ids = [`xhs:${externalId}`];
  if (status === 'multi-interview') {
    const cases = ['case-a', 'case-b'].map((caseKey) => ({
      case_key: caseKey,
      interview_note_id: childInterviewNoteId(record.source, caseKey),
      evidence: [{ ref: record.artifacts[0].ref, locator: `fixture-${caseKey}` }],
    }));
    record.boundary_review.interview_note_cases = cases;
    record.boundary_review.interview_note_ids = cases.map((item) => item.interview_note_id);
  }
  const marker = `<!-- source-note: id=${record.source_note_id} schema=source-note-issue.v2 -->`;
  const body = template
    .replace(/<!-- source-note:\s*id=[^\s]+\s+schema=[^\s]+\s*-->/, marker)
    .replace(/<!-- source-note-record\s*\n[\s\S]*?\n-->/, `<!-- source-note-record\n${JSON.stringify(record, null, 2)}\n-->`);
  const validation = validateSourceNoteIssue({ body, labels, state: 'open' });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  return { number, state: 'open', body, labels };
}

function makeReport(items, schema = 'issue-1605-boundary-transition-report.v1') {
  const report = {
    schema_version: schema,
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    source_repository: 'liqiangcc/xhs',
    source_ref: '95b77bb261048059846273688e4b90a2e108b437',
    mode: 'plan-only',
    live_apply_authorized: false,
    items,
  };
  report.report_sha256 = sha256Text(canonicalJson(report));
  return report;
}

function item(source, decision, status = 'already_applied', ids = []) {
  const parsed = parseSourceNoteIssue(source.body).record;
  return {
    source_note_issue_number: source.number,
    source_note_id: parsed.source_note_id,
    source_note_body_sha256: sha256Text(source.body),
    live_source_note_body_sha256: sha256Text(source.body),
    source_revision_id: parsed.source_revision.id,
    decision,
    transition_id: `fixture-transition-${source.number}`,
    transition_status: status,
    interview_note_ids: ids,
  };
}

function plan(reports, sourceIssues, ownershipIssues = [], options = {}) {
  return planIssue1605Materialization({
    boundaryReports: reports,
    sourceIssues,
    ownershipIssues,
    ownershipErrors: options.ownershipErrors || new Map(),
    receiptsBySourceIssue: options.receiptsBySourceIssue || new Map(),
    requireCompleteScope: options.requireCompleteScope ?? false,
    sourceSnapshot: { mode: 'test', count: sourceIssues.length },
    ownershipSnapshot: { mode: 'test' },
  });
}

test('blocks every row when boundary transition is not live-applied', () => {
  const source = makeSourceIssue(910, 'pending', 'runtime-fixture-1');
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/issue-1605-materialization/boundary-transition-report.not-applied.json'), 'utf8'));
  const output = plan([report], [source]);
  assert.equal(output.ok, true);
  assert.equal(output.mutation_performed, false);
  assert.deepEqual(output.write_operations, { patch: 0, post: 0, create: 0 });
  assert.equal(output.counts.blocked, 1);
  assert.equal(output.blocked_reasons['boundary-transition-not-live-applied'], 1);
  assert.equal(output.results[0].derived_interview_note_id, undefined);
  assert.match(output.dry_run_sha256, /^[0-9a-f]{64}$/);
});

test('derives a single InterviewNote identity only from the live SourceNote', () => {
  const source = makeSourceIssue(911, 'single-interview');
  const output = plan([makeReport([item(source, 'single-interview', 'already_applied', ['xhs:runtime-fixture-911'])])], [source]);
  assert.equal(output.ok, true, output.errors.join('\n'));
  assert.equal(output.counts['would-materialize'], 1);
  assert.equal(output.results[0].derived_interview_note_id, 'xhs:runtime-fixture-911');
  assert.equal(output.results[0].request.schema_version, 'source-note-interview-materialization.v1');
  assert.equal(output.results[0].projection.interview_note_id, 'xhs:runtime-fixture-911');
  assert.equal(output.results[0].mutation_performed, false);
});

test('derives stable v2 child identities for every approved multi-interview case', () => {
  const source = makeSourceIssue(912, 'multi-interview');
  const parsed = parseSourceNoteIssue(source.body).record;
  const ids = parsed.boundary_review.interview_note_ids;
  const output = plan([makeReport([item(source, 'multi-interview', 'applied', ids)])], [source]);
  assert.equal(output.ok, true, output.errors.join('\n'));
  assert.equal(output.counts['would-materialize'], 2);
  assert.deepEqual(output.results.map((result) => result.derived_interview_note_id).sort(), ids.sort());
  assert.deepEqual(output.results.map((result) => result.request.schema_version).sort(), ['source-note-interview-materialization.v2', 'source-note-interview-materialization.v2']);
  assert.equal(output.results.some((result) => Object.prototype.hasOwnProperty.call(result.request, 'interview_note_id')), false);
});

test('blocks duplicate SourceNote ownership and duplicate derived InterviewNote claims globally', () => {
  const first = makeSourceIssue(913, 'single-interview', 'runtime-duplicate');
  const second = makeSourceIssue(914, 'single-interview', 'runtime-duplicate');
  const reports = [
    makeReport([item(first, 'single-interview', 'already_applied', ['xhs:runtime-duplicate'])]),
    makeReport([item(second, 'single-interview', 'already_applied', ['xhs:runtime-duplicate'])]),
  ];
  const output = plan(reports, [first, second]);
  assert.equal(output.ok, false);
  assert.equal(output.counts.blocked, 2);
  assert.equal(output.blocked_reasons['duplicate-source-note-identity'], 2);
  assert.equal(output.counts['would-materialize'], undefined);
  assert.equal(output.write_operations.create, 0);
});

test('blocks multiple existing InterviewNote owners instead of choosing one', () => {
  const source = makeSourceIssue(915, 'single-interview');
  const validation = { ok: true, parsed: { record: parseSourceNoteIssue(source.body).record } };
  const projection = buildInterviewProjection(source, validation);
  const owners = [
    { number: 1201, state: 'open', body: projection.body, labels: projection.labels },
    { number: 1202, state: 'open', body: projection.body, labels: projection.labels },
  ];
  const output = plan([makeReport([item(source, 'single-interview', 'already_applied', ['xhs:runtime-fixture-915'])])], [source], owners);
  assert.equal(output.ok, true);
  assert.equal(output.counts.blocked, 1);
  assert.equal(output.blocked_reasons['materialization-preflight-failed'], 1);
  assert.match(output.results[0].errors.join('\n'), /duplicate ownership conflict/);
  assert.equal(findOwnershipMatches(owners, 'xhs:runtime-fixture-915').length, 2);
});

test('does not materialize not-interview SourceNotes and blocks an unexpected owner', () => {
  const source = makeSourceIssue(916, 'not-interview');
  const report = makeReport([item(source, 'not-interview', 'already_applied', [])]);
  const noOwner = plan([report], [source]);
  assert.equal(noOwner.ok, true, noOwner.errors.join('\n'));
  assert.equal(noOwner.counts['skip-not-interview'], 1);
  const validation = { ok: true, parsed: { record: parseSourceNoteIssue(source.body).record } };
  const projection = buildInterviewProjection({ ...source, body: source.body }, validation);
  const owner = { number: 1301, body: projection.body, labels: projection.labels, state: 'open' };
  const withOwner = plan([report], [source], [owner]);
  assert.equal(withOwner.counts.blocked, 1);
  assert.equal(withOwner.blocked_reasons['not-interview-has-interview-owner'], 1);
});

test('fails closed on a tampered boundary report digest and identity claim', () => {
  const source = makeSourceIssue(917, 'single-interview');
  const report = makeReport([item(source, 'single-interview', 'already_applied', ['xhs:injected'])]);
  report.items[0].interview_note_ids = ['xhs:injected'];
  report.report_sha256 = '0'.repeat(64);
  const output = plan([report], [source]);
  assert.equal(output.ok, false);
  assert.ok(output.errors.some((error) => /does not match/.test(error)));
  assert.equal(output.counts.blocked, 1);
  assert.equal(output.write_operations.create, 0);
});

test('CLI rejects apply-shaped arguments before any input read', () => {
  assert.throws(() => parseArgs(['--boundary-report', 'fixture.json', '--apply']), /plan-only and never PATCHes or POSTs/);
});

test('complete boundary scope is mandatory for the production planner', () => {
  const source = makeSourceIssue(918, 'pending');
  const report = makeReport([item(source, 'blocked', 'not-applied', [])]);
  const output = planIssue1605Materialization({
    boundaryReports: [report],
    sourceIssues: [source],
    requireCompleteScope: true,
  });
  assert.equal(output.ok, false);
  assert.ok(output.errors.some((error) => /complete 419-row boundary authorization manifest is required/.test(error)));
  assert.equal(output.results[0].action, 'blocked');
  assert.equal(output.results[0].reason_code, 'planner-input-invalid');
  assert.equal(output.mutation_performed, false);
});

test('partial or retargeted boundary manifest fails closed', () => {
  const manifest = {
    schema_version: 'source-note-boundary-review-batch.v1',
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    source_snapshot: { repository: 'liqiangcc/xhs', ref: '95b77bb261048059846273688e4b90a2e108b437' },
    plan_digest: '0'.repeat(64),
    items: [{ issue_number: 918, transition_id: 'wrong-transition', request_file: 'request.json' }],
    canonical_digest: '0'.repeat(64),
  };
  const validation = validateBoundaryManifest(manifest);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => /exactly 419 candidate rows/.test(error)));
  assert.ok(validation.errors.some((error) => /plan_digest/.test(error)));
  assert.ok(validation.errors.some((error) => /canonical_digest/.test(error)));
});

test('transition-applied candidates require an exact, live-bound evidence comment', () => {
  const source = makeSourceIssue(919, 'single-interview');
  const parsed = parseSourceNoteIssue(source.body).record;
  const expected = {
    source_note_issue_number: source.number,
    source_note_id: parsed.source_note_id,
    source_note_body_sha256: sha256Text(source.body),
    source_revision_id: parsed.source_revision.id,
    decision: 'single-interview',
    transition_id: 'fixture-transition-919',
    evidence_comment_id: 5579991919,
  };
  const payload = {
    schema_version: 'source-note-boundary-review-evidence.v1',
    transition_id: expected.transition_id,
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    issue_number: source.number,
    source_note_id: expected.source_note_id,
    expected_body_sha256: expected.source_note_body_sha256,
    expected_source_revision_id: expected.source_revision_id,
    expected_source_repository_ref: '95b77bb261048059846273688e4b90a2e108b437',
    decision: expected.decision,
    checks: ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication'].map((check_id) => ({ check_id, result: 'pass' })),
  };
  const comment = {
    id: expected.evidence_comment_id,
    issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${source.number}`,
    body: `<!-- source-note-boundary-review-evidence\n${JSON.stringify(payload)}\n-->`,
  };
  assert.equal(validateLiveBoundaryEvidenceComment(comment, expected, source).ok, true);
  for (const mutate of [
    (value) => ({ ...value, id: value.id + 1 }),
    (value) => ({ ...value, issue_url: 'https://api.github.com/repos/other/repo/issues/919' }),
    (value) => ({ ...value, body: value.body.replace('source-note-boundary-review-evidence', 'source-note-boundary-review-transition') }),
  ]) {
    assert.equal(validateLiveBoundaryEvidenceComment(mutate(comment), expected, source).ok, false);
  }
  const wrongPayload = { ...payload, decision: 'not-interview' };
  const wrongComment = { ...comment, body: `<!-- source-note-boundary-review-evidence\n${JSON.stringify(wrongPayload)}\n-->` };
  assert.equal(validateLiveBoundaryEvidenceComment(wrongComment, expected, source).ok, false);
});

test('strictly adapts the issue-1608 evidence schema without accepting drift or duplicate matches', () => {
  const source = makeSourceIssue(919, 'single-interview');
  const sourceRecordMarker = source.body.match(/<!-- source-note-record\s*\n([\s\S]*?)\n-->/);
  const sourceRecord = JSON.parse(sourceRecordMarker[1]);
  sourceRecord.schema_version = 'source-note-issue.v1';
  sourceRecord.source_revision.source_repository = 'liqiangcc/xhs';
  sourceRecord.source_revision.source_repository_ref = '95b77bb261048059846273688e4b90a2e108b437';
  sourceRecord.artifacts[2] = {
    ...sourceRecord.artifacts[2],
    ref: 'liqiangcc/xhs:note_desc/runtime-fixture-919.txt@95b77bb261048059846273688e4b90a2e108b437',
    kind: 'text_projection',
    provenance: 'source_projection',
    git_blob_sha: 'b'.repeat(40),
    sha256: 'c'.repeat(64),
    byte_size: 10,
  };
  source.body = source.body
    .replace(/<!-- source-note:\s*id=[^\s]+\s+schema=[^\s]+\s*-->/, `<!-- source-note: id=${sourceRecord.source_note_id} schema=${sourceRecord.schema_version} -->`)
    .replace(sourceRecordMarker[0], `<!-- source-note-record\n${JSON.stringify(sourceRecord, null, 2)}\n-->`);
  const parsed = parseSourceNoteIssue(source.body).record;
  const transitionId = 'fixture-transition-919-issue-1608';
  const evidenceBodySha = 'a'.repeat(64);
  const projection = {
    ref: 'liqiangcc/xhs:note_desc/runtime-fixture-919.txt@95b77bb261048059846273688e4b90a2e108b437',
    kind: 'text_projection',
    provenance: 'source_projection',
    blob_sha: 'b'.repeat(40),
    content_sha256: 'c'.repeat(64),
    byte_size: 10,
  };
  const oldPayload = {
    schema_version: 'issue-1608-boundary-evidence.v1',
    issue_number: source.number,
    source_note_id: parsed.source_note_id,
    source_revision_id: parsed.source_revision.id,
    source_repository: 'liqiangcc/xhs',
    source_repository_ref: '95b77bb261048059846273688e4b90a2e108b437',
    evidence_status: 'sufficient-for-controller-review',
    decision: 'single-interview',
    artifact: { ref: projection.ref, kind: projection.kind, provenance: projection.provenance, git_blob_sha: projection.blob_sha, byte_size: projection.byte_size, content_sha256: projection.content_sha256 },
    excerpts: [{ excerpt: 'fixture', locator: 'fixture:line-1', line: 1 }],
    checks: ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication'].map((check_id) => ({ check_id, result: 'pass' })),
    transition_request: {
      schema_version: 'source-note-boundary-review-transition.v1',
      transition_id: transitionId,
      repository: 'liqiangcc/interview-lab',
      issue_number: source.number,
      source_note_id: parsed.source_note_id,
      expected_body_sha256: evidenceBodySha,
      expected_boundary_status: 'pending',
      expected_source_revision_id: parsed.source_revision.id,
      expected_source_repository_ref: '95b77bb261048059846273688e4b90a2e108b437',
      decision: 'single-interview',
      source_projection: projection,
      live_binding: {
        issue_number: source.number,
        body_sha256: evidenceBodySha,
        source_note_id: parsed.source_note_id,
        source_revision_id: parsed.source_revision.id,
        source_repository: 'liqiangcc/xhs',
        source_repository_ref: '95b77bb261048059846273688e4b90a2e108b437',
        source_projection_ref: projection.ref,
        source_projection_blob_sha: projection.blob_sha,
        source_projection_content_sha256: projection.content_sha256,
      },
    },
  };
  const comment = {
    id: 9191608,
    issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/919',
    body: `<!-- issue-1608-boundary-evidence.v1\n${JSON.stringify(oldPayload)}\n-->`,
  };
  const expected = {
    source_note_issue_number: source.number,
    source_note_id: parsed.source_note_id,
    source_note_body_sha256: sha256Text(source.body),
    evidence_body_sha256: evidenceBodySha,
    live_source_note_body_sha256: sha256Text(source.body),
    source_revision_id: parsed.source_revision.id,
    decision: 'single-interview',
    transition_id: transitionId,
    evidence_comment_id: comment.id,
    evidence_schema: 'issue-1608-boundary-evidence.v1',
  };
  assert.equal(validateLiveBoundaryEvidenceComment(comment, expected, source).ok, true);
  const clonePayload = () => JSON.parse(JSON.stringify(oldPayload));
  const commentFor = (payload) => ({ ...comment, body: `<!-- issue-1608-boundary-evidence.v1\n${JSON.stringify(payload)}\n-->` });
  const missingFields = clonePayload();
  delete missingFields.artifact.ref;
  delete missingFields.artifact.kind;
  delete missingFields.artifact.provenance;
  delete missingFields.artifact.git_blob_sha;
  delete missingFields.artifact.content_sha256;
  delete missingFields.artifact.byte_size;
  delete missingFields.transition_request.source_projection.ref;
  delete missingFields.transition_request.source_projection.kind;
  delete missingFields.transition_request.source_projection.provenance;
  delete missingFields.transition_request.source_projection.blob_sha;
  delete missingFields.transition_request.source_projection.content_sha256;
  delete missingFields.transition_request.source_projection.byte_size;
  delete missingFields.transition_request.live_binding.source_projection_ref;
  delete missingFields.transition_request.live_binding.source_projection_blob_sha;
  delete missingFields.transition_request.live_binding.source_projection_content_sha256;
  assert.equal(validateLiveBoundaryEvidenceComment(commentFor(missingFields), expected, source).ok, false);
  for (const replaceObject of [
    (payload) => { payload.artifact = []; },
    (payload) => { payload.transition_request.source_projection = []; },
    (payload) => { payload.transition_request.live_binding = []; },
  ]) {
    const arrayObject = clonePayload();
    replaceObject(arrayObject);
    assert.equal(validateLiveBoundaryEvidenceComment(commentFor(arrayObject), expected, source).ok, false);
  }
  const otherSource = clonePayload();
  const otherRef = 'other/repository:note_json/other-source.json@95b77bb261048059846273688e4b90a2e108b437';
  otherSource.artifact.ref = otherRef;
  otherSource.transition_request.source_projection.ref = otherRef;
  otherSource.transition_request.live_binding.source_projection_ref = otherRef;
  assert.equal(validateLiveBoundaryEvidenceComment(commentFor(otherSource), expected, source).ok, false);
  for (const mutate of [
    (payload) => { payload.artifact.byte_size = -1; payload.transition_request.source_projection.byte_size = -1; },
    (payload) => { payload.artifact.git_blob_sha = 'bad'; payload.transition_request.source_projection.blob_sha = 'bad'; payload.transition_request.live_binding.source_projection_blob_sha = 'bad'; },
    (payload) => { payload.artifact.content_sha256 = 'bad'; payload.transition_request.source_projection.content_sha256 = 'bad'; payload.transition_request.live_binding.source_projection_content_sha256 = 'bad'; },
  ]) {
    const malformed = clonePayload();
    mutate(malformed);
    assert.equal(validateLiveBoundaryEvidenceComment(commentFor(malformed), expected, source).ok, false);
  }
  const duplicateChecks = clonePayload();
  duplicateChecks.checks.push({ check_id: 'source_identity', result: 'fail' });
  assert.equal(validateLiveBoundaryEvidenceComment(commentFor(duplicateChecks), expected, source).ok, false);
  const invalidSource = { ...source, labels: [] };
  assert.equal(validateLiveBoundaryEvidenceComment(comment, expected, invalidSource).ok, false);
  const withSourceRecord = (mutate) => {
    const copy = JSON.parse(JSON.stringify(source));
    const recordMarker = copy.body.match(/<!-- source-note-record\s*\n([\s\S]*?)\n-->/);
    const record = JSON.parse(recordMarker[1]);
    mutate(record);
    copy.body = copy.body
      .replace(/<!-- source-note:\s*id=[^\s]+\s+schema=[^\s]+\s*-->/, `<!-- source-note: id=${record.source_note_id} schema=${record.schema_version} -->`)
      .replace(recordMarker[0], `<!-- source-note-record\n${JSON.stringify(record, null, 2)}\n-->`);
    return copy;
  };
  assert.equal(validateLiveBoundaryEvidenceComment({ ...comment }, expected, { ...source, body: `${source.body}\nsource body drift` }).ok, false);
  const refDrift = withSourceRecord((record) => { record.source_revision.source_repository_ref = 'wrong/ref'; });
  assert.equal(validateLiveBoundaryEvidenceComment(comment, { ...expected, live_source_note_body_sha256: sha256Text(refDrift.body) }, refDrift).ok, false);
  const identityDrift = withSourceRecord((record) => { record.source_note_id = 'xhs-note:drifted-source'; });
  assert.equal(validateLiveBoundaryEvidenceComment(comment, { ...expected, live_source_note_body_sha256: sha256Text(identityDrift.body) }, identityDrift).ok, false);
  for (const mutate of [
    (value) => ({ ...value, transition_request: { ...value.transition_request, expected_body_sha256: 'd'.repeat(64) } }),
    (value) => ({ ...value, source_repository_ref: 'wrong/ref' }),
    (value) => ({ ...value, transition_request: { ...value.transition_request, source_note_id: 'xhs-note:drift' } }),
  ]) {
    const tampered = { ...comment, body: `<!-- issue-1608-boundary-evidence.v1\n${JSON.stringify(mutate(oldPayload))}\n-->` };
    assert.equal(validateLiveBoundaryEvidenceComment(tampered, expected, source).ok, false);
  }
  const applied = {
    id: 9191609,
    issue_url: comment.issue_url,
    body: `<!-- source-note-boundary-review-applied\n${JSON.stringify({
      schema_version: 'source-note-boundary-review-applied.v1',
      transition_id: transitionId,
      repository: 'liqiangcc/interview-lab',
      issue_number: source.number,
      source_note_id: parsed.source_note_id,
      decision: 'single-interview',
      new_body_sha256: sha256Text(source.body),
      previous_body_sha256: evidenceBodySha,
      interview_note_ids: [`xhs:${parsed.source.external_id}`],
      interview_note_cases: null,
    })}\n-->`,
  };
  const duplicateSameSchema = exactAppliedBoundaryEvidence(source, [applied, comment, { ...comment, id: 9191610 }]);
  assert.match(duplicateSameSchema.errors.join('\n'), /matching boundary evidence comment \(got 2\)/);
  const emptyApplied = { ...applied, body: applied.body.replace(`"interview_note_ids":["xhs:${parsed.source.external_id}"]`, '"interview_note_ids":[]') };
  assert.match(exactAppliedBoundaryEvidence(source, [emptyApplied, comment]).errors.join('\n'), /receipt interview_note_ids mismatch/);
  const currentPayload = {
    schema_version: 'source-note-boundary-review-evidence.v1',
    transition_id: transitionId,
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    issue_number: source.number,
    source_note_id: parsed.source_note_id,
    expected_body_sha256: evidenceBodySha,
    expected_source_revision_id: parsed.source_revision.id,
    expected_source_repository_ref: '95b77bb261048059846273688e4b90a2e108b437',
    decision: 'single-interview',
    checks: oldPayload.checks,
  };
  const duplicateCrossSchema = exactAppliedBoundaryEvidence(source, [applied, comment, {
    id: 9191611,
    issue_url: comment.issue_url,
    body: `<!-- source-note-boundary-review-evidence\n${JSON.stringify(currentPayload)}\n-->`,
  }]);
  assert.match(duplicateCrossSchema.errors.join('\n'), /matching boundary evidence comment \(got 2\)/);
});
