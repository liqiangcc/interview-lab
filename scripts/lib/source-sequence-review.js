'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'source-sequence-review.v1';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function reviewKey(manifestId, manifestSha256) {
  return `${manifestId}#${manifestSha256}`;
}

function validateSourceSequenceReview(review) {
  const errors = [];
  const warnings = [];

  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    return { ok: false, errors: ['review must be an object'], warnings, review: null };
  }

  if (review.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isNonEmptyString(review.review_id)) errors.push('review_id must be a non-empty string');
  if (!isNonEmptyString(review.manifest_id)) errors.push('manifest_id must be a non-empty string');
  if (!/^[0-9a-f]{64}$/.test(String(review.manifest_sha256 || ''))) errors.push('manifest_sha256 must be a 64-char lowercase hex SHA-256');
  if (!['approved', 'rejected'].includes(review.decision)) errors.push('decision must be approved or rejected');
  if (!isNonEmptyString(review.reviewed_at) || Number.isNaN(Date.parse(review.reviewed_at))) errors.push('reviewed_at must be a valid timestamp');
  if (!['human', 'ai-assisted'].includes(review.reviewer_kind)) errors.push('reviewer_kind must be human or ai-assisted');

  const evidence = review.review_evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    errors.push('review_evidence must be an object');
  } else {
    if (!/^[^/]+\/[^/]+$/.test(String(evidence.repository || ''))) errors.push('review_evidence.repository must use owner/repo');
    if (!Number.isInteger(evidence.issue_number) || evidence.issue_number < 1) errors.push('review_evidence.issue_number must be a positive integer');
    if (!Number.isInteger(evidence.comment_id) || evidence.comment_id < 1) errors.push('review_evidence.comment_id must be a positive integer');
  }

  if (!Array.isArray(review.checks) || review.checks.length === 0) {
    errors.push('checks must be a non-empty array');
  } else {
    const checkIds = new Set();
    for (const [index, check] of review.checks.entries()) {
      const prefix = `checks[${index}]`;
      if (!check || typeof check !== 'object' || Array.isArray(check)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(String(check.check_id || ''))) errors.push(`${prefix}.check_id must be a stable machine identifier`);
      else if (checkIds.has(check.check_id)) errors.push(`${prefix}.check_id must be unique within review`);
      else checkIds.add(check.check_id);
      if (!['pass', 'fail'].includes(check.result)) errors.push(`${prefix}.result must be pass or fail`);
    }
    if (review.decision === 'approved' && review.checks.some((check) => check && check.result !== 'pass')) {
      errors.push('approved review requires every check result=pass');
    }
    if (review.decision === 'rejected' && !review.checks.some((check) => check && check.result === 'fail')) {
      errors.push('rejected review requires at least one failed check');
    }
  }

  if (!Array.isArray(review.limitations)) errors.push('limitations must be an array');
  if (review.supersedes_review_id != null && !isNonEmptyString(review.supersedes_review_id)) errors.push('supersedes_review_id must be null or a non-empty string');

  return { ok: errors.length === 0, errors, warnings, review };
}

function loadSourceSequenceReviews(directory = path.join(process.cwd(), 'data', 'source-sequence-reviews'), options = {}) {
  const errors = [];
  const warnings = [];
  const reviews = [];
  const byId = new Map();
  const grouped = new Map();

  if (!fs.existsSync(directory)) return { ok: true, errors, warnings, reviews, byId, effectiveByManifestDigest: new Map() };

  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
    const filePath = path.join(directory, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      errors.push(`${name}: invalid JSON: ${error.message}`);
      continue;
    }
    const result = validateSourceSequenceReview(parsed);
    errors.push(...result.errors.map((error) => `${name}: ${error}`));
    warnings.push(...result.warnings.map((warning) => `${name}: ${warning}`));
    if (!result.ok) continue;
    if (byId.has(parsed.review_id)) {
      errors.push(`${name}: duplicate review_id ${parsed.review_id}`);
      continue;
    }
    parsed.__file = filePath;
    reviews.push(parsed);
    byId.set(parsed.review_id, parsed);
    const key = reviewKey(parsed.manifest_id, parsed.manifest_sha256);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(parsed);
  }

  const effectiveByManifestDigest = new Map();
  for (const [key, entries] of grouped.entries()) {
    const superseded = new Set();
    for (const review of entries) {
      if (review.supersedes_review_id == null) continue;
      const previous = byId.get(review.supersedes_review_id);
      if (!previous) {
        errors.push(`${review.review_id}: supersedes_review_id ${review.supersedes_review_id} does not resolve`);
        continue;
      }
      if (reviewKey(previous.manifest_id, previous.manifest_sha256) !== key) {
        errors.push(`${review.review_id}: superseded review must target the same manifest_id + digest`);
        continue;
      }
      superseded.add(previous.review_id);
    }

    const heads = entries.filter((review) => !superseded.has(review.review_id));
    if (heads.length !== 1) {
      errors.push(`${key}: review chain must have exactly one effective head; found ${heads.length}`);
      continue;
    }

    const head = heads[0];
    const seen = new Set();
    let cursor = head;
    while (cursor && cursor.supersedes_review_id != null) {
      if (seen.has(cursor.review_id)) {
        errors.push(`${key}: review chain contains a cycle at ${cursor.review_id}`);
        break;
      }
      seen.add(cursor.review_id);
      cursor = byId.get(cursor.supersedes_review_id) || null;
    }

    effectiveByManifestDigest.set(key, head);
  }

  if (options.manifestsById && typeof options.manifestsById.get === 'function') {
    for (const review of reviews) {
      const manifest = options.manifestsById.get(review.manifest_id);
      if (!manifest) {
        errors.push(`${review.review_id}: manifest_id ${review.manifest_id} does not resolve`);
      } else if (manifest.content_sha256 !== review.manifest_sha256) {
        warnings.push(`${review.review_id}: review targets a non-current digest for manifest_id ${review.manifest_id}; it remains historical but cannot approve the current manifest content`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, reviews, byId, effectiveByManifestDigest };
}

function getEffectiveSourceSequenceReview(effectiveByManifestDigest, manifestId, manifestSha256) {
  if (!effectiveByManifestDigest || typeof effectiveByManifestDigest.get !== 'function') return null;
  return effectiveByManifestDigest.get(reviewKey(manifestId, manifestSha256)) || null;
}

module.exports = {
  SCHEMA_VERSION,
  reviewKey,
  validateSourceSequenceReview,
  loadSourceSequenceReviews,
  getEffectiveSourceSequenceReview,
};
