'use strict';

const fs = require('node:fs');
const {
  canonicalJson,
  sha256Text,
  planSourceNoteBoundaryReviewTransition,
  validateTransitionRequest,
  buildAppliedReceipt,
  renderAppliedReceiptComment,
} = require('./source-note-boundary-review-transition');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');
const {
  buildPacketSet,
  validatePacketSet,
  livePostGate,
  inspectEvidence,
  exactOwnership,
} = require('./issue-1539-boundary-evidence-batch');
const { verifyPinnedArtifact, normalizeLabels } = require('./issue-1539-boundary-expansion');
const { validateReceipt: validateEvidenceReceipt, requestSha256 } = require('./issue-1539-boundary-evidence-batch');
const { acquireProgressLock, durableWriteJson } = require('./issue-1539-evidence-batch');

const BATCH_SCHEMA_VERSION = 'issue-1539-boundary-review-transition-batch.v1';
const PROGRESS_SCHEMA_VERSION = 'issue-1539-boundary-review-transition-progress.v1';
const INTENT_SCHEMA_VERSION = 'issue-1539-boundary-review-transition-intent.v1';
const BATCH_ID = 'issue-1539-boundary-review-transition-001';
const REPOSITORY = 'liqiangcc/interview-lab';
const PACKET_SET_SHA256 = 'e20d030d503c57016083eb688189c2f8a3a078441479b1c3dd7562eb49b8ea11';
const ISSUE_NUMBERS = Object.freeze([158, 278, 361, 478, 649, 692, 843, 901, 937, 942, 946, 952, 987, 1121, 1168, 1221, 1301]);
const PHASES = new Set(['planned', 'patch-pending', 'patched', 'receipt-pending', 'complete', 'uncertain']);
const APPLIED_MARKER_RE = /<!--\s*source-note-boundary-review-applied\s*\n([\s\S]*?)\n-->/g;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function same(a, b) { return canonicalJson(a) === canonicalJson(b); }
function requestId(request) { return Number(request.issue_number); }
function packetMap(packetSet) { return new Map(packetSet.packets.map((packet) => [packet.issue_number, packet])); }
function intentId(request, packetSetSha256 = PACKET_SET_SHA256) { return sha256Text(`${BATCH_ID}:${packetSetSha256}:${requestId(request)}:${requestSha256(request)}`); }
function intentFor(request, phase, extra = {}, packetSetSha256 = PACKET_SET_SHA256) {
  return { schema_version: INTENT_SCHEMA_VERSION, intent_id: intentId(request, packetSetSha256), batch_id: BATCH_ID, packet_set_sha256: packetSetSha256, issue_number: requestId(request), transition_id: request.transition_id, request_sha256: requestSha256(request), phase, ...clone(extra) };
}
function issueSnapshot(issue) {
  const labels = normalizeLabels(issue && issue.labels);
  return { number: Number(issue && issue.number), body_sha256: sha256Text(issue && issue.body || ''), labels: labels.ok ? [...labels.labels].sort() : null, state: String(issue && issue.state || '').toLowerCase() };
}
function validSnapshot(snapshot) {
  return Boolean(snapshot && Number.isInteger(snapshot.number) && snapshot.number > 0 && /^[0-9a-f]{64}$/.test(String(snapshot.body_sha256 || '')) && Array.isArray(snapshot.labels) && snapshot.labels.every((label) => typeof label === 'string') && typeof snapshot.state === 'string');
}
function controlledLabels(labels) { return (labels || []).filter((label) => label.startsWith('boundary:') || label === 'task:boundary-review'); }
function assertOnlyBoundaryTransition(before, after) {
  const beforeSet = new Set(before || []); const afterSet = new Set(after || []);
  const beforeStatus = (before || []).filter((label) => label.startsWith('status:')).sort();
  const afterStatus = (after || []).filter((label) => label.startsWith('status:')).sort();
  if (!same(beforeStatus, afterStatus)) return { ok: false, error: 'transition may not change status labels' };
  if (afterSet.has('status:source-ready') || afterSet.has('source-ready')) return { ok: false, error: 'transition may not set source-ready' };
  if (!beforeSet.has('boundary:pending') || !afterSet.has('boundary:single-interview') || afterSet.has('boundary:pending') || afterSet.has('boundary:multi-interview') || afterSet.has('boundary:not-interview')) return { ok: false, error: 'transition must change boundary:pending to boundary:single-interview only' };
  const unexpected = [...afterSet].filter((label) => !beforeSet.has(label) && label !== 'boundary:single-interview');
  const missing = [...beforeSet].filter((label) => !afterSet.has(label) && !['boundary:pending', 'task:boundary-review'].includes(label));
  if (unexpected.length || missing.length) return { ok: false, error: `uncontrolled labels changed unexpectedly: added=${unexpected.join(',')} removed=${missing.join(',')}` };
  return { ok: true };
}

