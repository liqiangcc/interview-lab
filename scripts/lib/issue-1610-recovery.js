'use strict';

const crypto = require('node:crypto');
const { canonicalJson } = require('./issue-1539-recovery-plan');

const SCHEMA_VERSION = 'issue-1610-recovery-selection.v1';
const PLAN_SCHEMA_VERSION = 'issue-1610-recovery-dry-run.v1';
const EVIDENCE_SCHEMA_VERSION = 'issue-1610-recovery-evidence.v1';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const EXPECTED_ITEMS = Object.freeze([1, 2]);
const REQUIRED_CHECK_IDS = Object.freeze([
  'source_identity',
  'source_revision_binding',
  'artifact_reference_integrity',
  'raw_projection_traceability',
  'source_artifact_provenance',
  'known_limitations_recorded',
  'duplicate_ownership',
  'no_fabrication',
  'boundary_disposition',
  'image_recovery',
]);

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sorted(values) {
  return [...values].sort();
}

function labelsOf(issue) {
  return (issue && issue.labels || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(Boolean);
}

function statusOf(issue) {
  const statuses = labelsOf(issue).filter((label) => label.startsWith('status:'));
  return statuses.length === 1 ? statuses[0].slice('status:'.length) : null;
}

function check(checkId, passed, note) {
  return { check_id: checkId, result: passed ? 'pass' : 'fail', note };
}

function normalizeArtifacts(artifacts) {
  return (artifacts || []).map((artifact) => ({
    kind: artifact.kind,
    ref: artifact.ref,
    git_blob_sha: artifact.git_blob_sha,
    byte_size: artifact.byte_size ?? null,
    provenance: artifact.provenance,
    integrity: artifact.integrity ?? null,
  })).sort((a, b) => String(a.ref).localeCompare(String(b.ref)));
}

function validateSelection(selection) {
  const errors = [];
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return { ok: false, errors: ['selection must be an object'] };
  if (selection.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (selection.scope !== 'issue-1610-fixed-2') errors.push('selection scope must be issue-1610-fixed-2');
  if (selection.repository !== 'liqiangcc/interview-lab') errors.push('selection repository is outside issue-1610');
  if (selection.controller_issue_number !== 1605) errors.push('controller_issue_number must be 1605');
  if (selection.scope_issue_number !== 1610) errors.push('scope_issue_number must be 1610');
  if (selection.source_snapshot && selection.source_snapshot.repository !== SOURCE_REPOSITORY) errors.push('source repository must be liqiangcc/xhs');
  if (!selection.source_snapshot || selection.source_snapshot.ref !== SOURCE_REF) errors.push('source ref must be the fixed 95b77bb commit');
  for (const field of ['controller_body_sha256', 'scope_body_sha256']) {
    if (!/^[0-9a-f]{64}$/.test(String(selection[field] || ''))) errors.push(`${field} must be a SHA-256`);
  }
  if (!Array.isArray(selection.items) || selection.items.length !== EXPECTED_ITEMS.length) errors.push('selection must contain exactly InterviewNote #1/#2');
  const seen = new Set();
  for (const [index, item] of (selection.items || []).entries()) {
    const prefix = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${prefix} must be an object`); continue; }
    if (!EXPECTED_ITEMS.includes(item.issue_number)) errors.push(`${prefix} issue is outside fixed #1/#2 scope`);
    if (seen.has(item.issue_number)) errors.push(`${prefix} duplicates issue #${item.issue_number}`);
    seen.add(item.issue_number);
    for (const field of ['interview_note_id', 'source_note_id', 'source_revision_id', 'interview_source_revision_id']) if (!item[field]) errors.push(`${prefix}.${field} is required`);
    for (const field of ['expected_interview_body_sha256', 'expected_source_note_body_sha256']) if (!/^[0-9a-f]{64}$/.test(String(item[field] || ''))) errors.push(`${prefix}.${field} must be a SHA-256`);
    if (!Number.isInteger(item.source_note_issue_number) || item.source_note_issue_number < 1) errors.push(`${prefix}.source_note_issue_number must be positive`);
    if (item.expected_labels?.includes('status:blocked') !== true || item.expected_labels?.includes('task:source-recovery') !== true) errors.push(`${prefix} must freeze blocked source-recovery labels`);
    if (item.expected_source_note_labels?.includes('boundary:pending') !== true) errors.push(`${prefix} must freeze the pending SourceNote boundary state`);
    if (!Array.isArray(item.image_urls) || item.image_urls.length !== 2 || item.image_urls.some((url) => typeof url !== 'string' || !/^https?:\/\//.test(url))) errors.push(`${prefix}.image_urls must contain exactly two recorded URLs`);
    if (!Array.isArray(item.artifacts) || item.artifacts.length === 0) errors.push(`${prefix}.artifacts must be non-empty`);
    for (const artifact of item.artifacts || []) {
      if (!artifact.ref || !artifact.ref.endsWith(`@${SOURCE_REF}`)) errors.push(`${prefix} artifact is not pinned to the fixed source ref`);
      if (!/^[0-9a-f]{40}$/.test(String(artifact.git_blob_sha || ''))) errors.push(`${prefix} artifact git_blob_sha is invalid`);
      if (!Number.isInteger(artifact.byte_size) || artifact.byte_size < 0) errors.push(`${prefix} artifact byte_size is invalid`);
    }
  }
  if (!EXPECTED_ITEMS.every((number) => seen.has(number))) errors.push('selection must include both exact issue numbers 1 and 2');
  return { ok: errors.length === 0, errors };
}

function stableAttempt(attempt) {
  return {
    sequence: attempt.sequence,
    url: attempt.url,
    method: attempt.method,
    http_code: attempt.http_code,
    curl_exit: attempt.curl_exit,
    content_type: attempt.content_type || null,
    bytes: attempt.bytes,
    sha256: attempt.sha256,
    accepted_artifact: attempt.accepted_artifact,
  };
}

function attemptsDigest(attempts) {
  return sha256Text(canonicalJson((attempts || []).map(stableAttempt)));
}

function evidenceSubject(packet) {
  const { evidence_subject_sha256: ignored, observed_at: ignoredTime, ...subject } = packet;
  return subject;
}

function evidenceSubjectSha256(packet) {
  return sha256Text(canonicalJson(evidenceSubject(packet)));
}

function buildEvidencePacket({ selection, item, live, pinnedArtifactManifestSha256, checks, attempts, ownership }) {
  const failedCheckIds = checks.filter((entry) => entry.result === 'fail').map((entry) => entry.check_id);
  const packet = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    scope: selection.scope,
    repository: selection.repository,
    controller_issue_number: selection.controller_issue_number,
    scope_issue_number: selection.scope_issue_number,
    issue_number: item.issue_number,
    interview_note_id: item.interview_note_id,
    source_note_issue_number: item.source_note_issue_number,
    source_note_id: item.source_note_id,
    expected_interview_body_sha256: item.expected_interview_body_sha256,
    expected_source_note_body_sha256: item.expected_source_note_body_sha256,
    source_revision_id: item.source_revision_id,
    interview_source_revision_id: live.interview.record.source_revision.id,
    source_snapshot: clone(selection.source_snapshot),
    pinned_artifact_manifest_sha256: pinnedArtifactManifestSha256,
    recovery_attempts_sha256: attemptsDigest(attempts),
    checks: clone(checks),
    failed_check_ids: failedCheckIds,
    decision: 'blocked',
    final_status: 'blocked',
    independent_review: {
      status: 'candidate-only-unposted',
      live_comment_id: null,
      boundary_review_evidence_reused: false,
    },
    ownership: {
      exact_owner_issue_numbers: ownership.map((candidate) => Number(candidate.number)).sort((a, b) => a - b),
      expected_exact_owner_count: 1,
    },
    no_raw_overwrite: true,
    mutation_performed: false,
  };
  packet.evidence_subject_sha256 = evidenceSubjectSha256(packet);
  return packet;
}

function summarizeRecovery(attempts) {
  return {
    total: attempts.length,
    successful: attempts.filter((attempt) => attempt.accepted_artifact).length,
    blocked: attempts.filter((attempt) => !attempt.accepted_artifact).length,
    all_nonempty_200_image_responses: attempts.length > 0 && attempts.every((attempt) => attempt.accepted_artifact),
  };
}

module.exports = {
  SCHEMA_VERSION,
  PLAN_SCHEMA_VERSION,
  EVIDENCE_SCHEMA_VERSION,
  SOURCE_REPOSITORY,
  SOURCE_REF,
  EXPECTED_ITEMS,
  REQUIRED_CHECK_IDS,
  sha256Text,
  canonicalJson,
  clone,
  labelsOf,
  statusOf,
  normalizeArtifacts,
  validateSelection,
  stableAttempt,
  attemptsDigest,
  evidenceSubject,
  evidenceSubjectSha256,
  buildEvidencePacket,
  summarizeRecovery,
};
