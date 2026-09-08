'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPlan,
  SOURCE_REVIEW_RECEIPT_SCHEMA,
  MATERIALIZATION_CANDIDATE_COUNT,
} = require('../scripts/lib/issue-1611-context-learning-plan');
const { canonicalDigest, sha256Text, SOURCE_REF } = require('../scripts/lib/aggregate-downstream-pipeline');

const boundary = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data/pilot/issue-1605/boundary-transition-report.json'), 'utf8'));

function candidatesFromBoundary() {
  return boundary.items.flatMap((item) => (item.interview_note_ids || []).map((id) => ({
    item,
    id,
    caseKey: (item.interview_note_cases || []).find((entry) => entry.interview_note_id === id)?.case_key || null,
  })));
}

function materializationPlan(actionFor = () => 'would-materialize') {
  const results = candidatesFromBoundary().map(({ item, id }) => ({
    source_note_issue_number: item.source_note_issue_number,
    source_note_id: item.source_note_id,
    boundary_decision: item.decision,
    boundary_transition_status: item.transition_status,
    case_key: (item.interview_note_cases || []).find((entry) => entry.interview_note_id === id)?.case_key || null,
    derived_interview_note_id: id,
    action: actionFor(id),
    request: {
      expected_source_note_body_sha256: item.live_source_note_body_sha256,
      expected_source_revision_id: item.source_revision_id,
      expected_source_repository_ref: SOURCE_REF,
      materialization_id: `fixture-${id}`,
    },
    ownership: { count: 0, issue_numbers: [] },
    mutation_performed: false,
  }));
  const input = {
    schema_version: 'issue-1605-interview-note-materialization-plan.v1',
    repository: 'liqiangcc/interview-lab', parent_issue: 1605,
    source_repository: 'liqiangcc/xhs', source_ref: SOURCE_REF,
    mode: 'plan-only', mutation_performed: false,
    write_operations: { patch: 0, post: 0, create: 0 },
    results, errors: [], ok: true,
  };
  return { ...input, dry_run_sha256: canonicalDigest(input) };
}

function interviewBody(candidate) {
  const record = {
    schema_version: 'interview-note-issue.v2',
    interview_note_id: candidate.interview_note_id,
    source: { system: 'xhs', external_id: candidate.interview_note_id.split(':').pop(), url: null },
    source_revision: { id: candidate.source_revision_id, captured_at: null },
    source_published_at: { precision: 'year', value: '2024' },
    source_edited_at: { precision: 'unknown', value: null },
    interview_occurred_at: { precision: 'year', value: '2023' },
    artifacts: [{ kind: 'html', ref: `${candidate.interview_note_id}.html`, sha256: null, provenance: 'raw_capture' }],
    limitations: ['fixture source limitation'],
  };
  return `<!-- interview-note: id=${candidate.interview_note_id} schema=interview-note-issue.v2 -->\n<!-- interview-note-record\n${JSON.stringify(record, null, 2)}\n-->\n\n## 来源身份\n\n## 原始标题\n\nFixture\n\n## 原始正文\n\nRaw interview source\n\n## 原始附件\n\n- raw\n\n## 来源限制\n\n- fixture\n\n## 派生链接\n`;
}

function reviewedContext(candidate) {
  return {
    schema_version: 'interview-context.v1',
    context_id: `${candidate.interview_note_id}:context-v1`,
    interview_note_id: candidate.interview_note_id,
    source_revision_id: candidate.source_revision_id,
    review_status: 'reviewed', reviewed_at: '2026-09-08T00:00:00Z',
    company: { id: 'acme', display_name: 'Acme', basis: 'source-explicit', evidence_refs: ['fixture:company'] },
    role: { family: 'backend', title: '后端', basis: 'source-explicit', evidence_refs: ['fixture:role'] },
    recruitment_type: { value: 'campus', basis: 'reviewed-inference', evidence_refs: ['fixture:recruitment'] },
    round: { value: '2', basis: 'source-explicit', evidence_refs: ['fixture:round'] },
    interview_occurred_at: { precision: 'year', value: '2023', basis: 'source-explicit', evidence_refs: ['fixture:time'] },
    outcome_visibility: 'sealed-until-source-reveal',
  };
}

