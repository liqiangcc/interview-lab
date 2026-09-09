'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  canonicalize,
  sha256,
  TRANSITION_V1,
  TRANSITION_V2,
  buildEvidenceTransitionPlan,
  validateEvidenceTransitionPlan,
} = require('../scripts/lib/issue-1656-evidence-transition-request-plan');

const REVIEW_PLAN = require('../data/pilot/issue-1656/dynamic-review-plan.json');
const INVENTORY = require('../data/pilot/issue-1656/pending-inventory.json');
const ISSUES_FILE = path.join(__dirname, '..', 'data', 'pilot', 'issue-1611', 'source-note-live.snapshot.json');
const ISSUES = JSON.parse(fs.readFileSync(ISSUES_FILE, 'utf8'));
const CAPTURED_AT = '2026-09-09T00:00:00.000Z';

function redigest(value) {
  return { ...value, canonical_digest: sha256(canonicalize(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'canonical_digest')))) };
}

test('planner partitions the complete 421 scope into proposal rows and blocked ledger', () => {
  const result = buildEvidenceTransitionPlan({ reviewPlan: REVIEW_PLAN, issueSnapshot: ISSUES, inventory: INVENTORY, capturedAt: CAPTURED_AT });
  assert.equal(result.ok, true, result.errors?.join('; '));
  assert.equal(result.scope.total, 421);
  assert.equal(result.proposal_rows.length + result.blocked_ledger.length, 421);
  assert.equal(new Set([...result.proposal_rows, ...result.blocked_ledger].map((row) => row.issue_number)).size, 421);
  assert.equal(result.summary.durable_reviews, 0);
  assert.equal(result.mode, 'plan-only');
  assert.deepEqual(result.mutation_guard, { patch: 0, post: 0, label: 0, create: 0, mutation: 0, read_only: true, live_mutation: false });
  assert.equal(validateEvidenceTransitionPlan(result, REVIEW_PLAN).ok, true);
});

test('single uses transition v1 and multi uses v2 with exact case keys and evidence locators', () => {
  const result = buildEvidenceTransitionPlan({ reviewPlan: REVIEW_PLAN, issueSnapshot: ISSUES, inventory: INVENTORY, capturedAt: CAPTURED_AT });
  const single = result.proposal_rows.find((row) => row.decision === 'single-interview');
  assert.equal(single.transition_request.schema_version, TRANSITION_V1);
  assert.equal(single.transition_request.review_evidence, null);
  const multi = result.proposal_rows.find((row) => row.decision === 'multi-interview');
  assert.equal(multi.transition_request.schema_version, TRANSITION_V2);
  assert.ok(multi.transition_request.interview_cases.length >= 2);
  const locators = multi.transition_request.interview_cases.flatMap((candidate) => candidate.evidence.map((evidence) => evidence.locator));
  assert.equal(new Set(locators).size, locators.length);
  assert.ok(multi.transition_request.interview_cases.every((candidate) => candidate.case_key && candidate.evidence.every((evidence) => evidence.ref === multi.source_projection.ref && evidence.locator)));
});

test('#735 is only in the independent-review-required blocked ledger', () => {
  const result = buildEvidenceTransitionPlan({ reviewPlan: REVIEW_PLAN, issueSnapshot: ISSUES, inventory: INVENTORY, capturedAt: CAPTURED_AT });
  assert.equal(result.proposal_rows.some((row) => row.issue_number === 735), false);
  const row = result.blocked_ledger.find((candidate) => candidate.issue_number === 735);
  assert.equal(row.status, 'independent-review-required');
  assert.equal(row.decision, null);
  assert.equal(row.review.durable_review, false);
});

test('live body, SourceNote, SourceRevision, and source projection drift fail closed without partial proposals', () => {
  const tampered = JSON.parse(JSON.stringify(ISSUES));
  tampered.issues.find((issue) => issue.number === 31).body += '\n drift';
  const result = buildEvidenceTransitionPlan({ reviewPlan: REVIEW_PLAN, issueSnapshot: tampered, inventory: INVENTORY, capturedAt: CAPTURED_AT });
  assert.equal(result.ok, false);
  assert.equal(result.proposal_rows.length, 0);
  assert.equal(result.blocked_ledger.length, 0);
  assert.ok(result.errors.some((error) => /body SHA|SourceNote binding/.test(error)));

  const refTampered = JSON.parse(JSON.stringify(ISSUES));
  const issue = refTampered.issues.find((candidate) => candidate.number === 31);
  issue.body = issue.body.replace('liqiangcc/xhs:note_desc/', 'evil/xhs:note_desc/');
  const refResult = buildEvidenceTransitionPlan({ reviewPlan: REVIEW_PLAN, issueSnapshot: refTampered, inventory: INVENTORY, capturedAt: CAPTURED_AT });
  assert.equal(refResult.ok, false);
  assert.equal(refResult.proposal_rows.length, 0);
});

