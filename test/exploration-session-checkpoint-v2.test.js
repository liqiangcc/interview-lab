'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExplorationSessionCheckpoint } = require('../scripts/lib/exploration-session-checkpoint');
const { loadSourceSequenceManifests } = require('../scripts/lib/source-sequence-manifest');
const { loadSourceSequenceReviews } = require('../scripts/lib/source-sequence-review');

const validBody = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'exploration-session-checkpoint-v2.valid.md'),
  'utf8',
);
const manifests = loadSourceSequenceManifests(path.join(__dirname, '..', 'data', 'source-sequences'));
const reviews = loadSourceSequenceReviews(path.join(__dirname, '..', 'data', 'source-sequence-reviews'), { manifestsById: manifests.byId });

function validate(body, effectiveReviewsByManifestDigest = reviews.effectiveByManifestDigest) {
  return validateExplorationSessionCheckpoint(body, {
    manifestsById: manifests.byId,
    effectiveReviewsByManifestDigest,
  });
}

test('approved manifest-bound checkpoint v2 passes', () => {
  const result = validate(validBody);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('v2 rejects manifest with no effective review', () => {
  const result = validate(validBody, new Map());
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /no effective SourceSequenceReview/);
});

test('v2 rejects manifest whose effective review is rejected', () => {
  const rejected = new Map(reviews.effectiveByManifestDigest);
  const key = [...rejected.keys()][0];
  rejected.set(key, { ...rejected.get(key), review_id: 'rejected-review', decision: 'rejected' });
  const result = validate(validBody, rejected);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /is not approved/);
});

test('v2 rejects manifest digest mismatch', () => {
  const body = validBody.replace(
    '"source_manifest_sha256": "829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad"',
    `"source_manifest_sha256": "${'0'.repeat(64)}"`,
  );
  const result = validate(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_manifest_sha256 must equal manifest content_sha256/);
});

test('v2 rejects self-reported position that disagrees with SourceUnit', () => {
  const body = validBody
    .replace('"revealed_position": 4', '"revealed_position": 5')
    .replace('"revealed_range": "1..4"', '"revealed_range": "1..5"');
  const result = validate(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /revealed_position must equal manifest SourceUnit position/);
});

test('v2 rejects source unit text that disagrees with manifest', () => {
  const body = validBody.replace(
    '4.一个http请求和它使用的tcp连接对应什么关系（想问长连接和多路复用 然后又深挖了多路复用原理)',
    '4.被错误改写的 Source unit',
  );
  const result = validate(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /current_source_unit must equal manifest SourceUnit text_projection/);
});

test('v2 rejects source unit type that disagrees with manifest', () => {
  const body = validBody.replace('"source_unit_type": "question-like"', '"source_unit_type": "stage-summary"');
  const result = validate(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_unit_type must equal manifest SourceUnit type/);
});

test('v2 rejects unknown SourceFragment', () => {
  const body = validBody
    .replace(':u4:f1"', ':u4:f999"')
    .replace(':u4:f1",\n  "revealed_within_unit"', ':u4:f999",\n  "revealed_within_unit"');
  const result = validate(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_fragment_id .* does not exist/);
});

test('v2 derives withheld state from SourceFragment order', () => {
  const body = validBody.replace('"has_withheld_within_unit": true', '"has_withheld_within_unit": false');
  const result = validate(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /has_withheld_within_unit must be true/);
});

test('v2 temporal_cursor must equal stable SourceFragment id', () => {
  const body = validBody.replace(
    '"temporal_cursor": "xhs:6508552c000000001303f499:legacy-r1:image-1:u4:f1"',
    '"temporal_cursor": "free-text-cursor"',
  );
  const result = validate(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /temporal_cursor must equal source_fragment_id/);
});
