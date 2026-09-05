'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  sha256Text,
  buildInterviewProjection,
  validateExistingOwnership,
} = require('./source-note-interview-materialization');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');
const { parseInterviewNoteIssue } = require('./interview-note-issue');
const { normalizeLabels, verifyPinnedArtifact } = require('./issue-1539-boundary-expansion');
const {
  validateInputs: validateBoundaryInputs,
  validateAppliedReceipt,
} = require('./issue-1539-boundary-transition-batch');
const { acquireProgressLock } = require('./issue-1539-evidence-batch');

const BATCH_SCHEMA_VERSION = 'issue-1539-interview-note-materialization-batch.v1';
const PLAN_SCHEMA_VERSION = 'issue-1556-interview-note-materialization-plan.v1';
const REPOSITORY = 'liqiangcc/interview-lab';
const PACKET_SET_SHA256 = 'e20d030d503c57016083eb688189c2f8a3a078441479b1c3dd7562eb49b8ea11';
const ISSUE_NUMBERS = Object.freeze([158, 278, 361, 478, 649, 692, 843, 901, 937, 942, 946, 952, 987, 1121, 1168, 1221, 1301]);
const FORBIDDEN_SOURCE_LABELS = Object.freeze([
  'status:source-ready',
  'status:source-review',
]);
const FORBIDDEN_LEARNING_PREFIXES = Object.freeze([
  'learning:',
]);
const PROGRESS_SCHEMA_VERSION = 'issue-1556-materialization-progress.v1';
const INTENT_SCHEMA_VERSION = 'issue-1556-materialization-intent.v1';
const RECEIPT_SCHEMA_VERSION = 'issue-1556-materialization-receipt.v1';
const PHASES = new Set(['planned', 'create-pending', 'created', 'receipt-pending', 'complete', 'uncertain']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function same(left, right) { return canonicalJson(left) === canonicalJson(right); }
function requestSha256(request) { return sha256Text(canonicalJson(request)); }
function interviewNoteId(sourceNoteId) {
  if (typeof sourceNoteId !== 'string' || !sourceNoteId.startsWith('xhs-note:')) throw new Error('source_note_id must use xhs-note:<external-id>');
  return `xhs:${sourceNoteId.slice('xhs-note:'.length)}`;
}
function materializationId(sourceNoteId) {
  return `xhs-note-${sourceNoteId.slice('xhs-note:'.length, sourceNoteId.length).slice(0, 8)}-materialization-1`;
}

function buildMaterializationRequest(transitionRequest, transitionReceipt) {
  if (!transitionRequest || !transitionReceipt) throw new Error('Boundary transition request and receipt are required');
  return {
    schema_version: 'source-note-interview-materialization.v1',
    materialization_id: materializationId(transitionRequest.source_note_id),
    repository: transitionRequest.repository,
    source_note_issue_number: transitionRequest.issue_number,
    source_note_id: transitionRequest.source_note_id,
    expected_source_note_body_sha256: transitionReceipt.new_body_sha256,
    expected_boundary_status: 'single-interview',
    expected_source_revision_id: transitionRequest.expected_source_revision_id,
    expected_manifest_sha256: transitionRequest.expected_manifest_sha256,
    expected_source_repository_ref: transitionRequest.expected_source_repository_ref,
  };
}

function validateFixedSet(values, name) {
  const errors = [];
  if (!Array.isArray(values) || values.length !== ISSUE_NUMBERS.length) {
    errors.push(`${name} must contain exactly the fixed 17 items`);
    return errors;
  }
  const numbers = values.map((value) => Number(value.issue_number));
  if (same(numbers, ISSUE_NUMBERS) === false) errors.push(`${name} must use the fixed 17 Issue order`);
  return errors;
}

function validateMaterializationInputs({ packetSet, manifest, transitionRequests, evidenceReceipts, transitionReceipts } = {}) {
  const errors = [];
  if (!packetSet || packetSet.packet_set_sha256 !== PACKET_SET_SHA256) errors.push(`packet set digest must equal ${PACKET_SET_SHA256}`);
  errors.push(...validateFixedSet(transitionRequests, 'Boundary transition requests'));
  errors.push(...validateFixedSet(transitionReceipts, 'Boundary transition receipts'));
  errors.push(...validateFixedSet(evidenceReceipts, '#1549 evidence receipts'));
  if (packetSet && manifest && Array.isArray(transitionRequests) && Array.isArray(evidenceReceipts)) {
    const boundary = validateBoundaryInputs(transitionRequests, evidenceReceipts, packetSet, manifest, PACKET_SET_SHA256);
    if (!boundary.ok) errors.push(...boundary.errors);
  }
  const requestByIssue = new Map((transitionRequests || []).map((item) => [Number(item.issue_number), item]));
  const evidenceByIssue = new Map((evidenceReceipts || []).map((item) => [Number(item.issue_number), item]));
  for (const receipt of transitionReceipts || []) {
    const request = requestByIssue.get(Number(receipt.issue_number));
    if (!request) { errors.push(`#${receipt.issue_number}: transition receipt has no request`); continue; }
    const validation = validateAppliedReceipt(receipt, request, receipt.new_body_sha256);
    if (!validation.ok) errors.push(...validation.errors.map((error) => `#${receipt.issue_number}: ${error}`));
    const evidence = evidenceByIssue.get(Number(receipt.issue_number));
    if (evidence && evidence.packet_set_sha256 !== PACKET_SET_SHA256) errors.push(`#${receipt.issue_number}: evidence receipt packet digest mismatch`);
    if (evidence && evidence.transition_id !== request.transition_id) errors.push(`#${receipt.issue_number}: evidence/transition identity mismatch`);
  }
  return { ok: errors.length === 0, errors };
}

function forbiddenSourceLabels(labels) {
  return labels.filter((label) => FORBIDDEN_SOURCE_LABELS.includes(label) || FORBIDDEN_LEARNING_PREFIXES.some((prefix) => label.startsWith(prefix)));
}

function exactMaterializationReceipts(comments, request) {
  const marker = /<!--\s*source-note-interview-materialized\s*([\s\S]*?)-->/g;
  const matches = [];
  const errors = [];
  for (const comment of comments || []) {
    for (const match of String(comment && comment.body || '').matchAll(marker)) {
      try {
        const value = JSON.parse(match[1].trim());
        if (value.materialization_id === request.materialization_id) matches.push({ value, comment });
      } catch (error) { errors.push(`invalid materialization receipt in comment ${comment && comment.id}: ${error.message}`); }
    }
  }
  if (matches.length > 1) errors.push('multiple materialization receipts exist for this SourceNote');
  if (matches.length === 1) {
    const found = matches[0];
    if (found.value.request_sha256 !== requestSha256(request)
      || found.value.source_note_id !== request.source_note_id
      || found.value.interview_note_id !== interviewNoteId(request.source_note_id)
      || found.value.source_note_body_sha256 !== request.expected_source_note_body_sha256
      || found.value.source_revision_id !== request.expected_source_revision_id) errors.push('materialization receipt identity mismatch');
  }
  return { ok: errors.length === 0, receipt: matches.length === 1 ? matches[0] : null, errors };
}

function durableWriteText(file, value) {
  if (typeof value !== 'string') throw new TypeError('durableWriteText requires text');
  const absolute = path.resolve(file);
  const directory = path.dirname(absolute);
  fs.mkdirSync(directory, { recursive: true });
  const temp = `${absolute}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'w', 0o600);
    fs.writeFileSync(fd, value, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, absolute);
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (_) { /* preserve original failure */ }
    if (error.code === 'EINVAL' || error.code === 'ENOTSUP' || error.code === 'EPERM') return;
    throw error;
  }
}

function durableWriteJson(file, value) { durableWriteText(file, `${JSON.stringify(value, null, 2)}\n`); }

function intentId(item, phase) {
  return sha256Text(`${BATCH_SCHEMA_VERSION}:${PACKET_SET_SHA256}:${item.issue_number}:${item.request_sha256}:${phase}`);
}

function makeIntent(item, phase, extra = {}) {
  return {
    schema_version: INTENT_SCHEMA_VERSION,
    intent_id: intentId(item, phase),
    phase,
    issue_number: item.issue_number,
    source_note_issue_number: item.source_note_issue_number,
    source_note_id: item.source_note_id,
    interview_note_id: item.interview_note_id,
    request_sha256: item.request_sha256,
    packet_set_sha256: PACKET_SET_SHA256,
    ...clone(extra),
  };
}

function initialProgress(items, planSha256) {
  return {
    schema_version: PROGRESS_SCHEMA_VERSION,
    packet_set_sha256: PACKET_SET_SHA256,
    plan_sha256: planSha256,
    status: 'planned',
    mutation_attempted: false,
    mutation_performed: false,
    possibly_performed: false,
    items: Object.fromEntries(items.map((item) => [String(item.issue_number), {
      issue_number: item.issue_number,
      source_note_issue_number: item.source_note_issue_number,
      source_note_id: item.source_note_id,
      interview_note_id: item.interview_note_id,
      request_sha256: item.request_sha256,
      phase: 'planned',
      intent: makeIntent(item, 'planned'),
      result: null,
    }])),
  };
}

function validateProgress(progress, items, expectedPlanSha256 = null) {
  const errors = [];
  if (!progress || progress.schema_version !== PROGRESS_SCHEMA_VERSION) errors.push('progress schema_version mismatch');
  if (!progress || progress.packet_set_sha256 !== PACKET_SET_SHA256) errors.push('progress packet set digest mismatch');
  if (expectedPlanSha256 && progress && progress.plan_sha256 !== expectedPlanSha256) errors.push('progress plan digest mismatch');
  if (!progress || !['planned', 'running', 'failed', 'complete'].includes(progress.status)) errors.push('progress status is invalid');
  if (progress && progress.possibly_performed === true) errors.push('progress contains unresolved possibly performed mutation');
  const expected = new Map((items || []).map((item) => [String(item.issue_number), item]));
  const actual = progress && progress.items || {};
  if (Object.keys(actual).length !== expected.size) errors.push('progress item count mismatch');
  for (const [key, item] of expected) {
    const state = actual[key];
    if (!state) { errors.push(`progress missing #${key}`); continue; }
    if (state.issue_number !== item.issue_number || state.source_note_id !== item.source_note_id || state.interview_note_id !== item.interview_note_id || state.request_sha256 !== item.request_sha256) errors.push(`progress identity mismatch for #${key}`);
    if (!PHASES.has(state.phase) || !state.intent || state.intent.intent_id !== intentId(item, state.phase) || state.intent.phase !== state.phase) errors.push(`progress intent mismatch for #${key}`);
    if (state.phase === 'uncertain') errors.push(`progress #${key} is uncertain and requires live reconciliation`);
  }
  return { ok: errors.length === 0, errors };
}