function targetRevisionBinding(record, request) {
  const errors = [];
  const revision = record && record.source_revision;
  const liveSourceRepositoryRef = revision?.source_repository_ref ?? null;
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) {
    errors.push('live SourceRevision is required');
  } else if (liveSourceRepositoryRef !== request.expected_source_repository_ref) {
    errors.push('live SourceRevision repository ref does not match request');
  }
  if (record?.schema_version === 'source-note-issue.v2') {
    if (request.expected_source_repository_ref !== null) errors.push('SourceNote v2 target must use expected_source_repository_ref=null');
    if (!request.expected_manifest_sha256 || revision?.manifest_sha256 !== request.expected_manifest_sha256) errors.push('live SourceCapture manifest does not match request');
  } else if (record?.schema_version === 'source-note-issue.v1') {
    if (request.expected_manifest_sha256 !== null) errors.push('SourceNote v1 target must use expected_manifest_sha256=null');
  }
  return { ok: errors.length === 0, errors };
}

function validateInputs(requests, evidenceReceipts, packetSet, manifest, expectedPacketSetSha256 = PACKET_SET_SHA256) {
  const errors = [];
  const packetValidation = validatePacketSet(packetSet, manifest);
  if (!packetSet || packetSet.packet_set_sha256 !== expectedPacketSetSha256) errors.push('packet set digest is not the authorized fixed digest');
  if (!Array.isArray(requests) || requests.length !== ISSUE_NUMBERS.length) errors.push('exactly 17 Boundary Review requests are required');
  if (!Array.isArray(evidenceReceipts) || evidenceReceipts.length !== ISSUE_NUMBERS.length) errors.push('exactly 17 #1549 evidence receipts are required');
  const packets = packetMap(packetSet || { packets: [] });
  const receiptByIssue = new Map((evidenceReceipts || []).map((receipt) => [Number(receipt.issue_number), receipt]));
  if (canonicalJson((requests || []).map(requestId)) !== canonicalJson(ISSUE_NUMBERS)) errors.push('request set/order is not the fixed 17-item set');
  for (const request of requests || []) {
    const packet = packets.get(requestId(request));
    const prefix = `#${requestId(request)}`;
    const validation = validateTransitionRequest(request);
    if (!validation.ok) errors.push(...validation.errors.map((error) => `${prefix}: ${error}`));
    if (!packet) { errors.push(`${prefix}: packet mapping is missing`); continue; }
    for (const field of ['repository', 'issue_number', 'source_note_id', 'expected_body_sha256', 'expected_source_revision_id', 'expected_source_repository_ref']) if (!same(request[field], field === 'repository' ? REPOSITORY : packet[field])) errors.push(`${prefix}: ${field} does not match #1549 packet`);
    if (request.expected_boundary_status !== 'pending' || request.decision !== 'single-interview') errors.push(`${prefix}: only pending single-interview requests are allowed`);
    if (request.review_evidence.repository !== REPOSITORY || request.review_evidence.issue_number !== request.issue_number) errors.push(`${prefix}: review evidence locator mismatch`);
    const receipt = receiptByIssue.get(requestId(request));
    if (!receipt) errors.push(`${prefix}: #1549 evidence receipt is missing`);
    else {
      const receiptValidation = validateEvidenceReceipt(receipt, packet, packetSet.packet_set_sha256, request);
      if (!receiptValidation.ok) errors.push(...receiptValidation.errors.map((error) => `${prefix}: evidence receipt: ${error}`));
      if (receipt.evidence_comment_id !== request.review_evidence.comment_id) errors.push(`${prefix}: evidence receipt comment locator mismatch`);
    }
  }
  return { ok: errors.length === 0 && packetValidation.ok, errors: [...errors, ...(packetValidation.ok ? [] : packetValidation.errors)] };
}

