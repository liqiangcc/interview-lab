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
  evidenceSubjectSha256,
  planSourceReview,
  requestSha256,
  validateRequest,
} = require('./interview-note-source-review-transition');
const { validateInterviewNoteIssue } = require('./interview-note-issue');
const { validateSourceNoteIssue } = require('./source-note-issue');
const {
  buildManifest,
  validateManifest: validatePinnedManifest,
  verifyManifestItem,
} = require('./issue-1539-pinned-artifact-manifest');
const {
  evidenceBody,
  inspectEvidence,
  validateEvidenceBodySize,
  buildFormalRequest,
  requestBody,
  acquireProgressLock,
} = require('./issue-1539-evidence-batch');

const SCOPE = 'issue-1577-fixed-17';
const SCHEMA_VERSION = 'issue-1577-source-review-batch.v1';
const PROGRESS_SCHEMA_VERSION = 'issue-1577-source-review-progress.v1';
const RECEIPT_SCHEMA_VERSION = 'issue-1577-source-review-receipt.v1';
const INTENT_SCHEMA_VERSION = 'issue-1577-source-review-intent.v1';
const INTENT_PHASES = new Set(['planned', 'post-pending', 'post-uncertain', 'evidence-posted', 'request-written', 'receipt-pending', 'receipt-uncertain', 'receipt-written', 'complete']);
const MAX_COMMENT_BYTES = 65536;
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const FIXED_ITEMS = Object.freeze([
  [158, 1558, 'xhs-note:6615074a000000001b01318f', 'xhs-note:6615074a000000001b01318f:snapshot-95b77bb26104', '26c384f9b0621e95405c096149949919107a7dac'],
  [278, 1559, 'xhs-note:66ad8f30000000000600d4fd', 'xhs-note:66ad8f30000000000600d4fd:snapshot-95b77bb26104', '3f5852d5b69ffcad581eb4acc5e92d92c34cba78'],
  [361, 1562, 'xhs-note:670cbc25000000002100bc6b', 'xhs-note:670cbc25000000002100bc6b:snapshot-95b77bb26104', '678075a4cde4f580fcd50a5af904697abd25218b'],
  [478, 1563, 'xhs-note:677cc089000000000800c983', 'xhs-note:677cc089000000000800c983:snapshot-95b77bb26104', 'c3384b75166656e0d76b3b91d7e01f523776b75d'],
  [649, 1564, 'xhs-note:67e63a42000000001d006100', 'xhs-note:67e63a42000000001d006100:snapshot-95b77bb26104', 'd6b59f9526ce9274dfaeb3591d1124587535a284'],
  [692, 1565, 'xhs-note:67f49f22000000000b01cae3', 'xhs-note:67f49f22000000000b01cae3:snapshot-95b77bb26104', '9665c004ca830d6937bcf2aae24317d35d234c1e'],
  [843, 1566, 'xhs-note:6824b0bb0000000021001e25', 'xhs-note:6824b0bb0000000021001e25:snapshot-95b77bb26104', '20c1034788767419733bd9fd235181e9567e131a'],
  [901, 1567, 'xhs-note:6842998a000000000303f15c', 'xhs-note:6842998a000000000303f15c:snapshot-95b77bb26104', '488680a5585c30308b5346499966f33241b66221'],
  [937, 1568, 'xhs-note:6843eb6b000000002202daa4', 'xhs-note:6843eb6b000000002202daa4:snapshot-95b77bb26104', '88f28efd9e84e5ca5efca7b57bb6e5be5d7b6660'],
  [942, 1569, 'xhs-note:68465a78000000000f03bdcd', 'xhs-note:68465a78000000000f03bdcd:snapshot-95b77bb26104', 'df4d4992516a27aafe4a3ef61ff9d64d015e5258'],
  [946, 1570, 'xhs-note:6846a62900000000210185f6', 'xhs-note:6846a62900000000210185f6:snapshot-95b77bb26104', 'b85b6c3a8c625a7055bed6be40988ff00899c060'],
  [952, 1571, 'xhs-note:684a3226000000001101ca7c', 'xhs-note:684a3226000000001101ca7c:snapshot-95b77bb26104', '06b22a91322436583ace28188ea91ac70ce0003c'],
  [987, 1572, 'xhs-note:685d25970000000017036aec', 'xhs-note:685d25970000000017036aec:snapshot-95b77bb26104', 'e52402553eb55460b10d5bd1c58f4573652d1b12'],
  [1121, 1573, 'xhs-note:689eed25000000001b03450a', 'xhs-note:689eed25000000001b03450a:snapshot-95b77bb26104', 'a1d9a3f35aa2f80b0b418b998eb0583cd9033f07'],
  [1168, 1574, 'xhs-note:68a99d1c000000001d039d10', 'xhs-note:68a99d1c000000001d039d10:snapshot-95b77bb26104', '4b34caf771f89a18b632d3468a08fb14720ee8d5'],
  [1221, 1575, 'xhs-note:68b2c7b4000000001b01f8ba', 'xhs-note:68b2c7b4000000001b01f8ba:snapshot-95b77bb26104', 'eb496bf7f5ba82a6d52d5b899de7fc63463af76c'],
  [1301, 1576, 'xhs-note:68c36f32000000001d00c805', 'xhs-note:68c36f32000000001d00c805:snapshot-95b77bb26104', '72b4f5d9ab8bd0034ca2f69494bea3e5072adb47'],
].map(([source_note_issue_number, interview_issue_number, source_note_id, source_revision_id, text_projection_blob]) => ({
  source_note_issue_number,
  interview_issue_number,
  source_note_id,
  source_revision_id,
  text_projection_ref: `${SOURCE_REPOSITORY}:note_desc/${source_note_id.slice('xhs-note:'.length)}.txt@${SOURCE_REF}`,
  text_projection_blob,
})));

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function bodySha(issue) { return sha256Text(issue && issue.body || ''); }
function fixedKey(item) { return `${item.source_note_issue_number}:${item.interview_issue_number}`; }
function fixedMap() { return new Map(FIXED_ITEMS.map((item) => [fixedKey(item), item])); }

function validateFixedManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['fixed manifest must be an object'] };
  if (manifest.schema_version !== 'issue-1577-source-review-manifest.v1') errors.push('fixed manifest schema_version mismatch');
  if (manifest.issue_number !== 1577 || manifest.repository !== 'liqiangcc/interview-lab') errors.push('fixed manifest repository/Issue mismatch');
  if (manifest.scope !== SCOPE) errors.push('fixed manifest scope mismatch');
  if (!manifest.source_snapshot || manifest.source_snapshot.repository !== SOURCE_REPOSITORY || manifest.source_snapshot.ref !== SOURCE_REF) errors.push('fixed manifest source snapshot mismatch');
  if (!Array.isArray(manifest.items) || manifest.items.length !== FIXED_ITEMS.length) errors.push('fixed manifest must contain exactly 17 items');
  for (const [index, expected] of FIXED_ITEMS.entries()) {
    const actual = manifest.items && manifest.items[index];
    for (const field of ['source_note_issue_number', 'interview_issue_number', 'source_note_id', 'source_revision_id', 'text_projection_blob']) {
      if (!actual || actual[field] !== expected[field]) errors.push(`fixed manifest item ${index} ${field} mismatch`);
    }
    if (!actual || actual.text_projection_ref !== expected.text_projection_ref) errors.push(`fixed manifest item ${index} text projection ref mismatch`);
  }
  return { ok: errors.length === 0, errors };
}

function buildPinnedManifest(fixedManifest, sourceRecords, treeEntries) {
  const errors = [];
  const fixedValidation = validateFixedManifest(fixedManifest);
  if (!fixedValidation.ok) errors.push(...fixedValidation.errors);
  const entries = [];
  for (const item of FIXED_ITEMS) {
    const record = sourceRecords.get(item.source_note_issue_number);
    if (!record) { errors.push(`SourceNote #${item.source_note_issue_number} record is missing`); continue; }
    if (record.source_note_id !== item.source_note_id) errors.push(`SourceNote #${item.source_note_issue_number} identity mismatch`);
    if (!record.source_revision || record.source_revision.id !== item.source_revision_id) errors.push(`SourceNote #${item.source_note_issue_number} SourceRevision mismatch`);
    const projection = (record.artifacts || []).find((artifact) => artifact.kind === 'text_projection');
    if (!projection || projection.ref !== item.text_projection_ref || projection.git_blob_sha !== item.text_projection_blob) errors.push(`SourceNote #${item.source_note_issue_number} pinned text projection mismatch`);
    entries.push({
      interview_issue_number: item.interview_issue_number,
      source_note_issue_number: item.source_note_issue_number,
      source_note_id: record.source_note_id,
      source_revision_id: record.source_revision.id,
      artifacts: record.artifacts,
    });
  }
  if (errors.length) return { ok: false, errors };
  const result = buildManifest({
    repository: fixedManifest.repository,
    sourceSnapshot: fixedManifest.source_snapshot,
    entries,
    treeEntries,
    scope: 'issue-1577-fixed-17',
  });
  const validation = validatePinnedManifest(result);
  if (!validation.ok) errors.push(...validation.errors);
  return { ok: errors.length === 0, errors, manifest: result };
}

function buildRequest(item, interviewIssue, sourceRecord, allIssues, pinnedArtifactManifest) {
  const request = {
    schema_version: 'interview-note-source-review-transition.v1',
    transition_id: `issue-1577-source-review-${item.interview_issue_number}`,
    repository: 'liqiangcc/interview-lab',
    issue_number: item.interview_issue_number,
    interview_note_id: `xhs:${sourceRecord.source.external_id}`,
    expected_interview_body_sha256: bodySha(interviewIssue),
    expected_initial_status: 'captured',
    expected_source_revision_id: sourceRecord.source_revision.id,
    source_note_issue_number: item.source_note_issue_number,
    expected_source_note_body_sha256: item.source_note_body_sha256,
    expected_source_repository_ref: SOURCE_REF,
    provenance_mode: 'pinned-source-artifact',
    provenance_statement: 'pinned-source-artifact; raw-lineage-unproven',
    pinned_artifact_manifest_sha256: pinnedArtifactManifest.digest,
    decision: 'source-ready',
    limitations: sourceRecord.limitations || [],
  };
  request.checks = computeChecks(request, interviewIssue, { body: item.source_body, labels: item.source_labels, state: item.source_state }, allIssues);
  request.evidence_subject_sha256 = evidenceSubjectSha256(request, request.checks);
  const validation = validateRequest(request, { planningOnly: true });
  return { request, validation };
}

function verifyPinnedItem(item, sourceRecord, fixedManifest, pinnedArtifactManifest) {
  const errors = [];
  const fixed = fixedMap().get(fixedKey(item));
  if (!fixed) errors.push(`${item.packet_id} is outside fixed manifest`);
  if (fixed && (!sourceRecord || sourceRecord.source_note_id !== fixed.source_note_id)) errors.push(`${item.packet_id} SourceNote id mismatch`);
  if (fixed && (!sourceRecord.source_revision || sourceRecord.source_revision.id !== fixed.source_revision_id)) errors.push(`${item.packet_id} SourceRevision mismatch`);
  const verification = verifyManifestItem(pinnedArtifactManifest, item.candidate_request, sourceRecord);
  errors.push(...verification.errors);
  const manifestItem = pinnedArtifactManifest.items.find((candidate) => Number(candidate.source_note_issue_number) === Number(item.source_note_issue_number) && Number(candidate.interview_issue_number) === Number(item.interview_issue_number));
  if (!manifestItem || !fixed || manifestItem.artifacts.find((artifact) => artifact.kind === 'text_projection')?.ref !== fixed.text_projection_ref || manifestItem.artifacts.find((artifact) => artifact.kind === 'text_projection')?.git_blob_sha !== fixed.text_projection_blob) errors.push(`${item.packet_id} fixed text projection binding mismatch`);
  return { ok: errors.length === 0, errors, item: manifestItem || null };
}