function renderMaterializationReceipt(receipt) {
  return `<!-- source-note-interview-materialized\n${JSON.stringify(receipt, null, 2)}\n-->`;
}

function buildMaterializationReceipt(request, owner, projection, packetSetSha256 = PACKET_SET_SHA256) {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    packet_set_sha256: packetSetSha256,
    materialization_id: request.materialization_id,
    request_sha256: requestSha256(request),
    repository: request.repository,
    source_note_issue_number: request.source_note_issue_number,
    source_note_id: request.source_note_id,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    source_repository_ref: request.expected_source_repository_ref,
    interview_note_id: interviewNoteId(request.source_note_id),
    interview_issue_number: Number(owner.number),
    interview_body_sha256: sha256Text(projection.body),
  };
}

function validateMaterializationReceipt(receipt, request, projection = null) {
  const errors = [];
  if (!receipt || receipt.schema_version !== RECEIPT_SCHEMA_VERSION) errors.push('materialization receipt schema mismatch');
  if (receipt && (receipt.packet_set_sha256 !== PACKET_SET_SHA256
    || receipt.materialization_id !== request.materialization_id
    || receipt.request_sha256 !== requestSha256(request)
    || receipt.repository !== request.repository
    || receipt.source_note_issue_number !== request.source_note_issue_number
    || receipt.source_note_id !== request.source_note_id
    || receipt.source_note_body_sha256 !== request.expected_source_note_body_sha256
    || receipt.source_revision_id !== request.expected_source_revision_id
    || receipt.interview_note_id !== interviewNoteId(request.source_note_id)
    || !Number.isInteger(receipt.interview_issue_number) || receipt.interview_issue_number < 1
    || !/^[0-9a-f]{64}$/.test(String(receipt.interview_body_sha256 || '')))) errors.push('materialization receipt immutable identity mismatch');
  if (projection && receipt.interview_body_sha256 !== sha256Text(projection.body)) errors.push('materialization receipt InterviewNote body digest mismatch');
  return { ok: errors.length === 0, errors };
}

