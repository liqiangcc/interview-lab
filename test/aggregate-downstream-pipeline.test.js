'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
  SOURCE_REF,
  BOUNDARY_BATCHES,
  canonicalDigest,
  jsonDigest,
  upstreamDigest,
  validateUpstreamReport,
  sha256Text,
  planAggregate,
  validateAuthorization,
  applyPlan,
  EXISTING_SOURCE_READY_ISSUES,
} = require('../scripts/lib/aggregate-downstream-pipeline');
const { parseInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');

const repository = 'liqiangcc/interview-lab';
const body = fs.readFileSync('test/fixtures/interview-note-issue.valid.md', 'utf8');
const parsed = parseInterviewNoteIssue(body);
const interviewNoteId = parsed.marker.interview_note_id;
const sourceRevisionId = parsed.record.source_revision.id;
const sourceNoteId = `xhs-note:${parsed.record.source.external_id}`;
const issueNumber = 2000;
const sourceIssueNumber = 20;
const sourceBodySha = '1'.repeat(64);
const issue1609Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/aggregate-upstream/issue-1609-boundary-dry-run.json'), 'utf8'));

function boundaryReport(batch, includeCandidate = batch.issue_number === 1606) {
  const items = [];
  for (let index = 0; index < batch.expected_count; index += 1) {
    const number = batch.first + index;
    items.push({
      issue_number: number,
      status: 'already_applied',
      source_note_id: number === sourceIssueNumber ? sourceNoteId : `xhs-note:${number.toString(16).padStart(32, '0')}`,
      current_body_sha256: number === sourceIssueNumber ? sourceBodySha : '2'.repeat(64),
      interview_note_ids: number === sourceIssueNumber && includeCandidate ? [interviewNoteId] : [],
    });
  }
  const report = { schema_version: 'source-note-boundary-review-batch.v1', repository, total: items.length, counts: { ready: items.length, blocked: 0, already_applied: 0 }, items };
  return { ...report, dry_run_sha256: jsonDigest(report) };
}

function materializationReport(extra = {}) {
  const report = {
    schema_version: 'source-note-interview-materialization-batch.v1',
    repository,
    results: [{
      source_note_issue_number: sourceIssueNumber,
      source_note_id: sourceNoteId,
      boundary_status: 'single-interview',
      case_key: null,
      action: 'already-materialized',
      request: {
        expected_source_note_body_sha256: sourceBodySha,
        expected_source_revision_id: sourceRevisionId,
        expected_source_repository_ref: SOURCE_REF,
        materialization_id: 'fixture-materialization-1',
      },
      materialization: {
        interview_note_id: interviewNoteId,
        existing_issue_number: issueNumber,
        source_note_body_sha256: sourceBodySha,
        projected_body_sha256: sha256Text(body),
      },
    }],
    ...extra,
  };
  return { ...report, dry_run_sha256: jsonDigest(report) };
}

function contextProjection(id = interviewNoteId, revision = sourceRevisionId, number = issueNumber, bodyValue = body, action = undefined, existingSourceReady = false) {
  const context = {
    schema_version: 'interview-context.v1',
    context_id: `${id}:context-v1`,
    interview_note_id: id,
    source_revision_id: revision,
    review_status: 'reviewed',
    reviewed_at: '2026-09-08T00:00:00Z',
    company: { id: null, display_name: null, basis: 'unknown', evidence_refs: [] },
    role: { family: 'unknown', title: null, basis: 'unknown', evidence_refs: [] },
    recruitment_type: { value: 'unknown', basis: 'unknown', evidence_refs: [] },
    round: { value: 'unknown', basis: 'unknown', evidence_refs: [] },
    interview_occurred_at: { precision: 'unknown', value: null, basis: 'unknown', evidence_refs: [] },
    outcome_visibility: 'sealed-until-source-reveal',
  };
  return {
    issue_number: number,
    expected_body_sha256: sha256Text(bodyValue),
    context,
    title: id.split(':').pop().slice(0, 8),
    labels: ['source-year:2023', 'source:xhs', 'status:source-ready', 'type:interview-note'],
    live_issue: { number, state: 'open', body: bodyValue, labels: ['source:xhs', 'status:source-ready', 'type:interview-note'] },
    ...(action ? { action } : {}),
    ...(existingSourceReady ? { existing_source_ready: true } : {}),
  };
}

function manifest() {
  return {
    schema_version: 'aggregate-downstream-pipeline.v1',
    aggregate_id: 'issue-1611-fixture',
    repository,
    source_repository: 'liqiangcc/xhs',
    source_ref: SOURCE_REF,
    parent_issue: 1605,
    issue_number: 1611,
    dependency_issues: [1606, 1607, 1608, 1609, 1610],
    boundary_batches: BOUNDARY_BATCHES.map((batch) => ({ ...batch, report: `boundary-${batch.issue_number}.json` })),
    recovery_report: 'recovery.json',
    materialization_reports: ['materialization.json'],
    source_review_receipts: 'source-review.json',
    context_reports: ['context.json'],
    existing_context_reports: ['existing-context.json'],
    existing_source_ready_issue_numbers: [...EXISTING_SOURCE_READY_ISSUES],
    live_issue_snapshot: 'live.json',
  };
}

function validInputs() {
  const reports = {};
  for (const batch of BOUNDARY_BATCHES) reports[batch.issue_number] = boundaryReport(batch);
  const recoveryWithoutDigest = { schema_version: 'issue-1610-source-recovery.v1', repository, items: [{ interview_issue_number: 1, final_status: 'blocked' }, { interview_issue_number: 2, final_status: 'blocked' }] };
  const recovery = { ...recoveryWithoutDigest, report_sha256: canonicalDigest(recoveryWithoutDigest) };
  const review = [{
    schema_version: 'interview-note-source-review-applied.v1',
    interview_note_id: interviewNoteId,
    source_note_body_sha256: sourceBodySha,
    interview_body_sha256: sha256Text(body),
    source_revision_id: sourceRevisionId,
    source_repository_ref: SOURCE_REF,
    final_status: 'source-ready',
    independent: true,
  }];
  const existingItems = EXISTING_SOURCE_READY_ISSUES.map((number, index) => {
    const suffix = (0x630e2e22000000001103c490n + BigInt(index + 1)).toString(16).padStart(32, '0');
    const id = `xhs:${suffix}`;
    const existingBody = body.replaceAll('630e2e22000000001103c490', suffix);
    return contextProjection(id, `${id}:r1`, number, existingBody, 'already_applied', true);
  });
  const liveIssues = new Map([[issueNumber, { number: issueNumber, state: 'open', body, labels: ['source:xhs', 'status:source-ready', 'type:interview-note'] }]]);
  for (const item of existingItems) liveIssues.set(item.issue_number, item.live_issue);
  return { manifest: manifest(), boundaryReports: reports, recoveryReport: recovery, materializationReports: [materializationReport()], sourceReviewReceipts: review, contextReports: [{ items: [contextProjection()] }], existingContextReports: [{ items: existingItems }], liveIssues };
}

test('aggregate fails closed when dependency receipts are absent', () => {
  const input = validInputs();
  input.boundaryReports[1606] = null;
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.equal(result.plan.mutation_performed, false);
  assert.equal(result.plan.summary.mutation_count, 0);
  assert.match(result.errors.join('\n'), /boundary #1606/);
});

test('real #1609 dry-run report shape validates with recursive canonical JSON', () => {
  const validation = validateUpstreamReport(issue1609Fixture, 'boundary #1609', 'issue-1609-boundary-dry-run.v1');
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(upstreamDigest(issue1609Fixture, 'issue-1609-boundary-dry-run.v1').expected, issue1609Fixture.dry_run_sha256);
  const { dry_run_sha256: ignored, ...input } = issue1609Fixture;
  assert.notEqual(sha256Text(JSON.stringify(input)), issue1609Fixture.dry_run_sha256, 'fixture must exercise canonical ordering rather than insertion-order JSON');
  const insertionOrderReport = { ...issue1609Fixture, dry_run_sha256: sha256Text(JSON.stringify(input)) };
  assert.equal(validateUpstreamReport(insertionOrderReport, 'boundary #1609', 'issue-1609-boundary-dry-run.v1').ok, false);
});

test('recovery dry-run uses its declared plan_sha256 digest input', () => {
  const digestInput = { schema_version: 'issue-1610-recovery-digest-input.v1', items: [{ issue_number: 1, status: 'blocked' }, { issue_number: 2, status: 'blocked' }] };
  const report = { schema_version: 'issue-1610-recovery-dry-run.v1', digest_input: digestInput, plan_sha256: canonicalDigest(digestInput) };
  const validation = upstreamDigest(report);
  assert.equal(validation.ok, true, validation.errors && validation.errors.join('\n'));
  assert.equal(validation.expected, report.plan_sha256);
});

test('aggregate requires the parent pending inventory and ownership dependency when pinned', () => {
  const input = validInputs();
  input.manifest.pending_inventory_snapshot = '../issue-1605/pending-inventory.snapshot.json';
  input.manifest.pending_inventory_ownership = '../issue-1605/pending-inventory.ownership.json';
  input.manifest.expected_pending_inventory_digest = '1'.repeat(64);
  input.manifest.expected_pending_ownership_digest = '2'.repeat(64);
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.equal(result.plan.summary.mutation_count, 0);
  assert.match(result.errors.join('\n'), /pending inventory snapshot and ownership index are required dependencies/);
});

test('aggregate freezes the four disjoint boundary ranges and source ref', () => {
  const input = validInputs();
  const result = planAggregate(input);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.plan.source_ref, SOURCE_REF);
  assert.equal(result.plan.selection.length, 51);
  assert.equal(result.plan.selection[0].source_note_body_sha256, sourceBodySha);
  assert.equal(result.plan.selection[0].raw_body_mutation, false);
  assert.match(result.plan.canonical_digest, /^[0-9a-f]{64}$/);
});

test('duplicate InterviewNote ownership and reused/non-independent evidence block the full plan', () => {
  const input = validInputs();
  input.materializationReports = [materializationReport({ results: [
    ...materializationReport().results,
    { ...materializationReport().results[0], source_note_issue_number: 21 },
  ] })];
  input.sourceReviewReceipts[0].independent = false;
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate materialization ownership|independent evidence/);
  assert.equal(result.plan.summary.mutation_count, 0);
});

