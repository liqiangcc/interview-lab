'use strict';

const { canonicalJson, sha256Text, validateManifest: validateRecoveryManifest, parseIndependentEvidence, reviewAction } = require('./issue-1539-recovery-plan');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./interview-note-issue');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');
const {
  computeChecks,
  evidenceSubjectSha256,
  planSourceReview,
  sourceReadyGate,
  validateRequest,
  validateEvidenceComment,
} = require('./interview-note-source-review-transition');
const { analyzeSourceProvenance } = require('./source-note-provenance');
const {
  validateManifest: validatePinnedArtifactManifest,
  verifyManifestDigest,
  verifyManifestItem,
} = require('./issue-1539-pinned-artifact-manifest');
const { buildSourceReviewRequest } = require('../plan-xhs-issue-1539-recovery');

const PACKET_SCHEMA_VERSION = 'issue-1539-source-review-packets.v1';
const CANDIDATE_STATUS = 'candidate-only-awaiting-independent-source-review-evidence';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digestWithoutField(value, field) {
  const without = clone(value);
  delete without[field];
  return sha256Text(canonicalJson(without));
}

function assertEqual(actual, expected, label, errors) {
  if (canonicalJson(actual) !== canonicalJson(expected)) errors.push(`${label} mismatch`);
}

function labelsOf(issue) {
  return (issue && issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
}

function sourceRevisionEvidence(sourceRecord, request) {
  const revision = sourceRecord.source_revision || {};
  return {
    source_repository: revision.source_repository || null,
    source_repository_ref: request.expected_source_repository_ref,
    ...(request.expected_manifest_sha256 == null ? {} : { manifest_sha256: request.expected_manifest_sha256 }),
    raw_artifact_count: (sourceRecord.artifacts || []).filter((artifact) => artifact.provenance === 'raw_capture').length,
    source_projection_count: (sourceRecord.artifacts || []).filter((artifact) => artifact.provenance === 'source_projection').length,
  };
}

function decisionFields(decision) {
  return {
    current_status: decision.current_status,
    action: decision.action,
    candidate_decision: decision.candidate_decision,
    independent_evidence: decision.independent_evidence,
    source_ready_gate: decision.source_ready_gate,
    receipt_count: decision.receipt_count,
    mutation_performed: decision.mutation_performed,
    errors: decision.errors,
  };
}

function validatePacketSet(packetSet, { manifest, report, pinnedArtifactManifest } = {}) {
  const errors = [];
  if (!packetSet || typeof packetSet !== 'object' || Array.isArray(packetSet)) return { ok: false, errors: ['packet set must be an object'] };
  if (!manifest) errors.push('manifest anchor is required');
  if (!report) errors.push('recovery report anchor is required');
  if (!pinnedArtifactManifest) errors.push('pinned artifact manifest anchor is required');
  if (errors.length) return { ok: false, errors };
  const recoveryManifestValidation = validateRecoveryManifest(manifest);
  if (!recoveryManifestValidation.ok) errors.push(...recoveryManifestValidation.errors.map((error) => `manifest: ${error}`));
  const pinnedManifestValidation = validatePinnedArtifactManifest(pinnedArtifactManifest);
  if (!pinnedManifestValidation.ok) errors.push(...pinnedManifestValidation.errors.map((error) => `pinned manifest: ${error}`));
  if (report.dry_run_sha256 !== digestWithoutField(report, 'dry_run_sha256')) errors.push('recovery dry-run digest is not reproducible');
  if (report.manifest && report.manifest.pinned_artifact_manifest_sha256 !== pinnedArtifactManifest.digest) errors.push('recovery report is not bound to the supplied pinned artifact manifest');
  if (packetSet.schema_version !== PACKET_SCHEMA_VERSION) errors.push(`schema_version must be ${PACKET_SCHEMA_VERSION}`);
  if (packetSet.repository !== manifest.repository) errors.push('packet set repository mismatch');
  if (canonicalJson(packetSet.source_snapshot) !== canonicalJson(manifest.source_snapshot)) errors.push('packet set source snapshot mismatch');
  if (!Array.isArray(packetSet.packets) || packetSet.packets.length !== 30) errors.push('packets must contain exactly 30 items');
  if (!packetSet.pinned_artifact_manifest_sha256 || !/^[0-9a-f]{64}$/.test(packetSet.pinned_artifact_manifest_sha256)) errors.push('packet set must bind a pinned artifact manifest digest');
  if (!packetSet.packet_set_sha256 || !/^[0-9a-f]{64}$/.test(packetSet.packet_set_sha256)) errors.push('packet_set_sha256 must be a lowercase SHA-256');
  if (packetSet.packet_set_sha256 && digestWithoutField(packetSet, 'packet_set_sha256') !== packetSet.packet_set_sha256) errors.push('packet_set_sha256 is not reproducible');
  if (report && packetSet.recovery_dry_run_sha256 !== report.dry_run_sha256) errors.push('recovery dry-run digest mismatch');
  if (pinnedArtifactManifest && packetSet.pinned_artifact_manifest_sha256 !== pinnedArtifactManifest.digest) errors.push('pinned artifact manifest digest mismatch');

  const seen = new Set();
  for (const [index, packet] of (packetSet.packets || []).entries()) {
    const prefix = `packets[${index}]`;
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) { errors.push(`${prefix} must be an object`); continue; }
    const identity = `${packet.interview_issue_number}:${packet.source_note_issue_number}`;
    if (seen.has(identity)) errors.push(`${prefix} duplicates ${identity}`);
    seen.add(identity);
    if (!Number.isInteger(packet.interview_issue_number) || packet.interview_issue_number < 1) errors.push(`${prefix}.interview_issue_number must be positive`);
    if (!Number.isInteger(packet.source_note_issue_number) || packet.source_note_issue_number < 1) errors.push(`${prefix}.source_note_issue_number must be positive`);
    if (packet.status !== CANDIDATE_STATUS) errors.push(`${prefix} must remain candidate-only`);
    if (packet.live_status !== 'blocked') errors.push(`${prefix} live status must be blocked`);
    if (packet.independent_evidence !== 'missing') errors.push(`${prefix} must not claim independent evidence`);
    if (packet.boundary_review_evidence_reused !== false) errors.push(`${prefix} must not reuse Boundary Review evidence`);
    if (!packet.pinned_artifact_manifest_item_verified) errors.push(`${prefix} pinned manifest item must be verified`);
    if (!packet.candidate_request || typeof packet.candidate_request !== 'object') { errors.push(`${prefix}.candidate_request is required`); continue; }
    const request = packet.candidate_request;
    const requestValidation = validateRequest(request, { planningOnly: true });
    if (!requestValidation.ok) errors.push(...requestValidation.errors.map((error) => `${prefix}.candidate_request: ${error}`));
    for (const forbidden of ['reviewed_at', 'reviewer_kind', 'review_evidence']) {
      if (Object.prototype.hasOwnProperty.call(request, forbidden)) errors.push(`${prefix}.candidate_request must not fabricate ${forbidden}`);
    }
    if (request.issue_number !== packet.interview_issue_number) errors.push(`${prefix} request InterviewNote Issue mismatch`);
    if (request.source_note_issue_number !== packet.source_note_issue_number) errors.push(`${prefix} request SourceNote Issue mismatch`);
    if (request.interview_note_id !== packet.interview_note_id) errors.push(`${prefix} request InterviewNote identity mismatch`);
    if (request.expected_interview_body_sha256 !== packet.expected_interview_body_sha256) errors.push(`${prefix} request InterviewNote body SHA mismatch`);
    if (request.expected_source_note_body_sha256 !== packet.expected_source_note_body_sha256) errors.push(`${prefix} request SourceNote body SHA mismatch`);
    if (request.expected_source_revision_id !== packet.source_revision_id) errors.push(`${prefix} request SourceRevision mismatch`);
    if (canonicalJson(request.checks) !== canonicalJson(packet.computed_checks)) errors.push(`${prefix} request checks mismatch`);
    if (request.expected_initial_status !== 'blocked' || request.recovery_mode !== 'blocked-source-recovery') errors.push(`${prefix} request is not restricted blocked recovery`);
    if (request.decision !== 'source-ready') errors.push(`${prefix} candidate decision must be source-ready`);
    if (request.pinned_artifact_manifest_sha256 !== packetSet.pinned_artifact_manifest_sha256) errors.push(`${prefix} request manifest digest mismatch`);
    if (packet.evidence_subject_sha256 !== request.evidence_subject_sha256) errors.push(`${prefix} evidence subject mismatch`);
    if (request.evidence_subject_sha256 !== evidenceSubjectSha256(request, request.checks)) errors.push(`${prefix} evidence subject is not reproducible`);
    if (report) {
      const reportItem = (report.source_review && report.source_review.items || []).find((item) => Number(item.issue_number) === Number(packet.interview_issue_number) && Number(item.source_note_issue_number) === Number(packet.source_note_issue_number));
      if (!reportItem) errors.push(`${prefix} is absent from recovery dry-run`);
      else {
        assertEqual(packet.expected_interview_body_sha256, reportItem.expected_interview_body_sha256, `${prefix} InterviewNote body SHA`, errors);
        assertEqual(packet.expected_source_note_body_sha256, reportItem.expected_source_note_body_sha256, `${prefix} SourceNote body SHA`, errors);
        assertEqual(packet.interview_note_id, reportItem.interview_note_id, `${prefix} InterviewNote identity`, errors);
        assertEqual(packet.source_revision_id, reportItem.expected_source_revision_id, `${prefix} SourceRevision`, errors);
        assertEqual(packet.live_status, reportItem.current_status, `${prefix} live status`, errors);
        assertEqual(packet.evidence_subject_sha256, reportItem.evidence_subject_sha256, `${prefix} report evidence subject`, errors);
        assertEqual(packet.computed_checks, reportItem.computed_checks, `${prefix} computed checks`, errors);
        assertEqual(packet.source_revision_evidence, reportItem.source_revision_evidence, `${prefix} source revision evidence`, errors);
        assertEqual(packet.provenance, reportItem.provenance, `${prefix} provenance`, errors);
        assertEqual(packet.failed_check_ids, reportItem.failed_check_ids, `${prefix} failed checks`, errors);
        assertEqual(packet.source_ready_gate, reportItem.source_ready_gate, `${prefix} source-ready gate`, errors);
        assertEqual(packet.decision_fields, decisionFields(reportItem), `${prefix} decision fields`, errors);
        assertEqual(packet.independent_evidence, reportItem.independent_evidence, `${prefix} independent evidence`, errors);
        assertEqual(packet.boundary_review_evidence_reused, reportItem.boundary_review_evidence_reused, `${prefix} Boundary Review reuse flag`, errors);
        assertEqual(packet.pinned_artifact_manifest_item_verified, reportItem.pinned_artifact_manifest_item_verified, `${prefix} manifest item verification`, errors);
      }
    }
    if (pinnedArtifactManifest) {
      const manifestItem = pinnedArtifactManifest.items.find((item) => Number(item.interview_issue_number) === Number(packet.interview_issue_number) && Number(item.source_note_issue_number) === Number(packet.source_note_issue_number));
      if (!manifestItem) errors.push(`${prefix} is absent from pinned artifact manifest`);
      else {
        assertEqual(packet.pinned_artifact_manifest_item, manifestItem, `${prefix} pinned manifest item`, errors);
        if (packet.source_revision_id !== manifestItem.source_revision_id) errors.push(`${prefix} SourceRevision/manifest mismatch`);
      }
    }
    if (!packet.source_facts || !packet.pinned_artifact_manifest_item || packet.source_facts.source_note_id !== packet.pinned_artifact_manifest_item.source_note_id) errors.push(`${prefix} source facts do not bind manifest SourceNote identity`);
    if (!packet.source_facts || !packet.source_facts.source_revision || packet.source_facts.source_revision.id !== packet.source_revision_id) errors.push(`${prefix} source facts do not bind SourceRevision`);
    if (!packet.interview_facts || packet.interview_facts.interview_note_id !== packet.interview_note_id) errors.push(`${prefix} InterviewNote facts do not bind InterviewNote identity`);
    if (packet.source_facts) assertEqual(packet.source_revision_evidence, sourceRevisionEvidence(packet.source_facts, request), `${prefix} derived source revision evidence`, errors);
    if (packet.source_facts) assertEqual(packet.provenance, analyzeSourceProvenance(packet.source_facts), `${prefix} derived provenance`, errors);
    assertEqual(packet.failed_check_ids, packet.computed_checks.filter((check) => check.result !== 'pass').map((check) => check.check_id), `${prefix} derived failed checks`, errors);
    const gate = sourceReadyGate(request, packet.computed_checks, packet.provenance, { ...pinnedArtifactManifest, item_verified: packet.pinned_artifact_manifest_item_verified });
    assertEqual(packet.source_ready_gate, gate, `${prefix} derived source-ready gate`, errors);
  }
  return { ok: errors.length === 0, errors };
}