function compareReceiptFacts(left, right) {
  const strip = (value) => { const copy = clone(value || {}); delete copy.comment_id; return copy; };
  return same(strip(left), strip(right));
}

function applyBatch({ planResult, packetSet, manifest, transitionRequests, transitionReceipts, evidenceReceipts, progress = null }, options = {}) {
  if (!planResult || !planResult.ok) return { ok: false, errors: ['an approved successful plan is required'], progress };
  if (planResult.plan_sha256 !== options.expectedPlanSha256) return { ok: false, errors: ['plan digest confirmation mismatch'], progress };
  if (typeof options.loadLive !== 'function' || typeof options.createInterviewIssue !== 'function' || typeof options.postReceipt !== 'function') return { ok: false, errors: ['apply requires live loader, createInterviewIssue and postReceipt adapters'], progress };
  const items = planResult.items;
  let state = progress || initialProgress(items, planResult.plan_sha256);
  const valid = validateProgress(state, items, planResult.plan_sha256);
  if (!valid.ok) return { ok: false, errors: valid.errors, progress: state };
  const requests = new Map((transitionRequests || []).map((request) => [Number(request.issue_number), request]));
  const transitionByIssue = new Map((transitionReceipts || []).map((receipt) => [Number(receipt.issue_number), receipt]));
  state.status = 'running';
  if (options.persistProgress) options.persistProgress(state);
  const resultItems = [];
  const mark = (item, phase, extra = {}) => {
    const current = state.items[String(item.issue_number)];
    current.phase = phase;
    current.intent = makeIntent(item, phase, extra);
    if (options.persistProgress) options.persistProgress(state);
  };
  const failUncertain = (item, phase, message, extra = {}) => {
    state.status = 'failed'; state.mutation_attempted = true; state.possibly_performed = true;
    mark(item, 'uncertain', { prior_phase: phase, error: message, ...extra });
    state.items[String(item.issue_number)].result = { status: 'uncertain', error: message, mutation_attempted: true, mutation_performed: null, possibly_performed: true };
    if (options.persistProgress) options.persistProgress(state);
    return { ok: false, errors: [`#${item.issue_number}: ${message}`], progress: state, items: resultItems };
  };
  for (const item of items) {
    const transitionRequest = requests.get(item.issue_number);
    const transitionReceipt = transitionByIssue.get(item.issue_number);
    if (!transitionRequest || !transitionReceipt) return { ok: false, errors: [`#${item.issue_number}: transition input missing`], progress: state, items: resultItems };
    const request = buildMaterializationRequest(transitionRequest, transitionReceipt);
    let live;
    let gate;
    try { live = options.loadLive(request); gate = targetPreflight(packetSet.packets.find((packet) => packet.issue_number === item.issue_number), transitionRequest, transitionReceipt, live, { readBlob: options.readBlob }); }
    catch (error) { return { ok: false, errors: [`#${item.issue_number}: fresh preflight failed: ${error.message}`], progress: state, items: resultItems }; }
    if (!gate.ok) return { ok: false, errors: gate.errors.map((error) => `#${item.issue_number}: ${error}`), progress: state, items: resultItems };
    let owner = gate.owners[0] || null;
    if (!owner) {
      mark(item, 'create-pending', { request, projection: gate.projection, mutation_attempted: false, mutation_performed: false, possibly_performed: false });
      if (typeof options.beforeMutation === 'function') {
        try { options.beforeMutation('create', request); } catch (error) { return { ok: false, errors: [`#${item.issue_number}: mutation hook failed before create: ${error.message}`], progress: state, items: resultItems }; }
      }
      state.mutation_attempted = true; state.possibly_performed = true;
      state.items[String(item.issue_number)].intent = makeIntent(item, 'create-pending', { request, projection: gate.projection, mutation_attempted: true, mutation_performed: null, possibly_performed: true });
      if (options.persistProgress) options.persistProgress(state);
      try { options.createInterviewIssue(request, gate.projection); }
      catch (error) {
        let reconciled;
        try { const after = options.loadLive(request); reconciled = targetPreflight(packetSet.packets.find((packet) => packet.issue_number === item.issue_number), transitionRequest, transitionReceipt, after, { readBlob: options.readBlob }); }
        catch (reconcileError) { return failUncertain(item, 'create-pending', `create response lost and ownership reconcile failed: ${reconcileError.message}`, { cause: error.message }); }
        if (!reconciled.ok || reconciled.owners.length !== 1) return failUncertain(item, 'create-pending', `create response lost without exactly one reconciled owner: ${error.message}`, { reconcile_errors: reconciled.errors });
        gate = reconciled; owner = reconciled.owners[0];
      }
      if (!owner) {
        let reconciled;
        try { const after = options.loadLive(request); reconciled = targetPreflight(packetSet.packets.find((packet) => packet.issue_number === item.issue_number), transitionRequest, transitionReceipt, after, { readBlob: options.readBlob }); }
        catch (error) { return failUncertain(item, 'create-pending', `create succeeded without fresh ownership reconcile: ${error.message}`); }
        if (!reconciled.ok || reconciled.owners.length !== 1) return failUncertain(item, 'create-pending', 'create response did not reconcile to exactly one owner', { reconcile_errors: reconciled.errors });
        gate = reconciled; owner = reconciled.owners[0];
      }
      state.mutation_performed = true; state.possibly_performed = false;
      mark(item, 'created', { owner_issue_number: Number(owner.number), interview_body_sha256: sha256Text(gate.projection.body) });
    }
    if (gate.receipts.receipt) {
      const foundReceipt = buildMaterializationReceipt(request, owner, gate.projection);
      const actual = { ...foundReceipt, comment_id: Number(gate.receipts.receipt.comment.id) };
      if (!compareReceiptFacts(actual, gate.receipts.receipt.value)) return failUncertain(item, 'created', 'live materialization receipt conflicts with the fresh projection');
      if (options.writeReceipt) options.writeReceipt(request, actual);
      state.items[String(item.issue_number)].result = { status: 'already-materialized', interview_issue_number: Number(owner.number), receipt: actual, mutation_attempted: false, mutation_performed: false, possibly_performed: false };
      mark(item, 'complete', { receipt: actual });
      resultItems.push({ issue_number: item.issue_number, action: 'already-materialized', interview_issue_number: Number(owner.number) });
      continue;
    }
    const receipt = buildMaterializationReceipt(request, owner, gate.projection);
    if (options.writeRequest) options.writeRequest(request, request);
    mark(item, 'receipt-pending', { receipt, owner_issue_number: Number(owner.number), mutation_attempted: state.mutation_attempted, mutation_performed: state.mutation_performed, possibly_performed: true });
    if (typeof options.beforeMutation === 'function') {
      try { options.beforeMutation('receipt', request); } catch (error) { return { ok: false, errors: [`#${item.issue_number}: mutation hook failed before receipt: ${error.message}`], progress: state, items: resultItems }; }
    }
    state.mutation_attempted = true; state.possibly_performed = true;
    state.items[String(item.issue_number)].intent = makeIntent(item, 'receipt-pending', { receipt, owner_issue_number: Number(owner.number), mutation_attempted: true, mutation_performed: null, possibly_performed: true });
    if (options.persistProgress) options.persistProgress(state);
    try { options.postReceipt(request, receipt); } catch (_) { /* POST is never retried; reconcile below */ }
    let afterGate;
    try { const after = options.loadLive(request); afterGate = targetPreflight(packetSet.packets.find((packet) => packet.issue_number === item.issue_number), transitionRequest, transitionReceipt, after, { readBlob: options.readBlob }); }
    catch (error) { return failUncertain(item, 'receipt-pending', `receipt response lost and fresh reconcile failed: ${error.message}`); }
    if (!afterGate.ok || !afterGate.receipts.receipt) return failUncertain(item, 'receipt-pending', 'receipt POST did not reconcile to a unique matching live receipt', { reconcile_errors: afterGate.errors });
    const confirmed = buildMaterializationReceipt(request, afterGate.owners[0], afterGate.projection);
    const liveReceipt = { ...confirmed, comment_id: Number(afterGate.receipts.receipt.comment.id) };
    if (!compareReceiptFacts(liveReceipt, receipt) && !compareReceiptFacts(liveReceipt, afterGate.receipts.receipt.value)) return failUncertain(item, 'receipt-pending', 'live receipt facts differ from the durable receipt intent');
    if (options.writeReceipt) options.writeReceipt(request, liveReceipt);
    state.mutation_performed = true; state.possibly_performed = false;
    state.items[String(item.issue_number)].result = { status: 'materialized', interview_issue_number: Number(afterGate.owners[0].number), receipt: liveReceipt, mutation_attempted: true, mutation_performed: true, possibly_performed: false };
    mark(item, 'complete', { receipt: liveReceipt });
    resultItems.push({ issue_number: item.issue_number, action: 'materialized', interview_issue_number: Number(afterGate.owners[0].number) });
  }
  state.status = 'complete'; state.possibly_performed = false;
  if (options.persistProgress) options.persistProgress(state);
  return { ok: true, items: resultItems, progress: state, mutation_attempted: state.mutation_attempted, mutation_performed: state.mutation_performed, possibly_performed: false };
}

