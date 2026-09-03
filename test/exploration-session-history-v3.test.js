'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExplorationSessionHistory } = require('../scripts/lib/exploration-session-history');
const { loadSourceSequenceManifests } = require('../scripts/lib/source-sequence-manifest');
const { loadSourceSequenceReviews, reviewKey } = require('../scripts/lib/source-sequence-review');

const manifests = loadSourceSequenceManifests(path.join(__dirname, '..', 'data', 'source-sequences'));
const reviews = loadSourceSequenceReviews(path.join(__dirname, '..', 'data', 'source-sequence-reviews'), { manifestsById: manifests.byId });
const manifestId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1';
const manifestSha256 = '829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad';
const reviewId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-1';
const unitId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:u4';
const unitText = '4.一个http请求和它使用的tcp连接对应什么关系（想问长连接和多路复用 然后又深挖了多路复用原理)';

function record(fragmentNumber, phase = 'literal', overrides = {}) {
  const fragmentId = `xhs:6508552c000000001303f499:legacy-r1:image-1:u4:f${fragmentNumber}`;
  return {
    schema_version: 'exploration-session-checkpoint.v3',
    session_id: 'manifest-history-v3-test',
    target_type: 'InterviewNote',
    target_id: 'xhs:6508552c000000001303f499',
    mode: 'learning',
    source_revision_id: 'xhs:6508552c000000001303f499:legacy-r1',
    source_manifest_id: manifestId,
    source_manifest_sha256: manifestSha256,
    source_review_id: reviewId,
    source_unit_id: unitId,
    source_fragment_id: fragmentId,
    revealed_position: 4,
    revealed_range: '1..4',
    current_source_unit: unitText,
    source_unit_type: 'question-like',
    loop_phase: phase,
    temporal_cursor: fragmentId,
    revealed_within_unit: `fragment-${fragmentNumber}`,
    has_withheld_within_unit: fragmentNumber < 3,
    position_status: 'active',
    session_status: 'active',
    closure_reason: null,
    completed_at: null,
    ...overrides,
  };
}

function comment(id, value) {
  return {
    id,
    created_at: `2026-09-03T09:${String(id).padStart(2, '0')}:00Z`,
    updated_at: `2026-09-03T09:${String(id).padStart(2, '0')}:00Z`,
    body: `## ExplorationSession checkpoint\n\n<!-- exploration-session-checkpoint\n${JSON.stringify(value, null, 2)}\n-->`,
  };
}

function validate(comments, overrides = {}) {
  return validateExplorationSessionHistory(comments, {
    manifestsById: manifests.byId,
    reviewsById: reviews.byId,
    effectiveReviewsByManifestDigest: reviews.effectiveByManifestDigest,
    ...overrides,
  });
}

test('v3 history preserves pinned approved review identity', () => {
  const result = validate([
    comment(1, record(1, 'literal')),
    comment(2, record(2, 'classification')),
    comment(3, record(3, 'knowledge')),
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('historical v3 remains valid after pinned approval is superseded by rejection', () => {
  const oldApproved = reviews.byId.get(reviewId);
  const rejected = {
    ...oldApproved,
    review_id: 'review-later-rejected',
    decision: 'rejected',
    supersedes_review_id: reviewId,
  };
  const reviewsById = new Map(reviews.byId);
  reviewsById.set(rejected.review_id, rejected);
  const effective = new Map([[reviewKey(manifestId, manifestSha256), rejected]]);
  const result = validate([comment(1, record(1, 'literal'))], {
    reviewsById,
    effectiveReviewsByManifestDigest: effective,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.match(result.warnings.join('\n'), /pins superseded review .* current effective review is review-later-rejected \(rejected\)/);
});

test('v3 history requires pinned review to exist', () => {
  const result = validate([comment(1, record(1, 'literal', { source_review_id: 'missing-review' }))]);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_review_id missing-review does not resolve/);
});

test('v3 session cannot silently switch pinned review identity', () => {
  const second = record(2, 'classification', { source_review_id: 'another-review' });
  const another = { ...reviews.byId.get(reviewId), review_id: 'another-review' };
  const reviewsById = new Map(reviews.byId);
  reviewsById.set(another.review_id, another);
  const result = validate([comment(1, record(1, 'literal')), comment(2, second)], { reviewsById });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_review_id changed within session/);
});
