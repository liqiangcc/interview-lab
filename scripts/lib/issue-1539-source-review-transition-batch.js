'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  planSourceReview,
  requestSha256,
  buildReceipt,
  validateRequest,
} = require('./interview-note-source-review-transition');
const {
  validateManifest,
  verifyManifestDigest,
} = require('./issue-1539-pinned-artifact-manifest');
const { canonicalJson, sha256Text } = require('./issue-1539-recovery-plan');

const BATCH_SCHEMA_VERSION = 'issue-1539-source-review-transition-batch.v1';
const PROGRESS_SCHEMA_VERSION = 'issue-1539-source-review-transition-progress.v1';
const INTENT_SCHEMA_VERSION = 'issue-1539-source-review-transition-intent.v1';
const BATCH_ID = 'issue-1539-source-review-transition-001';
const REPOSITORY = 'liqiangcc/interview-lab';
const PACKET_SET_SHA256 = '347c4019ab07e455e0a164bd1216cb26876a80c30788916295b7c1dc1beb52d2';
const PINNED_ARTIFACT_MANIFEST_SHA256 = '4f40de87cc5b65f2ef0c93f25ca19235f7a9386db8811a12530b77374fce9b45';
const ISSUE_NUMBERS = Object.freeze(Array.from({ length: 30 }, (_, index) => 1509 + index));
const PHASES = new Set([
  'planned', 'begin-pending', 'begin-applied', 'final-pending', 'final-applied',
  'receipt-pending', 'receipt-posted', 'complete', 'uncertain', 'failed',
]);
const PENDING_PHASES = new Set(['begin-pending', 'final-pending', 'receipt-pending']);
const LIFECYCLE_LABELS = new Set(['task:source-recovery', 'task:source-review']);
const RECEIPT_MARKER = 'interview-note-source-review-applied';
const LABEL_CONVERGENCE_TIMEOUT_MS = 15000;
const LABEL_CONVERGENCE_MAX_ATTEMPTS = 8;
const LABEL_CONVERGENCE_INITIAL_BACKOFF_MS = 100;
const LABEL_CONVERGENCE_MAX_BACKOFF_MS = 2000;