function validatePacketSet(packetSet, fixedManifest, pinnedArtifactManifest) {
  const errors = [];
  if (!fixedManifest) errors.push('fixed manifest anchor is required');
  if (!pinnedArtifactManifest) errors.push('pinned artifact manifest anchor is required');
  const fixedValidation = validateFixedManifest(fixedManifest);
  if (!fixedValidation.ok) errors.push(...fixedValidation.errors);
  const pinnedValidation = validatePinnedManifest(pinnedArtifactManifest);
  if (!pinnedValidation.ok) errors.push(...pinnedValidation.errors);
  if (!packetSet || packetSet.schema_version !== SCHEMA_VERSION || packetSet.scope !== SCOPE) errors.push('packet set schema/scope mismatch');
  if (!packetSet || packetSet.repository !== 'liqiangcc/interview-lab' || packetSet.issue_number !== 1577) errors.push('packet set repository/Issue mismatch');
  if (!packetSet || !Array.isArray(packetSet.packets) || packetSet.packets.length !== 17) errors.push('packet set must contain exactly 17 packets');
  if (!packetSet || packetSet.pinned_artifact_manifest_sha256 !== (pinnedArtifactManifest && pinnedArtifactManifest.digest)) errors.push('packet set pinned manifest digest mismatch');
  if (!packetSet || !/^[0-9a-f]{64}$/.test(String(packetSet.packet_set_sha256 || ''))) errors.push('packet_set_sha256 is required');
  if (errors.length) return { ok: false, errors };
  const { packet_set_sha256: ignoredPacketSetHash, ...packetSetWithoutHash } = packetSet;
  const packetSetWithoutItemHashes = {
    ...packetSetWithoutHash,
    packets: packetSet.packets.map(({ packet_set_sha256, ...packet }) => packet),
  };
  if (sha256Text(canonicalJson(packetSetWithoutItemHashes)) !== packetSet.packet_set_sha256) errors.push('packet_set_sha256 is not reproducible');
  const seen = new Set();
  for (const [index, packet] of packetSet.packets.entries()) {
    const prefix = `packets[${index}]`;
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) { errors.push(`${prefix} must be an object`); continue; }
    const key = `${packet.source_note_issue_number}:${packet.interview_issue_number}`;
    if (seen.has(key)) errors.push(`${prefix} duplicate identity`); seen.add(key);
    const fixed = fixedMap().get(key);
    if (!fixed) { errors.push(`${prefix} is outside fixed17`); continue; }
    for (const field of ['source_note_id', 'source_revision_id', 'interview_note_id', 'expected_source_note_body_sha256', 'expected_interview_body_sha256', 'evidence_subject_sha256']) if (!packet[field]) errors.push(`${prefix}.${field} is required`);
    if (packet.boundary_review_evidence_reused !== false) errors.push(`${prefix} must not reuse Boundary Review evidence`);
    if (!packet.candidate_request || packet.candidate_request.expected_initial_status !== 'captured' || packet.candidate_request.recovery_mode != null) errors.push(`${prefix} candidate request must be captured/no-recovery`);
    if (packet.candidate_request && packet.candidate_request.pinned_artifact_manifest_sha256 !== pinnedArtifactManifest.digest) errors.push(`${prefix} request pinned digest mismatch`);
    const requestValidation = validateRequest(packet.candidate_request, { planningOnly: true });
    if (!requestValidation.ok) errors.push(...requestValidation.errors.map((error) => `${prefix}: ${error}`));
    const expectedSet = { ...packet, packet_set_sha256: undefined };
    delete expectedSet.packet_set_sha256;
    if (packet.packet_set_sha256 !== packetSet.packet_set_sha256) errors.push(`${prefix} packet set identity mismatch`);
    if (packet.source_note_issue_number !== fixed.source_note_issue_number || packet.interview_issue_number !== fixed.interview_issue_number || packet.source_note_id !== fixed.source_note_id || packet.source_revision_id !== fixed.source_revision_id) errors.push(`${prefix} fixed identity mismatch`);
  }
  const expectedKeys = new Set(FIXED_ITEMS.map(fixedKey));
  for (const key of expectedKeys) if (!seen.has(key)) errors.push(`packet set is missing fixed identity ${key}`);
  return { ok: errors.length === 0, errors };
}

function makePacket(item, sourceIssue, interviewIssue, sourceRecord, interviewRecord, allIssues, pinnedArtifactManifest) {
  const sourceBody = sourceIssue.body || '';
  const { request, validation } = buildRequest({ ...item, source_body: sourceBody, source_labels: labelsOf(sourceIssue), source_state: sourceIssue.state, source_note_body_sha256: bodySha(sourceIssue) }, interviewIssue, sourceRecord, allIssues, pinnedArtifactManifest);
  const errors = [...validation.errors];
  const transition = planSourceReview(request, interviewIssue, {
    planningOnly: true,
    sourceIssue,
    allIssues,
    pinnedArtifactManifest,
  });
  errors.push(...transition.errors);
  const failed = request.checks.filter((check) => check.result !== 'pass').map((check) => check.check_id);
  const packet = {
    packet_id: `issue-1577-source-review-${item.interview_issue_number}`,
    source_note_issue_number: item.source_note_issue_number,
    interview_issue_number: item.interview_issue_number,
    source_note_id: sourceRecord.source_note_id,
    interview_note_id: interviewRecord.interview_note_id,
    source_revision_id: sourceRecord.source_revision.id,
    expected_source_note_body_sha256: bodySha(sourceIssue),
    expected_interview_body_sha256: bodySha(interviewIssue),
    source_facts: clone(sourceRecord),
    interview_facts: clone(interviewRecord),
    source_revision_evidence: {
      source_repository: sourceRecord.source_revision.source_repository,
      source_repository_ref: sourceRecord.source_revision.source_repository_ref,
      raw_artifact_count: sourceRecord.artifacts.filter((artifact) => artifact.provenance === 'raw_capture').length,
      source_projection_count: sourceRecord.artifacts.filter((artifact) => artifact.provenance === 'source_projection').length,
    },
    pinned_artifact_manifest_item: pinnedArtifactManifest.items.find((candidate) => Number(candidate.source_note_issue_number) === Number(item.source_note_issue_number) && Number(candidate.interview_issue_number) === Number(item.interview_issue_number)),
    provenance: transition.provenance,
    computed_checks: request.checks,
    failed_check_ids: failed,
    evidence_subject_sha256: request.evidence_subject_sha256,
    candidate_request: request,
    source_ready_gate: transition.source_ready_gate,
    boundary_review_evidence_reused: false,
    build_errors: errors,
  };
  return { packet, transition, errors };
}