function initialProgress(requests, packetSetSha256 = PACKET_SET_SHA256) {
  return { schema_version: PROGRESS_SCHEMA_VERSION, batch_id: BATCH_ID, packet_set_sha256: packetSetSha256, status: 'planned', mutation_attempted: false, mutation_performed: false, possibly_performed: false, items: Object.fromEntries(requests.map((request) => [String(requestId(request)), { issue_number: requestId(request), transition_id: request.transition_id, request_sha256: requestSha256(request), phase: 'planned', intent: intentFor(request, 'planned', {}, packetSetSha256), result: null }])) };
}

function validateProgress(progress, requests, packetSetSha256 = PACKET_SET_SHA256) {
  const errors = [];
  if (!progress || progress.schema_version !== PROGRESS_SCHEMA_VERSION) errors.push('progress schema_version mismatch');
  if (!progress || progress.batch_id !== BATCH_ID || progress.packet_set_sha256 !== packetSetSha256) errors.push('progress batch identity mismatch');
  if (!progress || !['planned', 'running', 'failed', 'complete'].includes(progress.status)) errors.push('progress status is invalid');
  if (progress && progress.possibly_performed === true) errors.push('progress contains possibly performed mutation');
  const expected = new Map((requests || []).map((request) => [String(requestId(request)), request]));
  const actual = progress && progress.items || {};
  if (Object.keys(actual).length !== expected.size) errors.push('progress item count mismatch');
  for (const [key, request] of expected) {
    const item = actual[key];
    if (!item) { errors.push(`progress missing item #${key}`); continue; }
    if (item.issue_number !== requestId(request) || item.transition_id !== request.transition_id || item.request_sha256 !== requestSha256(request)) errors.push(`progress identity mismatch for #${key}`);
    if (!PHASES.has(item.phase) || !item.intent || item.intent.intent_id !== intentId(request, packetSetSha256) || item.intent.packet_set_sha256 !== packetSetSha256 || item.intent.phase !== item.phase || item.intent.request_sha256 !== requestSha256(request)) errors.push(`progress intent mismatch for #${key}`);
    if (item.phase === 'uncertain') errors.push(`progress item #${key} is uncertain`);
    if (item.phase === 'patch-pending' && (!validSnapshot(item.intent.expected_snapshot) || !validSnapshot(item.intent.after_snapshot || item.intent.expected_snapshot))) errors.push(`progress patch intent is incomplete for #${key}`);
    if (item.phase === 'receipt-pending' && (!item.intent.receipt || item.intent.receipt.transition_id !== request.transition_id)) errors.push(`progress receipt intent is incomplete for #${key}`);
  }
  for (const key of Object.keys(actual)) if (!expected.has(key)) errors.push(`progress contains unknown item #${key}`);
  return { ok: errors.length === 0, errors };
}

function parseAppliedReceipts(comments, request) {
  const matches = [];
  for (const comment of comments || []) for (const match of String(comment && comment.body || '').matchAll(APPLIED_MARKER_RE)) {
    let receipt; try { receipt = JSON.parse(match[1].trim()); } catch (error) { return { ok: false, errors: [`invalid applied receipt JSON: ${error.message}`] }; }
    if (receipt.transition_id === request.transition_id) matches.push({ receipt, comment });
  }
  if (matches.length > 1) return { ok: false, errors: ['multiple applied receipts exist for this transition'] };
  if (!matches.length) return { ok: true, receipt: null, comment: null };
  const found = matches[0];
  const locator = `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`;
  if (found.comment.issue_url !== locator || (Object.prototype.hasOwnProperty.call(found.comment, 'repository_url') && found.comment.repository_url !== `https://api.github.com/repos/${request.repository}`)) return { ok: false, errors: ['applied receipt comment locator is not exact'] };
  return { ok: true, receipt: found.receipt, comment: found.comment };
}