function buildPacketSet({ manifest, report, pinnedArtifactManifest, liveIssues, liveComments }) {
  const errors = [];
  if (!manifest || !report || !pinnedArtifactManifest) throw new Error('manifest, recovery report, and pinned artifact manifest are required');
  const pinnedValidation = validatePinnedArtifactManifest(pinnedArtifactManifest);
  if (!pinnedValidation.ok) errors.push(...pinnedValidation.errors);
  const digestCheck = verifyManifestDigest(pinnedArtifactManifest, report.manifest && report.manifest.pinned_artifact_manifest_sha256);
  if (!digestCheck.ok) errors.push(...digestCheck.errors);
  if (report.dry_run_sha256 !== digestWithoutField(report, 'dry_run_sha256')) errors.push('recovery dry-run digest is not reproducible');
  if (!Array.isArray(liveIssues)) errors.push('liveIssues must be an array');
  if (!(liveComments instanceof Map)) errors.push('liveComments must be a Map of read-only Issue comments');
  const liveByNumber = new Map((liveIssues || []).map((issue) => [Number(issue.number), issue]));
  const allIssues = [...new Map((liveIssues || []).map((issue) => [Number(issue.number), issue])).values()];
  const packets = [];
  for (const [index, item] of (manifest.source_review.items || []).entries()) {
    const reportItem = (report.source_review && report.source_review.items || []).find((candidate) => Number(candidate.issue_number) === Number(item.interview_issue_number) && Number(candidate.source_note_issue_number) === Number(item.source_note_issue_number));
    const interviewIssue = liveByNumber.get(Number(item.interview_issue_number));
    const sourceIssue = liveByNumber.get(Number(item.source_note_issue_number));
    const prefix = `source_review.items[${index}]`;
    if (!reportItem) { errors.push(`${prefix} missing recovery report item`); continue; }
    if (!interviewIssue || !sourceIssue) { errors.push(`${prefix} live Issue lookup missing`); continue; }
    if (sha256Text(interviewIssue.body || '') !== reportItem.expected_interview_body_sha256) errors.push(`${prefix} stale InterviewNote body`);
    if (sha256Text(sourceIssue.body || '') !== reportItem.expected_source_note_body_sha256) errors.push(`${prefix} stale SourceNote body`);
    const currentStatus = labelsOf(interviewIssue).filter((label) => label.startsWith('status:'));
    if (currentStatus.length !== 1 || currentStatus[0] !== 'status:blocked') errors.push(`${prefix} live InterviewNote must have exactly status:blocked`);
    const interviewValidation = validateInterviewNoteIssue({ body: interviewIssue.body || '', labels: labelsOf(interviewIssue), state: String(interviewIssue.state || '').toLowerCase() });
    const sourceValidation = validateSourceNoteIssue({ body: sourceIssue.body || '', labels: labelsOf(sourceIssue), state: String(sourceIssue.state || '').toLowerCase() });
    if (!interviewValidation.ok) errors.push(...interviewValidation.errors.map((error) => `${prefix} InterviewNote: ${error}`));
    if (!sourceValidation.ok) errors.push(...sourceValidation.errors.map((error) => `${prefix} SourceNote: ${error}`));
    if (!interviewValidation.parsed || !sourceValidation.parsed) continue;
    const interviewRecord = interviewValidation.parsed.record;
    const sourceRecord = sourceValidation.parsed.record;
    if (interviewRecord.interview_note_id !== item.interview_note_id) errors.push(`${prefix} InterviewNote identity mismatch`);
    const request = buildSourceReviewRequest(manifest, { ...item, source_note_body: sourceIssue.body || '' }, interviewIssue, interviewRecord, sourceRecord, pinnedArtifactManifest);
    request.checks = computeChecks(request, interviewIssue, sourceIssue, allIssues);
    const reportChecks = reportItem.computed_checks || [];
    if (canonicalJson(request.checks) !== canonicalJson(reportChecks)) errors.push(`${prefix} live machine checks differ from recovery report`);
    request.evidence_subject_sha256 = evidenceSubjectSha256(request, request.checks);
    if (request.evidence_subject_sha256 !== reportItem.evidence_subject_sha256) errors.push(`${prefix} evidence subject differs from recovery report`);
    const manifestItem = pinnedArtifactManifest.items.find((candidate) => Number(candidate.interview_issue_number) === Number(item.interview_issue_number) && Number(candidate.source_note_issue_number) === Number(item.source_note_issue_number));
    if (!manifestItem) errors.push(`${prefix} pinned artifact manifest item missing`);
    const manifestItemCheck = verifyManifestItem(pinnedArtifactManifest, request, sourceRecord);
    if (!manifestItemCheck.ok) errors.push(...manifestItemCheck.errors.map((error) => `${prefix} pinned manifest: ${error}`));
    const requestValidation = validateRequest(request, { planningOnly: true });
    if (!requestValidation.ok) errors.push(...requestValidation.errors.map((error) => `${prefix} candidate request: ${error}`));
    const comments = liveComments instanceof Map ? liveComments.get(Number(item.interview_issue_number)) : null;
    if (!Array.isArray(comments)) errors.push(`${prefix} live comments lookup missing`);
    const evidence = parseIndependentEvidence(comments || [], {
      repository: manifest.repository,
      interview_note_id: request.interview_note_id,
      source_note_issue_number: item.source_note_issue_number,
      source_revision_id: request.expected_source_revision_id,
      transition_id: request.transition_id,
      evidence_subject_sha256: request.evidence_subject_sha256,
      expected_interview_body_sha256: request.expected_interview_body_sha256,
      expected_source_note_body_sha256: request.expected_source_note_body_sha256,
      provenance_mode: request.provenance_mode,
      pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256,
      checks: request.checks,
    });
    const evidenceComment = evidence.evidence && (comments || []).find((comment) => Number(comment.id) === Number(evidence.evidence.comment_id));
    const evidenceCommentErrors = [];
    if (evidenceComment) validateEvidenceComment(request, evidenceComment, evidenceCommentErrors);
    const transition = planSourceReview(request, interviewIssue, { planningOnly: true, sourceIssue, allIssues, evidenceComment, pinnedArtifactManifest });
    if (!transition.ok) errors.push(...transition.errors.map((error) => `${prefix} transition planning: ${error}`));
    const liveDecision = reviewAction({
      currentStatus: transition.current_status || 'blocked',
      checks: transition.computed_checks || request.checks,
      evidence: evidence.evidence,
      receiptCount: (comments || []).filter((comment) => String(comment.body || '').includes('interview-note-source-review-applied')).length,
      errors: [...evidence.errors, ...evidenceCommentErrors, ...transition.errors],
      sourceReadyGateResult: transition.source_ready_gate,
    });
    if (canonicalJson(decisionFields(liveDecision)) !== canonicalJson(decisionFields(reportItem))) errors.push(`${prefix} live decision fields differ from recovery report`);
    const liveSourceRevisionEvidence = sourceRevisionEvidence(sourceRecord, request);
    const liveProvenance = transition.provenance || analyzeSourceProvenance(sourceRecord);
    const liveFailedCheckIds = request.checks.filter((check) => check.result !== 'pass').map((check) => check.check_id);
    if (canonicalJson(liveSourceRevisionEvidence) !== canonicalJson(reportItem.source_revision_evidence)) errors.push(`${prefix} live source revision evidence differs from recovery report`);
    if (canonicalJson(liveProvenance) !== canonicalJson(reportItem.provenance)) errors.push(`${prefix} live provenance differs from recovery report`);
    if (canonicalJson(liveFailedCheckIds) !== canonicalJson(reportItem.failed_check_ids)) errors.push(`${prefix} live failed checks differ from recovery report`);
    if (canonicalJson(transition.source_ready_gate) !== canonicalJson(reportItem.source_ready_gate)) errors.push(`${prefix} live source-ready gate differs from recovery report`);
    packets.push({
      sequence: index + 1,
      packet_id: `${manifest.source_review.batch_id}:${item.interview_issue_number}`,
      status: CANDIDATE_STATUS,
      interview_issue_number: Number(item.interview_issue_number),
      source_note_issue_number: Number(item.source_note_issue_number),
      live_status: 'blocked',
      interview_note_id: request.interview_note_id,
      expected_interview_body_sha256: request.expected_interview_body_sha256,
      expected_source_note_body_sha256: request.expected_source_note_body_sha256,
      source_revision_id: request.expected_source_revision_id,
      source_facts: clone(sourceRecord),
      interview_facts: clone(interviewRecord),
      source_revision_evidence: liveSourceRevisionEvidence,
      pinned_artifact_manifest_item: clone(manifestItem),
      pinned_artifact_manifest_item_verified: manifestItemCheck.ok,
      provenance: liveProvenance,
      computed_checks: clone(request.checks),
      failed_check_ids: liveFailedCheckIds,
      evidence_subject_sha256: request.evidence_subject_sha256,
      candidate_request: request,
      source_ready_gate: clone(transition.source_ready_gate),
      decision_fields: decisionFields(liveDecision),
      independent_evidence: liveDecision.independent_evidence,
      boundary_review_evidence_reused: false,
      review_instruction: '主控逐项确认 live body SHA、SourceRevision、manifest item、全部 checks 与 subject digest；取得独立 Source Review 证据前保持 blocked。',
    });
  }
  if (errors.length) throw new Error(errors.join('; '));
  const packetSetWithoutDigest = {
    schema_version: PACKET_SCHEMA_VERSION,
    repository: manifest.repository,
    source_snapshot: clone(manifest.source_snapshot),
    source_review_batch_id: manifest.source_review.batch_id,
    recovery_dry_run_sha256: report.dry_run_sha256,
    pinned_artifact_manifest_sha256: pinnedArtifactManifest.digest,
    pinned_artifact_manifest_item_count: pinnedArtifactManifest.items.length,
    candidate_status: CANDIDATE_STATUS,
    mutation_performed: false,
    packets,
  };
  const packetSet = { ...packetSetWithoutDigest, packet_set_sha256: sha256Text(canonicalJson(packetSetWithoutDigest)) };
  const validation = validatePacketSet(packetSet, { manifest, report, pinnedArtifactManifest });
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return packetSet;
}