function authorizationSha256(packetSet, pinnedArtifactManifest) {
  return sha256Text(canonicalJson({
    scope: SCOPE,
    issue_number: 1577,
    repository: packetSet.repository,
    source_snapshot: packetSet.source_snapshot,
    pinned_artifact_manifest_sha256: pinnedArtifactManifest.digest,
    packets: packetSet.packets.map((packet) => ({
      packet_id: packet.packet_id,
      source_note_issue_number: packet.source_note_issue_number,
      interview_issue_number: packet.interview_issue_number,
      source_note_id: packet.source_note_id,
      interview_note_id: packet.interview_note_id,
      source_revision_id: packet.source_revision_id,
      expected_source_note_body_sha256: packet.expected_source_note_body_sha256,
      expected_interview_body_sha256: packet.expected_interview_body_sha256,
      evidence_subject_sha256: packet.evidence_subject_sha256,
      checks: packet.computed_checks,
    })),
  }));
}

function finalizePacketSet(packetBase) {
  const packetSetHash = sha256Text(canonicalJson(packetBase));
  return {
    ...packetBase,
    packet_set_sha256: packetSetHash,
    packets: packetBase.packets.map((packet) => ({ ...packet, packet_set_sha256: packetSetHash })),
  };
}

function planBatch({ fixedManifest, treeEntries, liveLoader } = {}) {
  const errors = [];
  if (typeof liveLoader !== 'function') errors.push('liveLoader is required');
  const fixedValidation = validateFixedManifest(fixedManifest);
  if (!fixedValidation.ok) errors.push(...fixedValidation.errors);
  if (errors.length) return { ok: false, errors, mode: 'plan', mutation_count: 0, possibly_performed: false };
  const live = new Map();
  const sourceRecords = new Map();
  for (const item of FIXED_ITEMS) {
    let snapshot;
    try { snapshot = liveLoader(item); } catch (error) { errors.push(`load ${fixedKey(item)} failed: ${error.message}`); continue; }
    if (!snapshot || !Array.isArray(snapshot.comments) || !Array.isArray(snapshot.sourceComments) || !Array.isArray(snapshot.allIssues)) errors.push(`live snapshot ${fixedKey(item)} must contain comments/sourceComments/allIssues arrays`);
    const sourceValidation = validateSourceNoteIssue({ body: snapshot && snapshot.sourceIssue && snapshot.sourceIssue.body || '', labels: labelsOf(snapshot && snapshot.sourceIssue), state: snapshot && snapshot.sourceIssue && snapshot.sourceIssue.state || '' });
    const interviewValidation = validateInterviewNoteIssue({ body: snapshot && snapshot.interviewIssue && snapshot.interviewIssue.body || '', labels: labelsOf(snapshot && snapshot.interviewIssue), state: snapshot && snapshot.interviewIssue && snapshot.interviewIssue.state || '' });
    if (!sourceValidation.ok) errors.push(...sourceValidation.errors.map((error) => `SourceNote #${item.source_note_issue_number}: ${error}`));
    if (!interviewValidation.ok) errors.push(...interviewValidation.errors.map((error) => `InterviewNote #${item.interview_issue_number}: ${error}`));
    if (!sourceValidation.parsed || !interviewValidation.parsed) continue;
    sourceRecords.set(item.source_note_issue_number, sourceValidation.parsed.record);
    live.set(fixedKey(item), { ...snapshot, sourceRecord: sourceValidation.parsed.record, interviewRecord: interviewValidation.parsed.record });
  }
  const pinned = buildPinnedManifest(fixedManifest, sourceRecords, treeEntries || []);
  if (!pinned.ok) errors.push(...pinned.errors);
  if (errors.length) return { ok: false, errors, mode: 'plan', mutation_count: 0, possibly_performed: false };
  const packets = [];
  for (const item of FIXED_ITEMS) {
    const current = live.get(fixedKey(item));
    const built = makePacket(item, current.sourceIssue, current.interviewIssue, current.sourceRecord, current.interviewRecord, current.allIssues, pinned.manifest);
    if (built.errors.length) errors.push(...built.errors.map((error) => `${built.packet.packet_id}: ${error}`));
    packets.push(built.packet);
  }
  if (errors.length) return { ok: false, errors, mode: 'plan', mutation_count: 0, possibly_performed: false };
  const packetBase = {
    schema_version: SCHEMA_VERSION,
    scope: SCOPE,
    issue_number: 1577,
    repository: 'liqiangcc/interview-lab',
    source_snapshot: fixedManifest.source_snapshot,
    pinned_artifact_manifest_sha256: pinned.manifest.digest,
    packets: packets.map((packet) => ({ ...packet, packet_set_sha256: undefined })),
  };
  const packetSet = finalizePacketSet(packetBase);
  const setValidation = validatePacketSet(packetSet, fixedManifest, pinned.manifest);
  if (!setValidation.ok) return { ok: false, errors: setValidation.errors, mode: 'plan', mutation_count: 0, possibly_performed: false };
  const authorization = authorizationSha256(packetSet, pinned.manifest);
  const items = packets.map((packet) => {
    const current = live.get(`${packet.source_note_issue_number}:${packet.interview_issue_number}`);
    const evidence = inspectEvidence(current.comments, { candidate_request: packet.candidate_request }, packetSet.packet_set_sha256);
    const bodySize = validateEvidenceBodySize({ candidate_request: packet.candidate_request, interview_facts: packet.interview_facts, source_facts: packet.source_facts, failed_check_ids: packet.failed_check_ids, source_revision_evidence: packet.source_revision_evidence, source_ready_gate: packet.source_ready_gate }, packetSet.packet_set_sha256, MAX_COMMENT_BYTES);
    const currentStatus = statusOf(current.interviewIssue);
    const action = evidence.exact ? 'already-present' : currentStatus === 'captured' ? 'would-post' : 'remain-blocked';
    return {
      packet_id: packet.packet_id,
      source_note_issue_number: packet.source_note_issue_number,
      interview_issue_number: packet.interview_issue_number,
      current_status: currentStatus,
      evidence_marker_count: evidence.marker_count,
      action,
      evidence_comment_id: evidence.exact ? Number(evidence.comment.id) : null,
      evidence_body_bytes: bodySize.bytes,
      evidence_gate: evidence,
      source_ready_gate: packet.source_ready_gate,
      failed_check_ids: packet.failed_check_ids,
      mutation_performed: false,
      possibly_performed: false,
      errors: [...evidence.errors, ...bodySize.errors],
    };
  });
  const planBase = {
    schema_version: SCHEMA_VERSION,
    mode: 'plan',
    issue_number: 1577,
    repository: 'liqiangcc/interview-lab',
    fixed_item_count: 17,
    packet_set_sha256: packetSet.packet_set_sha256,
    pinned_artifact_manifest_sha256: pinned.manifest.digest,
    authorization_sha256: authorization,
    preflight_ok: items.every((item) => item.errors.length === 0),
    mutation_count: 0,
    mutation_attempted: false,
    mutation_performed: false,
    possibly_performed: false,
    items,
  };
  const plan = { ...planBase, plan_sha256: sha256Text(canonicalJson(planBase)) };
  return { ok: plan.preflight_ok, ...plan, packetSet, pinnedArtifactManifest: pinned.manifest, live, errors: items.flatMap((item) => item.errors) };
}

