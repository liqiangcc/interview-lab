'use strict';

const {
  sha256Text,
  parseIndependentEvidence,
} = require('./issue-1539-recovery-plan');
const crypto = require('node:crypto');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const {
  planSourceReview,
  requestSha256,
  validateRequest,
  validateEvidenceComment,
} = require('./interview-note-source-review-transition');
const { validatePacketSet, CANDIDATE_STATUS } = require('./issue-1539-source-review-packets');

const EVIDENCE_SCHEMA_VERSION = 'interview-note-source-review-evidence.v1';
const PROGRESS_SCHEMA_VERSION = 'issue-1539-evidence-apply-progress.v1';
const INTENT_SCHEMA_VERSION = 'issue-1539-evidence-apply-intent.v1';
const MAX_GITHUB_COMMENT_BYTES = 65536;
const INTENT_PHASES = new Set([
  'planned',
  'evidence-post-pending',
  'evidence-post-uncertain',
  'evidence-posted',
  'formal-request-failed',
  'evidence-validation-failed',
  'planner-failed',
  'request-generated',
]);
const LOCK_SCHEMA_VERSION = 'issue-1539-evidence-apply-lock.v1';
const EVIDENCE_MARKER_RE = /<!--\s*interview-note-source-review-evidence\.v1\s*\n([\s\S]*?)\n-->/g;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function processState(pid) {
  if (!Number.isInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return 'alive'; } catch (error) {
    if (error.code === 'EPERM') return 'alive';
    if (error.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isCompleteLockRecord(lock, lockPath) {
  if (!lock || lock.schema_version !== LOCK_SCHEMA_VERSION || !isUuid(lock.lock_id)
    || !Number.isSafeInteger(lock.pid) || lock.pid < 1
    || typeof lock.hostname !== 'string' || lock.hostname.length === 0
    || typeof lock.acquired_at !== 'string' || Number.isNaN(Date.parse(lock.acquired_at))
    || !Number.isSafeInteger(lock.device) || lock.device < 0
    || !Number.isSafeInteger(lock.inode) || lock.inode < 0
    || typeof lockPath !== 'string' || lockPath.length === 0) return false;
  let currentStat;
  try { currentStat = fs.statSync(lockPath); } catch (_) { return false; }
  return currentStat.dev === lock.device && currentStat.ino === lock.inode;
}

function lockIsStale(lock, lockPath) {
  // Only an unambiguously dead same-host owner can be reclaimed automatically.
  // Foreign hosts and malformed/unknown-owner locks require explicit operator recovery.
  if (!isCompleteLockRecord(lock, lockPath) || lock.hostname !== os.hostname()) return false;
  return processState(lock.pid) === 'dead';
}

function readLock(lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch (_) { return null; }
}

function acquireProgressLock(lockPath) {
  if (typeof lockPath !== 'string' || !lockPath) throw new Error('progress lock path is required');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lock = {
    schema_version: LOCK_SCHEMA_VERSION,
    lock_id: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      const inode = fs.fstatSync(fd);
      lock.device = inode.dev;
      lock.inode = inode.ino;
      try { fs.writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`); } finally { fs.closeSync(fd); }
      return {
        lock,
        lockPath,
        release() {
          const current = readLock(lockPath);
          let currentStat;
          try { currentStat = fs.statSync(lockPath); } catch (_) { throw new Error('progress lock ownership changed; refusing to remove another owner lock'); }
          if (!current || current.lock_id !== lock.lock_id || current.device !== lock.device || current.inode !== lock.inode || currentStat.dev !== lock.device || currentStat.ino !== lock.inode) {
            throw new Error('progress lock owner token or inode changed; refusing to remove another owner lock');
          }
          fs.unlinkSync(lockPath);
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = readLock(lockPath);
      if (!lockIsStale(current, lockPath)) {
        throw new Error(`progress lock is held by ${current && current.hostname ? `${current.hostname} pid ${current.pid}` : 'an active or unreadable owner'}`);
      }
      const quarantine = `${lockPath}.stale-${Date.now()}-${process.pid}-${crypto.randomUUID()}`;
      try { fs.renameSync(lockPath, quarantine); } catch (renameError) {
        if (!['ENOENT', 'EEXIST'].includes(renameError.code)) throw renameError;
      }
    }
  }
  throw new Error('could not acquire progress lock after stale-lock recovery attempts');
}

function labelsOf(issue) {
  return (issue && issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
}

function bodySha256(issue) {
  return sha256Text(issue && issue.body || '');
}

function evidenceRecord(packet, packetSetSha256 = null) {
  const request = packet.candidate_request;
  const record = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    repository: request.repository,
    issue_number: request.issue_number,
    interview_note_id: request.interview_note_id,
    source_note_issue_number: request.source_note_issue_number,
    source_revision_id: request.expected_source_revision_id,
    transition_id: request.transition_id,
    evidence_subject_sha256: request.evidence_subject_sha256,
    expected_interview_body_sha256: request.expected_interview_body_sha256,
    expected_source_note_body_sha256: request.expected_source_note_body_sha256,
    provenance_mode: request.provenance_mode,
    provenance_statement: request.provenance_statement,
    pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256,
    decision: request.decision,
    limitations: request.limitations,
    interview_facts: packet.interview_facts,
    source_facts: packet.source_facts,
    checks: request.checks,
    failed_check_ids: packet.failed_check_ids,
    source_revision_evidence: packet.source_revision_evidence,
    source_ready_gate: packet.source_ready_gate,
  };
  if (packetSetSha256 != null) record.packet_set_sha256 = packetSetSha256;
  if (request.expected_manifest_sha256 != null) record.expected_manifest_sha256 = request.expected_manifest_sha256;
  if (request.expected_source_repository_ref != null) record.expected_source_repository_ref = request.expected_source_repository_ref;
  if (request.case_key != null) record.case_key = request.case_key;
  return record;
}

function evidenceBody(packet, packetSetSha256 = null) {
  return `<!-- ${EVIDENCE_SCHEMA_VERSION}\n${JSON.stringify(evidenceRecord(packet, packetSetSha256), null, 2)}\n-->`;
}

function validateEvidenceBodySize(packet, packetSetSha256 = null, maxBytes = MAX_GITHUB_COMMENT_BYTES) {
  const bytes = Buffer.byteLength(evidenceBody(packet, packetSetSha256), 'utf8');
  return bytes <= maxBytes
    ? { ok: true, bytes, errors: [] }
    : { ok: false, bytes, errors: [`evidence comment body is ${bytes} UTF-8 bytes; GitHub limit is ${maxBytes} bytes`] };
}

function buildFormalRequest(packet, commentId, reviewedAt) {
  if (!Number.isInteger(Number(commentId)) || Number(commentId) < 1) throw new Error('evidence comment id must be positive before building a formal request');
  if (typeof reviewedAt !== 'string' || Number.isNaN(Date.parse(reviewedAt))) throw new Error('reviewed_at must be a valid timestamp before building a formal request');
  const request = {
    ...clone(packet.candidate_request),
    reviewed_at: reviewedAt,
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: packet.candidate_request.repository, issue_number: packet.candidate_request.issue_number, comment_id: Number(commentId) },
  };
  const validation = validateRequest(request);
  if (!validation.ok) throw new Error(`formal transition request is invalid: ${validation.errors.join('; ')}`);
  return request;
}

function requestBody(request) {
  return `<!-- interview-note-source-review-transition\n${JSON.stringify(request, null, 2)}\n-->`;
}

function expectedEvidence(packet, packetSetSha256 = null) {
  return evidenceRecord(packet, packetSetSha256);
}

function commentLocatorMatches(comment, repository, issueNumber) {
  return Boolean(comment
    && Number(comment.issue_url && comment.issue_url.match(/\/issues\/(\d+)$/)?.[1]) === Number(issueNumber)
    && (!Object.prototype.hasOwnProperty.call(comment, 'repository_url') || comment.repository_url === `https://api.github.com/repos/${repository}`)
    && comment.issue_url === `https://api.github.com/repos/${repository}/issues/${issueNumber}`);
}

function inspectEvidence(comments, packet, packetSetSha256 = null) {
  const expected = expectedEvidence(packet, packetSetSha256);
  const parsed = parseIndependentEvidence(comments, expected);
  const markers = [];
  for (const comment of comments || []) {
    for (const match of String(comment && comment.body || '').matchAll(EVIDENCE_MARKER_RE)) markers.push({ comment, value: (() => { try { return JSON.parse(match[1].trim()); } catch (_) { return null; } })() });
  }
  const errors = [...parsed.errors];
  if (markers.length > 1) errors.push('multiple Source Review evidence markers exist; refusing to choose one');
  if (markers.length === 1 && !commentLocatorMatches(markers[0].comment, packet.candidate_request.repository, packet.candidate_request.issue_number)) errors.push('Source Review evidence comment belongs to another repository or Issue');
  if (markers.length === 1 && !parsed.evidence) errors.push('existing Source Review evidence conflicts with this packet');
  return {
    ok: errors.length === 0,
    errors,
    marker_count: markers.length,
    exact: Boolean(parsed.evidence && markers.length === 1),
    comment: parsed.evidence && markers.length === 1 ? markers[0].comment : null,
  };
}

function validateLivePacket(packet, interviewIssue, sourceIssue) {
  const errors = [];
  if (!interviewIssue || Number(interviewIssue.number) !== Number(packet.interview_issue_number)) errors.push('live InterviewNote Issue identity mismatch');
  if (!sourceIssue || Number(sourceIssue.number) !== Number(packet.source_note_issue_number)) errors.push('live SourceNote Issue identity mismatch');
  if (interviewIssue && bodySha256(interviewIssue) !== packet.expected_interview_body_sha256) errors.push('live InterviewNote body SHA mismatch');
  if (sourceIssue && bodySha256(sourceIssue) !== packet.expected_source_note_body_sha256) errors.push('live SourceNote body SHA mismatch');
  if (interviewIssue && labelsOf(interviewIssue).filter((label) => label.startsWith('status:')).join(',') !== 'status:blocked') errors.push('live InterviewNote status must be exactly blocked');
  if (interviewIssue && !labelsOf(interviewIssue).includes('task:source-recovery')) errors.push('live InterviewNote must retain task:source-recovery');
  return { ok: errors.length === 0, errors };
}

function intentFor(packetSetSha256, packet, phase = 'planned') {
  const intentId = sha256Text(`${packetSetSha256}:${packet.packet_id}`);
  return {
    schema_version: INTENT_SCHEMA_VERSION,
    intent_id: intentId,
    packet_set_sha256: packetSetSha256,
    packet_id: packet.packet_id,
    issue_number: packet.interview_issue_number,
    source_note_issue_number: packet.source_note_issue_number,
    interview_note_id: packet.interview_note_id,
    evidence_subject_sha256: packet.evidence_subject_sha256,
    phase,
  };
}

function initialProgress(packetSetSha256, packetIds) {
  return {
    schema_version: PROGRESS_SCHEMA_VERSION,
    packet_set_sha256: packetSetSha256,
    status: 'planned',
    mutation_attempted: false,
    mutation_performed: false,
    possibly_performed: false,
    results: {},
    intents: Object.fromEntries(packetIds.map((packetId) => [packetId, null])),
  };
}

function validateProgress(progress, packetSet) {
  const errors = [];
  if (!progress || progress.schema_version !== PROGRESS_SCHEMA_VERSION) errors.push('progress schema_version mismatch');
  if (!packetSet || !progress || progress.packet_set_sha256 !== packetSet.packet_set_sha256) errors.push('progress packet_set_sha256 mismatch');
  if (progress && !['planned', 'running', 'complete'].includes(progress.status)) errors.push(`progress status is not allowed: ${progress.status}`);
  const packets = new Map((packetSet && packetSet.packets || []).map((packet) => [packet.packet_id, packet]));
  const ids = new Set(packets.keys());
  for (const packetId of ids) if (!Object.prototype.hasOwnProperty.call(progress && progress.intents || {}, packetId)) errors.push(`progress is missing packet intent ${packetId}`);
  for (const key of Object.keys(progress && progress.intents || {})) if (!ids.has(key)) errors.push(`progress contains unknown packet intent ${key}`);
  for (const key of Object.keys(progress && progress.results || {})) if (!ids.has(key)) errors.push(`progress contains unknown packet result ${key}`);
  for (const [packetId, intent] of Object.entries(progress && progress.intents || {})) {
    if (intent == null) continue;
    if (intent.schema_version !== INTENT_SCHEMA_VERSION || intent.packet_set_sha256 !== progress.packet_set_sha256 || intent.packet_id !== packetId) errors.push(`progress intent identity mismatch for ${packetId}`);
    if (intent.intent_id !== sha256Text(`${progress.packet_set_sha256}:${packetId}`)) errors.push(`progress intent_id is not reproducible for ${packetId}`);
    if (!INTENT_PHASES.has(intent.phase)) errors.push(`progress intent phase is not allowed for ${packetId}: ${intent.phase}`);
    const packet = packets.get(packetId);
    if (packet && (intent.issue_number !== packet.interview_issue_number
      || intent.source_note_issue_number !== packet.source_note_issue_number
      || intent.interview_note_id !== packet.interview_note_id
      || intent.evidence_subject_sha256 !== packet.evidence_subject_sha256)) errors.push(`progress intent fact binding mismatch for ${packetId}`);
    if (intent.phase === 'request-generated' && (!Number.isInteger(intent.evidence_comment_id) || intent.evidence_comment_id < 1 || !/^[0-9a-f]{64}$/.test(String(intent.request_sha256 || '')))) errors.push(`progress request identity is incomplete for ${packetId}`);
  }
  for (const [packetId, result] of Object.entries(progress && progress.results || {})) {
    if (!result || !Number.isInteger(result.evidence_comment_id) || result.evidence_comment_id < 1) {
      if (result && result.mutation_attempted === true && result.possibly_performed === true) continue;
      errors.push(`progress result identity is incomplete for ${packetId}`);
    }
    if (result && result.transition_request_generated === true && (!/^[0-9a-f]{64}$/.test(String(result.request_sha256 || '')) || result.lifecycle_transition_performed !== false)) errors.push(`progress result lifecycle/request identity is unsafe for ${packetId}`);
    if (result && result.mutation_attempted === true && result.mutation_performed === false && result.possibly_performed !== true) errors.push(`progress uncertain mutation result is unsafe for ${packetId}`);
  }
  return { ok: errors.length === 0, errors };
}

function preflightPacketSet(packetSet, anchors, liveLoader) {
  const anchorValidation = validatePacketSet(packetSet, anchors);
  if (!anchorValidation.ok) return { ok: false, errors: anchorValidation.errors, items: [] };
  const items = [];
  const errors = [];
  for (const packet of packetSet.packets) {
    const live = liveLoader(packet);
    const liveValidation = validateLivePacket(packet, live.interviewIssue, live.sourceIssue);
    const evidence = inspectEvidence(live.comments, packet, packetSet.packet_set_sha256);
    const bodySize = validateEvidenceBodySize(packet, packetSet.packet_set_sha256);
    const item = { packet_id: packet.packet_id, issue_number: packet.interview_issue_number, source_note_issue_number: packet.source_note_issue_number, live: liveValidation, evidence, evidence_body_bytes: bodySize.bytes };
    items.push(item);
    if (!liveValidation.ok) errors.push(`${packet.packet_id}: ${liveValidation.errors.join('; ')}`);
    if (!evidence.ok) errors.push(`${packet.packet_id}: ${evidence.errors.join('; ')}`);
    if (!bodySize.ok) errors.push(`${packet.packet_id}: ${bodySize.errors.join('; ')}`);
  }
  return { ok: errors.length === 0, errors, items };
}

function applyEvidenceItem(packet, packetSetSha256, progress, options = {}) {
  const current = options.liveLoader(packet);
  const currentValidation = validateLivePacket(packet, current.interviewIssue, current.sourceIssue);
  const currentEvidence = inspectEvidence(current.comments, packet, packetSetSha256);
  if (!currentValidation.ok || !currentEvidence.ok) return { ok: false, mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: [`${packet.packet_id}: apply-time CAS failed: ${[...(currentValidation.errors || []), ...(currentEvidence.errors || [])].join('; ')}`] };
  const exactComment = currentEvidence.exact ? currentEvidence.comment : null;
  const planned = {
    packet_id: packet.packet_id,
    issue_number: packet.interview_issue_number,
    source_note_issue_number: packet.source_note_issue_number,
    evidence_action: exactComment ? 'already-present-skip-post' : 'would-post-evidence',
    evidence_comment_id: exactComment ? Number(exactComment.id) : null,
    transition_request: null,
    mutation_performed: false,
  };
  let evidenceComment = exactComment;
  if (!evidenceComment) {
    const priorIntent = progress.intents[packet.packet_id];
    if (priorIntent) {
      return { ok: false, mutation_attempted: false, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: [`${packet.packet_id}: prior evidence POST intent (${priorIntent.phase}) has no exact live marker; refusing duplicate POST`] };
    }
    const pending = intentFor(packetSetSha256, packet, 'evidence-post-pending');
    progress.intents[packet.packet_id] = pending;
    progress.mutation_attempted = true;
    progress.mutation_performed = null;
    progress.possibly_performed = true;
    options.persistProgress(progress);
    try {
      if (typeof options.beforeEvidencePost === 'function') options.beforeEvidencePost();
      evidenceComment = options.createEvidenceComment(packet, evidenceBody(packet, packetSetSha256));
    } catch (error) {
      const recovery = inspectEvidence(options.liveLoader(packet).comments, packet, packetSetSha256);
      if (recovery.exact) evidenceComment = recovery.comment;
      else {
        progress.intents[packet.packet_id] = { ...pending, phase: 'evidence-post-uncertain', error: error.message };
        progress.results[packet.packet_id] = { evidence_comment_id: null, mutation_attempted: true, mutation_performed: null, possibly_performed: true, status: 'uncertain-post' };
        options.persistProgress(progress);
        return { ok: false, mutation_attempted: true, mutation_performed: null, possibly_performed: true, errors: [`${packet.packet_id}: evidence POST response lost and exact marker was not recoverable; refusing retry`] };
      }
    }
    const confirmation = inspectEvidence(options.liveLoader(packet).comments, packet, packetSetSha256);
    if (!confirmation.exact) {
      progress.intents[packet.packet_id] = { ...pending, phase: 'evidence-post-uncertain', error: 'POST response did not yield one exact live evidence marker' };
      progress.results[packet.packet_id] = { evidence_comment_id: null, mutation_attempted: true, mutation_performed: null, possibly_performed: true, status: 'uncertain-post' };
      options.persistProgress(progress);
      return { ok: false, mutation_attempted: true, mutation_performed: null, possibly_performed: true, errors: [`${packet.packet_id}: evidence POST was not confirmed exactly; refusing retry`] };
    }
    evidenceComment = confirmation.comment;
  }
  if (!exactComment) {
    progress.mutation_attempted = true;
    progress.mutation_performed = true;
    progress.possibly_performed = false;
  }
  progress.status = 'running';
  progress.intents[packet.packet_id] = { ...intentFor(packetSetSha256, packet, 'evidence-posted'), evidence_comment_id: Number(evidenceComment.id) };
  options.persistProgress(progress);
  let request;
  try {
    request = buildFormalRequest(packet, Number(evidenceComment.id), options.reviewedAt || new Date().toISOString());
  } catch (error) {
    progress.intents[packet.packet_id] = { ...intentFor(packetSetSha256, packet, 'formal-request-failed'), evidence_comment_id: Number(evidenceComment.id), error: error.message };
    options.persistProgress(progress);
    return { ok: false, mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: [`${packet.packet_id}: formal request generation failed after evidence confirmation: ${error.message}`] };
  }
  const evidenceErrors = [];
  validateEvidenceComment(request, evidenceComment, evidenceErrors);
  if (evidenceErrors.length) {
    progress.intents[packet.packet_id] = { ...intentFor(packetSetSha256, packet, 'evidence-validation-failed'), evidence_comment_id: Number(evidenceComment.id), error: evidenceErrors.join('; ') };
    options.persistProgress(progress);
    return { ok: false, mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: [`${packet.packet_id}: ${evidenceErrors.join('; ')}`] };
  }
  const plannedLive = options.liveLoader(packet);
  const planner = (options.planFormalRequest || planSourceReview)(request, plannedLive.interviewIssue, {
    planningOnly: true,
    sourceIssue: plannedLive.sourceIssue,
    allIssues: plannedLive.allIssues || [],
    evidenceComment,
    pinnedArtifactManifest: options.pinnedArtifactManifest,
  });
  if (!planner || !planner.ok) {
    const plannerErrors = planner && planner.errors || ['formal request planner returned no successful plan'];
    progress.intents[packet.packet_id] = { ...intentFor(packetSetSha256, packet, 'planner-failed'), error: plannerErrors.join('; ') };
    options.persistProgress(progress);
    return { ok: false, mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: [`${packet.packet_id}: formal request planner dry-run failed: ${plannerErrors.join('; ')}`] };
  }
  const requestDigest = requestSha256(request);
  progress.intents[packet.packet_id] = { ...intentFor(packetSetSha256, packet, 'request-generated'), request_sha256: requestDigest, evidence_comment_id: Number(evidenceComment.id) };
  progress.results[packet.packet_id] = { evidence_comment_id: Number(evidenceComment.id), request_sha256: requestDigest, transition_request_generated: true, lifecycle_transition_performed: false, mutation_attempted: !exactComment, mutation_performed: !exactComment, possibly_performed: false };
  progress.mutation_attempted = progress.mutation_attempted || !exactComment;
  progress.mutation_performed = progress.mutation_performed === true || !exactComment ? true : progress.mutation_performed;
  progress.possibly_performed = false;
  progress.status = 'running';
  options.persistProgress(progress);
  options.writeRequest(packet, requestBody(request), request);
  return { ok: true, mutation_performed: !exactComment, item: { ...planned, evidence_action: exactComment ? 'already-present-skip-post' : 'posted-evidence', evidence_comment_id: Number(evidenceComment.id), transition_request: request, mutation_performed: !exactComment } };
}

function runBatch(packetSet, anchors, options = {}) {
  const apply = options.apply === true;
  const liveLoader = options.liveLoader;
  if (typeof liveLoader !== 'function') throw new Error('liveLoader is required');
  if (apply && typeof options.persistProgress !== 'function') throw new Error('apply requires durable progress persistence');
  if (apply && typeof options.createEvidenceComment !== 'function') throw new Error('apply requires an evidence comment publisher');
  if (apply && typeof options.writeRequest !== 'function') throw new Error('apply requires durable formal request persistence');
  let progress = options.progress || initialProgress(packetSet.packet_set_sha256, packetSet.packets.map((packet) => packet.packet_id));
  const progressValidation = validateProgress(progress, packetSet);
  if (!progressValidation.ok) return { ok: false, mode: apply ? 'apply' : 'plan', mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: progressValidation.errors, items: [] };
  const preflight = preflightPacketSet(packetSet, anchors, liveLoader);
  if (!preflight.ok) return { ok: false, mode: apply ? 'apply' : 'plan', mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: preflight.errors, items: preflight.items };
  const reviewedAt = options.reviewedAt || null;
  const items = [];
  for (const packet of packetSet.packets) {
    const preflightItem = preflight.items.find((item) => item.packet_id === packet.packet_id);
    if (!apply) {
      items.push({ packet_id: packet.packet_id, issue_number: packet.interview_issue_number, source_note_issue_number: packet.source_note_issue_number, evidence_action: preflightItem.evidence.comment ? 'already-present-skip-post' : 'would-post-evidence', evidence_comment_id: preflightItem.evidence.comment ? Number(preflightItem.evidence.comment.id) : null, evidence_body_bytes: preflightItem.evidence_body_bytes, transition_request: null, mutation_performed: false });
      continue;
    }
    const result = applyEvidenceItem(packet, packetSet.packet_set_sha256, progress, { ...options, liveLoader, reviewedAt: reviewedAt || undefined, pinnedArtifactManifest: anchors.pinnedArtifactManifest });
    if (!result.ok) return { ok: false, mode: 'apply', mutation_attempted: progress.mutation_attempted, mutation_performed: progress.mutation_performed, possibly_performed: progress.possibly_performed, errors: result.errors, items };
    items.push(result.item);
  }
  progress.status = apply ? 'complete' : 'planned';
  if (typeof options.persistProgress === 'function') options.persistProgress(progress);
  return { ok: true, mode: apply ? 'apply' : 'plan', mutation_attempted: progress.mutation_attempted, mutation_performed: apply ? progress.mutation_performed : false, possibly_performed: progress.possibly_performed, packet_set_sha256: packetSet.packet_set_sha256, candidate_status: CANDIDATE_STATUS, items, progress };
}

module.exports = {
  EVIDENCE_SCHEMA_VERSION,
  PROGRESS_SCHEMA_VERSION,
  INTENT_SCHEMA_VERSION,
  INTENT_PHASES,
  MAX_GITHUB_COMMENT_BYTES,
  LOCK_SCHEMA_VERSION,
  isCompleteLockRecord,
  lockIsStale,
  acquireProgressLock,
  evidenceRecord,
  evidenceBody,
  validateEvidenceBodySize,
  buildFormalRequest,
  requestBody,
  inspectEvidence,
  validateLivePacket,
  intentFor,
  initialProgress,
  validateProgress,
  preflightPacketSet,
  applyEvidenceItem,
  runBatch,
  validatePacketSet,
};