function targetPreflight(packet, transitionRequest, transitionReceipt, live, options = {}) {
  const errors = [];
  const sourceIssue = live && live.sourceIssue;
  const labelsResult = normalizeLabels(sourceIssue && sourceIssue.labels);
  if (!labelsResult.ok) errors.push(...labelsResult.errors);
  const labels = labelsResult.labels || [];
  if (!sourceIssue || Number(sourceIssue.number) !== transitionRequest.issue_number) errors.push('live SourceNote Issue identity mismatch');
  if (!sourceIssue || String(sourceIssue.state || '').toLowerCase() !== 'open') errors.push('live SourceNote must be open');
  if (sourceIssue && sha256Text(sourceIssue.body || '') !== transitionReceipt.new_body_sha256) errors.push('live SourceNote body does not match #1554 receipt target');
  if (labels.includes('boundary:pending') || !labels.includes('boundary:single-interview') || labels.filter((label) => label.startsWith('boundary:')).length !== 1) errors.push('live SourceNote must be exactly boundary:single-interview');
  const forbidden = forbiddenSourceLabels(labels);
  if (forbidden.length) errors.push(`SourceNote has forbidden materialization-side labels: ${forbidden.join(', ')}`);

  const validation = validateSourceNoteIssue({ body: sourceIssue && sourceIssue.body || '', labels, state: String(sourceIssue && sourceIssue.state || '').toLowerCase() });
  if (!validation.ok) errors.push(...validation.errors.map((error) => `SourceNote invalid: ${error}`));
  const record = validation.parsed && validation.parsed.record;
  const targetId = interviewNoteId(transitionRequest.source_note_id);
  if (!record || record.source_note_id !== transitionRequest.source_note_id) errors.push('SourceNote id mismatch');
  if (record && (record.source_revision?.id !== transitionRequest.expected_source_revision_id || record.boundary_review?.status !== 'single-interview' || !same(record.boundary_review?.interview_note_ids || [], [targetId]))) errors.push('SourceNote target record is not the exact #1554 single-interview state');

  const artifact = record && packet && typeof options.readBlob === 'function'
    ? verifyPinnedArtifact({ source_note_id: packet.source_note_id, artifact: packet.artifact }, record, options.readBlob)
    : { ok: false, errors: ['pinned artifact reader is required'] };
  if (!artifact.ok) errors.push(...artifact.errors);

  if (!live || !Array.isArray(live.allIssues)) errors.push('live ownership inventory must be an explicit array');
  const owners = Array.isArray(live && live.allIssues)
    ? live.allIssues.filter((issue) => !issue.pull_request && parseInterviewNoteIssue(issue.body || '').marker?.interview_note_id === targetId)
    : [];
  if (owners.length > 1) errors.push(`duplicate InterviewNote ownership: ${owners.length}`);

  let projection = null;
  if (record && validation.ok && sourceIssue) {
    try { projection = buildInterviewProjection(sourceIssue, validation); }
    catch (error) { errors.push(`InterviewNote projection failed: ${error.message}`); }
  }
  if (projection && owners.length === 1) {
    const ownerValidation = validateExistingOwnership(owners[0], projection);
    if (!ownerValidation.ok) errors.push(...ownerValidation.errors);
  }
  const receipts = exactMaterializationReceipts(live && live.comments, buildMaterializationRequest(transitionRequest, transitionReceipt));
  if (!receipts.ok) errors.push(...receipts.errors);
  return {
    ok: errors.length === 0,
    errors,
    sourceIssue,
    labels,
    record,
    projection,
    owners,
    ownership_count: owners.length,
    receipts,
    action: owners.length === 0 ? 'would-create' : receipts.receipt ? 'already-materialized' : 'receipt-repair',
  };
}