test('missing Source Review receipt emits an independent evidence request but no mutation plan', () => {
  const input = validInputs();
  input.sourceReviewReceipts = [];
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.equal(result.plan.summary.mutation_count, 0);
  assert.equal(result.plan.independent_source_review_evidence_requests.length, 1);
  assert.equal(result.plan.independent_source_review_evidence_requests[0].boundary_evidence_reuse, false);
});

test('a raw body field in a derived Context report is rejected', () => {
  const input = validInputs();
  input.contextReports[0].items[0].body = 'must never be written';
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /mutate Raw InterviewNote body/);
});

test('applyPlan can only perform metadata/comment mutations and preserves Raw', () => {
  const input = validInputs();
  const result = planAggregate(input);
  assert.equal(result.ok, true, result.errors.join('\n'));
  const calls = [];
  const applied = applyPlan(result.plan, {
    patchIssueMetadata(number, projection) { calls.push(['patch', number, projection]); },
    postComment(number, comment) { calls.push(['comment', number, comment]); return 77; },
  });
  assert.equal(applied.mutation_performed, true);
  assert.deepEqual(calls.map((call) => call[0]), ['patch', 'comment']);
  assert.equal(calls[0][2].body, undefined);
  assert.match(calls[1][2], /raw_body_mutation.*false/);
});

test('apply authorization is scoped to the aggregate plan and parent issue', () => {
  const input = validInputs();
  const result = planAggregate(input);
  const auth = { schema_version: 'aggregate-downstream-apply-authorization.v1', aggregate_id: input.manifest.aggregate_id, issue_number: 1611, parent_issue: 1605, plan_digest: result.plan.canonical_digest, allow_live_github: true, authorized_by: 'master-reviewer' };
  assert.equal(validateAuthorization(auth, result.plan.canonical_digest, input.manifest).ok, true);
  assert.equal(validateAuthorization({ ...auth, plan_digest: '0'.repeat(64) }, result.plan.canonical_digest, input.manifest).ok, false);
});