function normalizeLabelNames(labels, { strict = false } = {}) {
  if (!Array.isArray(labels)) return strict ? null : [];
  const names = [];
  for (const label of labels) {
    if (typeof label === 'string' && label.length > 0) {
      names.push(label);
    } else if (label && typeof label === 'object' && typeof label.name === 'string' && label.name.length > 0) {
      names.push(label.name);
    } else if (strict) {
      return null;
    }
  }
  return [...new Set(names)].sort();
}
function sortedLabels(issue) { return normalizeLabelNames(issue && issue.labels || []); }
function issueSnapshot(issue) {
  return {
    number: Number(issue && issue.number),
    body_sha256: sha256Text(issue && issue.body || ''),
    labels: sortedLabels(issue),
    state: String(issue && issue.state || '').toLowerCase(),
    updated_at: issue && issue.updated_at || null,
  };
}
function sameSnapshot(a, b) { return canonicalJson(a) === canonicalJson(b); }
function labelsMatch(issueSnapshotValue, labels) {
  return Boolean(issueSnapshotValue) && canonicalJson(issueSnapshotValue.labels) === canonicalJson([...labels].sort());
}
function isLifecycleLabel(label) { return typeof label === 'string' && (label.startsWith('status:') || LIFECYCLE_LABELS.has(label)); }
function lifecycleLabels(labels) { return normalizeLabelNames(labels).filter(isLifecycleLabel); }
function nonLifecycleLabels(labels) { return normalizeLabelNames(labels).filter((label) => !isLifecycleLabel(label)); }
function lifecycleLabelsMatch(issueSnapshotValue, labels) {
  return Boolean(issueSnapshotValue) && canonicalJson(lifecycleLabels(issueSnapshotValue.labels)) === canonicalJson(lifecycleLabels(labels));
}
function preservesNonLifecycleLabels(issueSnapshotValue, beforeLabels) {
  if (!issueSnapshotValue) return false;
  const after = new Set(nonLifecycleLabels(issueSnapshotValue.labels));
  return nonLifecycleLabels(beforeLabels).every((label) => after.has(label));
}
function lifecycleLabelDelta(beforeLabels, desiredLabels) {
  const before = new Set(lifecycleLabels(beforeLabels));
  const desired = new Set(lifecycleLabels(desiredLabels));
  return {
    add: [...desired].filter((label) => !before.has(label)).sort(),
    remove: [...before].filter((label) => !desired.has(label)).sort(),
  };
}
function lifecycleOperationPlan(beforeLabels, desiredLabels) {
  const delta = lifecycleLabelDelta(beforeLabels, desiredLabels);
  return [
    ...delta.add.map((label) => ({ kind: 'add', label })),
    ...delta.remove.map((label) => ({ kind: 'remove', label })),
  ];
}
function applyLifecycleOperation(controlledLabels, operation) {
  const next = new Set(controlledLabels);
  if (operation.kind === 'add') next.add(operation.label);
  else if (operation.kind === 'remove') next.delete(operation.label);
  else throw new Error(`unsupported lifecycle label operation: ${operation.kind}`);
  return [...next].sort();
}
function pendingOperationAssessment(state, issue) {
  const intent = state && state.intent;
  const stage = state && pendingStage(state.phase);
  if (!stage || !intent || !Array.isArray(intent.before_controlled_labels)
    || !Array.isArray(intent.desired_controlled_labels) || !Array.isArray(intent.uncontrolled_labels)
    || !Array.isArray(intent.operation_plan) || !Number.isInteger(intent.operation_index)) {
    return { ok: false, error: 'pending label sub-intent is incomplete' };
  }
  const liveLabels = normalizeLabelNames(issue && issue.labels, { strict: true });
  const beforeLabels = normalizeLabelNames(intent.before_controlled_labels, { strict: true });
  const desiredLabels = normalizeLabelNames(intent.desired_controlled_labels, { strict: true });
  const uncontrolledLabels = normalizeLabelNames(intent.uncontrolled_labels, { strict: true });
  if (!liveLabels || !beforeLabels || !desiredLabels || !uncontrolledLabels) {
    return { ok: false, error: 'pending label recovery encountered malformed labels' };
  }
  const before = lifecycleLabels(beforeLabels);
  const desired = lifecycleLabels(desiredLabels);
  const operations = lifecycleOperationPlan(before, desired);
  if (canonicalJson(intent.operation_plan) !== canonicalJson(operations)) return { ok: false, error: 'pending label operation plan is not reproducible' };
  if (intent.operation_index < 0 || intent.operation_index >= operations.length) return { ok: false, error: 'pending label operation index is out of range' };
  const current = lifecycleLabels(liveLabels);
  const uncontrolled = nonLifecycleLabels(liveLabels);
  const baseline = nonLifecycleLabels(uncontrolledLabels);
  if (!baseline.every((label) => uncontrolled.includes(label))) return { ok: false, error: 'pending label recovery detected lost unrelated labels' };
  let completed = -1;
  let prefix = before;
  if (canonicalJson(current) === canonicalJson(prefix)) completed = 0;
  for (let index = 0; index < operations.length; index += 1) {
    prefix = applyLifecycleOperation(prefix, operations[index]);
    if (canonicalJson(current) === canonicalJson(prefix)) completed = index + 1;
  }
  if (completed < 0) return { ok: false, error: 'pending label recovery found a non-legal controlled label set' };
  if (completed === operations.length) return { ok: true, kind: 'complete', stage, completed, operations, before, desired, baseline, current, uncontrolled };
  if (completed === 0) return { ok: true, kind: 'retry', stage, next_index: 0, completed, operations, before, desired, baseline, current, uncontrolled };
  if (completed === intent.operation_index + 1) return { ok: true, kind: 'advance', stage, next_index: completed, completed, operations, before, desired, baseline, current, uncontrolled };
  if (completed === intent.operation_index) return { ok: true, kind: 'retry', stage, next_index: completed, completed, operations, before, desired, baseline, current, uncontrolled };
  return { ok: false, error: 'pending label recovery found an unexpected lifecycle operation prefix' };
}
function pendingPlannerIssue(issue, assessment) {
  const controlled = assessment.kind === 'complete' ? assessment.desired : assessment.before;
  const planner = { ...issue, labels: [...assessment.uncontrolled, ...controlled].sort() };
  return planner;
}
function pendingDesiredLabels(issue, assessment) {
  return [...new Set([...nonLifecycleLabels((issue && issue.labels) || []), ...assessment.desired])].sort();
}
function requestIds(requests) { return requests.map((request) => Number(request.issue_number)); }
function batchIntentId(request) { return sha256Text(`${BATCH_ID}:${PACKET_SET_SHA256}:${request.issue_number}:${requestSha256(request)}`); }
function pendingStage(phase) {
  if (phase === 'begin-pending') return 'begin';
  if (phase === 'final-pending') return 'final';
  return null;
}
function validSnapshot(snapshot) {
  return Boolean(snapshot && typeof snapshot === 'object' && Number.isInteger(snapshot.number) && snapshot.number > 0
    && /^[0-9a-f]{64}$/.test(String(snapshot.body_sha256 || '')) && Array.isArray(snapshot.labels)
    && snapshot.labels.every((label) => typeof label === 'string') && typeof snapshot.state === 'string'
    && (snapshot.updated_at == null || (typeof snapshot.updated_at === 'string' && !Number.isNaN(Date.parse(snapshot.updated_at)))));
}
function intentFor(request, phase, extra = {}) {
  return {
    schema_version: INTENT_SCHEMA_VERSION,
    intent_id: batchIntentId(request),
    batch_id: BATCH_ID,
    packet_set_sha256: PACKET_SET_SHA256,
    issue_number: request.issue_number,
    transition_id: request.transition_id,
    request_sha256: requestSha256(request),
    phase,
    ...extra,
  };
}
function initialProgress(requests) {
  return {
    schema_version: PROGRESS_SCHEMA_VERSION,
    batch_id: BATCH_ID,
    packet_set_sha256: PACKET_SET_SHA256,
    pinned_artifact_manifest_sha256: PINNED_ARTIFACT_MANIFEST_SHA256,
    status: 'planned',
    mutation_attempted: false,
    mutation_performed: false,
    possibly_performed: false,
    items: Object.fromEntries(requests.map((request) => [String(request.issue_number), {
      issue_number: request.issue_number,
      transition_id: request.transition_id,
      request_sha256: requestSha256(request),
      phase: 'planned',
      intent: intentFor(request, 'planned'),
      result: null,
    }])),
  };
}

