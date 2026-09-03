'use strict';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExplorationSessionHistory } = require('../scripts/lib/exploration-session-history');
const { loadSourceSequenceManifests } = require('../scripts/lib/source-sequence-manifest');

const manifests = loadSourceSequenceManifests(path.join(__dirname, '..', 'data', 'source-sequences'));
const manifestId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:sequence-v1';
const unitId = 'xhs:6508552c000000001303f499:legacy-r1:image-1:u4';
const unitText = '4.一个http请求和它使用的tcp连接对应什么关系（想问长连接和多路复用 然后又深挖了多路复用原理)';

function record(fragmentNumber, phase = 'literal') {
  const fragmentId = `xhs:6508552c000000001303f499:legacy-r1:image-1:u4:f${fragmentNumber}`;
  return {
    schema_version: 'exploration-session-checkpoint.v2',
    session_id: 'manifest-history-v2-test',
    target_type: 'InterviewNote',
    target_id: 'xhs:6508552c000000001303f499',
    mode: 'learning',
    source_revision_id: 'xhs:6508552c000000001303f499:legacy-r1',
    source_manifest_id: manifestId,
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
  };
}

function comment(id, value) {
  return {
    id,
    created_at: `2026-09-03T08:${String(id).padStart(2, '0')}:00Z`,
    updated_at: `2026-09-03T08:${String(id).padStart(2, '0')}:00Z`,
    body: `## ExplorationSession checkpoint\n\n<!-- exploration-session-checkpoint\n${JSON.stringify(value, null, 2)}\n-->`,
  };
}

test('v2 SourceFragment frontier advances by manifest order', () => {
  const comments = [
    comment(1, record(1, 'literal')),
    comment(2, record(2, 'classification')),
    comment(3, record(3, 'knowledge')),
  ];
  const result = validateExplorationSessionHistory(comments, { manifestsById: manifests.byId });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('v2 SourceFragment frontier cannot regress by manifest order', () => {
  const comments = [
    comment(1, record(2, 'literal')),
    comment(2, record(1, 'classification')),
  ];
  const result = validateExplorationSessionHistory(comments, { manifestsById: manifests.byId });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_fragment_id regressed from manifest order 2 to 1/);
});

test('v2 session cannot silently switch SourceSequenceManifest', () => {
  const second = record(2, 'classification');
  second.source_manifest_id = 'other-manifest';
  const comments = [comment(1, record(1, 'literal')), comment(2, second)];
  const result = validateExplorationSessionHistory(comments, { manifestsById: manifests.byId });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_manifest_id .* does not resolve|source_manifest_id changed within session/);
});
