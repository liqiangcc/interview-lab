'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 'issue-1539-recovery-plan.v1';
const INDEPENDENT_EVIDENCE_RE = /<!--\s*interview-note-source-review-evidence\.v1\s*\n([\s\S]*?)\n-->/g;
const REQUIRED_INDEPENDENT_EVIDENCE_FIELDS = [
  'repository', 'interview_note_id', 'source_note_issue_number', 'source_revision_id',
  'transition_id', 'evidence_subject_sha256', 'expected_interview_body_sha256',
  'expected_source_note_body_sha256', 'provenance_mode',
  'pinned_artifact_manifest_sha256', 'checks',
];

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function labelsOf(issue) {
  return (issue && issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
}

function statusOf(issue) {
  const statuses = labelsOf(issue).filter((label) => label.startsWith('status:'));
  return statuses.length === 1 ? statuses[0].slice('status:'.length) : null;
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, errors: ['manifest must be an object'] };
  if (manifest.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (typeof manifest.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(manifest.repository)) errors.push('repository must use owner/repo');
  if (!manifest.source_snapshot || manifest.source_snapshot.repository !== 'liqiangcc/xhs' || !/^[0-9a-f]{40}$/.test(String(manifest.source_snapshot.ref || ''))) {
    errors.push('source_snapshot must pin liqiangcc/xhs to a 40-char commit');
  }
  const sourceItems = manifest.source_review && manifest.source_review.items;
  if (!Array.isArray(sourceItems) || sourceItems.length === 0) errors.push('source_review.items must be non-empty');
  const interviewNumbers = new Set();
  const sourceNumbers = new Set();
  for (const [index, item] of (sourceItems || []).entries()) {
    if (!Number.isInteger(item && item.interview_issue_number) || item.interview_issue_number < 1) errors.push(`source_review.items[${index}].interview_issue_number must be positive`);
    if (!Number.isInteger(item && item.source_note_issue_number) || item.source_note_issue_number < 1) errors.push(`source_review.items[${index}].source_note_issue_number must be positive`);
    if (interviewNumbers.has(item && item.interview_issue_number)) errors.push(`duplicate source review InterviewNote Issue #${item.interview_issue_number}`);
    interviewNumbers.add(item && item.interview_issue_number);
    sourceNumbers.add(item && item.source_note_issue_number);
  }
  const boundary = manifest.boundary_expansion;
  if (!boundary || !Array.isArray(boundary.issue_numbers) || boundary.issue_numbers.length === 0) errors.push('boundary_expansion.issue_numbers must be non-empty');
  if (boundary && boundary.selection_policy !== 'pending-source-note-issue-number-ascending') errors.push('boundary_expansion.selection_policy must be deterministic ascending pending selection');
  const boundaryNumbers = boundary && boundary.issue_numbers || [];
  for (let i = 0; i < boundaryNumbers.length; i += 1) {
    if (!Number.isInteger(boundaryNumbers[i]) || boundaryNumbers[i] < 1) errors.push(`boundary_expansion.issue_numbers[${i}] must be positive`);
    if (i > 0 && boundaryNumbers[i] <= boundaryNumbers[i - 1]) errors.push('boundary_expansion.issue_numbers must be strictly ascending');
    if (sourceNumbers.has(boundaryNumbers[i])) errors.push(`boundary selection overlaps Source Review SourceNote #${boundaryNumbers[i]}`);
  }
  return { ok: errors.length === 0, errors };
}

function parseIndependentEvidence(comments, expected = {}) {
  const matches = [];
  const errors = [];
  for (const comment of comments || []) {
    for (const match of String(comment && comment.body || '').matchAll(INDEPENDENT_EVIDENCE_RE)) {
      try {
        const value = JSON.parse(match[1].trim());
        if (value.schema_version !== 'interview-note-source-review-evidence.v1') errors.push(`comment ${comment.id} has wrong evidence schema`);
        for (const field of REQUIRED_INDEPENDENT_EVIDENCE_FIELDS) {
          if (value[field] == null) errors.push(`comment ${comment.id} evidence missing ${field}`);
        }
        for (const [key, expectedValue] of Object.entries(expected)) {
          if (expectedValue != null && canonicalJson(value[key]) !== canonicalJson(expectedValue)) errors.push(`comment ${comment.id} evidence ${key} mismatch`);
        }
        matches.push({ comment_id: Number(comment.id), value });
      } catch (error) {
        errors.push(`comment ${comment && comment.id || 'unknown'} independent evidence JSON invalid: ${error.message}`);
      }
    }
  }
  if (matches.length > 1) errors.push('multiple independent InterviewNote Source Review evidence markers found');
  return { evidence: errors.length ? null : (matches[0] || null), count: matches.length, errors };
}

function reviewAction({ currentStatus, checks, evidence, receiptCount = 0, errors = [], sourceReadyGateResult = null }) {
  const failedChecks = (checks || []).filter((check) => check.result !== 'pass');
  const allChecksPass = failedChecks.length === 0;
  const gatePass = sourceReadyGateResult ? sourceReadyGateResult.ok : allChecksPass;
  const result = {
    current_status: currentStatus,
    computed_checks: checks,
    failed_check_ids: failedChecks.map((check) => check.check_id),
    independent_evidence: evidence ? 'present' : 'missing',
    source_ready_gate: sourceReadyGateResult,
    receipt_count: receiptCount,
    mutation_performed: false,
    errors: [...errors],
  };
  // Any planner error is a hard safety failure. Evidence cannot waive it,
  // and missing evidence must never hide it behind the await-evidence path.
  if (result.errors.length > 0 || !gatePass) {
    result.action = 'remain-blocked';
    result.candidate_decision = 'blocked';
  } else if (!evidence) {
    result.action = 'await-independent-source-review-evidence';
    result.candidate_decision = 'blocked';
    result.errors.push('independent InterviewNote Source Review evidence is not present; Boundary Review evidence is not eligible');
  } else {
    result.action = 'source-review-ready-for-authorized-transition';
    result.candidate_decision = 'source-ready';
  }
  return result;
}

module.exports = { SCHEMA_VERSION, INDEPENDENT_EVIDENCE_RE, sha256Text, canonicalJson, labelsOf, statusOf, validateManifest, parseIndependentEvidence, reviewAction };