function validateAppliedReceipt(receipt, request, expectedBodySha = null) {
  const errors = [];
  if (!receipt || receipt.schema_version !== 'source-note-boundary-review-applied.v1') errors.push('applied receipt schema mismatch');
  if (receipt && (receipt.transition_id !== request.transition_id || receipt.repository !== request.repository || receipt.issue_number !== request.issue_number || receipt.source_note_id !== request.source_note_id || receipt.decision !== 'single-interview' || receipt.reviewed_at !== request.reviewed_at)) errors.push('applied receipt identity mismatch');
  if (receipt && receipt.previous_body_sha256 !== request.expected_body_sha256) errors.push('applied receipt previous body digest mismatch');
  if (receipt && expectedBodySha && receipt.new_body_sha256 !== expectedBodySha) errors.push('applied receipt new body digest mismatch');
  if (receipt && (!Array.isArray(receipt.interview_note_ids) || receipt.interview_note_ids.length !== 1 || receipt.interview_note_ids[0] !== `xhs:${request.source_note_id.slice('xhs-note:'.length)}`)) errors.push('applied receipt InterviewNote identity mismatch');
  if (receipt && (!isNonEmptyTimestamp(receipt.applied_at) || receipt.interview_note_cases !== null)) errors.push('applied receipt timestamp/case shape is invalid');
  return { ok: errors.length === 0, errors };
}
function isNonEmptyTimestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }

function targetGate(packet, request, live, expectedBodySha = null, packetSetSha256 = PACKET_SET_SHA256) {
  const errors = [];
  const issue = live && live.sourceIssue;
  const labelsResult = normalizeLabels(issue && issue.labels);
  if (!labelsResult.ok) errors.push(...labelsResult.errors);
  const labels = labelsResult.labels || [];
  if (!issue || Number(issue.number) !== request.issue_number || String(issue.state || '').toLowerCase() !== 'open') errors.push('live SourceNote must be the open requested Issue');
  if (!labels.includes('boundary:single-interview') || labels.filter((label) => label.startsWith('boundary:')).length !== 1 || labels.includes('boundary:pending')) errors.push('live SourceNote boundary label is not exactly single-interview');
  if (labels.includes('status:source-ready')) errors.push('live SourceNote must not be source-ready');
  const parsed = parseSourceNoteIssue(issue && issue.body || '');
  const validation = validateSourceNoteIssue({ body: issue && issue.body || '', labels, state: String(issue && issue.state || '').toLowerCase() });
  if (!validation.ok) errors.push(...validation.errors);
  const record = validation.parsed && validation.parsed.record;
  errors.push(...targetRevisionBinding(record, request).errors);
  if (!record || record.source_note_id !== request.source_note_id || record.source_revision?.id !== request.expected_source_revision_id || record.boundary_review?.status !== 'single-interview' || record.boundary_review?.reviewed_at !== request.reviewed_at || same(record.boundary_review?.interview_note_ids || [], [`xhs:${request.source_note_id.slice('xhs-note:'.length)}`]) === false) errors.push('live SourceNote target record does not match request');
  if (expectedBodySha && sha256Text(issue.body || '') !== expectedBodySha) errors.push('live target body SHA mismatch');
  const artifact = record ? verifyPinnedArtifact({ source_note_id: request.source_note_id, artifact: packet.artifact }, record, live.readBlob) : { ok: false, errors: ['pinned artifact check skipped'] };
  if (!artifact.ok) errors.push(...artifact.errors);
  const evidence = inspectEvidence(live && live.comments || [], packet, packetSetSha256);
  if (!evidence.ok || !evidence.exact || Number(evidence.comment.id) !== request.review_evidence.comment_id) errors.push(...(evidence.errors || []).concat(evidence.exact ? [] : ['exact evidence marker/comment is required']));
  if (!live || !Array.isArray(live.allIssues)) errors.push('live InterviewNote ownership inventory must be an explicit array');
  const owners = Array.isArray(live && live.allIssues)
    ? exactOwnership(live.allIssues, `xhs:${request.source_note_id.slice('xhs-note:'.length)}`)
    : [];
  if (owners.length !== 0) errors.push(`exact InterviewNote ownership count is ${owners.length}`);
  return { ok: errors.length === 0, errors, issue, labels: [...labels].sort(), evidence, owners, snapshot: issueSnapshot(issue) };
}

