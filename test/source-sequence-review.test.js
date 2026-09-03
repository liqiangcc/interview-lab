'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSourceSequenceReview,
  loadSourceSequenceReviews,
  reviewKey,
} = require('../scripts/lib/source-sequence-review');
const { loadSourceSequenceManifests } = require('../scripts/lib/source-sequence-manifest');

const manifests = loadSourceSequenceManifests(path.join(__dirname, '..', 'data', 'source-sequences'));
const manifestId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1';
const manifestSha256 = '829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad';

function review(overrides = {}) {
  return {
    schema_version: 'source-sequence-review.v1',
    review_id: 'review-1',
    manifest_id: manifestId,
    manifest_sha256: manifestSha256,
    decision: 'approved',
    reviewed_at: '2026-09-03T08:58:53Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: {
      repository: 'liqiangcc/interview-lab',
      issue_number: 3,
      comment_id: 5523241379,
    },
    checks: [{ check_id: 'unit_order', result: 'pass' }],
    limitations: [],
    supersedes_review_id: null,
    ...overrides,
  };
}

function withTempReviews(entries, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-sequence-reviews-'));
  try {
    entries.forEach((entry, index) => {
      fs.writeFileSync(path.join(dir, `${index + 1}.json`), JSON.stringify(entry, null, 2));
    });
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('valid approved SourceSequenceReview passes', () => {
  const result = validateSourceSequenceReview(review());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('approved review cannot contain failed checks', () => {
  const result = validateSourceSequenceReview(review({
    checks: [{ check_id: 'unit_order', result: 'fail' }],
  }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /approved review requires every check result=pass/);
});

test('rejected review requires an explicit failed check', () => {
  const result = validateSourceSequenceReview(review({ decision: 'rejected' }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /rejected review requires at least one failed check/);
});

test('repository review registry resolves one effective approval head', () => {
  const registry = loadSourceSequenceReviews(
    path.join(__dirname, '..', 'data', 'source-sequence-reviews'),
    { manifestsById: manifests.byId },
  );
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));
  const effective = registry.effectiveByManifestDigest.get(reviewKey(manifestId, manifestSha256));
  assert.equal(effective.decision, 'approved');
  assert.equal(effective.review_evidence.comment_id, 5523241379);
});

test('later rejected review can supersede earlier approval', () => {
  const first = review({ review_id: 'review-1' });
  const second = review({
    review_id: 'review-2',
    decision: 'rejected',
    reviewed_at: '2026-09-03T09:00:00Z',
    checks: [{ check_id: 'fragment_order', result: 'fail' }],
    supersedes_review_id: 'review-1',
  });
  withTempReviews([first, second], (dir) => {
    const registry = loadSourceSequenceReviews(dir, { manifestsById: manifests.byId });
    assert.equal(registry.ok, true, JSON.stringify(registry.errors));
    const effective = registry.effectiveByManifestDigest.get(reviewKey(manifestId, manifestSha256));
    assert.equal(effective.review_id, 'review-2');
    assert.equal(effective.decision, 'rejected');
  });
});

test('parallel review heads fail closed', () => {
  const first = review({ review_id: 'review-1' });
  const second = review({ review_id: 'review-2', reviewed_at: '2026-09-03T09:00:00Z' });
  withTempReviews([first, second], (dir) => {
    const registry = loadSourceSequenceReviews(dir, { manifestsById: manifests.byId });
    assert.equal(registry.ok, false);
    assert.match(registry.errors.join('\n'), /exactly one effective head/);
  });
});

test('supersedes_review_id must stay within exact manifest digest', () => {
  const first = review({ review_id: 'review-1' });
  const second = review({
    review_id: 'review-2',
    manifest_sha256: '0'.repeat(64),
    decision: 'rejected',
    checks: [{ check_id: 'unit_order', result: 'fail' }],
    supersedes_review_id: 'review-1',
  });
  withTempReviews([first, second], (dir) => {
    const registry = loadSourceSequenceReviews(dir, { manifestsById: manifests.byId });
    assert.equal(registry.ok, false);
    assert.match(registry.errors.join('\n'), /superseded review must target the same manifest_id \+ digest/);
  });
});
