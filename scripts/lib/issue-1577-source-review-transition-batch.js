'use strict';

const crypto = require('node:crypto');
const {
  canonicalJson,
  sha256Text,
  labelsOf,
  statusOf,
} = require('./issue-1539-recovery-plan');
const {
  computeChecks,
  parseRequest,
  parseReceipts,
  planSourceReview,
  requestSha256,
  validateReceipt,
  validateRequest,
} = require('./interview-note-source-review-transition');
const { validateInterviewNoteIssue } = require('./interview-note-issue');
const { validateSourceNoteIssue } = require('./source-note-issue');
const {
  validateManifest: validatePinnedManifest,
  verifyManifestItem,
} = require('./issue-1539-pinned-artifact-manifest');
const { acquireProgressLock } = require('./issue-1539-evidence-batch');
const { FIXED_ITEMS, validateFixedManifest } = require('./issue-1577-source-review-batch');

const SCOPE = 'issue-1577-fixed-17';
const SCHEMA_VERSION = 'issue-1577-source-review-transition-batch.v1';
const PROGRESS_SCHEMA_VERSION = 'issue-1577-source-review-transition-progress.v1';
const INTENT_SCHEMA_VERSION = 'issue-1577-source-review-transition-intent.v1';
const BATCH_ID = 'issue-1577-source-review-transition-001';
const TARGETS = Object.freeze(FIXED_ITEMS.map((item) => item.interview_issue_number));
const CONTROLLED_TASKS = new Set(['task:source-review', 'task:source-recovery']);
const PHASES = new Set(['planned', 'begin-pending', 'begin-applied', 'final-pending', 'final-applied', 'receipt-pending', 'receipt-uncertain', 'receipt-written', 'complete', 'uncertain']);
const EVIDENCE_MARKER_RE = /<!--\s*interview-note-source-review-evidence\.v1\n([\s\S]*?)\n-->/g;
const TRANSITION_RECEIPT_SCHEMA = 'interview-note-source-review-applied.v1';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function bodySha(issue) { return sha256Text(issue && issue.body || ''); }
function issueSnapshot(issue) {
  return {
    number: Number(issue && issue.number),
    body_sha256: bodySha(issue),
    labels: normalizeLabels(issue && issue.labels, true),
    state: String(issue && issue.state || '').toLowerCase(),
  };
}
function normalizeLabels(labels, strict = false) {
  if (!Array.isArray(labels)) return strict ? null : [];
  const names = [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label && label.name;
    if (typeof name !== 'string' || name.length === 0) {
      if (strict) return null;
      continue;
    }
    if (names.includes(name)) return strict ? null : names;
    names.push(name);
  }
  return names.sort();
}
function controlledLabels(labels) { return normalizeLabels(labels).filter((label) => label.startsWith('status:') || CONTROLLED_TASKS.has(label)); }
function nonLifecycleLabels(labels) { return normalizeLabels(labels).filter((label) => !label.startsWith('status:') && !CONTROLLED_TASKS.has(label)); }
function statusLabels(labels) { return normalizeLabels(labels).filter((label) => label.startsWith('status:')); }
function replaceControlled(labels, status, task = null) {
  return [...new Set([...nonLifecycleLabels(labels), `status:${status}`, ...(task ? [task] : [])])].sort();
}
function operations(before, desired) {
  const a = new Set(controlledLabels(before));
  const b = new Set(controlledLabels(desired));
  return [
    ...[...b].filter((value) => !a.has(value)).sort().map((label) => ({ kind: 'add', label })),
    ...[...a].filter((value) => !b.has(value)).sort().map((label) => ({ kind: 'remove', label })),
  ];
}
function applyOperation(labels, operation) {
  const next = new Set(controlledLabels(labels));
  if (operation.kind === 'add') next.add(operation.label);
  else if (operation.kind === 'remove') next.delete(operation.label);
  else throw new Error(`unsupported lifecycle operation ${operation.kind}`);
  return [...next].sort();
}
function preservesNonLifecycle(labels, baseline) {
  return canonicalJson(nonLifecycleLabels(labels)) === canonicalJson(nonLifecycleLabels(baseline));
}
function evidencePlanSha256(evidencePlan) {
  const { plan_sha256: ignoredPlanSha256, ...base } = evidencePlan || {};
  return sha256Text(canonicalJson({
    schema_version: base.schema_version,
    mode: base.mode,
    issue_number: base.issue_number,
    repository: base.repository,
    fixed_item_count: base.fixed_item_count,
    packet_set_sha256: base.packet_set_sha256,
    pinned_artifact_manifest_sha256: base.pinned_artifact_manifest_sha256,
    authorization_sha256: base.authorization_sha256,
    preflight_ok: base.preflight_ok,
    mutation_count: base.mutation_count,
    mutation_attempted: base.mutation_attempted,
    mutation_performed: base.mutation_performed,
    possibly_performed: base.possibly_performed,
    items: base.items,
  }));
}
function expectedEvidence(marker, request, packetSetSha256) {
  const errors = [];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return { ok: false, errors: ['evidence marker must contain one JSON object'] };
  const fields = [
    ['schema_version', 'interview-note-source-review-evidence.v1'],
    ['repository', request.repository],
    ['issue_number', request.issue_number],
    ['interview_note_id', request.interview_note_id],
    ['source_note_issue_number', request.source_note_issue_number],
    ['source_revision_id', request.expected_source_revision_id],
    ['transition_id', request.transition_id],
    ['evidence_subject_sha256', request.evidence_subject_sha256],
    ['expected_interview_body_sha256', request.expected_interview_body_sha256],
    ['expected_source_note_body_sha256', request.expected_source_note_body_sha256],
    ['provenance_mode', request.provenance_mode],
    ['provenance_statement', request.provenance_statement],
    ['pinned_artifact_manifest_sha256', request.pinned_artifact_manifest_sha256],
    ['decision', request.decision],
    ['packet_set_sha256', packetSetSha256],
  ];
  for (const [field, value] of fields) if (marker[field] !== value) errors.push(`evidence marker ${field} mismatch`);
  if (canonicalJson(marker.checks || []) !== canonicalJson(request.checks || [])) errors.push('evidence marker checks mismatch');
  return { ok: errors.length === 0, errors };
}
function inspectEvidence(comments, request, packetSetSha256, expectedCommentId) {
  const markers = [];
  for (const comment of comments || []) {
    for (const match of String(comment && comment.body || '').matchAll(EVIDENCE_MARKER_RE)) {
      let value = null;
      try { value = JSON.parse(match[1].trim()); } catch (_) { /* reported below */ }
      markers.push({ comment, value });
    }
  }
  const errors = [];
  if (markers.length !== 1) errors.push(`Source Review evidence marker count must be exactly one, got ${markers.length}`);
  const one = markers.length === 1 ? markers[0] : null;
  if (one) {
    errors.push(...expectedEvidence(one.value, request, packetSetSha256).errors);
    if (Number(one.comment.id) !== Number(expectedCommentId)) errors.push('evidence marker comment id mismatch');
    const expectedIssueUrl = `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`;
    if (one.comment.issue_url !== expectedIssueUrl) errors.push('evidence marker Issue locator mismatch');
    if (Object.prototype.hasOwnProperty.call(one.comment, 'repository_url') && one.comment.repository_url !== `https://api.github.com/repos/${request.repository}`) errors.push('evidence marker repository locator mismatch');
  }
  return { ok: errors.length === 0, exact: errors.length === 0 && markers.length === 1, marker_count: markers.length, comment: one && one.comment || null, errors };
}
function transitionReceipt(request, commentId, appliedAt) {
  return {
    schema_version: TRANSITION_RECEIPT_SCHEMA,
    transition_id: request.transition_id,
    request_sha256: requestSha256(request),
    repository: request.repository,
    issue_number: request.issue_number,
    interview_note_id: request.interview_note_id,
    case_key: request.case_key ?? null,
    source_note_issue_number: request.source_note_issue_number,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    interview_body_sha256: request.expected_interview_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    manifest_sha256: request.expected_manifest_sha256 ?? null,
    source_repository_ref: request.expected_source_repository_ref ?? null,
    decision: request.decision,
    final_status: 'source-ready',
    provenance_mode: request.provenance_mode ?? null,
    provenance_statement: request.provenance_statement ?? null,
    pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256 ?? null,
    evidence_subject_sha256: request.evidence_subject_sha256 ?? null,
    reviewed_at: request.reviewed_at,
    applied_at: appliedAt,
    comment_id: Number(commentId),
  };
}
function transitionReceiptBody(receipt) { return `<!-- interview-note-source-review-applied\n${JSON.stringify(receipt, null, 2)}\n-->\n\nSource Review transition applied and post-write validation passed.`; }
function receiptMatchesRequest(receipt, request) {
  const expected = {
    schema_version: TRANSITION_RECEIPT_SCHEMA,
    transition_id: request.transition_id,
    request_sha256: requestSha256(request),
    repository: request.repository,
    issue_number: request.issue_number,
    interview_note_id: request.interview_note_id,
    case_key: request.case_key ?? null,
    source_note_issue_number: request.source_note_issue_number,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    interview_body_sha256: request.expected_interview_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    manifest_sha256: request.expected_manifest_sha256 ?? null,
    source_repository_ref: request.expected_source_repository_ref ?? null,
    decision: request.decision,
    final_status: 'source-ready',
    provenance_mode: request.provenance_mode ?? null,
    provenance_statement: request.provenance_statement ?? null,
    pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256 ?? null,
    evidence_subject_sha256: request.evidence_subject_sha256 ?? null,
    reviewed_at: request.reviewed_at,
  };
  const validation = validateReceipt(receipt);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  const errors = [];
  for (const [field, value] of Object.entries(expected)) if (receipt[field] !== value) errors.push(`transition receipt ${field} mismatch`);
  if (!Number.isInteger(receipt.comment_id) || receipt.comment_id < 1) errors.push('transition receipt comment_id must be the positive live comment id');
  if (!isValidTimestamp(receipt.applied_at)) errors.push('transition receipt applied_at must be a valid timestamp');
  return { ok: errors.length === 0, errors };
}
function isValidTimestamp(value) { return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value)); }
function matchingTransitionReceipt(comments, request) {
  const parsed = parseReceipts(comments || []);
  const candidates = parsed.receipts.filter((receipt) => receipt.transition_id === request.transition_id || receipt.request_sha256 === requestSha256(request));
  const matches = [];
  const errors = [...parsed.errors];
  for (const receipt of candidates) {
    const check = receiptMatchesRequest(receipt, request);
    if (check.ok) matches.push(receipt);
    else errors.push(...check.errors);
  }
  return { receipts: matches, errors };
}
function authSha256(requests, evidencePlan) {
  return sha256Text(canonicalJson({
    scope: SCOPE,
    batch_id: BATCH_ID,
    packet_set_sha256: evidencePlan.packet_set_sha256,
    evidence_authorization_sha256: evidencePlan.authorization_sha256,
    evidence_plan_sha256: evidencePlan.plan_sha256,
    pinned_artifact_manifest_sha256: evidencePlan.pinned_artifact_manifest_sha256,
    requests: requests.map((request) => ({ issue_number: request.issue_number, transition_id: request.transition_id, request_sha256: requestSha256(request), evidence_subject_sha256: request.evidence_subject_sha256 })),
  }));
}
function validateEvidencePlan(evidencePlan) {
  const errors = [];
  if (!evidencePlan || evidencePlan.ok !== true || evidencePlan.preflight_ok !== true) errors.push('evidence plan must be a successful preflight');
  if (!evidencePlan || evidencePlan.issue_number !== 1577 || evidencePlan.fixed_item_count !== 17 || evidencePlan.mode !== 'plan') errors.push('evidence plan scope/shape mismatch');
  if (!evidencePlan || !/^[0-9a-f]{64}$/.test(String(evidencePlan.packet_set_sha256 || ''))) errors.push('evidence plan packet_set_sha256 is required');
  if (!evidencePlan || !/^[0-9a-f]{64}$/.test(String(evidencePlan.authorization_sha256 || ''))) errors.push('evidence plan authorization_sha256 is required');
  if (!evidencePlan || !/^[0-9a-f]{64}$/.test(String(evidencePlan.plan_sha256 || ''))) errors.push('evidence plan plan_sha256 is required');
  if (evidencePlan && /^[0-9a-f]{64}$/.test(String(evidencePlan.plan_sha256 || '')) && evidencePlan.plan_sha256 !== evidencePlanSha256(evidencePlan)) errors.push('evidence plan plan_sha256 is not reproducible');
  if (!evidencePlan || !evidencePlan.pinnedArtifactManifest || !Array.isArray(evidencePlan.pinnedArtifactManifest.items)) errors.push('evidence plan pinned artifact manifest is required');
  if (evidencePlan && evidencePlan.pinnedArtifactManifest) {
    const validation = validatePinnedManifest(evidencePlan.pinnedArtifactManifest);
    if (!validation.ok) errors.push(...validation.errors);
    if (evidencePlan.pinned_artifact_manifest_sha256 !== evidencePlan.pinnedArtifactManifest.digest) errors.push('evidence plan pinned manifest digest mismatch');
  }
  const expected = new Set(TARGETS);
  const seen = new Set();
  for (const item of evidencePlan && evidencePlan.items || []) {
    if (!expected.has(Number(item.interview_issue_number)) || seen.has(Number(item.interview_issue_number))) errors.push('evidence plan contains duplicate or out-of-scope target');
    seen.add(Number(item.interview_issue_number));
    if (item.action !== 'already-present' || item.evidence_marker_count !== 1 || !item.evidence_gate || item.evidence_gate.ok !== true || item.evidence_gate.exact !== true) errors.push(`evidence plan target #${item.interview_issue_number} is not exact already-present evidence`);
  }
  for (const issue of expected) if (!seen.has(issue)) errors.push(`evidence plan missing target #${issue}`);
  return { ok: errors.length === 0, errors };
}
function validateRequests(requests, evidencePlan) {
  const errors = [];
  if (!Array.isArray(requests) || requests.length !== TARGETS.length) errors.push('transition request set must contain exactly 17 requests');
  const seen = new Set();
  for (const [index, request] of (requests || []).entries()) {
    const issue = Number(request && request.issue_number);
    if (issue !== TARGETS[index]) errors.push(`request index ${index} must target #${TARGETS[index]}`);
    if (seen.has(issue)) errors.push(`duplicate request target #${issue}`); seen.add(issue);
    const valid = validateRequest(request || {});
    if (!valid.ok) errors.push(...valid.errors.map((error) => `#${issue}: ${error}`));
    if (!request || request.repository !== 'liqiangcc/interview-lab' || request.transition_id !== `issue-1577-source-review-${issue}` || request.expected_initial_status !== 'captured' || request.recovery_mode != null || request.decision !== 'source-ready') errors.push(`#${issue}: request is not the scoped captured source-ready request`);
    if (!request || request.pinned_artifact_manifest_sha256 !== evidencePlan.pinned_artifact_manifest_sha256) errors.push(`#${issue}: pinned manifest binding mismatch`);
    const evidenceItem = (evidencePlan.items || []).find((item) => Number(item.interview_issue_number) === issue);
    if (!request || !evidenceItem || Number(request.review_evidence && request.review_evidence.comment_id) !== Number(evidenceItem.evidence_comment_id)) errors.push(`#${issue}: evidence plan comment binding mismatch`);
  }
  return { ok: errors.length === 0, errors };
}
function validateLive(request, live, evidencePlan, pinnedManifest) {
  const errors = [];
  if (!live || !live.interviewIssue || !live.sourceIssue || !Array.isArray(live.comments) || !Array.isArray(live.allIssues)) return { ok: false, errors: ['live InterviewNote, SourceNote, comments, and ownership are required'] };
  const labels = normalizeLabels(live.interviewIssue.labels, true);
  if (!labels) errors.push('live InterviewNote labels are malformed or duplicated');
  if (Number(live.interviewIssue.number) !== request.issue_number) errors.push('live InterviewNote identity mismatch');
  if (Number(live.sourceIssue.number) !== request.source_note_issue_number) errors.push('live SourceNote identity mismatch');
  if (bodySha(live.interviewIssue) !== request.expected_interview_body_sha256) errors.push('live InterviewNote body SHA mismatch');
  if (bodySha(live.sourceIssue) !== request.expected_source_note_body_sha256) errors.push('live SourceNote body SHA mismatch');
  if (statusLabels(labels).length !== 1 || !['captured', 'source-review', 'source-ready'].includes(statusOf(live.interviewIssue))) errors.push('live InterviewNote status is unsupported or contradictory');
  const owners = (live.allIssues || []).filter((issue) => !issue.pull_request && String(issue.body || '').includes(`<!-- interview-note: id=${request.interview_note_id} `));
  if (owners.length !== 1 || Number(owners[0].number) !== request.issue_number) errors.push('InterviewNote ownership is not unique');
  const evidenceItem = evidencePlan.items.find((item) => Number(item.interview_issue_number) === request.issue_number);
  const evidence = inspectEvidence(live.comments, request, evidencePlan.packet_set_sha256, evidenceItem && evidenceItem.evidence_comment_id);
  errors.push(...evidence.errors);
  const interviewValidation = validateInterviewNoteIssue({ body: live.interviewIssue.body, labels: labels || [], state: live.interviewIssue.state });
  const sourceValidation = validateSourceNoteIssue({ body: live.sourceIssue.body, labels: labelsOf(live.sourceIssue), state: live.sourceIssue.state });
  if (!interviewValidation.ok) errors.push(...interviewValidation.errors.map((error) => `live InterviewNote invalid: ${error}`));
  if (!sourceValidation.ok) errors.push(...sourceValidation.errors.map((error) => `live SourceNote invalid: ${error}`));
  if (interviewValidation.parsed && interviewValidation.parsed.record.interview_note_id !== request.interview_note_id) errors.push('InterviewNote stable identity mismatch');
  if (sourceValidation.parsed && sourceValidation.parsed.record.source_revision.id !== request.expected_source_revision_id) errors.push('SourceNote SourceRevision mismatch');
  const pinned = verifyManifestItem(pinnedManifest, request, sourceValidation.parsed && sourceValidation.parsed.record);
  if (!pinned.ok) errors.push(...pinned.errors);
  const plannerIssue = statusOf(live.interviewIssue) === 'source-ready'
    ? { ...live.interviewIssue, labels: replaceControlled(labels, 'captured') }
    : live.interviewIssue;
  const parsedReceipts = parseReceipts(live.comments);
  const planner = planSourceReview(request, plannerIssue, { planningOnly: false, sourceIssue: live.sourceIssue, allIssues: live.allIssues, evidenceComment: evidence.comment, receipts: parsedReceipts.receipts, pinnedArtifactManifest: pinnedManifest });
  if (!planner.ok) errors.push(...planner.errors);
  const receipts = matchingTransitionReceipt(live.comments, request);
  if (receipts.errors.length) errors.push(...receipts.errors);
  if (receipts.receipts.length > 1) errors.push('multiple matching transition receipts exist');
  const finalLabels = replaceControlled(labels, 'source-ready');
  const beginLabels = replaceControlled(labels, 'source-review', 'task:source-review');
  if (statusOf(live.interviewIssue) === 'captured' && canonicalJson(controlledLabels(labels)) !== canonicalJson(['status:captured'])) errors.push('captured target has unexpected controlled labels');
  if (statusOf(live.interviewIssue) === 'source-review' && canonicalJson(controlledLabels(labels)) !== canonicalJson(['status:source-review', 'task:source-review'])) errors.push('source-review target has unexpected controlled labels');
  if (statusOf(live.interviewIssue) === 'source-ready' && canonicalJson(labels) !== canonicalJson(finalLabels)) errors.push('source-ready target labels do not preserve the scoped final projection');
  return { ok: errors.length === 0, errors, evidence, receipts: receipts.receipts, current_status: statusOf(live.interviewIssue), live_snapshot: issueSnapshot(live.interviewIssue), begin_labels: beginLabels, final_labels: finalLabels, transition_receipt: receipts.receipts[0] || null };
}
function planBatch({ requests, evidencePlan, liveLoader, pinnedArtifactManifest } = {}) {
  const errors = [];
  const evidenceValidation = validateEvidencePlan(evidencePlan);
  if (!evidenceValidation.ok) errors.push(...evidenceValidation.errors);
  const requestValidation = validateRequests(requests, evidencePlan || {});
  if (!requestValidation.ok) errors.push(...requestValidation.errors);
  if (typeof liveLoader !== 'function') errors.push('liveLoader is required');
  if (errors.length) return { ok: false, mode: 'plan', errors, items: [], mutation_count: 0, possibly_performed: false };
  const items = [];
  for (const request of requests) {
    let live; let check;
    try { live = liveLoader(request); check = validateLive(request, live, evidencePlan, pinnedArtifactManifest || evidencePlan.pinnedArtifactManifest); }
    catch (error) { check = { ok: false, errors: [error.message], current_status: null, live_snapshot: null, evidence: { marker_count: 0, exact: false } }; }
    const action = !check.ok ? 'blocked' : check.current_status === 'captured' ? 'would-transition' : check.current_status === 'source-review' ? 'resume-transition' : check.transition_receipt ? 'already-applied' : 'receipt-repair-only';
    items.push({ packet_id: `issue-1577-source-review-${request.issue_number}`, issue_number: request.issue_number, source_note_issue_number: request.source_note_issue_number, transition_id: request.transition_id, request_sha256: requestSha256(request), action, current_status: check.current_status, evidence_marker_count: check.evidence && check.evidence.marker_count || 0, evidence_comment_id: check.evidence && check.evidence.comment && Number(check.evidence.comment.id) || null, evidence_exact: Boolean(check.evidence && check.evidence.exact), live_snapshot: check.live_snapshot, begin_labels: check.begin_labels || [], final_labels: check.final_labels || [], transition_receipt_id: check.transition_receipt && Number(check.transition_receipt.comment_id) || null, label_operation_count: check.current_status === 'captured' ? operations(check.live_snapshot && check.live_snapshot.labels, check.begin_labels).length + operations(check.begin_labels, check.final_labels).length : 0, errors: check.errors || [] });
    if (!check.ok) errors.push(`#${request.issue_number}: ${check.errors.join('; ')}`);
  }
  const planBase = { schema_version: SCHEMA_VERSION, batch_id: BATCH_ID, scope: SCOPE, issue_number: 1577, repository: 'liqiangcc/interview-lab', packet_set_sha256: evidencePlan.packet_set_sha256, evidence_authorization_sha256: evidencePlan.authorization_sha256, evidence_plan_sha256: evidencePlan.plan_sha256, pinned_artifact_manifest_sha256: evidencePlan.pinned_artifact_manifest_sha256, authorization_sha256: authSha256(requests, evidencePlan), fixed_item_count: 17, preflight_ok: errors.length === 0, mutation_count: 0, mutation_attempted: false, mutation_performed: false, possibly_performed: false, items };
  return { ...planBase, ok: planBase.preflight_ok, mode: 'plan', errors, plan_sha256: sha256Text(canonicalJson(planBase)) };
}
function safeCounts(progress) { return progress && ['label_attempt_count', 'receipt_attempt_count', 'mutation_count'].every((field) => Number.isSafeInteger(progress[field]) && progress[field] >= 0) && progress.label_attempt_count + progress.receipt_attempt_count === progress.mutation_count; }
function initialProgress(plan) { return { schema_version: PROGRESS_SCHEMA_VERSION, batch_id: BATCH_ID, scope: SCOPE, packet_set_sha256: plan.packet_set_sha256, authorization_sha256: plan.authorization_sha256, status: 'planned', label_attempt_count: 0, receipt_attempt_count: 0, mutation_count: 0, mutation_attempted: false, mutation_performed: false, possibly_performed: false, intents: Object.fromEntries(TARGETS.map((issue) => [`issue-1577-source-review-${issue}`, null])), results: {} }; }
function validOperation(operation) { return operation && ['add', 'remove'].includes(operation.kind) && typeof operation.label === 'string' && (operation.label.startsWith('status:') || CONTROLLED_TASKS.has(operation.label)); }
function validSnapshot(snapshot, issue) { return snapshot && Number(snapshot.number) === issue && /^[0-9a-f]{64}$/.test(String(snapshot.body_sha256 || '')) && Array.isArray(snapshot.labels) && normalizeLabels(snapshot.labels, true) != null && typeof snapshot.state === 'string'; }
function validateIntent(id, value, plan, result) {
  const errors = [];
  const issue = Number(id.replace('issue-1577-source-review-', ''));
  const item = (plan.items || []).find((candidate) => Number(candidate.issue_number) === issue);
  if (!Number.isInteger(issue) || !TARGETS.includes(issue) || !item) errors.push('target is not in the transition plan');
  if (value.issue_number !== issue) errors.push('issue_number mismatch');
  if (value.transition_id !== `issue-1577-source-review-${issue}`) errors.push('transition_id mismatch');
  if (value.packet_id !== id) errors.push('packet_id mismatch');
  if (value.packet_set_sha256 !== plan.packet_set_sha256 || value.authorization_sha256 !== plan.authorization_sha256) errors.push('intent digest binding mismatch');
  if (value.intent_id !== sha256Text(`${plan.authorization_sha256}:${value.transition_id}`)) errors.push('intent_id mismatch');
  if (!/^[0-9a-f]{64}$/.test(String(value.request_sha256 || '')) || (item && value.request_sha256 !== item.request_sha256)) errors.push('request_sha256 mismatch');
  if (['begin-pending', 'final-pending'].includes(value.phase)) {
    if (value.stage !== (value.phase.startsWith('begin') ? 'begin' : 'final')) errors.push('pending stage mismatch');
    if (!Array.isArray(value.operation_plan) || value.operation_plan.length === 0 || value.operation_plan.some((operation) => !validOperation(operation))) errors.push('pending operation_plan is invalid');
    if (!Number.isSafeInteger(value.operation_index) || value.operation_index < 0 || value.operation_index > (value.operation_plan || []).length) errors.push('pending operation_index is invalid');
    if (!Array.isArray(value.before_controlled_labels) || canonicalJson(controlledLabels(value.before_controlled_labels)) !== canonicalJson(value.before_controlled_labels)) errors.push('pending before_controlled_labels are invalid');
    if (!Array.isArray(value.desired_controlled_labels) || canonicalJson(controlledLabels(value.desired_controlled_labels)) !== canonicalJson(value.desired_controlled_labels)) errors.push('pending desired_controlled_labels are invalid');
    if (!Array.isArray(value.baseline_non_lifecycle_labels) || canonicalJson(nonLifecycleLabels(value.baseline_non_lifecycle_labels)) !== canonicalJson(value.baseline_non_lifecycle_labels)) errors.push('pending baseline_non_lifecycle_labels are invalid');
    if (!validSnapshot(value.cas, issue)) errors.push('pending CAS snapshot is invalid');
  }
  if (['receipt-pending', 'receipt-uncertain', 'receipt-written'].includes(value.phase)) {
    if (value.receipt_request_sha256 !== value.request_sha256) errors.push('receipt request binding is invalid');
    if (value.phase === 'receipt-pending' && (!value.receipt || value.receipt.request_sha256 !== value.request_sha256 || Number(value.receipt.comment_id) !== 0)) errors.push('receipt-pending intent receipt is invalid');
    if (value.phase === 'receipt-written' && (!Number.isInteger(value.receipt_comment_id) || value.receipt_comment_id < 1)) errors.push('receipt-written comment id is invalid');
  }
  if (value.phase === 'uncertain' && (typeof value.attempted_phase !== 'string' || typeof value.error !== 'string' || value.error.length === 0)) errors.push('uncertain intent requires attempted phase and error');
  if (value.phase === 'uncertain' && ['begin-pending', 'final-pending'].includes(value.attempted_phase)) {
    if (!Array.isArray(value.operation_plan) || value.operation_plan.length === 0 || value.operation_plan.some((operation) => !validOperation(operation))) errors.push('uncertain label intent operation_plan is invalid');
    if (!Number.isSafeInteger(value.operation_index) || value.operation_index < 0 || value.operation_index > (value.operation_plan || []).length) errors.push('uncertain label intent operation_index is invalid');
    if (!Array.isArray(value.operation_prefix) || value.operation_prefix.length !== value.operation_index || value.operation_prefix.some((operation) => !validOperation(operation))) errors.push('uncertain label intent operation_prefix is invalid');
    if (!Array.isArray(value.before_controlled_labels) || canonicalJson(controlledLabels(value.before_controlled_labels)) !== canonicalJson(value.before_controlled_labels)) errors.push('uncertain before_controlled_labels are invalid');
    if (!Array.isArray(value.desired_controlled_labels) || canonicalJson(controlledLabels(value.desired_controlled_labels)) !== canonicalJson(value.desired_controlled_labels)) errors.push('uncertain desired_controlled_labels are invalid');
    if (!Array.isArray(value.baseline_non_lifecycle_labels) || canonicalJson(nonLifecycleLabels(value.baseline_non_lifecycle_labels)) !== canonicalJson(value.baseline_non_lifecycle_labels)) errors.push('uncertain baseline_non_lifecycle_labels are invalid');
    if (!validSnapshot(value.cas, issue)) errors.push('uncertain CAS snapshot is invalid');
  }
  if (value.phase === 'complete') {
    if (!result || result.status !== 'complete') errors.push('complete intent requires a complete result');
    if (result && (result.issue_number !== issue || result.transition_id !== value.transition_id || result.request_sha256 !== value.request_sha256 || Number(result.receipt_comment_id) !== Number(value.receipt_comment_id))) errors.push('complete result binding mismatch');
  }
  return errors;
}
function validateProgress(progress, plan) {
  const errors = [];
  if (!progress || progress.schema_version !== PROGRESS_SCHEMA_VERSION || progress.batch_id !== BATCH_ID || progress.scope !== SCOPE) errors.push('progress schema/batch/scope mismatch');
  if (progress && (progress.packet_set_sha256 !== plan.packet_set_sha256 || progress.authorization_sha256 !== plan.authorization_sha256)) errors.push('progress digest binding mismatch');
  if (!progress || !['planned', 'running', 'failed', 'complete'].includes(progress.status)) errors.push('progress status is invalid');
  if (!safeCounts(progress)) errors.push('progress counters are invalid or inconsistent');
  const ids = new Set(TARGETS.map((issue) => `issue-1577-source-review-${issue}`));
  for (const id of ids) if (!Object.prototype.hasOwnProperty.call(progress && progress.intents || {}, id)) errors.push(`progress missing intent ${id}`);
  for (const id of Object.keys(progress && progress.intents || {})) if (!ids.has(id)) errors.push(`progress has unknown intent ${id}`);
  for (const id of Object.keys(progress && progress.results || {})) if (!ids.has(id)) errors.push(`progress has unknown result ${id}`);
  for (const [id, intent] of Object.entries(progress && progress.intents || {})) if (intent && (intent.schema_version !== INTENT_SCHEMA_VERSION || !PHASES.has(intent.phase) || validateIntent(id, intent, plan, progress.results && progress.results[id]).length)) errors.push(`progress intent ${id} is invalid: ${validateIntent(id, intent, plan, progress.results && progress.results[id]).join('; ')}`);
  for (const [id, intent] of Object.entries(progress && progress.intents || {})) if (intent && intent.phase === 'uncertain') errors.push(`progress intent ${id} is permanently uncertain; explicit replan/operator recovery is required`);
  for (const [id, result] of Object.entries(progress && progress.results || {})) {
    const issue = Number(id.replace('issue-1577-source-review-', ''));
    const item = (plan.items || []).find((candidate) => Number(candidate.issue_number) === issue);
    if (!result || result.status !== 'complete' || result.issue_number !== issue || result.transition_id !== id || !item || result.request_sha256 !== item.request_sha256 || !Number.isInteger(result.receipt_comment_id) || result.receipt_comment_id < 1 || result.receipt_written !== true) errors.push(`progress result ${id} is invalid or not bound to its request`);
  }
  if (progress && progress.status === 'complete') for (const id of ids) if (!progress.intents[id] || progress.intents[id].phase !== 'complete' || !progress.results[id] || progress.possibly_performed) errors.push(`complete progress unresolved for ${id}`);
  return { ok: errors.length === 0, errors };
}
function intent(request, plan, phase, extra = {}) { return { schema_version: INTENT_SCHEMA_VERSION, intent_id: sha256Text(`${plan.authorization_sha256}:${request.transition_id}`), authorization_sha256: plan.authorization_sha256, packet_set_sha256: plan.packet_set_sha256, packet_id: `issue-1577-source-review-${request.issue_number}`, issue_number: request.issue_number, transition_id: request.transition_id, request_sha256: requestSha256(request), phase, ...extra }; }
function persistIntent(progress, request, plan, phase, extra, persist) { const id = `issue-1577-source-review-${request.issue_number}`; progress.intents[id] = intent(request, plan, phase, extra); persist(progress); }
function markUncertain(progress, request, plan, phase, error, persist, extra = {}) { progress.status = 'failed'; progress.mutation_performed = null; progress.possibly_performed = true; const uncertainPhase = ['receipt-pending', 'receipt-uncertain'].includes(phase) ? 'receipt-uncertain' : 'uncertain'; persistIntent(progress, request, plan, uncertainPhase, { attempted_phase: phase, error, ...(uncertainPhase === 'receipt-uncertain' ? { receipt_request_sha256: requestSha256(request) } : {}), ...extra }, persist); }
function pendingLabelPrefix(labels, pending) {
  const normalized = normalizeLabels(labels, true);
  if (!normalized || !pending || !Array.isArray(pending.operation_plan) || !Number.isInteger(pending.operation_index)) return { ok: false, errors: ['pending label intent is malformed'] };
  if (!preservesNonLifecycle(normalized, pending.baseline_non_lifecycle_labels)) return { ok: false, errors: ['pending label intent lost non-lifecycle labels'] };
  const before = Array.isArray(pending.before_controlled_labels) ? pending.before_controlled_labels : [];
  const index = pending.operation_index;
  if (index < 0 || index > pending.operation_plan.length) return { ok: false, errors: ['pending label intent operation index is invalid'] };
  const expectedBefore = pending.operation_plan.slice(0, index).reduce((value, operation) => applyOperation(value, operation), before);
  const expectedAfter = index < pending.operation_plan.length ? applyOperation(expectedBefore, pending.operation_plan[index]) : expectedBefore;
  const actual = controlledLabels(normalized);
  if (canonicalJson(actual) === canonicalJson(expectedBefore)) return { ok: true, next_index: index, kind: 'before' };
  if (index < pending.operation_plan.length && canonicalJson(actual) === canonicalJson(expectedAfter)) return { ok: true, next_index: index + 1, kind: 'after' };
  return { ok: false, errors: ['pending label state is neither the persisted CAS prefix nor its completed operation'] };
}
function applyBatch({ requests, evidencePlan, pinnedArtifactManifest, liveLoader, progress, expectedPlanSha256, expectedAuthorizationSha256 } = {}, options = {}) {
  const assertLock = () => { if (!options.lock || typeof options.lock.assertHeld !== 'function') throw new Error('transition apply requires an acquired progress lock'); options.lock.assertHeld(); };
  if (!progress) return { ok: false, errors: ['transition apply requires progress'] };
  if (typeof liveLoader !== 'function') return { ok: false, errors: ['transition apply requires liveLoader'] };
  if (typeof options.persistProgress !== 'function' || typeof options.patchLabel !== 'function' || typeof options.postReceipt !== 'function' || typeof options.writeReceipt !== 'function' || typeof options.readReceipt !== 'function') return { ok: false, errors: ['transition apply requires durable persistence, label, receipt, and local receipt readers/writers'] };
  try { assertLock(); } catch (error) { return { ok: false, errors: [error.message] }; }
  const permanentlyUncertain = Object.entries(progress.intents || {}).filter(([, value]) => value && value.phase === 'uncertain').map(([id]) => id);
  if (permanentlyUncertain.length) return { ok: false, errors: permanentlyUncertain.map((id) => `progress intent ${id} is permanently uncertain; explicit replan/operator recovery is required`), progress };
  const guardedLiveLoader = (request) => { assertLock(); const value = liveLoader(request); assertLock(); return value; };
  const planFn = options.planBatch || planBatch;
  const validateLiveFn = options.validateLive || validateLive;
  const freshPlan = planFn({ requests, evidencePlan, liveLoader: guardedLiveLoader, pinnedArtifactManifest });
  if (!freshPlan.ok) return { ok: false, errors: freshPlan.errors, items: freshPlan.items };
  if (expectedPlanSha256 && freshPlan.plan_sha256 !== expectedPlanSha256) return { ok: false, errors: [`fresh transition plan digest mismatch: expected ${expectedPlanSha256}, got ${freshPlan.plan_sha256}`] };
  if (expectedAuthorizationSha256 && freshPlan.authorization_sha256 !== expectedAuthorizationSha256) return { ok: false, errors: [`transition authorization digest mismatch: expected ${expectedAuthorizationSha256}, got ${freshPlan.authorization_sha256}`] };
  const validation = validateProgress(progress, freshPlan);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  progress.status = 'running'; assertLock(); options.persistProgress(progress);
  const throttle = options.beforeMutation || (() => {});
  const reconcileAttempts = Number.isInteger(options.reconcileAttempts) && options.reconcileAttempts > 0 ? options.reconcileAttempts : 3;
  const backoff = Number.isInteger(options.reconcileBackoffMs) && options.reconcileBackoffMs >= 0 ? options.reconcileBackoffMs : 1000;
  const readLive = (request) => guardedLiveLoader(request);
  const persist = (value) => { assertLock(); options.persistProgress(value); };
  const markLabelAttempt = () => { progress.label_attempt_count += 1; progress.mutation_count = progress.label_attempt_count + progress.receipt_attempt_count; progress.mutation_attempted = true; progress.mutation_performed = null; progress.possibly_performed = true; persist(progress); };
  const idFor = (request) => `issue-1577-source-review-${request.issue_number}`;
  const ensureLocalReceipt = (request, remoteReceipt, phase = 'receipt-uncertain') => {
    const expected = transitionReceipt(request, remoteReceipt.comment_id, remoteReceipt.applied_at || (options.now ? options.now() : new Date().toISOString()));
    let local = null;
    try { assertLock(); local = options.readReceipt(request); assertLock(); }
    catch (error) {
      if (error && error.code === 'ENOENT') local = null;
      else { markUncertain(progress, request, freshPlan, phase, `local receipt read failed: ${error.message}`, persist, { receipt_comment_id: remoteReceipt.comment_id }); throw error; }
    }
    if (local && canonicalJson(local) === canonicalJson(expected)) return expected;
    try { assertLock(); options.writeReceipt(request, expected); assertLock(); }
    catch (error) {
      markUncertain(progress, request, freshPlan, phase, `local receipt persistence failed: ${error.message}`, persist, { receipt_comment_id: remoteReceipt.comment_id });
      throw error;
    }
    return expected;
  };
  const applyStage = (request, stage, desiredLabels, state) => {
    let current = readLive(request); let labels = normalizeLabels(current.interviewIssue.labels, true); if (!labels) throw new Error(`#${request.issue_number}: malformed labels during ${stage}`);
    const baseline = state.intent && state.intent.baseline_non_lifecycle_labels || nonLifecycleLabels(state.preflight && state.preflight.labels || labels);
    const beforeControlled = state.intent && state.intent.before_controlled_labels || controlledLabels(labels);
    const plan = state.intent && state.intent.stage === stage && Array.isArray(state.intent.operation_plan) ? state.intent.operation_plan : operations(beforeControlled, desiredLabels);
    let index = state.intent && state.intent.stage === stage && Number.isInteger(state.intent.operation_index) ? state.intent.operation_index : 0;
    let lastCasSnapshot = issueSnapshot(current.interviewIssue);
    let patchInvokedInStage = false;
    while (index < plan.length) {
      const expectedControlled = plan.slice(0, index).reduce((value, op) => applyOperation(value, op), beforeControlled);
      if (!preservesNonLifecycle(labels, baseline)) throw new Error(`#${request.issue_number}: ${stage} state changed non-lifecycle labels`);
      const actualControlled = canonicalJson(controlledLabels(labels));
      if (actualControlled === canonicalJson(applyOperation(expectedControlled, plan[index]))) {
        index += 1;
        if (progress.intents[idFor(request)]) progress.intents[idFor(request)] = { ...progress.intents[idFor(request)], operation_index: index };
        state.intent = progress.intents[idFor(request)] || state.intent;
        persist(progress);
        continue;
      }
      if (actualControlled !== canonicalJson(expectedControlled)) throw new Error(`#${request.issue_number}: ${stage} state is not a legal CAS prefix`);
      const op = plan[index];
      persistIntent(progress, request, freshPlan, stage === 'begin' ? 'begin-pending' : 'final-pending', { stage, operation_plan: plan, operation_index: index, before_controlled_labels: beforeControlled, desired_controlled_labels: controlledLabels(desiredLabels), baseline_non_lifecycle_labels: nonLifecycleLabels(baseline), cas: issueSnapshot(current.interviewIssue) }, persist);
      markLabelAttempt();
      const casSnapshot = issueSnapshot(current.interviewIssue);
      const uncertaintyContext = {
        stage,
        operation_plan: clone(plan),
        operation_index: index,
        operation_prefix: clone(plan.slice(0, index)),
        before_controlled_labels: clone(beforeControlled),
        desired_controlled_labels: clone(controlledLabels(desiredLabels)),
        baseline_non_lifecycle_labels: clone(nonLifecycleLabels(baseline)),
        cas: casSnapshot,
      };
      let patchInvoked = false;
      let writeError = null;
      try { assertLock(); throttle(); patchInvokedInStage = true; patchInvoked = true; options.patchLabel(request, op); assertLock(); } catch (error) { if (!patchInvoked) throw error; writeError = error; }
      let converged = false;
      let reconcileError = null;
      for (let attempt = 1; attempt <= reconcileAttempts; attempt += 1) {
        try {
          current = readLive(request); labels = normalizeLabels(current.interviewIssue.labels, true);
          if (!labels || !preservesNonLifecycle(labels, baseline)) throw new Error(`#${request.issue_number}: ${stage} lost non-lifecycle labels`);
          lastCasSnapshot = issueSnapshot(current.interviewIssue);
          const expected = applyOperation(expectedControlled, op);
          if (canonicalJson(controlledLabels(labels)) === canonicalJson(expected)) { converged = true; break; }
          if (attempt < reconcileAttempts) { assertLock(); if (typeof options.sleep === 'function') options.sleep(backoff * (2 ** (attempt - 1))); assertLock(); }
        } catch (error) {
          reconcileError = error;
          break;
        }
      }
      if (!converged) {
        markUncertain(progress, request, freshPlan, stage === 'begin' ? 'begin-pending' : 'final-pending', (reconcileError || writeError || new Error(`${stage} label write did not converge`)).message, persist, uncertaintyContext);
        throw new Error(`#${request.issue_number}: ${stage} label write did not converge; refusing retry`);
      }
      if (typeof options.afterLabelReconcile === 'function') options.afterLabelReconcile(request, stage, op, index);
      index += 1;
      state.intent = null;
    }
    const finalUncertaintyContext = {
      stage,
      operation_plan: clone(plan),
      operation_index: index,
      operation_prefix: clone(plan.slice(0, index)),
      before_controlled_labels: clone(beforeControlled),
      desired_controlled_labels: clone(controlledLabels(desiredLabels)),
      baseline_non_lifecycle_labels: clone(nonLifecycleLabels(baseline)),
      cas: lastCasSnapshot,
    };
    try {
      const finalLive = readLive(request); const finalLabels = normalizeLabels(finalLive.interviewIssue.labels, true);
      if (!finalLabels || !preservesNonLifecycle(finalLabels, baseline) || canonicalJson(controlledLabels(finalLabels)) !== canonicalJson(controlledLabels(desiredLabels))) throw new Error(`#${request.issue_number}: ${stage} final label gate failed`);
      return finalLive;
    } catch (error) {
      if (patchInvokedInStage) {
        markUncertain(progress, request, freshPlan, stage === 'begin' ? 'begin-pending' : 'final-pending', error.message, persist, finalUncertaintyContext);
        throw new Error(`#${request.issue_number}: ${stage} final label gate uncertain; refusing retry`);
      }
      throw error;
    }
  };
  const results = [];
  for (const request of requests) {
    const id = idFor(request); const state = { intent: progress.intents[id], preflight: (freshPlan.items || []).find((item) => Number(item.issue_number) === request.issue_number)?.live_snapshot || null };
    try {
      let live = readLive(request); let checked = validateLiveFn(request, live, evidencePlan, pinnedArtifactManifest || evidencePlan.pinnedArtifactManifest);
      if (!checked.ok && state.intent && ['begin-pending', 'final-pending'].includes(state.intent.phase)) {
        const prefix = pendingLabelPrefix(live.interviewIssue && live.interviewIssue.labels, state.intent);
        if (prefix.ok) {
          const stage = state.intent.stage;
          const normalizedLabels = replaceControlled(live.interviewIssue.labels, stage === 'begin' ? 'captured' : 'source-review', stage === 'begin' ? null : 'task:source-review');
          const normalizedLive = { ...live, interviewIssue: { ...live.interviewIssue, labels: normalizedLabels } };
          const normalizedCheck = validateLiveFn(request, normalizedLive, evidencePlan, pinnedArtifactManifest || evidencePlan.pinnedArtifactManifest);
          if (normalizedCheck.ok) {
            checked = { ...normalizedCheck, current_status: stage === 'begin' ? 'captured' : 'source-review', live_snapshot: issueSnapshot(live.interviewIssue) };
            if (prefix.next_index !== state.intent.operation_index) {
              progress.intents[id] = { ...state.intent, operation_index: prefix.next_index };
              state.intent = progress.intents[id];
              persist(progress);
            }
          }
        }
      }
      if (!checked.ok) throw new Error(checked.errors.join('; '));
      if (state.intent && state.intent.phase === 'complete') { if (checked.current_status !== 'source-ready' || !checked.transition_receipt) throw new Error('completed transition does not match live state'); ensureLocalReceipt(request, checked.transition_receipt, 'receipt-uncertain'); results.push({ issue_number: request.issue_number, action: 'already-applied', mutation_performed: false, receipt_comment_id: checked.transition_receipt.comment_id }); continue; }
      if (checked.current_status === 'source-ready' && checked.transition_receipt) { ensureLocalReceipt(request, checked.transition_receipt); progress.intents[id] = intent(request, freshPlan, 'complete', { receipt_comment_id: checked.transition_receipt.comment_id, mutation_attempted: false, mutation_performed: false, possibly_performed: false }); progress.results[id] = { status: 'complete', issue_number: request.issue_number, transition_id: request.transition_id, request_sha256: requestSha256(request), receipt_comment_id: checked.transition_receipt.comment_id, receipt_written: true, mutation_performed: false }; persist(progress); results.push({ issue_number: request.issue_number, action: 'already-applied', mutation_performed: false, receipt_comment_id: checked.transition_receipt.comment_id }); continue; }
      if (state.intent && !['begin-pending', 'final-pending', 'receipt-pending', 'receipt-uncertain'].includes(state.intent.phase)) state.intent = null;
      if (checked.current_status === 'captured' || (state.intent && state.intent.phase === 'begin-pending')) { live = applyStage(request, 'begin', replaceControlled(normalizeLabels(live.interviewIssue.labels), 'source-review', 'task:source-review'), state); checked = validateLiveFn(request, live, evidencePlan, pinnedArtifactManifest || evidencePlan.pinnedArtifactManifest); if (!checked.ok) throw new Error(checked.errors.join('; ')); progress.intents[id] = intent(request, freshPlan, 'begin-applied', { mutation_attempted: true, mutation_performed: true, possibly_performed: false }); persist(progress); }
      live = readLive(request); checked = validateLiveFn(request, live, evidencePlan, pinnedArtifactManifest || evidencePlan.pinnedArtifactManifest); if (!checked.ok) throw new Error(checked.errors.join('; '));
      if (checked.current_status === 'source-review' || (state.intent && state.intent.phase === 'final-pending')) { live = applyStage(request, 'final', checked.final_labels, state); checked = validateLiveFn(request, live, evidencePlan, pinnedArtifactManifest || evidencePlan.pinnedArtifactManifest); if (!checked.ok) throw new Error(checked.errors.join('; ')); progress.intents[id] = intent(request, freshPlan, 'final-applied', { mutation_attempted: true, mutation_performed: true, possibly_performed: false }); persist(progress); }
      live = readLive(request); checked = validateLiveFn(request, live, evidencePlan, pinnedArtifactManifest || evidencePlan.pinnedArtifactManifest); if (!checked.ok || checked.current_status !== 'source-ready') throw new Error(`#${request.issue_number}: final source-ready gate failed`);
      let receipt = checked.transition_receipt;
      const priorReceiptPhase = Boolean(state.intent && (['receipt-pending', 'receipt-uncertain'].includes(state.intent.phase) || (state.intent.receipt_request_sha256 === requestSha256(request) && progress.receipt_attempt_count > 0 && !progress.results[id])));
      if (priorReceiptPhase && !receipt) {
        markUncertain(progress, request, freshPlan, state.intent.phase, 'prior transition receipt is not exactly recoverable; refusing duplicate POST', persist, { receipt_request_sha256: requestSha256(request) });
        throw new Error(`#${request.issue_number}: prior transition receipt is absent; refusing duplicate POST`);
      }
      if (!receipt) {
        const value = transitionReceipt(request, null, options.now ? options.now() : new Date().toISOString());
        persistIntent(progress, request, freshPlan, 'receipt-pending', { receipt_request_sha256: requestSha256(request), receipt: value }, persist);
        progress.receipt_attempt_count += 1; progress.mutation_count = progress.label_attempt_count + progress.receipt_attempt_count; progress.mutation_attempted = true; progress.mutation_performed = null; progress.possibly_performed = true; persist(progress);
        let writeError = null; let response = null;
        try { assertLock(); throttle(); response = options.postReceipt(request, transitionReceipt(request, 0, value.applied_at)); assertLock(); } catch (error) { writeError = error; }
        for (let attempt = 1; attempt <= reconcileAttempts; attempt += 1) {
          live = readLive(request); checked = validateLiveFn(request, live, evidencePlan, pinnedArtifactManifest || evidencePlan.pinnedArtifactManifest); receipt = checked.transition_receipt;
          if (checked.ok && receipt) break;
          if (attempt < reconcileAttempts) { assertLock(); if (typeof options.sleep === 'function') options.sleep(backoff * (2 ** (attempt - 1))); assertLock(); }
        }
        if (!receipt) { markUncertain(progress, request, freshPlan, 'receipt-pending', writeError ? writeError.message : 'transition receipt did not converge', persist, { receipt_request_sha256: requestSha256(request) }); throw new Error(`#${request.issue_number}: transition receipt uncertain; refusing retry`); }
        ensureLocalReceipt(request, receipt);
        persistIntent(progress, request, freshPlan, 'receipt-written', { receipt_request_sha256: requestSha256(request), receipt_comment_id: receipt.comment_id, mutation_attempted: true, mutation_performed: true, possibly_performed: false }, persist);
      }
      ensureLocalReceipt(request, receipt);
      progress.mutation_performed = true; progress.possibly_performed = false; progress.results[id] = { status: 'complete', issue_number: request.issue_number, transition_id: request.transition_id, request_sha256: requestSha256(request), receipt_comment_id: receipt.comment_id, receipt_written: true, mutation_attempted: true, mutation_performed: true, possibly_performed: false }; persistIntent(progress, request, freshPlan, 'complete', { receipt_comment_id: receipt.comment_id, mutation_attempted: true, mutation_performed: true, possibly_performed: false }, persist); results.push({ issue_number: request.issue_number, action: 'applied', mutation_performed: true, receipt_comment_id: receipt.comment_id });
    } catch (error) { if (!progress.possibly_performed) { progress.status = 'failed'; persist(progress); } return { ok: false, errors: [`#${request.issue_number}: ${error.message}`], items: results, progress }; }
  }
  progress.status = 'complete'; progress.possibly_performed = false; progress.mutation_count = progress.label_attempt_count + progress.receipt_attempt_count; persist(progress); return { ok: true, errors: [], items: results, progress };
}

module.exports = { SCOPE, SCHEMA_VERSION, PROGRESS_SCHEMA_VERSION, INTENT_SCHEMA_VERSION, BATCH_ID, TARGETS, FIXED_ITEMS, validateFixedManifest, normalizeLabels, controlledLabels, nonLifecycleLabels, preservesNonLifecycle, replaceControlled, operations, inspectEvidence, evidencePlanSha256, transitionReceipt, transitionReceiptBody, receiptMatchesRequest, matchingTransitionReceipt, validateEvidencePlan, validateRequests, validateLive, planBatch, initialProgress, validateProgress, applyBatch, acquireProgressLock };
