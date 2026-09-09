'use strict';

/*
 * Read-only planner for the post-review boundary workflow of Issue #1656.
 *
 * This module emits request-shaped proposal inputs only.  It has no GitHub
 * write primitive and deliberately does not implement an apply skeleton.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  SOURCE_REPOSITORY,
  SOURCE_REF,
  ISSUE,
  PARENT_ISSUE,
  EXPECTED_PENDING_COUNT,
  ZERO_MUTATIONS,
  canonicalize,
  sha256,
  validateIssueSnapshot,
  selectedPendingIssues,
  inventoryIndex,
  parseSelectedIssue,
  validateReviewPlan,
  validateSourceProjectionArtifact,
} = require('./issue-1656-dynamic-boundary-review');

const REPOSITORY = 'liqiangcc/interview-lab';
const UPSTREAM_ISSUE = 1605;
const PLAN_SCHEMA = 'issue-1656-dynamic-boundary-review-plan.v1';
const SCHEMA_VERSION = 'issue-1656-evidence-transition-request-plan.v1';
const TRANSITION_V1 = 'source-note-boundary-review-transition.v1';
const TRANSITION_V2 = 'source-note-boundary-review-transition.v2';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const CASE_KEY = /^[a-z][a-z0-9-]*$/;
const EVIDENCE_KEYS = new Set(['role', 'line', 'locator', 'excerpt', 'projection_path']);
const REQUEST_EVIDENCE_KEYS = new Set(['ref', 'line', 'locator', 'excerpt', 'projection_path']);
const DECISIONS = new Set(['not-interview', 'single-interview', 'multi-interview']);
const DEFAULT_PLAN = 'data/pilot/issue-1656/dynamic-review-plan.json';
const DEFAULT_ISSUES = 'data/pilot/issue-1611/source-note-live.snapshot.json';
const DEFAULT_INVENTORY = 'data/pilot/issue-1656/pending-inventory.json';
const DEFAULT_OUTPUT = 'data/pilot/issue-1656/evidence-transition-request-plan.json';
const DEFAULT_CAPTURED_AT = '2026-09-09T00:00:00.000Z';

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function canonicalDigest(value) { return sha256(canonicalize(value)); }

function sourceProjectionFromPlan(item) {
  const projection = item && item.source_projection;
  if (!projection) throw new Error('source projection is missing');
  validateSourceProjectionArtifact(projection, item.source_note_id);
  if (projection.blob_sha !== item.source_projection_blob_sha) throw new Error('source projection blob SHA alias drifted');
  if (!HEX40.test(String(projection.blob_sha || ''))) throw new Error('source projection blob SHA is invalid');
  if (!HEX64.test(String(projection.content_sha256 || ''))) throw new Error('source projection content digest is not verified');
  if (!Number.isInteger(projection.byte_size_verified) || projection.byte_size_verified < 0) throw new Error('source projection byte size is not verified');
  return {
    ref: projection.ref,
    kind: projection.kind,
    provenance: projection.provenance,
    blob_sha: projection.blob_sha,
    content_sha256: projection.content_sha256,
    byte_size: projection.byte_size_verified,
  };
}

function liveIssueMap(snapshot) {
  const validation = validateIssueSnapshot(snapshot);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  const selected = selectedPendingIssues(snapshot);
  const result = new Map(selected.map((issue) => [Number(issue.number), issue]));
  if (result.size !== EXPECTED_PENDING_COUNT) throw new Error(`live pending SourceNote scope must contain ${EXPECTED_PENDING_COUNT} items`);
  return result;
}

function compareLiveBinding(item, liveIssue, inventoryItem) {
  const errors = [];
  if (!liveIssue) return [`#${item.issue_number} live SourceNote is missing from the current pending snapshot`];
  let live;
  try { live = parseSelectedIssue(liveIssue, inventoryItem); }
  catch (error) { return [`#${item.issue_number} live SourceNote binding rejected: ${error.message}`]; }
  if (live.body_sha256 !== item.body_sha256) errors.push(`#${item.issue_number} live body SHA differs from dynamic plan`);
  if (live.source_note_id !== item.source_note_id) errors.push(`#${item.issue_number} live SourceNote identity differs from dynamic plan`);
  if (live.source_revision_id !== item.source_revision_id) errors.push(`#${item.issue_number} live SourceRevision differs from dynamic plan`);
  const liveProjection = live.source_projection;
  const expectedProjection = item.source_projection;
  for (const key of ['ref', 'kind', 'provenance', 'git_blob_sha', 'byte_size']) {
    if (liveProjection[key] !== expectedProjection[key === 'git_blob_sha' ? 'blob_sha' : key]) errors.push(`#${item.issue_number} live source projection ${key} differs from dynamic plan`);
  }
  if (live.source_revision.source_repository !== SOURCE_REPOSITORY || live.source_revision.source_repository_ref !== SOURCE_REF) errors.push(`#${item.issue_number} live SourceRevision source binding drifted`);
  return errors;
}

function validateEvidenceObject(evidence, expectedBlobSha, label) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [`${label} must be an object`];
  for (const key of Object.keys(evidence)) if (!EVIDENCE_KEYS.has(key)) errors.push(`${label} has unsupported evidence field: ${key}`);
  if (!Number.isInteger(evidence.line) || evidence.line < 1) errors.push(`${label}.line must be a positive integer`);
  if (typeof evidence.locator !== 'string' || !evidence.locator.trim()) errors.push(`${label}.locator is required`);
  else if (!evidence.locator.startsWith(`source-projection:blob:${expectedBlobSha}:`)) errors.push(`${label}.locator is not bound to the source projection blob`);
  if (typeof evidence.excerpt !== 'string' || !evidence.excerpt.trim()) errors.push(`${label}.excerpt is required`);
  return errors;
}

function validateRequestEvidenceObject(evidence, expectedRef, expectedBlobSha, label) {
  const errors = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [`${label} must be an object`];
  for (const key of Object.keys(evidence)) if (!REQUEST_EVIDENCE_KEYS.has(key)) errors.push(`${label} has unsupported evidence field: ${key}`);
  if (evidence.ref !== expectedRef) errors.push(`${label}.ref is not the exact source projection ref`);
  if (!Number.isInteger(evidence.line) || evidence.line < 1) errors.push(`${label}.line must be a positive integer`);
  if (typeof evidence.locator !== 'string' || !evidence.locator.startsWith(`source-projection:blob:${expectedBlobSha}:`)) errors.push(`${label}.locator is not bound to the source projection blob`);
  if (typeof evidence.excerpt !== 'string' || !evidence.excerpt.trim()) errors.push(`${label}.excerpt is required`);
  return errors;
}

function validateProposalEvidence(item) {
  const errors = [];
  const decision = item.proposal?.decision;
  if (!DECISIONS.has(decision)) return ['proposal decision is unsupported'];
  if (item.review?.status !== 'proposal-only') errors.push('proposal row must have proposal-only review status');
  const projection = sourceProjectionFromPlan(item);
  const locators = new Set();
  const lineEvidence = Array.isArray(item.line_evidence) ? item.line_evidence : [];
  if (!lineEvidence.length) errors.push('proposal must retain line evidence');
  for (const [index, evidence] of lineEvidence.entries()) {
    errors.push(...validateEvidenceObject(evidence, projection.blob_sha, `line_evidence[${index}]`));
    if (typeof evidence.locator === 'string' && locators.has(evidence.locator)) errors.push(`duplicate proposal evidence locator: ${evidence.locator}`);
    if (typeof evidence.locator === 'string') locators.add(evidence.locator);
  }
  if (decision === 'multi-interview') {
    const cases = item.proposal.cases;
    if (!Array.isArray(cases) || cases.length < 2 || Number(item.proposal.case_count) < 2) errors.push('multi proposal requires at least two cases');
    const caseLocators = new Set();
    for (const [caseIndex, candidate] of (Array.isArray(cases) ? cases : []).entries()) {
      if (!CASE_KEY.test(String(candidate.case_key || ''))) errors.push(`proposal case ${caseIndex} has invalid case_key`);
      if (!Array.isArray(candidate.evidence) || candidate.evidence.length < 1) errors.push(`proposal case ${caseIndex} has no evidence`);
      for (const [evidenceIndex, evidence] of (Array.isArray(candidate.evidence) ? candidate.evidence : []).entries()) {
        errors.push(...validateEvidenceObject(evidence, projection.blob_sha, `proposal case ${caseIndex} evidence ${evidenceIndex}`));
        if (typeof evidence.locator === 'string' && caseLocators.has(evidence.locator)) errors.push(`duplicate proposal case evidence locator: ${evidence.locator}`);
        if (typeof evidence.locator === 'string') caseLocators.add(evidence.locator);
      }
    }
  }
  return errors;
}

function liveBinding(item, liveIssue) {
  return {
    issue_number: Number(liveIssue.number),
    body_sha256: item.body_sha256,
    source_note_id: item.source_note_id,
    source_revision_id: item.source_revision_id,
    source_repository: SOURCE_REPOSITORY,
    source_repository_ref: SOURCE_REF,
    source_projection_ref: item.source_projection.ref,
    source_projection_blob_sha: item.source_projection.blob_sha,
    source_projection_content_sha256: item.source_projection.content_sha256,
  };
}

function evidenceReferences(item, evidence) {
  return evidence.map((entry) => ({
    ref: item.source_projection.ref,
    locator: entry.locator,
    line: entry.line,
    excerpt: entry.excerpt,
    ...(entry.projection_path ? { projection_path: entry.projection_path } : {}),
  }));
}

function transitionRequest(item, live, capturedAt) {
  const decision = item.proposal.decision;
  const multi = decision === 'multi-interview';
  const projection = sourceProjectionFromPlan(item);
  const request = {
    schema_version: multi ? TRANSITION_V2 : TRANSITION_V1,
    transition_id: `issue-1656-boundary-${String(item.issue_number).padStart(4, '0')}-${capturedAt.replace(/\D/g, '').slice(0, 14)}`,
    repository: REPOSITORY,
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    expected_body_sha256: item.body_sha256,
    expected_boundary_status: 'pending',
    expected_source_revision_id: item.source_revision_id,
    expected_manifest_sha256: item.source_revision?.manifest_sha256 || null,
    expected_source_repository_ref: SOURCE_REF,
    decision,
    reviewed_at: null,
    reviewer_kind: null,
    review_evidence: null,
    request_status: 'proposal-only-awaiting-independent-review-and-evidence-post',
    source_projection: projection,
    source_evidence: evidenceReferences(item, item.line_evidence),
    evidence_post_required_before_boundary_patch: true,
    boundary_patch_separate_stage: true,
    live_binding: liveBinding(item, live),
  };
  if (multi) {
    request.interview_cases = item.proposal.cases.map((candidate) => ({
      case_key: candidate.case_key,
      evidence: evidenceReferences(item, candidate.evidence),
    }));
  }
  return request;
}

function blockedLedgerRow(item, liveIssue, reason, status = 'blocked') {
  const projection = sourceProjectionFromPlan(item);
  return {
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    status,
    decision: null,
    reason,
    expected_body_sha256: item.body_sha256,
    expected_source_revision_id: item.source_revision_id,
    source_projection: projection,
    live_binding: liveIssue ? liveBinding(item, liveIssue) : null,
    review: { durable_review: false, evidence_post_allowed: false, boundary_patch_allowed: false },
  };
}

function planBase({ inputPlan, capturedAt, ok, errors, proposalRows, blockedLedger, liveSnapshot }) {
  const plan = {
    schema_version: SCHEMA_VERSION,
    repository: REPOSITORY,
    issue: ISSUE,
    parent_issue: PARENT_ISSUE,
    upstream_issue: UPSTREAM_ISSUE,
    input_plan: {
      schema_version: PLAN_SCHEMA,
      canonical_digest: inputPlan?.canonical_digest || null,
      source_snapshot_digest: inputPlan?.source_snapshot?.digest || null,
      inventory_digest: inputPlan?.inventory_digest || null,
    },
    source_snapshot: {
      repository: SOURCE_REPOSITORY,
      ref: SOURCE_REF,
      digest: inputPlan?.source_snapshot?.digest || null,
      complete: inputPlan?.source_snapshot?.complete === true,
    },
    live_issue_snapshot: liveSnapshot ? {
      schema_version: liveSnapshot.schema_version || null,
      count: liveSnapshot.count,
      issue_count: Array.isArray(liveSnapshot.issues) ? liveSnapshot.issues.length : null,
      pagination: liveSnapshot.pagination,
    } : null,
    captured_at: capturedAt,
    mode: 'plan-only',
    ok,
    ...(errors.length ? { errors } : {}),
    authorization: {
      independent_issue_1656_authorization_comment_required: true,
      authorization_comment_id: null,
      evidence_post: false,
      boundary_patch: false,
      live_github_mutation: false,
    },
    execution_stages: {
      evidence_post: { method: 'POST', separate_from_boundary_patch: true, authorized: false, status: 'not-executed' },
      boundary_patch: { method: 'PATCH', depends_on: 'evidence_post', authorized: false, status: 'not-executed' },
    },
    apply_contract: {
      skeleton_provided: false,
      required_guards: ['independent #1656 authorization comment', 'fresh GET/CAS plan digest', 'writer lock', 'journal', 'unknown-state reconciliation', 'zero blocked rows'],
    },
    mutation_guard: { ...ZERO_MUTATIONS, read_only: true, live_mutation: false },
    scope: { boundary_label: 'boundary:pending', total: EXPECTED_PENDING_COUNT, complete: ok },
    summary: {
      total: EXPECTED_PENDING_COUNT,
      proposal_rows: proposalRows.length,
      blocked_rows: blockedLedger.length,
      single_interview: proposalRows.filter((row) => row.decision === 'single-interview').length,
      multi_interview: proposalRows.filter((row) => row.decision === 'multi-interview').length,
      not_interview: proposalRows.filter((row) => row.decision === 'not-interview').length,
      independent_review_required: blockedLedger.filter((row) => row.status === 'independent-review-required').length,
      durable_reviews: 0,
    },
    proposal_rows: proposalRows,
    blocked_ledger: blockedLedger,
    fail_closed_conditions: [
      'input dynamic plan digest/schema/source binding drift',
      'current pending SourceNote selection is not exactly the 421-item scope',
      'live body SHA, SourceNote identity, SourceRevision, or projection binding drift',
      'duplicate issue rows or duplicate/unsupported evidence locators',
      'any blocked row exists before a future apply phase',
      'independent #1656 authorization, fresh GET/CAS, lock, journal, or unknown reconciliation is absent',
    ],
  };
  return { ...plan, canonical_digest: canonicalDigest(plan) };
}

function blockedPlanner(errors, inputPlan, capturedAt, liveSnapshot = null) {
  return planBase({ inputPlan, capturedAt, ok: false, errors: [...new Set(errors)], proposalRows: [], blockedLedger: [], liveSnapshot });
}

function buildEvidenceTransitionPlan({ reviewPlan, issueSnapshot, inventory, capturedAt = DEFAULT_CAPTURED_AT }) {
  const inputValidation = validateReviewPlan(reviewPlan, inventory);
  if (!inputValidation.ok) return blockedPlanner(['input dynamic review plan rejected', ...inputValidation.errors], reviewPlan, capturedAt, issueSnapshot);
  let inventoryBinding;
  try { inventoryBinding = inventoryIndex(inventory); }
  catch (error) { return blockedPlanner([error.message], reviewPlan, capturedAt, issueSnapshot); }
  let lives;
  try { lives = liveIssueMap(issueSnapshot); }
  catch (error) { return blockedPlanner([error.message], reviewPlan, capturedAt, issueSnapshot); }
  const bindingErrors = [];
  for (const item of reviewPlan.items) bindingErrors.push(...compareLiveBinding(item, lives.get(item.issue_number), inventoryBinding.byNumber.get(item.issue_number)));
  if (bindingErrors.length) return blockedPlanner(bindingErrors, reviewPlan, capturedAt, issueSnapshot);

  const proposalRows = [];
  const blockedLedger = [];
  const proposalErrors = [];
  for (const item of reviewPlan.items) {
    const live = lives.get(item.issue_number);
    if (item.issue_number === 735) {
      blockedLedger.push(blockedLedgerRow(item, live, '#735 requires independent review; no proposal decision or transition is authorized', 'independent-review-required'));
      continue;
    }
    if (!DECISIONS.has(item.proposal?.decision) || item.review?.status !== 'proposal-only') {
      blockedLedger.push(blockedLedgerRow(item, live, item.rationale || 'dynamic review proposal is blocked', 'blocked'));
      continue;
    }
    const errors = validateProposalEvidence(item);
    if (errors.length) proposalErrors.push(`#${item.issue_number}: ${errors.join('; ')}`);
    else {
      const projection = sourceProjectionFromPlan(item);
      proposalRows.push({
        issue_number: item.issue_number,
        source_note_id: item.source_note_id,
        decision: item.proposal.decision,
        expected_body_sha256: item.body_sha256,
        expected_source_revision_id: item.source_revision_id,
        source_revision: item.source_revision,
        source_projection: projection,
        line_evidence: evidenceReferences(item, item.line_evidence),
        transition_request: transitionRequest(item, live, capturedAt),
        live_binding: liveBinding(item, live),
        review: { durable_review: false, evidence_post_allowed: false, boundary_patch_allowed: false },
      });
    }
  }
  if (proposalErrors.length) return blockedPlanner(['proposal evidence rejected', ...proposalErrors], reviewPlan, capturedAt, issueSnapshot);
  if (proposalRows.length + blockedLedger.length !== EXPECTED_PENDING_COUNT) return blockedPlanner(['proposal and blocked ledgers do not partition the complete 421-item scope'], reviewPlan, capturedAt, issueSnapshot);
  const plan = planBase({ inputPlan: reviewPlan, capturedAt, ok: true, errors: [], proposalRows, blockedLedger, liveSnapshot: issueSnapshot });
  return plan;
}

function validateEvidenceTransitionPlan(plan, inputPlan = null) {
  const errors = [];
  if (!plan || plan.schema_version !== SCHEMA_VERSION) errors.push('request plan schema mismatch');
  if (plan?.repository !== REPOSITORY || plan?.issue !== ISSUE || plan?.parent_issue !== PARENT_ISSUE || plan?.upstream_issue !== UPSTREAM_ISSUE) errors.push('request plan issue binding drifted');
  if (plan?.mode !== 'plan-only' || plan?.ok !== true) errors.push('request plan is not an accepted plan-only result');
  if (plan && plan.canonical_digest !== canonicalDigest(without(plan, 'canonical_digest'))) errors.push('request plan canonical digest mismatch');
  if (plan?.source_snapshot?.repository !== SOURCE_REPOSITORY || plan?.source_snapshot?.ref !== SOURCE_REF || !HEX64.test(String(plan?.source_snapshot?.digest || ''))) errors.push('request plan source snapshot binding drifted');
  if (plan?.scope?.total !== EXPECTED_PENDING_COUNT || plan?.scope?.complete !== true) errors.push('request plan does not contain the complete 421-item scope');
  for (const key of Object.keys(ZERO_MUTATIONS)) if (plan?.mutation_guard?.[key] !== 0) errors.push(`mutation_guard.${key} must be zero: ${key}`);
  if (plan?.mutation_guard?.read_only !== true || plan?.mutation_guard?.live_mutation !== false) errors.push('request plan mutation guard is not read-only');
  if (plan?.authorization?.evidence_post !== false || plan?.authorization?.boundary_patch !== false || plan?.authorization?.live_github_mutation !== false) errors.push('request plan contains write authorization');
  if (plan?.execution_stages?.evidence_post?.method !== 'POST' || plan?.execution_stages?.boundary_patch?.method !== 'PATCH' || plan?.execution_stages?.boundary_patch?.depends_on !== 'evidence_post' || plan?.execution_stages?.evidence_post?.authorized !== false || plan?.execution_stages?.boundary_patch?.authorized !== false) errors.push('evidence POST and boundary PATCH stages are not separated and unauthorized');
  const proposals = Array.isArray(plan?.proposal_rows) ? plan.proposal_rows : [];
  const blocked = Array.isArray(plan?.blocked_ledger) ? plan.blocked_ledger : [];
  if (proposals.length + blocked.length !== EXPECTED_PENDING_COUNT) errors.push('proposal and blocked ledgers do not partition 421 items');
  const seen = new Set();
  for (const row of [...proposals, ...blocked]) {
    if (seen.has(row.issue_number)) errors.push(`duplicate issue row: #${row.issue_number}`);
    seen.add(row.issue_number);
  }
  if (seen.size !== EXPECTED_PENDING_COUNT) errors.push('request plan issue set is not complete');
  const issue735 = blocked.find((row) => row.issue_number === 735);
  if (!issue735 || issue735.status !== 'independent-review-required' || issue735.decision !== null) errors.push('#735 is not independently blocked');
  for (const row of blocked) {
    try { validateSourceProjectionArtifact(row.source_projection, row.source_note_id); }
    catch (error) { errors.push(`#${row.issue_number} blocked ledger source projection invalid: ${error.message}`); }
    if (!HEX64.test(String(row.expected_body_sha256 || '')) || !row.expected_source_revision_id) errors.push(`#${row.issue_number} blocked ledger live binding is incomplete`);
    if (row.review?.durable_review !== false || row.review?.evidence_post_allowed !== false || row.review?.boundary_patch_allowed !== false) errors.push(`#${row.issue_number} blocked ledger contains write authorization`);
  }
  for (const row of proposals) {
    if (!DECISIONS.has(row.decision)) errors.push(`#${row.issue_number} proposal decision is invalid`);
    const expectedVersion = row.decision === 'multi-interview' ? TRANSITION_V2 : TRANSITION_V1;
    if (row.transition_request?.schema_version !== expectedVersion) errors.push(`#${row.issue_number} transition schema does not match decision`);
    if (row.review?.durable_review !== false || row.review?.evidence_post_allowed !== false || row.review?.boundary_patch_allowed !== false) errors.push(`#${row.issue_number} contains write authorization`);
    try { validateSourceProjectionArtifact(row.source_projection, row.source_note_id); }
    catch (error) { errors.push(`#${row.issue_number} source projection binding invalid: ${error.message}`); }
    if (row.transition_request?.review_evidence !== null) errors.push(`#${row.issue_number} contains durable evidence comment state`);
    if (row.transition_request?.repository !== REPOSITORY || row.transition_request?.issue_number !== row.issue_number || row.transition_request?.source_note_id !== row.source_note_id || row.transition_request?.expected_body_sha256 !== row.expected_body_sha256 || row.transition_request?.expected_source_revision_id !== row.expected_source_revision_id) errors.push(`#${row.issue_number} transition request live binding drifted`);
    for (const [evidenceIndex, evidence] of (row.transition_request?.source_evidence || []).entries()) errors.push(...validateRequestEvidenceObject(evidence, row.source_projection.ref, row.source_projection.blob_sha, `#${row.issue_number} source_evidence[${evidenceIndex}]`));
    if (row.decision === 'multi-interview') {
      const cases = row.transition_request?.interview_cases;
      if (!Array.isArray(cases) || cases.length < 2) errors.push(`#${row.issue_number} multi request lacks >=2 case keys`);
      const locators = [];
      for (const candidate of Array.isArray(cases) ? cases : []) {
        if (!CASE_KEY.test(String(candidate.case_key || ''))) errors.push(`#${row.issue_number} multi case key invalid`);
        for (const evidence of candidate.evidence || []) {
          errors.push(...validateRequestEvidenceObject(evidence, row.source_projection.ref, row.source_projection.blob_sha, `#${row.issue_number} multi evidence`));
          locators.push(evidence.locator);
        }
      }
      if (new Set(locators).size !== locators.length) errors.push(`#${row.issue_number} multi evidence locators are duplicated`);
    }
  }
  if (inputPlan && plan.input_plan?.canonical_digest !== inputPlan.canonical_digest) errors.push('request plan input plan digest differs from supplied dynamic plan');
  return { ok: errors.length === 0, errors };
}

module.exports = {
  REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, ISSUE, PARENT_ISSUE, UPSTREAM_ISSUE, EXPECTED_PENDING_COUNT,
  TRANSITION_V1, TRANSITION_V2, SCHEMA_VERSION, canonicalize, sha256, sourceProjectionFromPlan,
  validateEvidenceObject, validateProposalEvidence, buildEvidenceTransitionPlan, blockedPlanner,
  validateEvidenceTransitionPlan, DEFAULT_PLAN, DEFAULT_ISSUES, DEFAULT_INVENTORY, DEFAULT_OUTPUT, DEFAULT_CAPTURED_AT,
};