function safeCounts(progress) {
  const fields = ['create_attempt_count', 'receipt_attempt_count', 'mutation_count'];
  if (!progress || fields.some((field) => !Number.isSafeInteger(progress[field]) || progress[field] < 0)) return null;
  return progress.create_attempt_count + progress.receipt_attempt_count === progress.mutation_count ? {
    create_attempt_count: progress.create_attempt_count,
    receipt_attempt_count: progress.receipt_attempt_count,
    mutation_count: progress.mutation_count,
  } : null;
}

function initialProgress(packetSet, authorization) {
  return {
    schema_version: PROGRESS_SCHEMA_VERSION,
    scope: SCOPE,
    packet_set_sha256: packetSet.packet_set_sha256,
    authorization_sha256: authorization,
    status: 'planned',
    create_attempt_count: 0,
    receipt_attempt_count: 0,
    mutation_count: 0,
    mutation_attempted: false,
    mutation_performed: false,
    possibly_performed: false,
    intents: Object.fromEntries(packetSet.packets.map((packet) => [packet.packet_id, null])),
    results: {},
  };
}

function validateProgress(progress, packetSet, authorization) {
  const errors = [];
  if (!progress || progress.schema_version !== PROGRESS_SCHEMA_VERSION || progress.scope !== SCOPE) errors.push('progress schema/scope mismatch');
  if (progress && progress.packet_set_sha256 !== packetSet.packet_set_sha256) errors.push('progress packet set mismatch');
  if (progress && progress.authorization_sha256 !== authorization) errors.push('progress authorization mismatch');
  if (progress && !['planned', 'running', 'failed', 'complete'].includes(progress.status)) errors.push('progress status is invalid');
  if (!safeCounts(progress)) errors.push('progress mutation counters must be safe non-negative integers with a matching sum');
  const ids = new Set(packetSet.packets.map((packet) => packet.packet_id));
  for (const id of ids) if (!Object.prototype.hasOwnProperty.call(progress && progress.intents || {}, id)) errors.push(`progress missing intent ${id}`);
  for (const id of Object.keys(progress && progress.intents || {})) if (!ids.has(id)) errors.push(`progress has unknown intent ${id}`);
  for (const id of Object.keys(progress && progress.results || {})) if (!ids.has(id)) errors.push(`progress has unknown result ${id}`);
  for (const [id, intent] of Object.entries(progress && progress.intents || {})) {
    if (intent == null) continue;
    if (intent.schema_version !== INTENT_SCHEMA_VERSION || intent.packet_id !== id || intent.packet_set_sha256 !== packetSet.packet_set_sha256 || intent.authorization_sha256 !== authorization) errors.push(`intent identity mismatch ${id}`);
    if (intent.intent_id !== sha256Text(`${authorization}:${id}`)) errors.push(`intent id mismatch ${id}`);
    if (!INTENT_PHASES.has(intent.phase)) errors.push(`intent phase invalid ${id}`);
  }
  for (const [id, result] of Object.entries(progress && progress.results || {})) {
    if (!result || !Number.isInteger(result.evidence_comment_id) || result.evidence_comment_id < 1) errors.push(`result evidence comment id invalid ${id}`);
    if (!result || !/^[0-9a-f]{64}$/.test(String(result.request_sha256 || ''))) errors.push(`result request digest invalid ${id}`);
    if (!result || result.receipt_written !== true) errors.push(`result receipt is not durably written ${id}`);
    if (result && !/^[0-9a-f]{64}$/.test(String(result.receipt_sha256 || ''))) errors.push(`result receipt digest invalid ${id}`);
    const intent = progress.intents && progress.intents[id];
    if (intent && intent.phase === 'complete' && (!result || result.receipt_written !== true)) errors.push(`complete intent has no complete result ${id}`);
  }
  if (progress && progress.status === 'complete') {
    for (const id of ids) {
      if (!progress.intents || progress.intents[id] == null || progress.intents[id].phase !== 'complete') errors.push(`complete progress has unresolved intent ${id}`);
      if (!progress.results || progress.results[id] == null) errors.push(`complete progress has no result ${id}`);
    }
    if (progress.possibly_performed === true) errors.push('complete progress cannot remain possibly_performed');
  }
  return { ok: errors.length === 0, errors };
}

