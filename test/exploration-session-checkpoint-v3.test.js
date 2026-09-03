'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExplorationSessionCheckpoint } = require('../scripts/lib/exploration-session-checkpoint');
const { loadSourceSequenceManifests } = require('../scripts/lib/source-sequence-manifest');
const { loadSourceSequenceReviews, reviewKey } = require('../scripts/lib/source-sequence-review');

const validBody = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'exploration-session-checkpoint-v3.valid.md'),
  'utf8',
);
const manifests = loadSourceSequenceManifests(path.join(__dirname, '..', 'data', 'source-sequences'));
const reviews = loadSourceSequenceReviews(path.join(__dirname, '..', 'data', 'source-sequence-reviews'), { manifestsById: manifests.byId });
const manifestId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1';
const manifestSha256 = '829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad';
const reviewId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-1';

function validate(body, overrides = {}) {
  return validateExplorationSessionCheckpoint(body, {
    manifestsById: manifests.byId,
    reviewsById: reviews.byId,
    effectiveReviewsByManifestDigest: reviews.effectiveByManifestDigest,
    requireCurrentApproval: true,
    ...overrides,
  });
}

test('review-pinned checkpoint v3 passes with current effective approval', () => {
  const result = validate(validBody);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('v3 requires source_review_id', () => {
  const body = validBody.replace(`  "source_review_id": "${reviewId}",\n`, '');
  const result = validate(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /v3 checkpoint requires source_review_id/);
});

test('v3 rejects unknown pinned SourceSequenceReview', () => {
  const body = validBody.replace(reviewId, 'unknown-review');
  const result = validate(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_review_id unknown-review does not resolve/);
});

test('v3 rejects pinned rejected review', () => {
  const rejected = {
    ...reviews.byId.get(reviewId),
    review_id: 'review-rejected',
    decision: 'rejected',
  };
  const reviewsById = new Map(reviews.byId);
  reviewsById.set(rejected.review_id, rejected);
  const body = validBody.replace(reviewId, rejected.review_id);
  const result = validate(body, { reviewsById });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /pinned SourceSequenceReview must be approved/);
});

test('v3 pinned review must target exact manifest digest', () => {
  const wrong = {
    ...reviews.byId.get(reviewId),
    review_id: 'review-wrong-digest',
    manifest_sha256: '0'.repeat(64),
  };
  const reviewsById = new Map(reviews.byId);
  reviewsById.set(wrong.review_id, wrong);
  const body = validBody.replace(reviewId, wrong.review_id);
  const result = validate(body, { reviewsById });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must target the exact source_manifest_id \+ source_manifest_sha256/);
});

test('new v3 checkpoint must pin current effective review', () => {
  const old = {
    ...reviews.byId.get(reviewId),
    review_id: 'review-old-approved',
  };
  const current = {
    ...reviews.byId.get(reviewId),
    review_id: 'review-current-approved',
    supersedes_review_id: old.review_id,
  };
  const reviewsById = new Map([[old.review_id, old], [current.review_id, current]]);
  const effective = new Map([[reviewKey(manifestId, manifestSha256), current]]);
  const body = validBody.replace(reviewId, old.review_id);
  const result = validate(body, {
    reviewsById,
    effectiveReviewsByManifestDigest: effective,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must pin the current effective SourceSequenceReview review-current-approved/);
});
