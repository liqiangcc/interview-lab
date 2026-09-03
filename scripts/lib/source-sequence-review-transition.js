'use strict';

const {
  validateSourceSequenceReview,
  getEffectiveSourceSequenceReview,
} = require('./source-sequence-review');

const SCHEMA_VERSION = 'source-sequence-review-transition.v1';
const MARKER_RE = /<!--\s*source-sequence-review-transition\s*([\s\S]*?)-->/g;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseSourceSequenceReviewTransition(body) {
  const matches = [...String(body || '').matchAll(MARKER_RE)];
  const errors = [];
  if (matches.length !== 1) {
    errors.push('comment must contain exactly one source-sequence-review-transition machine marker');
    return { request: null, errors };
  }
  try {
    return { request: JSON.parse(matches[0][1].trim()), errors };
  } catch (error) {
    errors.push(`source-sequence-review-transition marker must contain valid JSON: ${error.message}`);
    return { request: null, errors };
  }
}

function validateTransitionRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, errors: ['transition request must be an object'] };
  }
  if (request.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isNonEmptyString(request.transition_id)) errors.push('transition_id must be a non-empty string');
  if (!isNonEmptyString(request.manifest_id)) errors.push('manifest_id must be a non-empty string');
  if (!/^[0-9a-f]{64}$/.test(String(request.manifest_sha256 || ''))) errors.push('manifest_sha256 must be a 64-char lowercase hex SHA-256');
  if (request.expected_effective_review_id != null && !isNonEmptyString(request.expected_effective_review_id)) {
    errors.push('expected_effective_review_id must be null or a non-empty string');
  }
  if (!isNonEmptyString(request.new_review_id)) errors.push('new_review_id must be a non-empty string');
  if (!['approved', 'rejected'].includes(request.decision)) errors.push('decision must be approved or rejected');
  if (!isNonEmptyString(request.reviewed_at) || Number.isNaN(Date.parse(request.reviewed_at))) errors.push('reviewed_at must be a valid timestamp');
  if (!['human', 'ai-assisted'].includes(request.reviewer_kind)) errors.push('reviewer_kind must be human or ai-assisted');
  if (!request.review_evidence || typeof request.review_evidence !== 'object' || Array.isArray(request.review_evidence)) {
    errors.push('review_evidence must be an object');
  }
  if (!Array.isArray(request.checks) || request.checks.length === 0) errors.push('checks must be a non-empty array');
  if (!Array.isArray(request.limitations)) errors.push('limitations must be an array');
  return { ok: errors.length === 0, errors };
}

function planSourceSequenceReviewTransition(request, options = {}) {
  const errors = [];
  const requestResult = validateTransitionRequest(request);
  errors.push(...requestResult.errors);
  if (errors.length > 0) return { ok: false, errors, request, review: null };

  const manifestsById = options.manifestsById;
  const reviewsById = options.reviewsById;
  const effectiveReviewsByManifestDigest = options.effectiveReviewsByManifestDigest;
  if (!manifestsById || typeof manifestsById.get !== 'function') errors.push('transition planning requires SourceSequenceManifest registry');
  if (!reviewsById || typeof reviewsById.get !== 'function') errors.push('transition planning requires SourceSequenceReview by-id registry');
  if (!effectiveReviewsByManifestDigest || typeof effectiveReviewsByManifestDigest.get !== 'function') errors.push('transition planning requires effective SourceSequenceReview registry');
  if (errors.length > 0) return { ok: false, errors, request, review: null };

  const manifest = manifestsById.get(request.manifest_id);
  if (!manifest) {
    errors.push(`manifest_id ${request.manifest_id} does not resolve`);
    return { ok: false, errors, request, review: null };
  }
  if (manifest.content_sha256 !== request.manifest_sha256) errors.push('manifest_sha256 must equal the registered manifest content_sha256');

  const current = getEffectiveSourceSequenceReview(
    effectiveReviewsByManifestDigest,
    request.manifest_id,
    request.manifest_sha256,
  );
  const currentId = current ? current.review_id : null;
  if (request.expected_effective_review_id !== currentId) {
    errors.push(`stale review transition: expected_effective_review_id=${request.expected_effective_review_id ?? 'null'} but current effective review=${currentId ?? 'null'}`);
  }
  if (reviewsById.has(request.new_review_id)) errors.push(`new_review_id ${request.new_review_id} already exists`);
  if (current && Date.parse(request.reviewed_at) <= Date.parse(current.reviewed_at)) {
    errors.push('reviewed_at must be later than the current effective review timestamp');
  }

  const review = {
    schema_version: 'source-sequence-review.v1',
    review_id: request.new_review_id,
    manifest_id: request.manifest_id,
    manifest_sha256: request.manifest_sha256,
    decision: request.decision,
    reviewed_at: request.reviewed_at,
    reviewer_kind: request.reviewer_kind,
    review_evidence: request.review_evidence,
    checks: request.checks,
    limitations: request.limitations,
    supersedes_review_id: currentId,
  };
  const reviewResult = validateSourceSequenceReview(review);
  errors.push(...reviewResult.errors.map((error) => `planned review invalid: ${error}`));

  return {
    ok: errors.length === 0,
    errors,
    request,
    previous_effective_review_id: currentId,
    review,
  };
}

module.exports = {
  SCHEMA_VERSION,
  parseSourceSequenceReviewTransition,
  validateTransitionRequest,
  planSourceSequenceReviewTransition,
};