function makeIntent(packet, authorization, phase, fields = {}) {
  return { schema_version: INTENT_SCHEMA_VERSION, intent_id: sha256Text(`${authorization}:${packet.packet_id}`), packet_set_sha256: packet.packet_set_sha256, authorization_sha256: authorization, packet_id: packet.packet_id, source_note_issue_number: packet.source_note_issue_number, interview_issue_number: packet.interview_issue_number, interview_note_id: packet.interview_note_id, evidence_subject_sha256: packet.evidence_subject_sha256, phase, ...fields };
}

function buildReceipt(packet, request, commentId, authorizationSha256Value) {
  return { schema_version: RECEIPT_SCHEMA_VERSION, packet_set_sha256: packet.packet_set_sha256, authorization_sha256: authorizationSha256Value, request_sha256: requestSha256(request), repository: request.repository, issue_number: request.issue_number, source_note_issue_number: request.source_note_issue_number, interview_note_id: request.interview_note_id, source_note_body_sha256: request.expected_source_note_body_sha256, interview_body_sha256: request.expected_interview_body_sha256, source_revision_id: request.expected_source_revision_id, pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256, evidence_subject_sha256: request.evidence_subject_sha256, evidence_comment_id: Number(commentId) };
}

function receiptSha256(receipt) { return sha256Text(canonicalJson(receipt)); }

function validateReceipt(receipt, packet, request, authorizationSha256Value = null) {
  const errors = [];
  if (!receipt || receipt.schema_version !== RECEIPT_SCHEMA_VERSION) errors.push('receipt schema mismatch');
  for (const [field, expected] of [['packet_set_sha256', packet.packet_set_sha256], ['repository', request.repository], ['issue_number', request.issue_number], ['source_note_issue_number', request.source_note_issue_number], ['interview_note_id', request.interview_note_id], ['source_note_body_sha256', request.expected_source_note_body_sha256], ['interview_body_sha256', request.expected_interview_body_sha256], ['source_revision_id', request.expected_source_revision_id], ['pinned_artifact_manifest_sha256', request.pinned_artifact_manifest_sha256], ['evidence_subject_sha256', request.evidence_subject_sha256]]) if (!receipt || receipt[field] !== expected) errors.push(`receipt ${field} mismatch`);
  if (!receipt || !Number.isInteger(receipt.evidence_comment_id) || receipt.evidence_comment_id < 1) errors.push('receipt evidence_comment_id invalid');
  if (request.review_evidence && Number(receipt && receipt.evidence_comment_id) !== Number(request.review_evidence.comment_id)) errors.push('receipt evidence comment id mismatch');
  if (receipt && receipt.request_sha256 !== requestSha256(request)) errors.push('receipt request digest mismatch');
  if (authorizationSha256Value != null && (!receipt || receipt.authorization_sha256 !== authorizationSha256Value)) errors.push('receipt authorization digest mismatch');
  return { ok: errors.length === 0, errors };
}