function planOne(request, packet, packetSet, live, localReceipt = null, planTransition = planSourceNoteBoundaryReviewTransition) {
  const applied = parseAppliedReceipts(live && live.comments || [], request);
  if (!applied.ok) return { ok: false, errors: applied.errors, action: 'blocked' };
  const target = String((live && live.sourceIssue && live.sourceIssue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).find((label) => typeof label === 'string' && label.startsWith('boundary:')) || '') === 'boundary:single-interview';
  if (target) {
    const expectedBodySha = applied.receipt?.new_body_sha256 || localReceipt?.new_body_sha256 || null;
    const gate = targetGate(packet, request, live, expectedBodySha, packetSet.packet_set_sha256);
    if (!gate.ok) return { ok: false, errors: gate.errors, action: 'blocked', live_snapshot: gate.snapshot };
    const plannerCheck = planTransition(request, gate.issue, { evidenceComment: gate.evidence.comment, receipts: [] });
    if (!plannerCheck.ok || !plannerCheck.already_applied) return { ok: false, errors: plannerCheck.errors?.length ? plannerCheck.errors : ['single-item planner did not confirm the target state'], action: 'blocked', live_snapshot: gate.snapshot };
    if (applied.receipt) { const validation = validateAppliedReceipt(applied.receipt, request, gate.snapshot.body_sha256); if (!validation.ok) return { ok: false, errors: validation.errors, action: 'blocked' }; }
    if (localReceipt) { const validation = validateAppliedReceipt(localReceipt, request, gate.snapshot.body_sha256); if (!validation.ok || (applied.receipt && !same(localReceipt, applied.receipt))) return { ok: false, errors: validation.errors.concat(applied.receipt && !same(localReceipt, applied.receipt) ? ['local/live applied receipt conflict'] : []), action: 'blocked' }; }
    if (localReceipt && !applied.receipt) return { ok: false, errors: ['local transition receipt exists but no matching live receipt is present'], action: 'blocked', live_snapshot: gate.snapshot };
    return { ok: true, action: applied.receipt ? (localReceipt ? 'already-applied' : 'receipt-repair') : 'receipt-needed', already_applied: Boolean(applied.receipt && localReceipt), needs_receipt: !localReceipt, live_snapshot: gate.snapshot, source_issue: gate.issue, evidence: gate.evidence, applied_receipt: applied.receipt, local_receipt: localReceipt, current_body_sha256: gate.snapshot.body_sha256, next_body_sha256: gate.snapshot.body_sha256, next_labels: gate.labels };
  }
  const gate = livePostGate(packet, packetSet, live);
  if (!gate.ok) return { ok: false, errors: gate.errors, action: 'blocked', live_snapshot: issueSnapshot(live && live.sourceIssue) };
  if (Number(gate.evidence.comment.id) !== request.review_evidence.comment_id) return { ok: false, errors: ['request evidence comment_id does not match the unique exact marker'], action: 'blocked', live_snapshot: issueSnapshot(live.sourceIssue) };
  const plan = planTransition(request, live.sourceIssue, { evidenceComment: gate.evidence.comment, receipts: [] });
  if (!plan.ok) return { ...plan, action: 'blocked', live_snapshot: issueSnapshot(live.sourceIssue) };
  const labelsCheck = assertOnlyBoundaryTransition(gate.source.labels, plan.next_labels);
  if (!labelsCheck.ok) return { ok: false, errors: [labelsCheck.error], action: 'blocked', live_snapshot: issueSnapshot(live.sourceIssue) };
  return { ...plan, ok: true, action: 'would-transition', next_labels: [...plan.next_labels].sort(), live_snapshot: issueSnapshot(live.sourceIssue), source_issue: live.sourceIssue, evidence: gate.evidence };
}

