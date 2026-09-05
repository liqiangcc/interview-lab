'use strict';

const {
  ISSUE_NUMBERS,
  BATCH_ID,
  PROGRESS_SCHEMA_VERSION,
  PACKET_SET_SHA256,
  PINNED_ARTIFACT_MANIFEST_SHA256,
  lifecycleLabels,
  nonLifecycleLabels,
  lifecycleOperationPlan,
  applyLifecycleOperation,
  labelPendingIntent,
  intentFor,
  issueSnapshot,
} = require('./issue-1539-source-review-transition-batch');
const { canonicalJson, sha256Text } = require('./issue-1539-recovery-plan');
const { requestSha256 } = require('./interview-note-source-review-transition');

const LEGACY_PLAN_SHA256 = 'ed3770529310da7ebb20873d580011b076c1fc278b277bf22a360eec12c6bab9';
const RECOVERY_SCHEMA_VERSION = 'issue-1539-legacy-uncertain-recovery.v1';

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function validSha(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function planBase(plan) {
  return {
    schema_version: plan.schema_version,
    batch_id: plan.batch_id,
    repository: plan.repository,
    packet_set_sha256: plan.packet_set_sha256,
    pinned_artifact_manifest_sha256: plan.pinned_artifact_manifest_sha256,
    total: plan.total,
    errors: plan.errors,
    items: plan.items,
  };
}
function livePrefixSha256(issue) {
  const snapshot = issueSnapshot(issue);
  return sha256Text(canonicalJson({
    number: snapshot.number,
    body_sha256: snapshot.body_sha256,
    labels: snapshot.labels,
    state: snapshot.state,
  }));
}
function planItemMap(plan) {
  return new Map((plan && plan.items || []).map((item) => [Number(item.issue_number), item]));
}
function validateLegacyPlanArtifact(plan, requests, expectedPlanSha256 = LEGACY_PLAN_SHA256) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['legacy plan artifact must be an object'] };
  if (plan.plan_sha256 !== expectedPlanSha256) errors.push('legacy plan artifact digest does not match the authorized plan digest');
  if (sha256Text(canonicalJson(planBase(plan))) !== expectedPlanSha256) errors.push('legacy plan artifact digest is not reproducible');
  if (plan.mode !== 'plan' || plan.mutation_attempted !== false || plan.mutation_performed !== false || plan.possibly_performed !== false) errors.push('legacy plan artifact must be a mutation-free plan');
  if (plan.batch_id !== BATCH_ID || plan.packet_set_sha256 !== PACKET_SET_SHA256 || plan.pinned_artifact_manifest_sha256 !== PINNED_ARTIFACT_MANIFEST_SHA256) errors.push('legacy plan artifact batch anchors mismatch');
  if (plan.total !== ISSUE_NUMBERS.length || !Array.isArray(plan.items) || plan.items.length !== ISSUE_NUMBERS.length || !Array.isArray(plan.errors) || plan.errors.length !== 0) errors.push('legacy plan artifact must contain the complete error-free 30-item batch');
  const expected = new Map((requests || []).map((request) => [Number(request.issue_number), request]));
  const actual = planItemMap(plan);
  if (actual.size !== expected.size) errors.push('legacy plan artifact item identities are not unique and complete');
  for (const issue of ISSUE_NUMBERS) {
    const request = expected.get(issue);
    const item = actual.get(issue);
    if (!request || !item) { errors.push(`legacy plan artifact is missing #${issue}`); continue; }
    if (item.source_note_issue_number !== request.source_note_issue_number || item.transition_id !== request.transition_id || item.request_sha256 !== requestSha256(request)) errors.push(`legacy plan artifact identity mismatch for #${issue}`);
  }
  const item = actual.get(1509);
  if (item && (item.action !== 'begin-source-review-then-final' || item.current_status !== 'blocked' || item.needs_begin !== true || !Array.isArray(item.begin_labels) || !item.live_snapshot)) errors.push('legacy #1509 plan item is not the original blocked begin plan');
  return { ok: errors.length === 0, errors };
}
function validateLegacyProgress(progress, requests, plan, expectedPlanSha256 = LEGACY_PLAN_SHA256) {
  const errors = [];
  if (!progress || progress.schema_version !== PROGRESS_SCHEMA_VERSION) errors.push('progress schema_version mismatch');
  if (!progress || progress.batch_id !== BATCH_ID) errors.push('progress batch_id mismatch');
  if (!progress || progress.packet_set_sha256 !== PACKET_SET_SHA256) errors.push('progress packet_set_sha256 mismatch');
  if (!progress || progress.pinned_artifact_manifest_sha256 !== PINNED_ARTIFACT_MANIFEST_SHA256) errors.push('progress manifest digest mismatch');
  if (!progress || progress.status !== 'failed' || progress.mutation_attempted !== true || progress.mutation_performed !== null || progress.possibly_performed !== true) errors.push('progress is not the recorded uncertain legacy apply state');
  const expected = new Map((requests || []).map((request) => [String(request.issue_number), request]));
  const actual = progress && progress.items || {};
  if (Object.keys(actual).length !== expected.size) errors.push('progress must contain exactly the 30 fixed items');
  for (const [key, request] of expected) {
    const item = actual[key];
    if (!item || item.issue_number !== request.issue_number || item.transition_id !== request.transition_id || item.request_sha256 !== requestSha256(request)) errors.push(`progress identity mismatch for #${key}`);
    if (Number(key) === 1509) {
      if (!item || item.phase !== 'uncertain' || !item.intent || item.intent.attempted_phase !== 'begin-pending' || item.result?.status !== 'uncertain') errors.push('#1509 is not the recorded uncertain begin state');
    } else if (!item || item.phase !== 'planned' || item.possibly_performed === true) errors.push(`#${key} must remain planned and non-uncertain`);
  }
  for (const key of Object.keys(actual)) if (!expected.has(key)) errors.push(`progress contains unknown item #${key}`);
  const planValidation = validateLegacyPlanArtifact(plan, requests, expectedPlanSha256);
  if (!planValidation.ok) errors.push(...planValidation.errors.map((error) => `plan: ${error}`));
  return { ok: errors.length === 0, errors };
}
function assessLegacyLivePrefix(plan, progress, requests, live, receipts = []) {
  const errors = [];
  const item = planItemMap(plan).get(1509);
  const request = (requests || []).find((value) => Number(value.issue_number) === 1509);
  if (!item || !request) errors.push('legacy recovery requires #1509 request and plan item');
  const progressItem = progress && progress.items && progress.items['1509'];
  if (!progressItem || progressItem.phase !== 'uncertain' || progressItem.intent?.attempted_phase !== 'begin-pending') errors.push('progress must prove #1509 begin uncertain');
  const issue = live && live.interviewIssue;
  if (!issue || Number(issue.number) !== 1509) errors.push('live InterviewNote must be #1509');
  if (item && issue) {
    if (!item.live_snapshot || issueSnapshot(issue).body_sha256 !== item.live_snapshot.body_sha256) errors.push('live #1509 body does not match original plan snapshot');
    if (issueSnapshot(issue).state !== item.live_snapshot.state) errors.push('live #1509 state does not match original plan snapshot');
    const before = lifecycleLabels(item.live_snapshot.labels);
    const desired = lifecycleLabels(item.begin_labels);
    const operations = lifecycleOperationPlan(before, desired);
    const currentSnapshot = issueSnapshot(issue);
    const current = lifecycleLabels(currentSnapshot.labels);
    const baseline = nonLifecycleLabels(item.live_snapshot.labels);
    const uncontrolled = nonLifecycleLabels(currentSnapshot.labels);
    if (!baseline.every((label) => uncontrolled.includes(label))) errors.push('live #1509 lost an uncontrolled baseline label');
    const prefixes = [before];
    for (const operation of operations) prefixes.push(applyLifecycleOperation(prefixes[prefixes.length - 1], operation));
    const prefixIndex = prefixes.findIndex((prefix) => canonicalJson(prefix) === canonicalJson(current));
    if (prefixIndex < 0) errors.push('live #1509 controlled labels are not an original plan prefix');
    if (prefixIndex === operations.length && canonicalJson(current) !== canonicalJson(desired)) errors.push('live #1509 prefix calculation is inconsistent');
    if (Array.isArray(receipts) && receipts.length !== 0) errors.push('legacy #1509 must have no receipt');
    return {
      ok: errors.length === 0,
      errors,
      request,
      planItem: item,
      issue,
      before,
      desired,
      operations,
      prefixIndex,
      uncontrolled,
      live_prefix_sha256: livePrefixSha256(issue),
    };
  }
  return { ok: false, errors };
}
function buildLegacyRecoveryProgress(plan, progress, assessment, expectedPlanSha256 = LEGACY_PLAN_SHA256) {
  if (!assessment.ok) throw new Error(assessment.errors.join('; '));
  const next = clone(progress);
  const item = next.items['1509'];
  const priorUncertainIntent = clone(item.intent);
  const desiredLabels = [...new Set([...assessment.uncontrolled, ...assessment.desired])].sort();
  const pendingIntent = intentFor(assessment.request, 'begin-pending', {
    ...labelPendingIntent('begin', desiredLabels, issueSnapshot(assessment.issue), assessment.operations, Math.min(assessment.prefixIndex, assessment.operations.length - 1), assessment.uncontrolled, assessment.before),
    recovered_from_legacy_uncertain: true,
    legacy_plan_sha256: expectedPlanSha256,
    live_prefix_sha256: assessment.live_prefix_sha256,
    prior_uncertain_intent: priorUncertainIntent,
  });
  item.phase = 'begin-pending';
  delete item.possibly_performed;
  item.intent = pendingIntent;
  item.result = { status: 'pending', phase: 'begin-pending', recovered_from_legacy_uncertain: true, mutation_attempted: true, mutation_performed: null, possibly_performed: true };
  next.status = 'running';
  next.mutation_attempted = true;
  next.mutation_performed = null;
  next.possibly_performed = true;
  return next;
}
function recoverLegacyUncertain({ plan, progress, requests, live, receipts, expectedPlanSha256 = LEGACY_PLAN_SHA256 }) {
  const planValidation = validateLegacyPlanArtifact(plan, requests, expectedPlanSha256);
  const progressValidation = validateLegacyProgress(progress, requests, plan, expectedPlanSha256);
  const assessment = assessLegacyLivePrefix(plan, progress, requests, live, receipts);
  const errors = [...planValidation.errors, ...progressValidation.errors.filter((error) => !error.startsWith('plan: ')), ...assessment.errors];
  if (errors.length) return { ok: false, errors };
  const recoveryProgress = buildLegacyRecoveryProgress(plan, progress, assessment, expectedPlanSha256);
  return {
    ok: true,
    recovery_schema_version: RECOVERY_SCHEMA_VERSION,
    mode: 'plan',
    issue_number: 1509,
    legacy_plan_sha256: expectedPlanSha256,
    live_prefix_sha256: assessment.live_prefix_sha256,
    prefix_index: assessment.prefixIndex,
    operation_plan: assessment.operations,
    next_operation: assessment.operations[assessment.prefixIndex] || null,
    recovery_progress: recoveryProgress,
    write_performed: false,
    mutation_performed: false,
  };
}

module.exports = {
  LEGACY_PLAN_SHA256,
  RECOVERY_SCHEMA_VERSION,
  livePrefixSha256,
  validateLegacyPlanArtifact,
  validateLegacyProgress,
  assessLegacyLivePrefix,
  buildLegacyRecoveryProgress,
  recoverLegacyUncertain,
};