function renderSummary(packetSet) {
  const lines = [
    '# Issue #1539 Source Review 审核包汇总',
    '',
    `- 状态：${packetSet.candidate_status}`,
    `- repository：${packetSet.repository}`,
    `- source-review batch：${packetSet.source_review_batch_id}`,
    `- recovery dry-run：\`${packetSet.recovery_dry_run_sha256}\``,
    `- pinned artifact manifest：\`${packetSet.pinned_artifact_manifest_sha256}\`（${packetSet.pinned_artifact_manifest_item_count}/30）`,
    `- packet set digest：\`${packetSet.packet_set_sha256}\``,
    '- mutation：false；未生成 comment locator/reviewed_at，candidate request 仅可用于 planning-only 审核。',
    '',
    '| # | InterviewNote | SourceNote | SourceRevision | failed checks | evidence_subject_sha256 |',
    '|---:|---:|---:|---|---|---|',
  ];
  for (const packet of packetSet.packets) {
    lines.push(`| ${packet.sequence} | #${packet.interview_issue_number} | #${packet.source_note_issue_number} | \`${packet.source_revision_id}\` | ${packet.failed_check_ids.join(', ') || 'none'} | \`${packet.evidence_subject_sha256}\` |`);
  }
  lines.push('', '审核边界：30 条 live status 均为 `blocked`；Source projection 的 Raw lineage 未声称；Boundary Review evidence 不得充当 Source Review evidence；证据不足时必须保持 blocked。', '');
  return lines.join('\n');
}

module.exports = { PACKET_SCHEMA_VERSION, CANDIDATE_STATUS, validatePacketSet, buildPacketSet, renderSummary, digestWithoutField };