function planBatch({ packetSet, manifest, transitionRequests, evidenceReceipts, transitionReceipts, loadLive, readBlob } = {}) {
  const input = validateMaterializationInputs({ packetSet, manifest, transitionRequests, evidenceReceipts, transitionReceipts });
  if (!input.ok) return { ok: false, errors: input.errors, items: [] };
  if (typeof loadLive !== 'function') return { ok: false, errors: ['loadLive is required'], items: [] };
  const packetByIssue = new Map(packetSet.packets.map((packet) => [Number(packet.issue_number), packet]));
  const items = [];
  const errors = [];
  for (const transitionRequest of transitionRequests) {
    const issue = Number(transitionRequest.issue_number);
    const packet = packetByIssue.get(issue);
    const transitionReceipt = transitionReceipts.find((receipt) => Number(receipt.issue_number) === issue);
    const request = buildMaterializationRequest(transitionRequest, transitionReceipt);
    let live;
    let gate;
    try { live = loadLive(request); gate = targetPreflight(packet, transitionRequest, transitionReceipt, live, { readBlob }); }
    catch (error) { gate = { ok: false, errors: [error.message], owners: [], ownership_count: 0, action: 'blocked' }; }
    if (!gate.ok) errors.push(`#${issue}: ${gate.errors.join('; ')}`);
    items.push({
      issue_number: issue,
      source_note_issue_number: issue,
      source_note_id: request.source_note_id,
      interview_note_id: interviewNoteId(request.source_note_id),
      request_sha256: requestSha256(request),
      action: gate.action || 'blocked',
      ownership_count: gate.ownership_count || 0,
      expected_source_note_body_sha256: request.expected_source_note_body_sha256,
      expected_interview_body_sha256: gate.projection ? sha256Text(gate.projection.body) : null,
      labels: gate.labels || [],
      source_ready: false,
      source_review: false,
      errors: gate.errors || [],
    });
  }
  const report = {
    schema_version: PLAN_SCHEMA_VERSION,
    batch_schema_version: BATCH_SCHEMA_VERSION,
    repository: REPOSITORY,
    packet_set_sha256: PACKET_SET_SHA256,
    fixed_issue_numbers: [...ISSUE_NUMBERS],
    total: items.length,
    mutation_count: 0,
    source_ready_count: 0,
    source_review_count: 0,
    errors,
    items,
  };
  return { ok: errors.length === 0, report: { ...report, plan_sha256: sha256Text(canonicalJson(report)) }, plan_sha256: sha256Text(canonicalJson(report)), items, errors };
}

module.exports = {
  BATCH_SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  REPOSITORY,
  PACKET_SET_SHA256,
  ISSUE_NUMBERS,
  FORBIDDEN_SOURCE_LABELS,
  FORBIDDEN_LEARNING_PREFIXES,
  requestSha256,
  interviewNoteId,
  materializationId,
  buildMaterializationRequest,
  validateFixedSet,
  validateMaterializationInputs,
  exactMaterializationReceipts,
  targetPreflight,
  planBatch,
  PROGRESS_SCHEMA_VERSION,
  INTENT_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  PHASES,
  durableWriteText,
  durableWriteJson,
  intentId,
  makeIntent,
  initialProgress,
  validateProgress,
  renderMaterializationReceipt,
  buildMaterializationReceipt,
  validateMaterializationReceipt,
  applyBatch,
  acquireProgressLock,
};
