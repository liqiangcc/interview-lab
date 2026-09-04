'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateInterviewContext,
  buildLearningDiscovery,
  deriveLearningLabels,
  buildNonSpoilerTitle,
} = require('../scripts/lib/interview-context');
const {
  validateSourceSequenceManifest,
  loadSourceSequenceManifests,
} = require('../scripts/lib/source-sequence-manifest');
const { validateExplorationSessionCheckpoint } = require('../scripts/lib/exploration-session-checkpoint');
const { reviewKey } = require('../scripts/lib/source-sequence-review');

const contextPath = path.join(__dirname, '..', 'data', 'interview-contexts', 'xhs-6a8abe2d000000001602b26e.v1.json');
const manifestPath = path.join(__dirname, '..', 'data', 'source-sequences', 'xhs-6a8abe2d000000001602b26e-r1-readable-16.v1.json');
const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const checkpointBody = fs.readFileSync(path.join(__dirname, 'fixtures', 'exploration-session-checkpoint-xhs-6a8abe2d.v3.valid.md'), 'utf8');
const review = {
  schema_version: 'source-sequence-review.v1',
  review_id: 'xhs:6a8abe2d000000001602b26e:r1:readable-16:sequence-v1:review-1',
  manifest_id: manifest.manifest_id,
  manifest_sha256: manifest.content_sha256,
  decision: 'approved',
  reviewed_at: '2026-09-04T12:05:00Z',
  reviewer_kind: 'ai-assisted',
  review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 930, comment_id: 1 },
  checks: [
    { check_id: 'evidence_stream_binding', result: 'pass' },
    { check_id: 'sequence_scope', result: 'pass' },
    { check_id: 'unit_boundaries', result: 'pass' },
    { check_id: 'unit_order', result: 'pass' },
    { check_id: 'unit_types', result: 'pass' },
    { check_id: 'fragment_boundaries', result: 'pass' },
    { check_id: 'fragment_order', result: 'pass' },
    { check_id: 'no_fabrication', result: 'pass' },
  ],
  limitations: ['This test review covers only the exact manifest digest.'],
  supersedes_review_id: null,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('#930 reviewed InterviewContext is fail-closed about unknown facts and seals outcome', () => {
  const result = validateInterviewContext(context);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(context.company.id, 'ctrip');
  assert.equal(context.company.basis, 'source-explicit');
  assert.equal(context.role.family, 'backend');
  assert.equal(context.role.basis, 'reviewed-inference');
  assert.equal(context.recruitment_type.value, 'unknown');
  assert.equal(context.recruitment_type.basis, 'unknown');
  assert.equal(context.interview_occurred_at.precision, 'unknown');
  assert.equal(context.interview_occurred_at.basis, 'unknown');
  assert.equal(context.outcome_visibility, 'sealed-until-source-reveal');
  assert.deepEqual(deriveLearningLabels(context), {
    ok: true,
    errors: [],
    labels: ['company:ctrip', 'role:backend', 'round:1'],
  });
});

test('#930 discovery projection is non-spoiler and omits unknown recruitment/time labels', () => {
  const result = buildLearningDiscovery(context);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.non_spoiler_title, '[携程] 后端 · 一面 · 6a8abe2d');
  assert.deepEqual(result.learning_labels, ['company:ctrip', 'role:backend', 'round:1']);
  assert.equal(result.pre_learning_display.outcome, 'sealed');
  assert.equal(result.pre_learning_display.recruitment_type, null);
  assert.equal(result.pre_learning_display.interview_occurred_at, null);
  assert.doesNotMatch(result.non_spoiler_title, /失败|拒绝|未通过|凉|offer/i);
});