function planBatch(requests, packetSet, options = {}) {
  const input = validateInputs(requests, options.evidenceReceipts, packetSet, options.manifest, options.expectedPacketSetSha256 || PACKET_SET_SHA256);
  if (!input.ok) return { ok: false, errors: input.errors, items: [] };
  if (typeof options.loadLive !== 'function') throw new Error('loadLive is required');
  const items = []; const errors = [];
  for (const request of requests) {
    let live; let localReceipt = null; let plan;
    try { live = options.loadLive(request); if (typeof options.readTransitionReceipt === 'function') localReceipt = options.readTransitionReceipt(request); const packet = packetSet.packets.find((candidate) => candidate.issue_number === request.issue_number); plan = planOne(request, packet, packetSet, { ...live, }, localReceipt, options.planTransition); }
    catch (error) { plan = { ok: false, errors: [error.message], action: 'blocked' }; }
    const item = { issue_number: request.issue_number, transition_id: request.transition_id, request_sha256: requestSha256(request), action: plan.action, already_applied: Boolean(plan.already_applied), needs_receipt: Boolean(plan.needs_receipt), current_body_sha256: plan.current_body_sha256 || plan.live_snapshot?.body_sha256 || null, next_body_sha256: plan.next_body_sha256 || null, current_labels: plan.current_labels || plan.live_snapshot?.labels || [], next_labels: plan.next_labels || [], live_snapshot: plan.live_snapshot || null, errors: plan.errors || [] };
    items.push({ ...item, plan });
    if (!plan.ok) errors.push(`#${request.issue_number}: ${(plan.errors || ['plan failed']).join('; ')}`);
  }
  const reportBase = { schema_version: BATCH_SCHEMA_VERSION, batch_id: BATCH_ID, repository: REPOSITORY, packet_set_sha256: packetSet.packet_set_sha256, total: items.length, errors, items: items.map(({ plan, ...item }) => item) };
  return { ok: errors.length === 0, errors, items, report: { ...reportBase, plan_sha256: sha256Text(canonicalJson(reportBase)) } };
}

function persistItem(progress, request, phase, extra, persistProgress) { const item = progress.items[String(requestId(request))]; item.phase = phase; item.intent = intentFor(request, phase, extra, progress.packet_set_sha256); if (persistProgress) persistProgress(progress); }
function markBlockedBeforeMutation(progress, request, phase, error, extra, persistProgress) {
  const item = progress.items[String(requestId(request))];
  progress.status = 'failed';
  item.phase = 'planned';
  item.intent = intentFor(request, 'planned', { blocked_from_phase: phase, prior_intent: clone(item.intent), ...clone(extra) }, progress.packet_set_sha256);
  item.result = { status: 'blocked-before-mutation', error, mutation_attempted: false, mutation_performed: false, possibly_performed: false };
  if (persistProgress) persistProgress(progress);
  return { ok: false, errors: [`#${request.issue_number}: ${error}`], progress };
}
function markUncertain(progress, request, phase, error, extra, persistProgress) {
  const item = progress.items[String(requestId(request))];
  progress.status = 'failed';
  progress.mutation_attempted = true;
  progress.possibly_performed = true;
  item.phase = 'uncertain';
  item.intent = intentFor(request, 'uncertain', { prior_phase: phase, prior_intent: clone(item.intent), ...clone(extra) }, progress.packet_set_sha256);
  item.result = { status: 'uncertain', error, mutation_attempted: true, mutation_performed: false, possibly_performed: true };
  if (persistProgress) persistProgress(progress);
  return { ok: false, errors: [`#${request.issue_number}: ${error}`], progress };
}
function completed(progress, request, receipt, action, persistProgress) { const item = progress.items[String(requestId(request))]; progress.possibly_performed = false; item.phase = 'complete'; item.intent = intentFor(request, 'complete', { receipt_sha256: sha256Text(canonicalJson(receipt)) }, progress.packet_set_sha256); item.result = { status: action, receipt_sha256: sha256Text(canonicalJson(receipt)), mutation_attempted: action === 'applied', mutation_performed: action === 'applied', possibly_performed: false }; if (persistProgress) persistProgress(progress); }

