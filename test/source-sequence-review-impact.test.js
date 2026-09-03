'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeSourceSequenceReviewImpact } = require('../scripts/lib/source-sequence-review-impact');

const manifestId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1';
const manifestSha = '829b246ad8d21610c28b22f5ccb60309806a61fe9f1eb7b14af5d870bc795aad';
const review1 = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-1';
const review2 = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1:review-2';

function checkpoint(sessionId, schemaVersion, sessionStatus, reviewId, id) {
  const record = {
    schema_version: schemaVersion,
    session_id: sessionId,
    target_type: 'InterviewNote',
    target_id: 'xhs:6508552c000000001303f499',
    mode: 'source-analysis',
    source_revision_id: 'xhs:6508552c000000001303f499:legacy-r1',
    source_manifest_id: manifestId,
    source_manifest_sha256: manifestSha,
    source_unit_id: 'xhs:6508552c000000001303f499:legacy-r1:image-1:u7',
    source_fragment_id: null,
    revealed_position: 7,
    revealed_range: '7..7',
    current_source_unit: '无手撕，面完就感觉要寄，果不其然，当晚就挂了',
    source_unit_type: 'outcome-reflection-summary',
    loop_phase: sessionStatus === 'completed' ? 'closure' : 'literal',
    has_withheld_within_unit: false,
    position_status: sessionStatus === 'completed' ? 'complete' : 'active',
    session_status: sessionStatus,
    closure_reason: sessionStatus === 'completed' ? 'fixture complete' : null,
    completed_at: sessionStatus === 'completed' ? '2026-09-03T09:00:00Z' : null,
  };
  if (schemaVersion === 'exploration-session-checkpoint.v3') record.source_review_id = reviewId;
  return {
    id,
    created_at: `2026-09-03T09:${String(id).padStart(2, '0')}:00Z`,
    body: `## ExplorationSession checkpoint\n\n<!-- exploration-session-checkpoint\n${JSON.stringify(record, null, 2)}\n-->`,
  };
}

function fixtureComments() {
  return [
    checkpoint('v3-active', 'exploration-session-checkpoint.v3', 'active', review1, 1),
    checkpoint('v3-completed', 'exploration-session-checkpoint.v3', 'completed', review1, 2),
    checkpoint('v2-active', 'exploration-session-checkpoint.v2', 'active', null, 3),
    checkpoint('v2-completed', 'exploration-session-checkpoint.v2', 'completed', null, 4),
  ];
}

test('current approved review keeps matching active v3 session current', () => {
  const result = analyzeSourceSequenceReviewImpact(fixtureComments(), {
    manifestId,
    manifestSha256: manifestSha,
    effectiveReview: { review_id: review1, decision: 'approved' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.active_current, 1);
  assert.equal(result.summary.active_stale, 0);
  assert.equal(result.summary.legacy_active_unpinned, 1);
});

test('proposed approved successor makes old active v3 stale without invalidating completed history', () => {
  const result = analyzeSourceSequenceReviewImpact(fixtureComments(), {
    manifestId,
    manifestSha256: manifestSha,
    effectiveReview: { review_id: review2, decision: 'approved' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.active_stale, 1);
  assert.equal(result.summary.historical_superseded, 1);
  assert.equal(result.summary.legacy_active_unpinned, 1);
  assert.equal(result.summary.legacy_historical_unpinned, 1);
  assert.equal(result.summary.blocking_sessions, 1);
});

test('proposed rejection blocks active v3 and legacy v2 continuation', () => {
  const result = analyzeSourceSequenceReviewImpact(fixtureComments(), {
    manifestId,
    manifestSha256: manifestSha,
    effectiveReview: { review_id: review2, decision: 'rejected' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.summary.active_stale, 1);
  assert.equal(result.summary.legacy_active_blocked, 1);
  assert.equal(result.summary.blocking_sessions, 2);
});
