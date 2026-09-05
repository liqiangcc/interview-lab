'use strict';

const crypto = require('node:crypto');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');
const { parseInterviewNoteIssue } = require('./interview-note-issue');
const { verifyPinnedArtifact, validateCandidateManifest, canonicalJson, sha256Text, FIXED_ISSUES, REPOSITORY, SOURCE_REF } = require('./issue-1539-boundary-expansion');
const { validateTransitionRequest, planSourceNoteBoundaryReviewTransition } = require('./source-note-boundary-review-transition');
const { acquireProgressLock } = require('./issue-1539-evidence-batch');

const PACKET_SET_SCHEMA_VERSION = 'issue-1549-boundary-review-evidence-packet-set.v1';
const EVIDENCE_SCHEMA_VERSION = 'boundary-review-evidence.v1';
const PROGRESS_SCHEMA_VERSION = 'issue-1549-boundary-evidence-progress.v1';
const INTENT_SCHEMA_VERSION = 'issue-1549-boundary-evidence-intent.v1';
const RECEIPT_SCHEMA_VERSION = 'issue-1549-boundary-review-evidence-receipt.v1';
const MAX_GITHUB_COMMENT_BYTES = 65536;
const PHASES = new Set(['evidence-post-pending', 'evidence-post-uncertain', 'evidence-posted', 'request-generated', 'receipt-written', 'request-failed']);
const EVIDENCE_MARKER_RE = /<!--\s*boundary-review-evidence\.v1\s*\n([\s\S]*?)\n-->/g;
const REQUIRED_CHECK_IDS = Object.freeze(['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function digestWithout(value, field) { const copy = clone(value); delete copy[field]; return sha256Text(canonicalJson(copy)); }

function packetId(issueNumber) { return `issue-1549-boundary-evidence-${String(issueNumber).padStart(4, '0')}`; }
function transitionId(issueNumber) { return `issue-1549-boundary-review-${String(issueNumber).padStart(4, '0')}`; }

function sourceEvidence(packet) {
  return {
    ref: packet.artifact.ref,
    git_blob_sha: packet.artifact.git_blob_sha,
    kind: packet.artifact.kind,
    provenance: packet.artifact.provenance,
    locator: `source-projection-anchor:${packet.artifact.anchor}`,
    anchor: packet.artifact.anchor,
  };
}

function buildPacket(item, index) {
  const packet = {
      sequence: index + 1,
      packet_id: packetId(item.issue_number),
      transition_id: transitionId(item.issue_number),
      repository: REPOSITORY,
      issue_number: item.issue_number,
      source_note_issue_number: item.issue_number,
      source_note_id: item.source_note_id,
      expected_body_sha256: item.expected_body_sha256,
      expected_source_revision_id: item.expected_source_revision_id,
      expected_source_repository_ref: SOURCE_REF,
      artifact: clone(item.artifact),
      decision: 'single-interview',
      rationale: item.rationale,
      checks: REQUIRED_CHECK_IDS.map((check_id) => ({ check_id, result: 'pass', note: check_id === 'event_boundary' ? item.rationale : `Bound to the fixed SourceNote/pinned source projection for #${item.issue_number}.` })),
      limitations: [
        'This is Boundary Review evidence only; it is not Source Review evidence.',
        'The packet does not create an InterviewNote, InterviewContext, learning label, or source-ready claim.',
      ],
      source_ready_gate: { allowed: false, reason: 'boundary-review-evidence-does-not-establish-source-ready' },
  };
  packet.evidence_subject_sha256 = sha256Text(canonicalJson({
      schema_version: EVIDENCE_SCHEMA_VERSION,
      packet_set_scope: 'issue-1549-boundary-expansion',
      packet_id: packet.packet_id,
      transition_id: packet.transition_id,
      repository: packet.repository,
      issue_number: packet.issue_number,
      source_note_issue_number: packet.source_note_issue_number,
      source_note_id: packet.source_note_id,
      expected_body_sha256: packet.expected_body_sha256,
      expected_source_revision_id: packet.expected_source_revision_id,
      expected_source_repository_ref: packet.expected_source_repository_ref,
      artifact: packet.artifact,
      decision: packet.decision,
      rationale: packet.rationale,
      checks: packet.checks,
      limitations: packet.limitations,
      source_evidence: sourceEvidence(packet),
      source_ready_gate: packet.source_ready_gate,
  }));
  return packet;
}

function buildPacketSet(manifest) {
  const validation = validateCandidateManifest(manifest);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  const packets = manifest.items.map(buildPacket);
  const withoutDigest = {
    schema_version: PACKET_SET_SCHEMA_VERSION,
    repository: REPOSITORY,
    parent_issue: 923,
    evidence_issue: 1549,
    source_repository_ref: SOURCE_REF,
    candidate_manifest_sha256: sha256Text(canonicalJson(manifest)),
    fixed_issue_numbers: [...FIXED_ISSUES],
    candidate_count: packets.length,
    mutation_performed: false,
    source_ready_claimed: false,
    packets,
  };
  return { ...withoutDigest, packet_set_sha256: sha256Text(canonicalJson(withoutDigest)) };
}

function validatePacketSet(packetSet, manifest) {
  const errors = [];
  const manifestValidation = validateCandidateManifest(manifest);
  if (!manifestValidation.ok) errors.push(...manifestValidation.errors.map((error) => `candidate manifest: ${error}`));
  if (!packetSet || typeof packetSet !== 'object' || Array.isArray(packetSet)) return { ok: false, errors: ['packet set must be an object', ...errors] };
  if (packetSet.schema_version !== PACKET_SET_SCHEMA_VERSION) errors.push(`packet set schema_version must be ${PACKET_SET_SCHEMA_VERSION}`);
  if (packetSet.repository !== REPOSITORY) errors.push('packet set repository mismatch');
  if (packetSet.parent_issue !== 923 || packetSet.evidence_issue !== 1549) errors.push('packet set Issue scope mismatch');
  if (packetSet.source_repository_ref !== SOURCE_REF) errors.push('packet set source ref mismatch');
  if (packetSet.candidate_manifest_sha256 !== sha256Text(canonicalJson(manifest))) errors.push('packet set candidate manifest digest mismatch');
  if (!Array.isArray(packetSet.packets) || packetSet.packets.length !== FIXED_ISSUES.length) errors.push('packet set must contain exactly the fixed 17 items');
  if (packetSet.mutation_performed !== false || packetSet.source_ready_claimed !== false) errors.push('packet set must not claim mutation or source-ready');
  if (!/^[0-9a-f]{64}$/.test(String(packetSet.packet_set_sha256 || '')) || digestWithout(packetSet, 'packet_set_sha256') !== packetSet.packet_set_sha256) errors.push('packet_set_sha256 is not reproducible');
  const expected = new Map((manifest.items || []).map((item) => [item.issue_number, item]));
  const seen = new Set();
  for (const [index, packet] of (packetSet.packets || []).entries()) {
    const prefix = `packets[${index}]`;
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) { errors.push(`${prefix} must be an object`); continue; }
    if (seen.has(packet.issue_number)) errors.push(`${prefix} duplicate Issue`);
    seen.add(packet.issue_number);
    const candidate = expected.get(packet.issue_number);
    if (!candidate) { errors.push(`${prefix} is not in the fixed candidate manifest`); continue; }
    const expectedPacket = buildPacket(candidate, index);
    for (const field of ['packet_id', 'transition_id', 'source_note_id', 'expected_body_sha256', 'expected_source_revision_id', 'expected_source_repository_ref', 'decision', 'rationale', 'artifact', 'checks', 'limitations', 'source_ready_gate', 'evidence_subject_sha256']) {
      if (canonicalJson(packet[field]) !== canonicalJson(expectedPacket[field])) errors.push(`${prefix}.${field} mismatch with candidate facts`);
    }
    if (packet.source_note_issue_number !== packet.issue_number) errors.push(`${prefix} SourceNote Issue must equal the packet Issue scope`);
    if (packet.issue_number !== FIXED_ISSUES[index]) errors.push(`${prefix} is out of fixed order`);
    if (!Array.isArray(packet.checks) || packet.checks.length !== REQUIRED_CHECK_IDS.length || packet.checks.some((check, checkIndex) => !check || check.check_id !== REQUIRED_CHECK_IDS[checkIndex] || check.result !== 'pass')) errors.push(`${prefix}.checks must be the ordered all-pass Boundary Review checks`);
  }
  if (seen.size !== FIXED_ISSUES.length) errors.push('packet set does not cover the fixed candidate set exactly');
  return { ok: errors.length === 0, errors };
}

function evidenceRecord(packet, packetSetSha256) {
  return {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    packet_set_sha256: packetSetSha256,
    packet_id: packet.packet_id,
    transition_id: packet.transition_id,
    repository: packet.repository,
    issue_number: packet.issue_number,
    source_note_issue_number: packet.source_note_issue_number,
    source_note_id: packet.source_note_id,
    expected_body_sha256: packet.expected_body_sha256,
    expected_source_revision_id: packet.expected_source_revision_id,
    expected_source_repository_ref: packet.expected_source_repository_ref,
    evidence_subject_sha256: packet.evidence_subject_sha256,
    decision: packet.decision,
    rationale: packet.rationale,
    source_evidence: sourceEvidence(packet),
    checks: packet.checks,
    limitations: packet.limitations,
    source_ready_gate: packet.source_ready_gate,
  };
}

function evidenceBody(packet, packetSetSha256) { return `<!-- ${EVIDENCE_SCHEMA_VERSION}\n${JSON.stringify(evidenceRecord(packet, packetSetSha256), null, 2)}\n-->`; }

function evidenceBodySize(packet, packetSetSha256, maxBytes = MAX_GITHUB_COMMENT_BYTES) {
  const bytes = Buffer.byteLength(evidenceBody(packet, packetSetSha256), 'utf8');
  return { ok: bytes <= maxBytes, bytes, errors: bytes <= maxBytes ? [] : [`evidence body is ${bytes} bytes; GitHub limit is ${maxBytes}`] };
}

function commentLocatorMatches(comment, repository, issueNumber) {
  return Boolean(comment
    && comment.issue_url === `https://api.github.com/repos/${repository}/issues/${issueNumber}`
    && (!Object.prototype.hasOwnProperty.call(comment, 'repository_url') || comment.repository_url === `https://api.github.com/repos/${repository}`));
}

function inspectEvidence(comments, packet, packetSetSha256) {
  const markers = [];
  const errors = [];
  for (const comment of comments || []) {
    const matches = [...String(comment && comment.body || '').matchAll(EVIDENCE_MARKER_RE)];
    for (const match of matches) {
      let value = null;
      try { value = JSON.parse(match[1].trim()); } catch (error) { errors.push(`invalid boundary evidence JSON in comment ${comment.id}: ${error.message}`); }
      markers.push({ comment, value });
    }
  }
  const relevant = markers.filter((entry) => entry.value && (entry.value.packet_id === packet.packet_id || entry.value.transition_id === packet.transition_id));
  if (relevant.length > 1) errors.push('multiple Boundary Review evidence markers exist for this packet');
  if (relevant.length === 1) {
    const entry = relevant[0];
    if (!commentLocatorMatches(entry.comment, packet.repository, packet.issue_number)) errors.push('Boundary Review evidence comment locator is not the exact SourceNote Issue');
    const expected = evidenceRecord(packet, packetSetSha256);
    if (canonicalJson(entry.value) !== canonicalJson(expected)) errors.push('existing Boundary Review evidence facts/digest conflict with packet');
    if (!entry.value || entry.value.schema_version !== EVIDENCE_SCHEMA_VERSION) errors.push('Boundary Review evidence schema mismatch');
  }
  return { ok: errors.length === 0, errors, marker_count: relevant.length, exact: errors.length === 0 && relevant.length === 1, comment: relevant.length === 1 ? relevant[0].comment : null };
}

function liveSourceValidation(packet, issue) {
  const errors = [];
  if (!issue || Number(issue.number) !== packet.issue_number) errors.push('live SourceNote Issue number mismatch');
  if (issue && String(issue.state || '').toLowerCase() !== 'open') errors.push('live SourceNote must be open');
  if (issue && sha256Text(issue.body || '') !== packet.expected_body_sha256) errors.push('live SourceNote body SHA mismatch');
  const labels = (issue && issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
  for (const required of ['type:source-note', 'source:xhs', 'boundary:pending', 'task:boundary-review']) if (!labels.includes(required)) errors.push(`live SourceNote is missing ${required}`);
  if (labels.filter((label) => label.startsWith('boundary:')).length !== 1 || !labels.includes('boundary:pending')) errors.push('live SourceNote boundary labels are not exactly pending');
  const parsed = parseSourceNoteIssue(issue && issue.body || '');
  const validation = validateSourceNoteIssue({ body: issue && issue.body || '', labels, state: String(issue && issue.state || '').toLowerCase() });
  if (!validation.ok) errors.push(...validation.errors.map((error) => `SourceNote invalid: ${error}`));
  const record = validation.parsed && validation.parsed.record;
  if (!record) errors.push('live SourceNote record unavailable');
  else {
    if (record.source_note_id !== packet.source_note_id) errors.push('live SourceNote id mismatch');
    if (record.source_revision?.id !== packet.expected_source_revision_id) errors.push('live SourceRevision mismatch');
    if (record.source_revision?.source_repository_ref !== SOURCE_REF) errors.push('live SourceRevision ref mismatch');
    if (record.boundary_review?.status !== 'pending') errors.push('live SourceNote boundary status is not pending');
    if (parsed.marker?.source_note_id !== packet.source_note_id) errors.push('live SourceNote marker mismatch');
  }
  return { ok: errors.length === 0, errors, labels, record };
}

function exactOwnership(issues, interviewNoteId) {
  return (issues || []).filter((issue) => issue && !issue.pull_request)
    .filter((issue) => parseInterviewNoteIssue(issue.body || '').marker?.interview_note_id === interviewNoteId);
}

function preflightPacketSet(packetSet, manifest, liveLoader) {
  const packetValidation = validatePacketSet(packetSet, manifest);
  if (!packetValidation.ok) return { ok: false, errors: packetValidation.errors, items: [] };
  const errors = [];
  const items = [];
  for (const packet of packetSet.packets) {
    let live;
    try { live = liveLoader(packet); } catch (error) { live = null; errors.push(`${packet.packet_id}: live read failed: ${error.message}`); }
    const source = liveSourceValidation(packet, live && live.sourceIssue);
    const artifact = live && source.record ? verifyPinnedArtifact({ source_note_id: packet.source_note_id, artifact: packet.artifact }, source.record, live.readBlob) : { ok: false, errors: ['pinned artifact check skipped: SourceNote unavailable'] };
    const ownership = source.record ? exactOwnership(live.allIssues || [], `${source.record.source.system}:${source.record.source.external_id}`) : [];
    if (!source.ok) errors.push(`${packet.packet_id}: ${source.errors.join('; ')}`);
    if (!artifact.ok) errors.push(`${packet.packet_id}: ${artifact.errors.join('; ')}`);
    if (ownership.length !== 0) errors.push(`${packet.packet_id}: exact InterviewNote ownership count is ${ownership.length}`);
    const evidence = inspectEvidence(live && live.comments || [], packet, packetSet.packet_set_sha256);
    if (!evidence.ok) errors.push(`${packet.packet_id}: ${evidence.errors.join('; ')}`);
    const size = evidenceBodySize(packet, packetSet.packet_set_sha256);
    if (!size.ok) errors.push(`${packet.packet_id}: ${size.errors.join('; ')}`);
    items.push({ packet_id: packet.packet_id, issue_number: packet.issue_number, source_note_issue_number: packet.source_note_issue_number, source: { ok: source.ok, errors: source.errors }, artifact: { ok: artifact.ok, errors: artifact.errors }, ownership: { count: ownership.length, issue_numbers: ownership.map((issue) => Number(issue.number)) }, evidence: { ok: evidence.ok, exact: evidence.exact, marker_count: evidence.marker_count, errors: evidence.errors }, evidence_body_bytes: size.bytes, action: evidence.exact ? 'already-present-skip-post' : 'would-post-evidence' });
  }
  return { ok: errors.length === 0, errors, items };
}

function intentFor(packetSetSha256, packet, phase) {
  return { schema_version: INTENT_SCHEMA_VERSION, intent_id: sha256Text(`${packetSetSha256}:${packet.packet_id}`), packet_set_sha256: packetSetSha256, packet_id: packet.packet_id, issue_number: packet.issue_number, source_note_issue_number: packet.source_note_issue_number, source_note_id: packet.source_note_id, evidence_subject_sha256: packet.evidence_subject_sha256, phase };
}

function initialProgress(packetSetSha256, packetIds) {
  return { schema_version: PROGRESS_SCHEMA_VERSION, packet_set_sha256: packetSetSha256, status: 'planned', mutation_attempted: false, mutation_performed: false, possibly_performed: false, intents: Object.fromEntries(packetIds.map((id) => [id, null])), results: {} };
}

function validateProgress(progress, packetSet) {
  const errors = [];
  if (!progress || progress.schema_version !== PROGRESS_SCHEMA_VERSION) errors.push('progress schema_version mismatch');
  if (!progress || progress.packet_set_sha256 !== packetSet.packet_set_sha256) errors.push('progress packet_set_sha256 mismatch');
  if (progress && !['planned', 'running', 'complete', 'failed'].includes(progress.status)) errors.push('progress status is not allowed');
  const packets = new Map((packetSet.packets || []).map((packet) => [packet.packet_id, packet]));
  for (const id of packets.keys()) if (!Object.prototype.hasOwnProperty.call(progress && progress.intents || {}, id)) errors.push(`progress missing intent ${id}`);
  for (const id of Object.keys(progress && progress.intents || {})) if (!packets.has(id)) errors.push(`progress unknown intent ${id}`);
  for (const [id, intent] of Object.entries(progress && progress.intents || {})) {
    if (intent == null) continue;
    const packet = packets.get(id);
    if (intent.schema_version !== INTENT_SCHEMA_VERSION || intent.packet_id !== id || intent.packet_set_sha256 !== progress.packet_set_sha256) errors.push(`progress intent identity mismatch ${id}`);
    if (intent.intent_id !== sha256Text(`${progress.packet_set_sha256}:${id}`)) errors.push(`progress intent_id mismatch ${id}`);
    if (!PHASES.has(intent.phase)) errors.push(`progress intent phase is not allowed ${id}`);
    if (packet && (intent.issue_number !== packet.issue_number || intent.source_note_issue_number !== packet.source_note_issue_number || intent.source_note_id !== packet.source_note_id || intent.evidence_subject_sha256 !== packet.evidence_subject_sha256)) errors.push(`progress intent facts mismatch ${id}`);
  }
  for (const [id, result] of Object.entries(progress && progress.results || {})) {
    if (!packets.has(id)) errors.push(`progress unknown result ${id}`);
    if (!result || !['already-present', 'published', 'uncertain', 'request-failed'].includes(result.status)) errors.push(`progress result status is not allowed ${id}`);
    if (result && result.status === 'uncertain' && (result.mutation_attempted !== true || result.mutation_performed === false || result.possibly_performed !== true)) errors.push(`uncertain result is unsafe ${id}`);
    if (result && result.status !== 'uncertain' && result.mutation_attempted === true && result.mutation_performed !== true) errors.push(`non-uncertain result mutation accounting is unsafe ${id}`);
    if (result && result.evidence_comment_id != null && (!Number.isInteger(result.evidence_comment_id) || result.evidence_comment_id < 1)) errors.push(`result comment id is invalid ${id}`);
    if (result && result.request_sha256 != null && !/^[0-9a-f]{64}$/.test(result.request_sha256)) errors.push(`result request digest is invalid ${id}`);
  }
  return { ok: errors.length === 0, errors };
}

function buildFormalRequest(packet, commentId, reviewedAt) {
  const request = {
    schema_version: 'source-note-boundary-review-transition.v1',
    transition_id: packet.transition_id,
    repository: packet.repository,
    issue_number: packet.issue_number,
    source_note_id: packet.source_note_id,
    expected_body_sha256: packet.expected_body_sha256,
    expected_boundary_status: 'pending',
    expected_source_revision_id: packet.expected_source_revision_id,
    expected_manifest_sha256: null,
    expected_source_repository_ref: packet.expected_source_repository_ref,
    decision: packet.decision,
    reviewed_at: reviewedAt,
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: packet.repository, issue_number: packet.issue_number, comment_id: Number(commentId) },
    checks: clone(packet.checks),
    limitations: clone(packet.limitations),
  };
  const validation = validateTransitionRequest(request);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  return request;
}

function requestBody(request) { return `<!-- source-note-boundary-review-transition\n${JSON.stringify(request, null, 2)}\n-->`; }
function requestSha256(request) { return sha256Text(canonicalJson(request)); }

function validateReceipt(receipt, packet, packetSetSha256, request = null) {
  const errors = [];
  if (!receipt || receipt.schema_version !== RECEIPT_SCHEMA_VERSION) errors.push('receipt schema mismatch');
  if (receipt && (receipt.packet_set_sha256 !== packetSetSha256 || receipt.packet_id !== packet.packet_id || receipt.transition_id !== packet.transition_id || receipt.repository !== packet.repository || receipt.issue_number !== packet.issue_number || receipt.source_note_issue_number !== packet.source_note_issue_number || receipt.source_note_id !== packet.source_note_id || receipt.expected_body_sha256 !== packet.expected_body_sha256 || receipt.expected_source_revision_id !== packet.expected_source_revision_id || receipt.evidence_subject_sha256 !== packet.evidence_subject_sha256)) errors.push('receipt immutable identity mismatch');
  if (receipt && (!Number.isInteger(receipt.evidence_comment_id) || receipt.evidence_comment_id < 1)) errors.push('receipt evidence_comment_id must be positive');
  if (receipt && (!/^[0-9a-f]{64}$/.test(String(receipt.request_sha256 || '')))) errors.push('receipt request_sha256 must be lowercase sha256');
  if (request && receipt && receipt.request_sha256 !== requestSha256(request)) errors.push('receipt request digest mismatch');
  return { ok: errors.length === 0, errors };
}

function applyOne(packet, packetSet, progress, options) {
  const live = options.liveLoader(packet);
  const source = liveSourceValidation(packet, live.sourceIssue);
  const evidence = inspectEvidence(live.comments, packet, packetSet.packet_set_sha256);
  if (!source.ok || !evidence.ok) return { ok: false, errors: [...source.errors, ...evidence.errors], mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed };
  let comment = evidence.exact ? evidence.comment : null;
  const existingReceipt = typeof options.readReceipt === 'function' ? options.readReceipt(packet) : null;
  if (existingReceipt) {
    const receiptValidation = validateReceipt(existingReceipt, packet, packetSet.packet_set_sha256);
    if (!receiptValidation.ok) return { ok: false, errors: [`${packet.packet_id}: ${receiptValidation.errors.join('; ')}`], mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed };
    if (!comment || Number(comment.id) !== Number(existingReceipt.evidence_comment_id)) return { ok: false, errors: [`${packet.packet_id}: receipt exists without its exact live evidence comment`], mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed };
  }
  const prior = progress.intents[packet.packet_id];
  if (!comment) {
    if (prior && ['evidence-post-pending', 'evidence-post-uncertain'].includes(prior.phase)) {
      return { ok: false, errors: [`${packet.packet_id}: prior POST intent has no exact live marker; refusing duplicate POST`], mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed };
    }
    const pending = intentFor(packetSet.packet_set_sha256, packet, 'evidence-post-pending');
    progress.intents[packet.packet_id] = pending;
    progress.mutation_attempted = true;
    progress.mutation_performed = null;
    progress.possibly_performed = true;
    options.persistProgress(progress);
    let response = null;
    try { response = options.createEvidenceComment(packet, evidenceBody(packet, packetSet.packet_set_sha256)); }
    catch (error) { response = null; }
    const recovered = inspectEvidence(options.liveLoader(packet).comments, packet, packetSet.packet_set_sha256);
    if (!recovered.exact) {
      progress.status = 'failed';
      progress.intents[packet.packet_id] = { ...pending, phase: 'evidence-post-uncertain' };
      progress.results[packet.packet_id] = { status: 'uncertain', evidence_comment_id: null, mutation_attempted: true, mutation_performed: null, possibly_performed: true };
      options.persistProgress(progress);
      return { ok: false, errors: [`${packet.packet_id}: evidence POST unconfirmed; refusing retry`], mutation_attempted: true, mutation_performed: null, possibly_performed: true };
    }
    comment = recovered.comment;
    progress.mutation_performed = true;
    progress.possibly_performed = false;
    progress.intents[packet.packet_id] = { ...pending, phase: 'evidence-posted', evidence_comment_id: Number(comment.id) };
    options.persistProgress(progress);
  }
  const reviewedAt = options.reviewedAt;
  let request;
  try { request = buildFormalRequest(packet, Number(comment.id), reviewedAt); }
  catch (error) {
    progress.status = 'failed';
    progress.intents[packet.packet_id] = { ...intentFor(packetSet.packet_set_sha256, packet, 'request-failed'), evidence_comment_id: Number(comment.id) };
    progress.results[packet.packet_id] = { status: 'request-failed', evidence_comment_id: Number(comment.id), mutation_attempted: Boolean(progress.mutation_attempted), mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, error: error.message };
    options.persistProgress(progress);
    return { ok: false, errors: [`${packet.packet_id}: formal request failed: ${error.message}`], mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed };
  }
  if (existingReceipt && existingReceipt.request_sha256 !== requestSha256(request)) {
    return { ok: false, errors: [`${packet.packet_id}: existing receipt request digest does not match the supplied reviewed_at/request facts`], mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed };
  }
  const planned = planSourceNoteBoundaryReviewTransition(request, live.sourceIssue, { evidenceComment: comment, receipts: [] });
  if (!planned.ok) return { ok: false, errors: planned.errors, mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed };
  const requestDigest = requestSha256(request);
  options.writeRequest(packet, requestBody(request), request);
  const receipt = { schema_version: RECEIPT_SCHEMA_VERSION, packet_set_sha256: packetSet.packet_set_sha256, packet_id: packet.packet_id, transition_id: packet.transition_id, repository: packet.repository, issue_number: packet.issue_number, source_note_issue_number: packet.source_note_issue_number, source_note_id: packet.source_note_id, expected_body_sha256: packet.expected_body_sha256, expected_source_revision_id: packet.expected_source_revision_id, evidence_subject_sha256: packet.evidence_subject_sha256, evidence_comment_id: Number(comment.id), request_sha256: requestDigest, recorded_at: options.now ? options.now() : new Date().toISOString() };
  options.writeReceipt(packet, receipt);
  progress.intents[packet.packet_id] = { ...intentFor(packetSet.packet_set_sha256, packet, 'receipt-written'), evidence_comment_id: Number(comment.id), request_sha256: requestDigest };
  progress.results[packet.packet_id] = { status: evidence.exact ? 'already-present' : 'published', evidence_comment_id: Number(comment.id), request_sha256: requestDigest, mutation_attempted: !evidence.exact, mutation_performed: !evidence.exact, possibly_performed: false };
  options.persistProgress(progress);
  return { ok: true, item: { packet_id: packet.packet_id, issue_number: packet.issue_number, evidence_action: evidence.exact ? 'already-present-skip-post' : 'posted-evidence', evidence_comment_id: Number(comment.id), request_sha256: requestDigest, mutation_performed: !evidence.exact }, mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed };
}

function runBatch(packetSet, manifest, options = {}) {
  const packetValidation = validatePacketSet(packetSet, manifest);
  if (!packetValidation.ok) return { ok: false, mode: options.apply ? 'apply' : 'plan', mutation_attempted: false, mutation_performed: false, possibly_performed: false, errors: packetValidation.errors, items: [] };
  if (options.apply && typeof options.writeReceipt !== 'function') return { ok: false, mode: 'apply', mutation_attempted: false, mutation_performed: false, possibly_performed: false, errors: ['apply requires durable receipt persistence'], items: [] };
  let progress = options.progress || initialProgress(packetSet.packet_set_sha256, packetSet.packets.map((packet) => packet.packet_id));
  const progressValidation = validateProgress(progress, packetSet);
  if (!progressValidation.ok) return { ok: false, mode: options.apply ? 'apply' : 'plan', mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: progressValidation.errors, items: [] };
  const preflight = preflightPacketSet(packetSet, manifest, options.liveLoader);
  const reportBase = { schema_version: 'issue-1549-boundary-evidence-dry-run.v1', packet_set_sha256: packetSet.packet_set_sha256, total: packetSet.packets.length, mutation_count: 0, source_ready_claimed: 0, items: preflight.items };
  const dryRunSha = sha256Text(canonicalJson(reportBase));
  if (!preflight.ok) return { ok: false, mode: options.apply ? 'apply' : 'plan', dry_run_sha256: dryRunSha, mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: preflight.errors, report: { ...reportBase, ok: false, dry_run_sha256: dryRunSha }, items: preflight.items };
  if (!options.apply) return { ok: true, mode: 'plan', dry_run_sha256: dryRunSha, mutation_attempted: false, mutation_performed: false, possibly_performed: false, report: { ...reportBase, ok: true, dry_run_sha256: dryRunSha }, items: preflight.items, progress };
  const items = [];
  for (const packet of packetSet.packets) {
    const result = applyOne(packet, packetSet, progress, { ...options, manifest });
    if (!result.ok) return { ok: false, mode: 'apply', dry_run_sha256: dryRunSha, mutation_attempted: result.mutation_attempted, mutation_performed: result.mutation_performed, possibly_performed: result.possibly_performed, errors: result.errors, items, progress };
    items.push(result.item);
  }
  progress.status = 'complete';
  options.persistProgress(progress);
  return { ok: true, mode: 'apply', dry_run_sha256: dryRunSha, mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, items, progress, report: { ...reportBase, ok: true, dry_run_sha256: dryRunSha, mutation_count: items.filter((item) => item.mutation_performed).length } };
}

module.exports = {
  PACKET_SET_SCHEMA_VERSION, EVIDENCE_SCHEMA_VERSION, PROGRESS_SCHEMA_VERSION, INTENT_SCHEMA_VERSION, RECEIPT_SCHEMA_VERSION,
  MAX_GITHUB_COMMENT_BYTES, PHASES, REQUIRED_CHECK_IDS, packetId, transitionId, buildPacketSet, validatePacketSet,
  sourceEvidence, evidenceRecord, evidenceBody, evidenceBodySize, commentLocatorMatches, inspectEvidence,
  liveSourceValidation, exactOwnership, preflightPacketSet, intentFor, initialProgress, validateProgress,
  buildFormalRequest, requestBody, requestSha256, validateReceipt, runBatch, applyOne, acquireProgressLock,
};