test('#930 runtime SourceSequence has exactly 16 numbered source projections with per-unit provenance', () => {
  const result = validateSourceSequenceManifest(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(manifest.schema_version, 'source-sequence-manifest.v1');
  assert.equal(manifest.units.length, 16);
  assert.equal(manifest.evidence_stream.storage_kind, 'runtime-artifact-store');
  assert.equal(manifest.evidence_stream.raw_git_blob_sha, null);
  assert.equal(manifest.evidence_stream.readable_projection.provenance, 'source_projection');
  assert.equal(manifest.evidence_stream.readable_projection.git_blob_sha, null);
  assert.deepEqual(manifest.units.map((unit) => unit.position), Array.from({ length: 16 }, (_, index) => index + 1));
  assert.equal(manifest.units.every((unit) => unit.source_provenance.source_projection_item_number === unit.position), true);
  assert.equal(manifest.units.every((unit) => unit.source_provenance.source_projection_sha256 === 'c6789631aec3d6cea2074c7b1f15c6ee61171c367d9e3da2bc3726ae9cdae2cc'), true);
  assert.equal(manifest.units.every((unit) => unit.source_provenance.raw_sha256 === 'b297c15953d41ed4a6080c791b2cab95360d5e053079da4af357d6920ca9606c'), true);
  assert.equal(manifest.units[0].text_projection, '1、自我介绍，并简单介绍一下你最熟悉的项目经历。');
  assert.equal(manifest.units[15].text_projection, '16、设计一个系统，统计全国 14 亿人的收入总和。其中，系统在 1 月 1 日上午 8 点同时开放，大量用户会在同一时间提交自己的收入信息，应该如何设计系统架构？');
});

test('legacy Git manifests remain valid without runtime storage metadata', () => {
  const registry = loadSourceSequenceManifests(path.join(__dirname, '..', 'data', 'source-sequences'));
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));
  const legacy = registry.byId.get('xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1');
  assert.match(legacy.evidence_stream.raw_git_blob_sha, /^[0-9a-f]{40}$/);
  assert.equal(legacy.evidence_stream.storage_kind, undefined);
  assert.equal(legacy.evidence_stream.readable_projection.provenance, 'derived');
});

test('runtime Raw identity cannot use a guessed Git SHA or omit runtime storage kind', () => {
  const value = clone(manifest);
  delete value.evidence_stream.storage_kind;
  const result = validateSourceSequenceManifest(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /raw_git_blob_sha=null requires storage_kind=runtime-artifact-store/);
});

test('runtime readable projection must retain source_projection provenance', () => {
  const value = clone(manifest);
  value.evidence_stream.readable_projection.provenance = 'derived';
  const result = validateSourceSequenceManifest(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /runtime readable_projection\.provenance must be source_projection/);
});

test('#930 v3 checkpoint pins the exact review digest and reveals only SourceUnit 1', () => {
  const manifests = new Map([[manifest.manifest_id, manifest]]);
  const reviews = new Map([[review.review_id, review]]);
  const effective = new Map([[reviewKey(manifest.manifest_id, manifest.content_sha256), review]]);
  const result = validateExplorationSessionCheckpoint(checkpointBody, {
    manifestsById: manifests,
    reviewsById: reviews,
    effectiveReviewsByManifestDigest: effective,
    requireCurrentApproval: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.record.revealed_position, 1);
  assert.equal(result.record.source_unit_id, manifest.units[0].source_unit_id);
  assert.equal(result.record.current_source_unit, manifest.units[0].text_projection);
  assert.equal(result.record.source_review_id, review.review_id);
});

test('#930 v3 checkpoint rejects a future SourceUnit in the first reveal', () => {
  const manifests = new Map([[manifest.manifest_id, manifest]]);
  const reviews = new Map([[review.review_id, review]]);
  const effective = new Map([[reviewKey(manifest.manifest_id, manifest.content_sha256), review]]);
  const future = checkpointBody.replace(manifest.units[0].text_projection, manifest.units[1].text_projection);
  const result = validateExplorationSessionCheckpoint(future, {
    manifestsById: manifests,
    reviewsById: reviews,
    effectiveReviewsByManifestDigest: effective,
    requireCurrentApproval: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /current_source_unit must equal manifest SourceUnit text_projection/);
});