function validateBatchInputs(requests, pinnedArtifactManifest) {
  const errors = [];
  if (!Array.isArray(requests) || requests.length !== ISSUE_NUMBERS.length) errors.push('batch must contain exactly 30 requests');
  const actualIssues = requestIds(requests || []);
  if (canonicalJson(actualIssues) !== canonicalJson(ISSUE_NUMBERS)) errors.push('batch requests must be exactly InterviewNote Issues #1509-#1538 in order');
  const seenTransitions = new Set();
  for (const request of requests || []) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) { errors.push('each batch request must be an object'); continue; }
    const requestValidation = validateRequest(request);
    if (!requestValidation.ok) errors.push(...requestValidation.errors.map((error) => `#${request.issue_number}: ${error}`));
    if (request.repository !== REPOSITORY) errors.push(`#${request.issue_number}: repository must be ${REPOSITORY}`);
    if (request.expected_initial_status !== 'blocked') errors.push(`#${request.issue_number}: expected_initial_status must be blocked`);
    if (request.recovery_mode !== 'blocked-source-recovery') errors.push(`#${request.issue_number}: blocked-source-recovery is required`);
    if (request.decision !== 'source-ready') errors.push(`#${request.issue_number}: decision must be source-ready`);
    if (request.pinned_artifact_manifest_sha256 !== PINNED_ARTIFACT_MANIFEST_SHA256) errors.push(`#${request.issue_number}: pinned artifact manifest digest mismatch`);
    if (seenTransitions.has(request.transition_id)) errors.push(`#${request.issue_number}: duplicate transition_id`);
    seenTransitions.add(request.transition_id);
  }
  if (!pinnedArtifactManifest) errors.push('pinned artifact manifest is required');
  else {
    const validation = validateManifest(pinnedArtifactManifest);
    if (!validation.ok) errors.push(...validation.errors.map((error) => `pinned manifest: ${error}`));
    const digest = verifyManifestDigest(pinnedArtifactManifest, PINNED_ARTIFACT_MANIFEST_SHA256);
    if (!digest.ok) errors.push(...digest.errors);
    const manifestItems = new Map((pinnedArtifactManifest.items || []).map((item) => [`${item.interview_issue_number}:${item.source_note_issue_number}`, item]));
    for (const request of requests || []) {
      const item = manifestItems.get(`${request.issue_number}:${request.source_note_issue_number}`);
      if (!item) errors.push(`#${request.issue_number}: pinned manifest mapping is missing`);
      else if (item.source_revision_id !== request.expected_source_revision_id) errors.push(`#${request.issue_number}: pinned manifest SourceRevision mismatch`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function actionForPlan(plan) {
  if (!plan || !plan.ok) return 'blocked';
  if (plan.already_applied) return 'already-applied';
  if (plan.needs_receipt_repair) return 'receipt-repair-only';
  if (plan.needs_begin) return 'begin-source-review-then-final';
  if (plan.current_status === 'source-review') return 'final-source-ready';
  return 'blocked';
}

function planOne(request, live, pinnedArtifactManifest, planTransition = planSourceReview, pendingItem = null) {
  if (!live || !live.interviewIssue || !live.sourceIssue || !live.evidenceComment) {
    return { ok: false, errors: ['live InterviewNote, SourceNote, and evidence comment are required'] };
  }
  const receipts = live.receipts || [];
  let plannerIssue = live.interviewIssue;
  let pending = null;
  if (pendingItem && (pendingItem.phase === 'begin-pending' || pendingItem.phase === 'final-pending')) {
    pending = pendingOperationAssessment(pendingItem, live.interviewIssue);
    if (!pending.ok) return { ok: false, errors: [pending.error], action: 'blocked', live_snapshot: issueSnapshot(live.interviewIssue) };
    plannerIssue = pendingPlannerIssue(live.interviewIssue, pending);
  }
  const plan = planTransition(request, plannerIssue, {
    planningOnly: false,
    sourceIssue: live.sourceIssue,
    allIssues: live.allIssues || [],
    evidenceComment: live.evidenceComment,
    receipts,
    pinnedArtifactManifest,
  });
  if (pending && plan.ok) {
    const declaredDesired = pendingDesiredLabels(live.interviewIssue, pending);
    const plannerDesired = pending.stage === 'begin' ? plan.begin_labels : plan.final_labels;
    if (canonicalJson(lifecycleLabels(declaredDesired)) !== canonicalJson(lifecycleLabels(plannerDesired))) {
      return { ok: false, errors: [`pending ${pending.stage} desired lifecycle labels conflict with the authoritative planner`], action: 'blocked', live_snapshot: issueSnapshot(live.interviewIssue) };
    }
  }
  const planned = {
    ...plan,
    action: actionForPlan(plan),
    live_snapshot: issueSnapshot(live.interviewIssue),
    ...(pending ? { pending_assessment: pending } : {}),
  };
  if (pending) {
    const desired = pendingDesiredLabels(live.interviewIssue, pending);
    if (pending.stage === 'begin') planned.begin_labels = desired;
    if (pending.stage === 'final') planned.final_labels = desired;
  }
  return planned;
}

function planBatch(requests, pinnedArtifactManifest, options = {}) {
  const input = validateBatchInputs(requests, pinnedArtifactManifest);
  if (!input.ok) return { ok: false, errors: input.errors, items: [] };
  if (typeof options.loadLive !== 'function') throw new Error('loadLive is required');
  const items = [];
  const errors = [];
  for (const request of requests) {
    const progressItem = options.progress && options.progress.items && options.progress.items[String(request.issue_number)];
    let live;
    let plan;
    try {
      live = options.loadLive(request);
      plan = planOne(request, live, pinnedArtifactManifest, options.planTransition, options.progress && options.progress.items[String(request.issue_number)]);
    } catch (error) {
      plan = { ok: false, errors: [error.message], action: 'blocked', live_snapshot: null };
    }
    const item = {
      issue_number: request.issue_number,
      source_note_issue_number: request.source_note_issue_number,
      transition_id: request.transition_id,
      request_sha256: requestSha256(request),
      action: plan.action,
      current_status: plan.current_status || null,
      live_snapshot: plan.live_snapshot,
      begin_labels: plan.begin_labels || [],
      final_labels: plan.final_labels || [],
      receipt_mutation: plan.already_applied ? 'none' : plan.needs_receipt_repair ? 'receipt-only' : plan.ok ? 'receipt-after-transition' : 'none',
      already_applied: Boolean(plan.already_applied),
      needs_receipt_repair: Boolean(plan.needs_receipt_repair),
      needs_begin: Boolean(plan.needs_begin),
      pending_phase: progressItem && PENDING_PHASES.has(progressItem.phase) ? progressItem.phase : null,
      pending_operation_index: progressItem && (progressItem.phase === 'begin-pending' || progressItem.phase === 'final-pending')
        ? progressItem.intent && Number.isInteger(progressItem.intent.operation_index) ? progressItem.intent.operation_index : null
        : null,
      pending_intent_sha256: progressItem && PENDING_PHASES.has(progressItem.phase) && progressItem.intent
        ? sha256Text(canonicalJson(progressItem.intent))
        : null,
      plan,
    };
    items.push(item);
    if (!plan.ok) errors.push(`#${request.issue_number}: ${(plan.errors || ['plan failed']).join('; ')}`);
  }
  const reportBase = {
    schema_version: BATCH_SCHEMA_VERSION,
    batch_id: BATCH_ID,
    repository: REPOSITORY,
    packet_set_sha256: PACKET_SET_SHA256,
    pinned_artifact_manifest_sha256: PINNED_ARTIFACT_MANIFEST_SHA256,
    total: items.length,
    errors,
    items: items.map(({ plan, ...item }) => item),
  };
  return {
    ok: errors.length === 0,
    errors,
    items,
    report: { ...reportBase, plan_sha256: sha256Text(canonicalJson(reportBase)) },
  };
}

function validateProgress(progress, requests) {
  const errors = [];
  if (!progress || progress.schema_version !== PROGRESS_SCHEMA_VERSION) errors.push('progress schema_version mismatch');
  if (!progress || progress.batch_id !== BATCH_ID) errors.push('progress batch_id mismatch');
  if (!progress || progress.packet_set_sha256 !== PACKET_SET_SHA256) errors.push('progress packet_set_sha256 mismatch');
  if (!progress || progress.pinned_artifact_manifest_sha256 !== PINNED_ARTIFACT_MANIFEST_SHA256) errors.push('progress pinned artifact manifest mismatch');
  if (!progress || !['planned', 'running', 'failed', 'complete'].includes(progress.status)) errors.push('progress status is not allowed');
  const expected = new Map((requests || []).map((request) => [String(request.issue_number), request]));
  const actual = progress && progress.items || {};
  let pendingCount = 0;
  if (Object.keys(actual).length !== expected.size) errors.push('progress item count mismatch');
  for (const [issue, request] of expected) {
    const item = actual[issue];
    if (!item) { errors.push(`progress missing item #${issue}`); continue; }
    if (item.issue_number !== request.issue_number || item.transition_id !== request.transition_id || item.request_sha256 !== requestSha256(request)) errors.push(`progress identity mismatch for #${issue}`);
    if (!PHASES.has(item.phase)) errors.push(`progress phase is not allowed for #${issue}: ${item.phase}`);
    if (!item.intent || item.intent.schema_version !== INTENT_SCHEMA_VERSION || item.intent.intent_id !== batchIntentId(request) || item.intent.request_sha256 !== requestSha256(request) || item.intent.phase !== item.phase) errors.push(`progress intent is not reproducible for #${issue}`);
    if (PENDING_PHASES.has(item.phase)) {
      pendingCount += 1;
      const stage = pendingStage(item.phase);
      if (item.phase !== 'receipt-pending') {
        const intent = item.intent;
        const operationPlan = intent && Array.isArray(intent.operation_plan) ? intent.operation_plan : null;
        const reproducible = operationPlan && Array.isArray(intent.before_controlled_labels)
          && Array.isArray(intent.desired_controlled_labels)
          && canonicalJson(operationPlan) === canonicalJson(lifecycleOperationPlan(intent.before_controlled_labels, intent.desired_controlled_labels))
          && Number.isInteger(intent.operation_index)
          && intent.operation_index >= 0 && intent.operation_index < operationPlan.length;
        if (!intent || intent.stage !== stage || !Array.isArray(intent.expected_labels) || !validSnapshot(intent.cas)
          || !Array.isArray(intent.uncontrolled_labels) || !reproducible) errors.push(`progress pending ${stage} intent is incomplete for #${issue}`);
      }
      if (item.phase === 'receipt-pending' && (!item.intent || item.intent.receipt_request_sha256 !== requestSha256(request))) errors.push(`progress receipt intent is not bound to request for #${issue}`);
    }
    if (item.phase === 'uncertain' || item.possibly_performed === true) errors.push(`progress contains uncertain mutation for #${issue}`);
  }
  for (const key of Object.keys(actual)) if (!expected.has(key)) errors.push(`progress contains unknown item #${key}`);
  if (pendingCount > 1) errors.push('progress contains multiple pending mutation phases');
  if (progress && progress.possibly_performed === true && pendingCount === 0) errors.push('progress contains an uncertain mutation');
  return { ok: errors.length === 0, errors };
}

function persistIntent(progress, request, phase, extra, persistProgress) {
  const item = progress.items[String(request.issue_number)];
  item.phase = phase;
  item.intent = intentFor(request, phase, extra);
  if (persistProgress) persistProgress(progress);
}

function markUncertain(progress, request, phase, error, persistProgress) {
  const item = progress.items[String(request.issue_number)];
  const priorPendingSubIntent = PENDING_PHASES.has(phase) && item && item.intent
    ? JSON.parse(JSON.stringify(item.intent)) : null;
  progress.status = 'failed';
  progress.mutation_attempted = true;
  progress.mutation_performed = null;
  progress.possibly_performed = true;
  item.phase = 'uncertain';
  item.possibly_performed = true;
  item.intent = intentFor(request, 'uncertain', {
    attempted_phase: phase,
    error,
    ...(priorPendingSubIntent ? { prior_pending_sub_intent: priorPendingSubIntent } : {}),
  });
  item.result = { status: 'uncertain', phase, error, mutation_attempted: true, mutation_performed: null, possibly_performed: true };
  if (persistProgress) persistProgress(progress);
}

function assertStagePlan(request, plan, stage) {
  if (!plan || !plan.ok) throw new Error(`#${request.issue_number}: ${stage} precondition planner failed: ${(plan && plan.errors || []).join('; ')}`);
  if (stage === 'begin' && (!plan.needs_begin || plan.current_status !== request.expected_initial_status)) throw new Error(`#${request.issue_number}: begin CAS requires live blocked state`);
  if (stage === 'final' && plan.current_status !== 'source-review') throw new Error(`#${request.issue_number}: final CAS requires live source-review state`);
}
function stageConverged(plan, stage, labels, beforeSnapshot, request) {
  return plan && plan.ok
    && ((stage === 'begin' && plan.current_status === 'source-review') || (stage === 'final' && plan.current_status === request.decision))
    && lifecycleLabelsMatch(plan.live_snapshot, labels)
    && preservesNonLifecycleLabels(plan.live_snapshot, beforeSnapshot && beforeSnapshot.labels);
}
function operationConverged(issue, beforeSnapshot, operation) {
  if (!issue || !beforeSnapshot) return false;
  const current = lifecycleLabels(issue.labels || []);
  const expected = applyLifecycleOperation(lifecycleLabels(beforeSnapshot.labels), operation);
  return canonicalJson(current) === canonicalJson(expected) && preservesNonLifecycleLabels(issueSnapshot(issue), beforeSnapshot.labels);
}

function pollLabelOperationConvergence(request, beforeSnapshot, operation, baselineUncontrolled, loadLive, options = {}) {
  if (typeof loadLive !== 'function') throw new Error('loadLive is required for label convergence polling');
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const sleep = typeof options.sleep === 'function' ? options.sleep : (() => {});
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs >= 0
    ? options.timeoutMs : LABEL_CONVERGENCE_TIMEOUT_MS;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts >= 0
    ? options.maxAttempts : LABEL_CONVERGENCE_MAX_ATTEMPTS;
  const initialBackoffMs = Number.isInteger(options.initialBackoffMs) && options.initialBackoffMs >= 0
    ? options.initialBackoffMs : LABEL_CONVERGENCE_INITIAL_BACKOFF_MS;
  const maxBackoffMs = Number.isInteger(options.maxBackoffMs) && options.maxBackoffMs >= 0
    ? options.maxBackoffMs : LABEL_CONVERGENCE_MAX_BACKOFF_MS;
  const startedAt = clock();
  let attempts = 0;
  let lastLive = null;
  while (true) {
    lastLive = loadLive(request);
    const issue = lastLive && lastLive.interviewIssue;
    const snapshot = issue && issueSnapshot(issue);
    if (operationConverged(issue, beforeSnapshot, operation)
      && preservesNonLifecycleLabels(snapshot, baselineUncontrolled)) {
      return { ok: true, issue, snapshot, attempts };
    }
    const elapsed = clock() - startedAt;
    if (attempts >= maxAttempts || elapsed >= timeoutMs) {
      return { ok: false, issue, snapshot, attempts, elapsed };
    }
    const backoff = Math.min(maxBackoffMs, initialBackoffMs * (2 ** attempts));
    const remaining = Math.max(0, timeoutMs - elapsed);
    if (remaining === 0) return { ok: false, issue, snapshot, attempts, elapsed };
    sleep(Math.min(backoff, remaining));
    attempts += 1;
  }
}

function labelPendingIntent(stage, desiredLabels, beforeSnapshot, operationPlan, operationIndex, uncontrolledLabels = beforeSnapshot.labels, originalBeforeControlled = null) {
  return {
    stage,
    expected_labels: [...desiredLabels].sort(),
    cas: beforeSnapshot,
    before_controlled_labels: originalBeforeControlled ? [...originalBeforeControlled].sort() : lifecycleLabels(beforeSnapshot.labels),
    desired_controlled_labels: lifecycleLabels(desiredLabels),
    uncontrolled_labels: nonLifecycleLabels(uncontrolledLabels),
    operation_plan: operationPlan,
    operation_index: operationIndex,
    operation: operationPlan[operationIndex] || null,
  };
}

function reconcilePendingLabels(progress, request, state, issue, persistProgress) {
  if (!state || !['begin-pending', 'final-pending'].includes(state.phase)) return { ok: true, assessment: null };
  const assessment = pendingOperationAssessment(state, issue);
  if (!assessment.ok) {
    markUncertain(progress, request, state.phase, assessment.error, persistProgress);
    return { ok: false, error: `#${request.issue_number}: ${assessment.error}` };
  }
  const currentSnapshot = issueSnapshot(issue);
  const desiredLabels = pendingDesiredLabels(issue, assessment);
  if (assessment.kind === 'complete') {
    const appliedPhase = assessment.stage === 'begin' ? 'begin-applied' : 'final-applied';
    progress.mutation_attempted = true;
    progress.mutation_performed = true;
    progress.possibly_performed = false;
    state.result = { ...(state.result || {}), [`${assessment.stage}_labels`]: desiredLabels, mutation_attempted: true, mutation_performed: true, possibly_performed: false };
    persistIntent(progress, request, appliedPhase, {
      ...labelPendingIntent(assessment.stage, desiredLabels, currentSnapshot, assessment.operations, assessment.operations.length, assessment.baseline, assessment.before),
      recovered: true,
    }, persistProgress);
    return { ok: true, assessment, recovered: true };
  }
  const nextIndex = assessment.next_index;
  persistIntent(progress, request, state.phase, labelPendingIntent(
    assessment.stage,
    desiredLabels,
    currentSnapshot,
    assessment.operations,
    nextIndex,
    assessment.baseline,
    assessment.before,
  ), persistProgress);
  return { ok: true, assessment, recovered: false };
}

function reconcilePendingPhase(progress, request, state, plan, persistProgress) {
  const phase = state.phase;
  if (!PENDING_PHASES.has(phase)) return { ok: true, plan, mutationPerformed: false };
  if (!plan || !plan.ok) {
    markUncertain(progress, request, phase, `pending ${phase} live planner failed: ${(plan && plan.errors || []).join('; ')}`, persistProgress);
    return { ok: false, error: `#${request.issue_number}: pending ${phase} live planner failed` };
  }
  if (phase === 'receipt-pending') {
    if (plan.already_applied) {
      progress.mutation_attempted = true;
      progress.mutation_performed = true;
      progress.possibly_performed = false;
      state.result = { ...(state.result || {}), receipt_comment_id: plan.receipt && plan.receipt.comment_id || null, mutation_attempted: true, mutation_performed: true, possibly_performed: false };
      persistIntent(progress, request, 'receipt-posted', { receipt_comment_id: state.result.receipt_comment_id, recovered: true }, persistProgress);
      return { ok: true, plan, mutationPerformed: true };
    }
    markUncertain(progress, request, phase, 'receipt-pending has no matching live receipt; refusing a possibly duplicate POST', persistProgress);
    return { ok: false, error: `#${request.issue_number}: receipt-pending has no matching live receipt` };
  }
  // Label pending phases are reconciled from raw labels before planOne. This branch
  // is retained only for receipt-pending, whose state has no label sub-intent.
  if (phase !== 'receipt-pending') throw new Error('label pending phase must be reconciled before planOne');
  if (plan.already_applied) {
    progress.mutation_attempted = true;
    progress.mutation_performed = true;
    progress.possibly_performed = false;
    state.result = { ...(state.result || {}), receipt_comment_id: plan.receipt && plan.receipt.comment_id || null, mutation_attempted: true, mutation_performed: true, possibly_performed: false };
    persistIntent(progress, request, 'receipt-posted', { receipt_comment_id: state.result.receipt_comment_id, recovered: true }, persistProgress);
    return { ok: true, plan, mutationPerformed: true };
  }
  markUncertain(progress, request, phase, 'receipt-pending has no matching live receipt; refusing a possibly duplicate POST', persistProgress);
  return { ok: false, error: `#${request.issue_number}: receipt-pending has no matching live receipt` };
}

function applyBatch(requests, pinnedArtifactManifest, progress, options = {}) {
  if (typeof options.loadLive !== 'function') throw new Error('loadLive is required');
  if (typeof options.persistProgress !== 'function') throw new Error('persistProgress is required for apply');
  if (typeof options.patchLabels !== 'function') throw new Error('patchLabels is required for apply');
  if (typeof options.postReceipt !== 'function') throw new Error('postReceipt is required for apply');
  const validProgress = validateProgress(progress, requests);
  if (!validProgress.ok) return { ok: false, errors: validProgress.errors, items: [] };
  const preflight = planBatch(requests, pinnedArtifactManifest, { ...options, progress });
  if (!preflight.ok) {
    for (const request of requests) {
      const state = progress.items[String(request.issue_number)];
      const item = preflight.items.find((value) => value.issue_number === request.issue_number);
      if ((state.phase === 'begin-pending' || state.phase === 'final-pending') && item && !item.plan.ok) {
        markUncertain(progress, request, state.phase, item.plan.errors.join('; '), options.persistProgress);
      }
    }
    return { ok: false, errors: preflight.errors, items: preflight.items };
  }
  if (options.expectedPlanSha256 != null && options.expectedPlanSha256 !== preflight.report.plan_sha256) {
    return {
      ok: false,
      errors: [`plan confirmation mismatch: expected ${preflight.report.plan_sha256}`],
      items: preflight.items,
    };
  }
  progress.status = 'running';
  options.persistProgress(progress);
  const resultItems = [];
  for (const request of requests) {
    const key = String(request.issue_number);
    const state = progress.items[key];
    const planned = preflight.items.find((item) => item.issue_number === request.issue_number);
    let live;
    let plan;
    try {
      live = options.loadLive(request);
      if (state.phase === 'begin-pending' || state.phase === 'final-pending') {
        const pendingLabels = reconcilePendingLabels(progress, request, state, live.interviewIssue, options.persistProgress);
        if (!pendingLabels.ok) throw new Error(pendingLabels.error);
      }
      plan = planOne(request, live, pinnedArtifactManifest, options.planTransition, state);
      if (!plan.ok) {
        if (state.phase === 'receipt-pending') markUncertain(progress, request, state.phase, plan.errors.join('; '), options.persistProgress);
        throw new Error(plan.errors.join('; '));
      }
      if (state.phase === 'receipt-pending') {
        const pending = reconcilePendingPhase(progress, request, state, plan, options.persistProgress);
        if (!pending.ok) throw new Error(pending.error);
        plan = pending.plan;
      }
      if (state.phase === 'complete') {
        if (!plan.already_applied) throw new Error(`#${request.issue_number}: completed progress does not match live receipt/state`);
        resultItems.push({ issue_number: request.issue_number, action: 'already-applied', mutation_performed: false, receipt_comment_id: plan.receipt && plan.receipt.comment_id || null });
        continue;
      }
      if (plan.already_applied) {
        const recoveredMutation = state.result && state.result.mutation_attempted === true;
        state.result = { ...(state.result || {}), status: 'complete', action: 'already-applied', mutation_attempted: recoveredMutation, mutation_performed: recoveredMutation, possibly_performed: false, receipt_comment_id: plan.receipt && plan.receipt.comment_id || null };
        persistIntent(progress, request, 'complete', { receipt_comment_id: plan.receipt && plan.receipt.comment_id || null }, options.persistProgress);
        resultItems.push({ issue_number: request.issue_number, action: 'already-applied', mutation_performed: recoveredMutation, receipt_comment_id: plan.receipt && plan.receipt.comment_id || null });
        continue;
      }

      if (state.phase === 'planned' && !sameSnapshot(plan.live_snapshot, planned.live_snapshot)) throw new Error(`#${request.issue_number}: full-preflight InterviewNote CAS changed before mutation`);
      let mutationPerformed = false;

      const patchStage = (stage, labels, pendingPhase, appliedPhase) => {
        const latestLive = options.loadLive(request);
        const latestPlan = planOne(request, latestLive, pinnedArtifactManifest, options.planTransition, state);
        assertStagePlan(request, latestPlan, stage);
        if (state.phase === 'planned' && !sameSnapshot(latestPlan.live_snapshot, planned.live_snapshot)) throw new Error(`#${request.issue_number}: ${stage} label CAS changed since full preflight`);
        const beforeSnapshot = latestPlan.live_snapshot;
        const desiredLabels = [...new Set([...nonLifecycleLabels(beforeSnapshot.labels), ...labels])].sort();
        const existingIntent = state.phase === pendingPhase ? state.intent : null;
        const operations = existingIntent && Array.isArray(existingIntent.operation_plan)
          ? existingIntent.operation_plan
          : lifecycleOperationPlan(beforeSnapshot.labels, desiredLabels);
        const beforeControlled = existingIntent && Array.isArray(existingIntent.before_controlled_labels)
          ? existingIntent.before_controlled_labels
          : lifecycleLabels(beforeSnapshot.labels);
        const baselineUncontrolled = existingIntent && Array.isArray(existingIntent.uncontrolled_labels)
          ? existingIntent.uncontrolled_labels
          : nonLifecycleLabels(beforeSnapshot.labels);
        let operationIndex = existingIntent && Number.isInteger(existingIntent.operation_index) ? existingIntent.operation_index : 0;
        if (!operations.length) throw new Error(`#${request.issue_number}: ${stage} has no lifecycle label operation to apply`);
        let currentSnapshot = beforeSnapshot;
        const originalBeforeSnapshot = { ...beforeSnapshot, labels: [...baselineUncontrolled, ...beforeControlled].sort() };
        while (operationIndex < operations.length) {
          const operation = operations[operationIndex];
          const expectedBefore = operationIndex === 0
            ? beforeControlled
            : operations.slice(0, operationIndex).reduce((labelsValue, value) => applyLifecycleOperation(labelsValue, value), beforeControlled);
          if (canonicalJson(lifecycleLabels(currentSnapshot.labels)) !== canonicalJson(expectedBefore)
            || !preservesNonLifecycleLabels(currentSnapshot, baselineUncontrolled)) {
            markUncertain(progress, request, pendingPhase, `${stage} lifecycle state is not a legal operation prefix`, options.persistProgress);
            throw new Error(`#${request.issue_number}: ${stage} lifecycle state is not a legal operation prefix`);
          }
          persistIntent(progress, request, pendingPhase, labelPendingIntent(
            stage,
            desiredLabels,
            currentSnapshot,
            operations,
            operationIndex,
            baselineUncontrolled,
            beforeControlled,
          ), options.persistProgress);
          progress.mutation_attempted = true;
          progress.mutation_performed = null;
          progress.possibly_performed = true;
          options.persistProgress(progress);
          let patchError = null;
          try { options.patchLabels(request, desiredLabels, currentSnapshot, operation); }
          catch (error) { patchError = error; }
          let afterLive;
          try { afterLive = options.loadLive(request); }
          catch (error) { throw error; }
          const converged = operationConverged(afterLive.interviewIssue, currentSnapshot, operation)
            && preservesNonLifecycleLabels(afterLive.interviewIssue && issueSnapshot(afterLive.interviewIssue), baselineUncontrolled);
          if (converged) {
            currentSnapshot = issueSnapshot(afterLive.interviewIssue);
            operationIndex += 1;
            continue;
          }
          const polled = pollLabelOperationConvergence(request, currentSnapshot, operation, baselineUncontrolled, options.loadLive, {
            clock: options.clock,
            sleep: options.sleep,
            timeoutMs: options.labelConvergenceTimeoutMs,
            maxAttempts: options.labelConvergenceMaxAttempts,
            initialBackoffMs: options.labelConvergenceInitialBackoffMs,
            maxBackoffMs: options.labelConvergenceMaxBackoffMs,
          });
          if (polled.ok) {
            currentSnapshot = polled.snapshot;
            operationIndex += 1;
            continue;
          }
          const reason = patchError ? `${patchError.message}; label convergence polling exhausted` : `${stage} lifecycle operation did not converge after bounded polling`;
          markUncertain(progress, request, pendingPhase, reason, options.persistProgress);
          throw new Error(`#${request.issue_number}: ${reason}`);
        }
        const after = planOne(request, options.loadLive(request), pinnedArtifactManifest, options.planTransition);
        const converged = stageConverged(after, stage, desiredLabels, originalBeforeSnapshot, request);
        if (!converged) { markUncertain(progress, request, pendingPhase, `${stage} label mutation did not converge`, options.persistProgress); throw new Error(`#${request.issue_number}: ${stage} label mutation did not converge`); }
        progress.mutation_performed = true;
        progress.possibly_performed = false;
        state.result = { ...(state.result || {}), [`${stage}_labels`]: desiredLabels, mutation_attempted: true, mutation_performed: true, possibly_performed: false };
        persistIntent(progress, request, appliedPhase, { ...labelPendingIntent(stage, desiredLabels, after.live_snapshot, operations, operations.length, baselineUncontrolled), recovered: operationIndex > 0 && state.phase === pendingPhase }, options.persistProgress);
        plan = after;
        mutationPerformed = true;
      };

      if (plan.needs_begin || state.phase === 'begin-pending') patchStage('begin', plan.begin_labels, 'begin-pending', 'begin-applied');
      live = options.loadLive(request);
      plan = planOne(request, live, pinnedArtifactManifest, options.planTransition);
      if (!plan.ok) throw new Error(plan.errors.join('; '));
      if (!plan.already_applied && (plan.current_status === 'source-review' || state.phase === 'begin-applied' || state.phase === 'final-pending')) patchStage('final', plan.final_labels, 'final-pending', 'final-applied');
      live = options.loadLive(request);
      plan = planOne(request, live, pinnedArtifactManifest, options.planTransition);
      if (!plan.ok) throw new Error(plan.errors.join('; '));
      if (!plan.already_applied) {
        if (!plan.needs_receipt_repair) throw new Error(`#${request.issue_number}: final state is not receipt-repairable`);
        const receipt = buildReceipt(request, request.decision, options.now ? options.now() : new Date().toISOString());
        persistIntent(progress, request, 'receipt-pending', { receipt_request_sha256: requestSha256(request) }, options.persistProgress);
        progress.mutation_attempted = true;
        progress.mutation_performed = null;
        progress.possibly_performed = true;
        options.persistProgress(progress);
        let response;
        try {
          response = options.postReceipt(request, receipt);
        } catch (error) {
          const recovered = planOne(request, options.loadLive(request), pinnedArtifactManifest, options.planTransition);
          if (!recovered.ok || !recovered.already_applied) { markUncertain(progress, request, 'receipt-pending', error.message, options.persistProgress); throw new Error(`#${request.issue_number}: receipt response lost and live receipt was not recoverable`); }
          plan = recovered;
        }
        const responseIdValid = response != null && Number.isInteger(Number(response.id)) && Number(response.id) >= 1;
        if (!responseIdValid) {
          const recovered = planOne(request, options.loadLive(request), pinnedArtifactManifest, options.planTransition);
          if (!recovered.ok || !recovered.already_applied) { markUncertain(progress, request, 'receipt-pending', 'receipt POST returned no valid comment id and live receipt was not recoverable', options.persistProgress); throw new Error(`#${request.issue_number}: receipt POST returned no valid comment id and live receipt was not recoverable`); }
          plan = recovered;
          response = null;
        }
        if (response) {
          const afterReceipt = planOne(request, options.loadLive(request), pinnedArtifactManifest, options.planTransition);
          if (!afterReceipt.ok || !afterReceipt.already_applied) { markUncertain(progress, request, 'receipt-pending', 'receipt POST did not converge to matching live receipt', options.persistProgress); throw new Error(`#${request.issue_number}: receipt POST did not converge`); }
          plan = afterReceipt;
        }
        progress.mutation_performed = true;
        progress.possibly_performed = false;
        state.result = { ...(state.result || {}), receipt_comment_id: plan.receipt && plan.receipt.comment_id || response && response.id || null, mutation_attempted: true, mutation_performed: true, possibly_performed: false };
        persistIntent(progress, request, 'receipt-posted', { receipt_comment_id: state.result.receipt_comment_id }, options.persistProgress);
      }
      progress.mutation_performed = progress.mutation_performed === true || mutationPerformed;
      progress.possibly_performed = false;
      state.result = { ...(state.result || {}), status: 'complete', action: 'applied', mutation_attempted: true, mutation_performed: true, possibly_performed: false };
      persistIntent(progress, request, 'complete', { receipt_comment_id: state.result.receipt_comment_id || plan.receipt && plan.receipt.comment_id || null }, options.persistProgress);
      resultItems.push({ issue_number: request.issue_number, action: 'applied', mutation_performed: true, receipt_comment_id: state.result.receipt_comment_id || plan.receipt && plan.receipt.comment_id || null });
    } catch (error) {
      if (!progress.possibly_performed && state.phase !== 'uncertain') {
        progress.status = 'failed';
        state.result = { ...(state.result || {}), status: 'failed', error: error.message };
        options.persistProgress(progress);
      }
      return { ok: false, errors: [`#${request.issue_number}: ${error.message}`], items: resultItems, progress };
    }
  }
  progress.status = 'complete';
  progress.possibly_performed = false;
  options.persistProgress(progress);
  return { ok: true, errors: [], items: resultItems, progress };
}

function durableWriteJson(file, value) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, absolute);
  try { const directory = fs.openSync(path.dirname(absolute), 'r'); fs.fsyncSync(directory); fs.closeSync(directory); } catch (_) { /* best effort on platforms without directory fsync */ }
}

module.exports = {
  BATCH_SCHEMA_VERSION,
  PROGRESS_SCHEMA_VERSION,
  INTENT_SCHEMA_VERSION,
  BATCH_ID,
  REPOSITORY,
  PACKET_SET_SHA256,
  PINNED_ARTIFACT_MANIFEST_SHA256,
  ISSUE_NUMBERS,
  PHASES,
  PENDING_PHASES,
  LIFECYCLE_LABELS,
  RECEIPT_MARKER,
  LABEL_CONVERGENCE_TIMEOUT_MS,
  LABEL_CONVERGENCE_MAX_ATTEMPTS,
  LABEL_CONVERGENCE_INITIAL_BACKOFF_MS,
  LABEL_CONVERGENCE_MAX_BACKOFF_MS,
  initialProgress,
  validateBatchInputs,
  validateProgress,
  planOne,
  planBatch,
  applyBatch,
  issueSnapshot,
  sameSnapshot,
  normalizeLabelNames,
  isLifecycleLabel,
  lifecycleLabels,
  nonLifecycleLabels,
  lifecycleLabelsMatch,
  preservesNonLifecycleLabels,
  lifecycleLabelDelta,
  lifecycleOperationPlan,
  applyLifecycleOperation,
  pendingOperationAssessment,
  operationConverged,
  pollLabelOperationConvergence,
  labelPendingIntent,
  batchIntentId,
  intentFor,
  durableWriteJson,
};
