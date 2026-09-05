'use strict';

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
      || found.value.interview_note_id !== interviewNoteId(request.source_note_id)) errors.push('materialization receipt identity mismatch');
  }
  return { ok: errors.length === 0, receipt: matches.length === 1 ? matches[0] : null, errors };
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
};
