'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSourceSequenceManifests } = require('../scripts/lib/source-sequence-manifest');
const { loadSourceSequenceReviews } = require('../scripts/lib/source-sequence-review');
const { planSourceSequenceReviewTransition } = require('../scripts/lib/source-sequence-review-transition');

const manifests = loadSourceSequenceManifests(path.join(__dirname, '..', 'data', 'source-sequences'));
const reviews = loadSourceSequenceReviews(path.join(__dirname, '..', 'data', 'source-sequence-reviews'), { manifestsById: manifests.byId });
const manifestId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1';
const manifestSha = '829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad';
const review1 = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-1';

function request(overrides = {}) {
  return {
    schema_version: 'source-sequence-review-transition.v1',
    transition_id: 'transition-test-review-2',
    manifest_id: manifestId,
    manifest_sha256: manifestSha,
    expected_effective_review_id: review1,
    new_review_id: 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-2',
    decision: 'approved',
    reviewed_at: '2026-09-03T10:00:00Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 3, comment_id: 9999999999 },
    checks: [
      { check_id: 'evidence_stream_binding', result: 'pass' },
      { check_id: 'unit_boundaries', result: 'pass' },
      { check_id: 'unit_order', result: 'pass' },
      { check_id: 'unit_types', result: 'pass' },
      { check_id: 'fragment_boundaries', result: 'pass' },
      { check_id: 'fragment_order', result: 'pass' },
      { check_id: 'no_fabrication', result: 'pass' }
    ],
    limitations: ['fixture transition only'],
    ...overrides,
  };
}

function plan(value) {
  return planSourceSequenceReviewTransition(value, {
    manifestsById: manifests.byId,
    reviewsById: reviews.byId,
    effectiveReviewsByManifestDigest: reviews.effectiveByManifestDigest,
  });
}

test('valid transition automatically supersedes current effective head', () => {
  const result = plan(request());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.previous_effective_review_id, review1);
  assert.equal(result.review.supersedes_review_id, review1);
  assert.equal(result.review.decision, 'approved');
});

test('stale expected effective review fails closed', () => {
  const result = plan(request({ expected_effective_review_id: 'stale-review' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /stale review transition/);
});

test('new review id must not already exist', () => {
  const result = plan(request({ new_review_id: review1 }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /already exists/);
});

test('transition must target exact current manifest digest', () => {
  const result = plan(request({ manifest_sha256: '0'.repeat(64) }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /manifest_sha256 must equal/);
});

test('new review timestamp must be later than current head', () => {
  const result = plan(request({ reviewed_at: '2026-09-03T08:58:53Z' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /reviewed_at must be later/);
});

test('rejected transition still requires explicit failed check', () => {
  const result = plan(request({ decision: 'rejected' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /rejected review requires at least one failed check/);
});
