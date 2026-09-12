'use strict';

// The correction schema records historical bindings; it never replaces an
// applied receipt or relaxes source/owner identity validation.
const CORRECTION_SCHEMA_VERSION = 'source-note-boundary-review-applied-correction.v1';
const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REF_PIN = '95b77bb261048059846273688e4b90a2e108b437';
const HEX64 = /^[0-9a-f]{64}$/;
const { canonicalDigest } = require('./aggregate-downstream-pipeline');
const sameJson = (left, right) => canonicalDigest(left) === canonicalDigest(right);

function validateCorrectionMarker(value, row) {
  const errors = [];
  const object = (field, candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) errors.push(`${field} must be an object`);
    return Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate));
  };
  const requiredString = (field, actual, expected = null) => {
    if (typeof actual !== 'string' || !actual.trim()) errors.push(`${field} must be a non-empty string`);
    if (expected !== null && actual !== expected) errors.push(`${field} binding mismatch`);
  };
  const requiredInt = (field, actual, expected = null) => {
    if (!Number.isSafeInteger(actual) || actual < 1) errors.push(`${field} must be a positive integer`);
    if (expected !== null && actual !== expected) errors.push(`${field} binding mismatch`);
  };
  const exactKeys = (field, candidate, allowed) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    for (const key of Object.keys(candidate)) if (!allowed.has(key)) errors.push(`${field} has unsupported field: ${key}`);
  };
  object('correction', value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors };
  exactKeys('correction', value, new Set(['schema_version', 'correction_id', 'reason', 'repository', 'source_note_issue_number', 'source_note_id', 'source_note_body_sha256', 'source_revision_id', 'source_repository_ref', 'transition_id', 'original_receipt', 'corrected_receipt', 'owner_binding', 'materialization_binding', 'evidence_binding']));
  requiredString('schema_version', value.schema_version, CORRECTION_SCHEMA_VERSION);
  requiredString('correction_id', value.correction_id, `issue-1658-receipt-repair-${row.source_issue}-v1`);
  requiredString('reason', value.reason, 'historical-empty-interview-note-ids-reconciled');
  requiredString('repository', value.repository, REPOSITORY);
  requiredInt('source_note_issue_number', value.source_note_issue_number, row.source_issue);
  requiredString('source_note_id', value.source_note_id, row.source_note_id);
  requiredString('source_note_body_sha256', value.source_note_body_sha256, row.source_body_sha256);
  requiredString('source_revision_id', value.source_revision_id, row.source_revision_id);
  requiredString('source_repository_ref', value.source_repository_ref, SOURCE_REF_PIN);
  requiredString('transition_id', value.transition_id, row.transition_id);
  const issueApiUrl = `https://api.github.com/repos/${REPOSITORY}/issues/${row.source_issue}`;
  if (!HEX64.test(String(value.source_note_body_sha256 || ''))) errors.push('source_note_body_sha256 must be a lowercase SHA-256');
  const original = value.original_receipt;
  if (object('original_receipt', original)) {
    exactKeys('original_receipt', original, new Set(['comment_id', 'issue_url', 'schema_version', 'body_sha256', 'marker_sha256', 'interview_note_ids']));
    requiredInt('original_receipt.comment_id', original.comment_id, row.applied_comment_id);
    requiredString('original_receipt.issue_url', original.issue_url, issueApiUrl);
    requiredString('original_receipt.schema_version', original.schema_version, 'source-note-boundary-review-applied.v1');
    requiredString('original_receipt.body_sha256', original.body_sha256);
    requiredString('original_receipt.marker_sha256', original.marker_sha256);
    if (original.body_sha256 !== row.applied_receipt_body_sha256 || original.marker_sha256 !== row.applied_receipt_marker_sha256) errors.push('original_receipt digest binding mismatch');
    if (!HEX64.test(String(original.body_sha256 || '')) || !HEX64.test(String(original.marker_sha256 || ''))) errors.push('original receipt digests must be lowercase SHA-256');
    if (!Array.isArray(original.interview_note_ids) || original.interview_note_ids.length !== 0) errors.push('original_receipt.interview_note_ids must remain exactly []');
  }
  const corrected = value.corrected_receipt;
  if (object('corrected_receipt', corrected)) {
    exactKeys('corrected_receipt', corrected, new Set(['interview_note_ids', 'interview_note_cases']));
    if (!Array.isArray(corrected.interview_note_ids) || corrected.interview_note_ids.length !== 1 || corrected.interview_note_ids[0] !== row.identity) errors.push('corrected_receipt.interview_note_ids must contain exactly the bound identity');
    if (corrected.interview_note_cases !== null) errors.push('corrected_receipt.interview_note_cases must be null for this single-interview scope');
  }
  const owner = value.owner_binding;
  if (object('owner_binding', owner)) {
    exactKeys('owner_binding', owner, new Set(['issue_number', 'interview_note_id', 'body_sha256', 'labels']));
    requiredInt('owner_binding.issue_number', owner.issue_number, row.owner_issue);
    requiredString('owner_binding.interview_note_id', owner.interview_note_id, row.identity);
    requiredString('owner_binding.body_sha256', owner.body_sha256);
    if (!HEX64.test(String(owner.body_sha256 || ''))) errors.push('owner_binding.body_sha256 must be lowercase SHA-256');
    if (!Array.isArray(owner.labels) || owner.labels.length === 0 || owner.labels.some((label) => typeof label !== 'string')) errors.push('owner_binding.labels must be a non-empty string array');
    if (owner.body_sha256 !== row.owner_body_sha256 || !sameJson(owner.labels || [], row.owner_labels || [])) errors.push('owner_binding live owner fact mismatch');
  }
  const materialization = value.materialization_binding;
  if (object('materialization_binding', materialization)) {
    exactKeys('materialization_binding', materialization, new Set(['comment_id', 'issue_url', 'body_sha256', 'marker_sha256', 'source_note_id', 'source_note_body_sha256', 'source_revision_id', 'source_repository_ref', 'interview_note_id', 'interview_issue_number', 'interview_issue_body_sha256']));
    requiredInt('materialization_binding.comment_id', materialization.comment_id, row.materialization_comment_id);
    requiredString('materialization_binding.issue_url', materialization.issue_url, issueApiUrl);
    requiredString('materialization_binding.body_sha256', materialization.body_sha256);
    requiredString('materialization_binding.marker_sha256', materialization.marker_sha256);
    requiredString('materialization_binding.source_note_id', materialization.source_note_id, row.source_note_id);
    requiredString('materialization_binding.source_note_body_sha256', materialization.source_note_body_sha256, value.source_note_body_sha256);
    requiredString('materialization_binding.source_revision_id', materialization.source_revision_id, row.source_revision_id);
    requiredString('materialization_binding.source_repository_ref', materialization.source_repository_ref, SOURCE_REF_PIN);
    requiredString('materialization_binding.interview_note_id', materialization.interview_note_id, row.identity);
    requiredInt('materialization_binding.interview_issue_number', materialization.interview_issue_number, row.owner_issue);
    requiredString('materialization_binding.interview_issue_body_sha256', materialization.interview_issue_body_sha256);
    for (const field of ['body_sha256', 'marker_sha256', 'source_note_body_sha256', 'interview_issue_body_sha256']) if (!HEX64.test(String(materialization[field] || ''))) errors.push(`materialization_binding.${field} must be lowercase SHA-256`);
    if (materialization.body_sha256 !== row.materialization_receipt_body_sha256 || materialization.marker_sha256 !== row.materialization_receipt_marker_sha256 || materialization.interview_issue_body_sha256 !== row.owner_body_sha256) errors.push('materialization_binding live receipt/owner fact mismatch');
  }
  const evidence = value.evidence_binding;
  if (object('evidence_binding', evidence)) {
    exactKeys('evidence_binding', evidence, new Set(['comment_id', 'issue_url', 'body_sha256', 'marker_sha256', 'schema_version', 'transition_id']));
    requiredInt('evidence_binding.comment_id', evidence.comment_id, row.evidence_comment_id);
    requiredString('evidence_binding.issue_url', evidence.issue_url, issueApiUrl);
    requiredString('evidence_binding.body_sha256', evidence.body_sha256);
    requiredString('evidence_binding.marker_sha256', evidence.marker_sha256);
    requiredString('evidence_binding.schema_version', evidence.schema_version, 'issue-1608-boundary-evidence.v1');
    requiredString('evidence_binding.transition_id', evidence.transition_id, row.transition_id);
    if (!HEX64.test(String(evidence.body_sha256 || '')) || !HEX64.test(String(evidence.marker_sha256 || ''))) errors.push('evidence binding digests must be lowercase SHA-256');
    if (evidence.body_sha256 !== row.evidence_body_sha256 || evidence.marker_sha256 !== row.evidence_marker_sha256) errors.push('evidence_binding live comment fact mismatch');
  }
  return { ok: errors.length === 0, errors, value };
}


module.exports = { validateCorrectionMarker, CORRECTION_SCHEMA_VERSION };