test('future plan derives exactly 350 rows and blocks every downstream stage when materialization is absent', () => {
  const first = buildPlan({ boundaryReport: boundary, paths: { boundaryReport: 'boundary-transition-report.json', materializationPlan: 'materialization.dry-run.json' } });
  const second = buildPlan({ boundaryReport: boundary, paths: { boundaryReport: 'boundary-transition-report.json', materializationPlan: 'materialization.dry-run.json' } });
  assert.equal(first.ok, false);
  assert.equal(first.plan.candidate_count, MATERIALIZATION_CANDIDATE_COUNT);
  assert.equal(first.plan.candidates.length, MATERIALIZATION_CANDIDATE_COUNT);
  assert.equal(first.plan.summary.materialization_pending, MATERIALIZATION_CANDIDATE_COUNT);
  assert.equal(first.plan.summary.source_review_ready, 0);
  assert.equal(first.plan.summary.context_ready, 0);
  assert.equal(first.plan.summary.learning_projectable, 0);
  assert.equal(first.plan.summary.mutation_count, 0);
  assert.deepEqual(first.plan.write_operations, { patch: 0, post: 0, create: 0 });
  assert.equal(first.plan.candidates.every((candidate) => candidate.interview_issue_number === null && candidate.blocked_stages.length === 4), true);
  assert.equal(first.plan.candidates.every((candidate) => candidate.source_review.request.boundary_evidence_reuse === false), true);
  assert.equal(first.plan.candidates.every((candidate) => candidate.learning.required_label_templates.length === 6), true);
  assert.deepEqual(first.plan.candidates.map((candidate) => candidate.interview_note_id).sort(), [...new Set(first.plan.candidates.map((candidate) => candidate.interview_note_id))].sort());
  assert.equal(first.plan.canonical_digest, second.plan.canonical_digest);
  assert.deepEqual(first.plan.blocked_prerequisites, [{ code: 'materialization-plan-missing', required_schema: 'issue-1605-interview-note-materialization-plan.v1', path: 'materialization.dry-run.json' }]);
});

test('multi-interview candidates retain the case_key-to-identity binding', () => {
  const result = buildPlan({ boundaryReport: boundary });
  const multi = result.plan.candidates.filter((candidate) => candidate.boundary_decision === 'multi-interview');
  assert.equal(multi.length, boundary.items.filter((item) => item.decision === 'multi-interview').reduce((count, item) => count + item.interview_note_ids.length, 0));
  for (const candidate of multi) {
    const source = boundary.items.find((item) => item.source_note_issue_number === candidate.source_note_issue_number);
    const expected = source.interview_note_cases.find((entry) => entry.interview_note_id === candidate.interview_note_id).case_key;
    assert.equal(candidate.case_key, expected);
  }
});