function applyBatch({ fixedManifest, treeEntries, liveLoader, progress, expectedPlanSha256, expectedAuthorizationSha256 } = {}, options = {}) {
  const counts = safeCounts(progress);
  const invalidCounts = !counts;
  const baseResult = { ok: false, mode: 'apply', mutation_attempted: progress && progress.mutation_attempted === true, mutation_performed: progress && progress.mutation_performed === true ? true : null, possibly_performed: progress && progress.possibly_performed === true, create_attempt_count: invalidCounts ? null : counts.create_attempt_count, receipt_attempt_count: invalidCounts ? null : counts.receipt_attempt_count, mutation_count: invalidCounts ? null : counts.mutation_count, count_status: invalidCounts ? 'invalid' : 'valid', items: [], errors: [] };
  if (!progress) return { ...baseResult, errors: ['apply requires progress'] };
  const lock = options.lock;
  const assertLock = () => { if (!lock || typeof lock.assertHeld !== 'function') throw new Error('apply requires an acquired progress lock'); lock.assertHeld(); };
  try { assertLock(); } catch (error) { return { ...baseResult, errors: [error.message] }; }
  const freshPlan = (options.planBatch || planBatch)({ fixedManifest, treeEntries, liveLoader });
  if (!freshPlan.ok) return { ...baseResult, errors: freshPlan.errors };
  if (freshPlan.plan_sha256 !== expectedPlanSha256) return { ...baseResult, errors: [`fresh plan digest mismatch: expected ${expectedPlanSha256}, got ${freshPlan.plan_sha256}`] };
  if (freshPlan.authorization_sha256 !== expectedAuthorizationSha256) return { ...baseResult, errors: [`authorization digest mismatch: expected ${expectedAuthorizationSha256}, got ${freshPlan.authorization_sha256}`] };
  const validation = validateProgress(progress, freshPlan.packetSet, freshPlan.authorization_sha256);
  if (!validation.ok) return { ...baseResult, errors: validation.errors, create_attempt_count: invalidCounts ? null : counts.create_attempt_count, receipt_attempt_count: invalidCounts ? null : counts.receipt_attempt_count, mutation_count: invalidCounts ? null : counts.mutation_count, count_status: invalidCounts ? 'invalid' : 'valid' };
  const persist = (value) => { assertLock(); if (typeof options.persistProgress !== 'function') throw new Error('durable progress persistence is required'); options.persistProgress(value); };
  const items = [];
  let result = { ...baseResult, ok: true, errors: [], items: [], create_attempt_count: counts.create_attempt_count, receipt_attempt_count: counts.receipt_attempt_count, mutation_count: counts.mutation_count, count_status: 'valid' };
  const resultWithProgress = (overrides = {}) => ({ ...result, ...overrides, create_attempt_count: progress.create_attempt_count, receipt_attempt_count: progress.receipt_attempt_count, mutation_count: progress.mutation_count });
  for (const packet of freshPlan.packetSet.packets) {
    assertLock();
    const current = liveLoader({ source_note_issue_number: packet.source_note_issue_number, interview_issue_number: packet.interview_issue_number, source_note_id: packet.source_note_id, packet_id: packet.packet_id });
    if (!Array.isArray(current.comments) || !Array.isArray(current.sourceComments) || !Array.isArray(current.allIssues)) throw new Error(`${packet.packet_id}: live arrays are required`);
    const evidence = inspectEvidence(current.comments, { candidate_request: packet.candidate_request }, freshPlan.packetSet.packet_set_sha256);
    if (!evidence.ok) return resultWithProgress({ ok: false, errors: evidence.errors, items });
    let comment = evidence.exact ? evidence.comment : null;
    const prior = progress.intents[packet.packet_id];
    if (!comment) {
      if (prior && ['post-pending', 'post-uncertain'].includes(prior.phase)) return resultWithProgress({ ok: false, possibly_performed: true, errors: [`${packet.packet_id}: prior POST is uncertain; exact marker is absent, refusing duplicate POST`], items });
      if (statusOf(current.interviewIssue) !== 'captured') return resultWithProgress({ ok: false, errors: [`${packet.packet_id}: live InterviewNote is not captured and has no exact evidence`], items });
      const pending = makeIntent(packet, freshPlan.authorization_sha256, 'post-pending');
      progress.status = 'running'; progress.intents[packet.packet_id] = pending;
      persist(progress);
      if (typeof options.beforeEvidencePost === 'function') {
        try { options.beforeEvidencePost(); } catch (error) { return resultWithProgress({ ok: false, errors: [`${packet.packet_id}: mutation interval hook failed before POST: ${error.message}`], items }); }
      }
      assertLock();
      progress.mutation_attempted = true; progress.mutation_performed = null; progress.possibly_performed = true; progress.create_attempt_count += 1; progress.mutation_count = progress.create_attempt_count + progress.receipt_attempt_count;
      progress.intents[packet.packet_id] = makeIntent(packet, freshPlan.authorization_sha256, 'post-pending', { mutation_attempted: true, mutation_performed: null, possibly_performed: true });
      persist(progress);
      try { options.createEvidenceComment(packet, evidenceBody({ candidate_request: packet.candidate_request, interview_facts: packet.interview_facts, source_facts: packet.source_facts, failed_check_ids: packet.failed_check_ids, source_revision_evidence: packet.source_revision_evidence, source_ready_gate: packet.source_ready_gate }, freshPlan.packetSet.packet_set_sha256)); } catch (_) { /* reconcile below; never retry */ }
      const reconcileAttempts = Number.isSafeInteger(options.evidenceReconcileAttempts) && options.evidenceReconcileAttempts > 0 ? options.evidenceReconcileAttempts : 3;
      const reconcileBackoffMs = Number.isSafeInteger(options.evidenceReconcileBackoffMs) && options.evidenceReconcileBackoffMs >= 0 ? options.evidenceReconcileBackoffMs : 1000;
      const sleep = typeof options.sleep === 'function' ? options.sleep : () => {};
      let after = null;
      let reconcileError = null;
      for (let attempt = 1; attempt <= reconcileAttempts; attempt += 1) {
        assertLock();
        let reconciled = null;
        try { reconciled = liveLoader({ source_note_issue_number: packet.source_note_issue_number, interview_issue_number: packet.interview_issue_number, source_note_id: packet.source_note_id, packet_id: packet.packet_id }); } catch (error) { reconcileError = error.message; }
        assertLock();
        if (reconciled && Array.isArray(reconciled.comments)) {
          after = inspectEvidence(reconciled.comments, { candidate_request: packet.candidate_request }, freshPlan.packetSet.packet_set_sha256);
          if (after.ok && after.exact) break;
          reconcileError = (after.errors || []).join('; ') || 'exact evidence marker is absent';
        } else if (!reconcileError) reconcileError = 'reconcile comments response was not an array';
        if (attempt < reconcileAttempts) {
          assertLock();
          sleep(reconcileBackoffMs * (2 ** (attempt - 1)));
          assertLock();
        }
      }
      if (!after || !after.ok || !after.exact) {
        progress.status = 'failed'; progress.intents[packet.packet_id] = makeIntent(packet, freshPlan.authorization_sha256, 'post-uncertain', { mutation_attempted: true, mutation_performed: null, possibly_performed: true }); persist(progress);
        return resultWithProgress({ ok: false, possibly_performed: true, errors: [`${packet.packet_id}: evidence POST was not exactly recoverable after ${reconcileAttempts} read-only reconcile attempts${reconcileError ? `: ${reconcileError}` : ''}; refusing retry`], items });
      }
      comment = after.comment;
      progress.mutation_performed = true; progress.possibly_performed = false; progress.intents[packet.packet_id] = makeIntent(packet, freshPlan.authorization_sha256, 'evidence-posted', { evidence_comment_id: Number(comment.id), mutation_attempted: true, mutation_performed: true, possibly_performed: false });
      persist(progress);
    }
    assertLock();
    const fresh = liveLoader({ source_note_issue_number: packet.source_note_issue_number, interview_issue_number: packet.interview_issue_number, source_note_id: packet.source_note_id, packet_id: packet.packet_id });
    const finalEvidence = inspectEvidence(fresh.comments, { candidate_request: packet.candidate_request }, freshPlan.packetSet.packet_set_sha256);
    if (!finalEvidence.ok || !finalEvidence.exact || Number(finalEvidence.comment.id) !== Number(comment.id)) return resultWithProgress({ ok: false, errors: [`${packet.packet_id}: final exact evidence gate failed`, ...(finalEvidence.errors || [])], items });
    const priorFormalRequest = prior && prior.formal_request;
    const formal = priorFormalRequest || buildFormalRequest(packet, Number(comment.id), options.reviewedAt || new Date().toISOString());
    const planner = (options.planFormalRequest || planSourceReview)(formal, fresh.interviewIssue, { planningOnly: true, sourceIssue: fresh.sourceIssue, allIssues: fresh.allIssues, evidenceComment: finalEvidence.comment, pinnedArtifactManifest: freshPlan.pinnedArtifactManifest });
    if (!planner.ok) return resultWithProgress({ ok: false, errors: [`${packet.packet_id}: formal request planner failed`, ...planner.errors], items });
    const digest = requestSha256(formal);
    assertLock();
    const storedResult = progress.results[packet.packet_id];
    if (!(storedResult && storedResult.request_sha256 === digest && storedResult.receipt_written === true)) {
      if (typeof options.writeRequest !== 'function' || typeof options.writeReceipt !== 'function' || typeof options.readReceipt !== 'function') throw new Error('durable request, receipt writers, and receipt reader are required');
      if (!priorFormalRequest) {
        progress.intents[packet.packet_id] = makeIntent(packet, freshPlan.authorization_sha256, 'request-written', { evidence_comment_id: Number(comment.id), request_sha256: digest, formal_request: formal }); persist(progress);
        assertLock(); options.writeRequest(packet, requestBody(formal), formal);
      }
      const receipt = buildReceipt(packet, formal, Number(comment.id), freshPlan.authorization_sha256);
      let storedReceipt = null;
      const receiptDigest = receiptSha256(receipt);
      const receiptIntentFields = { evidence_comment_id: Number(comment.id), request_sha256: digest, formal_request: formal, receipt_sha256: receiptDigest, receipt_attempted: true, mutation_attempted: true, mutation_performed: null, possibly_performed: true };
      const pendingIntent = () => makeIntent(packet, freshPlan.authorization_sha256, 'receipt-pending', receiptIntentFields);
      const priorReceiptPhase = prior && ['receipt-pending', 'receipt-uncertain'].includes(prior.phase);
      const priorReceiptAttempt = prior && prior.receipt_attempted === true;
      if (priorReceiptPhase || priorReceiptAttempt) {
        try { storedReceipt = options.readReceipt(packet, formal); } catch (_) { storedReceipt = null; }
        if (!storedReceipt) return resultWithProgress({ ok: false, possibly_performed: true, errors: [`${packet.packet_id}: prior receipt write is uncertain; exact durable receipt is absent, refusing retry`], items });
      } else {
        progress.status = 'running';
        progress.receipt_attempt_count += 1;
        progress.mutation_count = progress.create_attempt_count + progress.receipt_attempt_count;
        progress.mutation_attempted = true;
        progress.mutation_performed = null;
        progress.possibly_performed = true;
        progress.intents[packet.packet_id] = pendingIntent();
        persist(progress);
        try { options.writeReceipt(packet, receipt); } catch (error) {
          try { storedReceipt = options.readReceipt(packet, formal); } catch (_) { storedReceipt = null; }
          if (!storedReceipt) {
            progress.status = 'failed';
            progress.mutation_performed = null;
            progress.possibly_performed = true;
            progress.intents[packet.packet_id] = makeIntent(packet, freshPlan.authorization_sha256, 'receipt-uncertain', { ...receiptIntentFields, error: error.message });
            persist(progress);
            return resultWithProgress({ ok: false, possibly_performed: true, errors: [`${packet.packet_id}: receipt write outcome was uncertain; exact durable receipt was not recoverable`], items });
          }
        }
        if (!storedReceipt) {
          try { storedReceipt = options.readReceipt(packet, formal); } catch (_) { storedReceipt = null; }
        }
      }
      const receiptValidation = validateReceipt(storedReceipt, packet, formal, freshPlan.authorization_sha256);
      if (!receiptValidation.ok || receiptSha256(storedReceipt) !== receiptDigest) {
        progress.status = 'failed';
        progress.mutation_performed = null;
        progress.possibly_performed = true;
        progress.intents[packet.packet_id] = makeIntent(packet, freshPlan.authorization_sha256, 'receipt-uncertain', { ...receiptIntentFields, errors: receiptValidation.errors });
        persist(progress);
        return resultWithProgress({ ok: false, possibly_performed: true, errors: [`${packet.packet_id}: durable receipt did not exactly match the planned receipt`], items });
      }
      progress.mutation_performed = true;
      progress.possibly_performed = false;
      progress.results[packet.packet_id] = { evidence_comment_id: Number(comment.id), request_sha256: digest, receipt_sha256: receiptDigest, receipt_written: true, mutation_attempted: true, mutation_performed: true, possibly_performed: false };
      progress.intents[packet.packet_id] = makeIntent(packet, freshPlan.authorization_sha256, 'receipt-written', { evidence_comment_id: Number(comment.id), request_sha256: digest, formal_request: formal, receipt_sha256: receiptDigest, mutation_attempted: true, mutation_performed: true, possibly_performed: false }); persist(progress);
      progress.intents[packet.packet_id] = makeIntent(packet, freshPlan.authorization_sha256, 'complete', { evidence_comment_id: Number(comment.id), request_sha256: digest, formal_request: formal, receipt_sha256: receiptDigest, mutation_attempted: true, mutation_performed: true, possibly_performed: false }); persist(progress);
    }
    items.push({ packet_id: packet.packet_id, evidence_comment_id: Number(comment.id), action: evidence.exact ? 'already-present' : 'posted', request_sha256: digest, mutation_performed: !evidence.exact });
  }
  progress.status = 'complete'; progress.possibly_performed = false; progress.mutation_count = progress.create_attempt_count + progress.receipt_attempt_count; persist(progress);
  return { ...result, ok: true, status: 'complete', items, mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed === true, possibly_performed: false, create_attempt_count: progress.create_attempt_count, receipt_attempt_count: progress.receipt_attempt_count, mutation_count: progress.mutation_count, progress };
}

module.exports = {
  SCOPE, SCHEMA_VERSION, PROGRESS_SCHEMA_VERSION, RECEIPT_SCHEMA_VERSION, INTENT_SCHEMA_VERSION,
  FIXED_ITEMS, validateFixedManifest, buildPinnedManifest, validatePacketSet, planBatch,
  authorizationSha256, finalizePacketSet, initialProgress, validateProgress, makeIntent, buildReceipt, validateReceipt,
  applyBatch, evidenceBody, requestBody, acquireProgressLock,
};