test('legacy 419/978-style manifests and duplicate rows are rejected', () => {
  for (const oldTotal of [419, 978]) {
    const oldManifest = redigest({ ...REVIEW_PLAN, scope: { ...REVIEW_PLAN.scope, total: oldTotal } });
    const result = buildEvidenceTransitionPlan({ reviewPlan: oldManifest, issueSnapshot: ISSUES, inventory: INVENTORY, capturedAt: CAPTURED_AT });
    assert.equal(result.ok, false);
    assert.equal(result.proposal_rows.length, 0);
    assert.ok(result.errors.some((error) => /421|complete|scope/.test(error)));
  }
  const duplicate = JSON.parse(JSON.stringify(REVIEW_PLAN));
  duplicate.items[duplicate.items.length - 1] = JSON.parse(JSON.stringify(duplicate.items[0]));
  duplicate.canonical_digest = redigest(duplicate).canonical_digest;
  const result = buildEvidenceTransitionPlan({ reviewPlan: duplicate, issueSnapshot: ISSUES, inventory: INVENTORY, capturedAt: CAPTURED_AT });
  assert.equal(result.ok, false);
  assert.equal(result.proposal_rows.length, 0);
  assert.ok(result.errors.some((error) => /duplicate|issue set/.test(error)));
});

test('unsupported evidence fields fail closed rather than creating a partial request plan', () => {
  const tampered = JSON.parse(JSON.stringify(REVIEW_PLAN));
  const proposal = tampered.items.find((item) => ['single-interview', 'multi-interview', 'not-interview'].includes(item.proposal.decision));
  proposal.line_evidence[0].unsupported_field = 'must reject';
  const result = buildEvidenceTransitionPlan({ reviewPlan: redigest(tampered), issueSnapshot: ISSUES, inventory: INVENTORY, capturedAt: CAPTURED_AT });
  assert.equal(result.ok, false);
  assert.equal(result.proposal_rows.length, 0);
  assert.equal(result.blocked_ledger.length, 0);
  assert.ok(result.errors.some((error) => /unsupported evidence field/.test(error)));
});

test('execution stages are explicit, separate, unauthorized, and contain no apply skeleton', () => {
  const result = buildEvidenceTransitionPlan({ reviewPlan: REVIEW_PLAN, issueSnapshot: ISSUES, inventory: INVENTORY, capturedAt: CAPTURED_AT });
  assert.deepEqual(result.execution_stages.evidence_post, { method: 'POST', separate_from_boundary_patch: true, authorized: false, status: 'not-executed' });
  assert.deepEqual(result.execution_stages.boundary_patch, { method: 'PATCH', depends_on: 'evidence_post', authorized: false, status: 'not-executed' });
  assert.equal(result.apply_contract.skeleton_provided, false);
  assert.equal(result.authorization.authorization_comment_id, null);
  assert.equal(result.authorization.live_github_mutation, false);
});

test('request plan digest is reproducible and validator rejects digest or stage tamper', () => {
  const result = buildEvidenceTransitionPlan({ reviewPlan: REVIEW_PLAN, issueSnapshot: ISSUES, inventory: INVENTORY, capturedAt: CAPTURED_AT });
  assert.equal(result.canonical_digest, sha256(canonicalize(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'canonical_digest')))));
  const tampered = JSON.parse(JSON.stringify(result));
  tampered.execution_stages.boundary_patch.depends_on = 'direct-patch';
  tampered.canonical_digest = redigest(tampered).canonical_digest;
  const validation = validateEvidenceTransitionPlan(tampered, REVIEW_PLAN);
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some((error) => /stages|separate|depends/.test(error)));

  const unsupportedEvidence = JSON.parse(JSON.stringify(result));
  unsupportedEvidence.proposal_rows[0].transition_request.source_evidence[0].unsupported_field = true;
  unsupportedEvidence.canonical_digest = redigest(unsupportedEvidence).canonical_digest;
  const evidenceValidation = validateEvidenceTransitionPlan(unsupportedEvidence, REVIEW_PLAN);
  assert.equal(evidenceValidation.ok, false);
  assert.ok(evidenceValidation.errors.some((error) => /unsupported evidence field/.test(error)));
});