test('one materialized candidate can advance only through independent Source Review, reviewed Context, and derived labels', () => {
  const plan = materializationPlan((id) => id === candidatesFromBoundary()[0].id ? 'already-materialized' : 'would-materialize');
  const candidate = candidatesFromBoundary()[0];
  const base = {
    source_note_issue_number: candidate.item.source_note_issue_number,
    source_note_id: candidate.item.source_note_id,
    source_note_body_sha256: candidate.item.live_source_note_body_sha256,
    source_revision_id: candidate.item.source_revision_id,
    source_ref: SOURCE_REF,
    interview_note_id: candidate.id,
  };
  const body = interviewBody(base);
  const issueNumber = 2001;
  plan.results[0].materialization = { existing_issue_number: issueNumber, interview_note_id: candidate.id, projected_body_sha256: sha256Text(body) };
  const { dry_run_sha256: ignored, ...digestInput } = plan;
  const pinnedPlan = { ...digestInput, dry_run_sha256: canonicalDigest(digestInput) };
  const context = reviewedContext(base);
  const liveIssue = { number: issueNumber, state: 'open', body, labels: ['source:xhs', 'status:source-ready', 'type:interview-note'] };
  const receipt = {
    schema_version: SOURCE_REVIEW_RECEIPT_SCHEMA,
    interview_note_id: candidate.id,
    source_note_body_sha256: base.source_note_body_sha256,
    interview_body_sha256: sha256Text(body),
    source_revision_id: base.source_revision_id,
    source_repository_ref: SOURCE_REF,
    final_status: 'source-ready', independent: true,
  };
  const result = buildPlan({
    boundaryReport: boundary, materializationPlan: pinnedPlan,
    sourceReviewReceipts: [receipt],
    contextReport: { items: [{ issue_number: issueNumber, expected_body_sha256: sha256Text(body), context }] },
    liveIssueSnapshot: { items: [liveIssue] },
  });
  const row = result.plan.candidates.find((item) => item.interview_note_id === candidate.id);
  assert.equal(result.plan.summary.source_review_ready, 1);
  assert.equal(result.plan.summary.context_ready, 1);
  assert.equal(result.plan.summary.learning_projectable, 1);
  assert.equal(row.source_review.status, 'source-ready');
  assert.equal(row.context.status, 'reviewed-context');
  assert.equal(row.learning.status, 'projectable');
  assert.deepEqual(row.learning.proposed_labels.filter((label) => label.startsWith('company:')), ['company:acme']);
  assert.ok(row.learning.proposed_labels.includes('role:backend'));
  assert.ok(row.learning.proposed_labels.includes('recruitment:campus'));
  assert.ok(row.learning.proposed_labels.includes('round:2'));
  assert.ok(row.learning.proposed_labels.includes('source-year:2024'));
  assert.ok(row.learning.proposed_labels.includes('interview-year:2023'));
  assert.equal(row.learning.raw_body_mutation, false);
  assert.equal(result.plan.write_operations.patch, 0);
});

test('Context body fields and malformed boundary input fail closed', () => {
  const plan = materializationPlan((id) => id === candidatesFromBoundary()[0].id ? 'already-materialized' : 'would-materialize');
  const candidate = candidatesFromBoundary()[0];
  const base = {
    source_note_issue_number: candidate.item.source_note_issue_number,
    source_note_id: candidate.item.source_note_id,
    source_note_body_sha256: candidate.item.live_source_note_body_sha256,
    source_revision_id: candidate.item.source_revision_id,
    source_ref: SOURCE_REF,
    interview_note_id: candidate.id,
  };
  const body = interviewBody(base);
  const issueNumber = 2002;
  plan.results[0].materialization = { existing_issue_number: issueNumber, interview_note_id: candidate.id };
  const { dry_run_sha256: ignored, ...digestInput } = plan;
  const pinnedPlan = { ...digestInput, dry_run_sha256: canonicalDigest(digestInput) };
  const context = { ...reviewedContext(base), body: 'forbidden' };
  const result = buildPlan({
    boundaryReport: boundary, materializationPlan: pinnedPlan,
    sourceReviewReceipts: [{ schema_version: SOURCE_REVIEW_RECEIPT_SCHEMA, interview_note_id: candidate.id, source_note_body_sha256: candidate.item.live_source_note_body_sha256, interview_body_sha256: sha256Text(body), source_revision_id: candidate.item.source_revision_id, source_repository_ref: SOURCE_REF, final_status: 'source-ready', independent: true }],
    contextReport: { items: [{ issue_number: issueNumber, expected_body_sha256: sha256Text(body), context }] },
    liveIssueSnapshot: { items: [{ number: issueNumber, state: 'open', body, labels: ['source:xhs', 'status:source-ready', 'type:interview-note'] }] },
  });
  assert.equal(result.ok, false);
  assert.ok(result.plan.errors.some((error) => /attempts to mutate Raw InterviewNote body/.test(error)));
  assert.equal(result.plan.summary.mutation_count, 0);

  const malformed = buildPlan({ boundaryReport: { ...boundary, items: boundary.items.slice(0, -1) } });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.plan.candidates.length, 0);
  assert.equal(malformed.plan.summary.mutation_count, 0);
});