function applyBatch(requests, packetSet, progress, options = {}) {
  const planned = planBatch(requests, packetSet, options);
  if (!planned.ok) return { ok: false, errors: planned.errors, items: [], progress };
  if (options.expectedPlanSha256 !== undefined && options.expectedPlanSha256 !== planned.report.plan_sha256) return { ok: false, errors: ['plan digest changed before apply'], items: [], progress };
  if (!progress) progress = initialProgress(requests, packetSet.packet_set_sha256);
  progress.status = 'running'; if (options.persistProgress) options.persistProgress(progress);
  const items = [];
  for (const request of requests) {
    const packet = packetSet.packets.find((candidate) => candidate.issue_number === request.issue_number);
    let live; let localReceipt = null; let current;
    try { live = options.loadLive(request); localReceipt = options.readTransitionReceipt ? options.readTransitionReceipt(request) : null; current = planOne(request, packet, packetSet, live, localReceipt, options.planTransition); } catch (error) { return { ok: false, errors: [`#${request.issue_number}: fresh plan failed: ${error.message}`], items, progress }; }
    if (!current.ok) return { ok: false, errors: current.errors.map((error) => `#${request.issue_number}: ${error}`), items, progress };
    if (current.action === 'already-applied') { completed(progress, request, current.local_receipt, 'already-applied', options.persistProgress); items.push({ issue_number: request.issue_number, action: current.action }); continue; }
    if (current.action === 'receipt-repair') { options.writeReceipt(request, current.applied_receipt); completed(progress, request, current.applied_receipt, 'receipt-repair', options.persistProgress); items.push({ issue_number: request.issue_number, action: current.action }); continue; }
    let receipt = current.applied_receipt;
    if (current.action === 'would-transition') {
      persistItem(progress, request, 'patch-pending', { expected_snapshot: current.live_snapshot, after_snapshot: current.live_snapshot, next_body_sha256: current.next_body_sha256, next_labels: current.next_labels }, options.persistProgress);
      let replan;
      try { replan = planOne(request, packet, packetSet, options.loadLive(request), localReceipt, options.planTransition); }
      catch (error) { return markBlockedBeforeMutation(progress, request, 'patch-pending', `fresh pre-PATCH read failed: ${error.message}`, {}, options.persistProgress); }
      if (!replan.ok) return markBlockedBeforeMutation(progress, request, 'patch-pending', 'fresh pre-PATCH gate failed', { error_detail: replan.errors }, options.persistProgress);
      if (replan.action !== 'would-transition') { if (replan.action === 'already-applied' && replan.local_receipt) { completed(progress, request, replan.local_receipt, 'already-applied', options.persistProgress); items.push({ issue_number: request.issue_number, action: 'already-applied' }); continue; } return markBlockedBeforeMutation(progress, request, 'patch-pending', 'live state changed before PATCH', { live_snapshot: replan.live_snapshot }, options.persistProgress); }
      if (!same(replan.live_snapshot, current.live_snapshot) || !same(replan.next_labels, current.next_labels) || replan.next_body_sha256 !== current.next_body_sha256) return markBlockedBeforeMutation(progress, request, 'patch-pending', 'live CAS facts changed before PATCH', { expected_snapshot: current.live_snapshot, live_snapshot: replan.live_snapshot }, options.persistProgress);
      let patchError = null;
      try { options.patchIssue(request, replan); } catch (error) { patchError = error; }
      if (patchError) {
        progress.mutation_attempted = true;
        progress.possibly_performed = true;
        persistItem(progress, request, 'patch-pending', { expected_snapshot: replan.live_snapshot, after_snapshot: replan.live_snapshot, next_body_sha256: replan.next_body_sha256, next_labels: replan.next_labels, patch_response_lost: true, mutation_attempted: true, possibly_performed: true }, options.persistProgress);
        let reconciled;
        try { reconciled = planOne(request, packet, packetSet, options.loadLive(request), null, options.planTransition); }
        catch (error) { return markUncertain(progress, request, 'patch-pending', `PATCH failed and fresh reconcile failed: ${patchError.message}; ${error.message}`, { mutation_attempted: true }, options.persistProgress); }
        if (!reconciled.ok || reconciled.action === 'would-transition') return markUncertain(progress, request, 'patch-pending', `PATCH failed and live target did not converge: ${patchError.message}`, { reconcile_errors: reconciled.errors || [], mutation_attempted: true }, options.persistProgress);
        if (reconciled.current_body_sha256 !== replan.next_body_sha256 || !same(reconciled.next_labels, replan.next_labels)) return markUncertain(progress, request, 'patch-pending', `PATCH failed and live target facts drifted from the planned target: ${patchError.message}`, { expected_body_sha256: replan.next_body_sha256, live_body_sha256: reconciled.current_body_sha256, expected_labels: replan.next_labels, live_labels: reconciled.next_labels, mutation_attempted: true }, options.persistProgress);
        if (reconciled.action === 'receipt-repair' || reconciled.action === 'already-applied') {
          progress.mutation_attempted = true; progress.mutation_performed = true; progress.possibly_performed = false;
          options.writeReceipt(request, reconciled.applied_receipt || reconciled.local_receipt);
          completed(progress, request, reconciled.applied_receipt || reconciled.local_receipt, reconciled.action, options.persistProgress);
          items.push({ issue_number: request.issue_number, action: reconciled.action });
          continue;
        }
        progress.mutation_attempted = true; progress.mutation_performed = true; progress.possibly_performed = false;
        persistItem(progress, request, 'patched', { expected_body_sha256: reconciled.current_body_sha256, expected_labels: reconciled.next_labels, patch_response_lost: true }, options.persistProgress);
        const after = reconciled;
        receipt = buildAppliedReceipt(request, { current_body_sha256: request.expected_body_sha256, next_body_sha256: after.current_body_sha256, interview_note_ids: [`xhs:${request.source_note_id.slice('xhs-note:'.length)}`], interview_note_cases: null }, options.now ? options.now() : new Date().toISOString());
      } else {
        progress.mutation_attempted = true; progress.mutation_performed = true;
        persistItem(progress, request, 'patched', { expected_body_sha256: replan.next_body_sha256, expected_labels: replan.next_labels }, options.persistProgress);
        let after;
        try { live = options.loadLive(request); after = planOne(request, packet, packetSet, live, null, options.planTransition); }
        catch (error) { return markUncertain(progress, request, 'patched', `post-PATCH reconcile failed: ${error.message}`, {}, options.persistProgress); }
        if (!after.ok || after.action === 'would-transition') return markUncertain(progress, request, 'patched', 'post-PATCH live SourceNote did not converge to the planned target', { errors: after.errors || [], live_snapshot: after.live_snapshot }, options.persistProgress);
        if (after.current_body_sha256 !== replan.next_body_sha256 || !same(after.next_labels, replan.next_labels)) return markUncertain(progress, request, 'patched', 'post-PATCH live target body or labels drifted from the planned target', { expected_body_sha256: replan.next_body_sha256, live_body_sha256: after.current_body_sha256, expected_labels: replan.next_labels, live_labels: after.next_labels }, options.persistProgress);
        receipt = buildAppliedReceipt(request, { current_body_sha256: request.expected_body_sha256, next_body_sha256: after.current_body_sha256, interview_note_ids: [`xhs:${request.source_note_id.slice('xhs-note:'.length)}`], interview_note_cases: null }, options.now ? options.now() : new Date().toISOString());
      }
    } else if (current.action === 'receipt-needed') {
      receipt = buildAppliedReceipt(request, { current_body_sha256: request.expected_body_sha256, next_body_sha256: current.current_body_sha256, interview_note_ids: [`xhs:${request.source_note_id.slice('xhs-note:'.length)}`], interview_note_cases: null }, options.now ? options.now() : new Date().toISOString());
    }
    progress.mutation_attempted = true;
    persistItem(progress, request, 'receipt-pending', { receipt, receipt_request_sha256: requestSha256(request), mutation_attempted: true, mutation_performed: false, possibly_performed: true }, options.persistProgress);
    try { options.postReceipt(request, receipt); } catch (_) { /* always reconcile below; never retry POST */ }
    let confirmed; try { const afterReceiptLive = options.loadLive(request); const afterReceipt = planOne(request, packet, packetSet, afterReceiptLive, null, options.planTransition); confirmed = afterReceipt.ok && afterReceipt.applied_receipt; } catch (error) { confirmed = null; }
    if (!confirmed || !same(confirmed, receipt)) return markUncertain(progress, request, 'receipt-pending', 'receipt POST was not confirmed by a matching live receipt', {}, options.persistProgress);
    progress.mutation_attempted = true;
    progress.mutation_performed = true;
    progress.possibly_performed = false;
    options.writeReceipt(request, confirmed); completed(progress, request, receipt, 'applied', options.persistProgress); items.push({ issue_number: request.issue_number, action: current.action === 'receipt-needed' ? 'receipt-posted' : 'applied' });
  }
  progress.status = 'complete'; if (options.persistProgress) options.persistProgress(progress);
  return { ok: true, items, progress, report: planned.report };
}

module.exports = { BATCH_SCHEMA_VERSION, PROGRESS_SCHEMA_VERSION, INTENT_SCHEMA_VERSION, BATCH_ID, REPOSITORY, PACKET_SET_SHA256, ISSUE_NUMBERS, PHASES, buildPacketSet, validateInputs, initialProgress, validateProgress, issueSnapshot, targetRevisionBinding, planOne, planBatch, applyBatch, intentFor, parseAppliedReceipts, validateAppliedReceipt, renderAppliedReceiptComment, acquireProgressLock, durableWriteJson };
