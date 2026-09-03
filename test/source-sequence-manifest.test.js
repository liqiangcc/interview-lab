'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSourceSequenceManifest,
  loadSourceSequenceManifests,
} = require('../scripts/lib/source-sequence-manifest');

const manifestPath = path.join(
  __dirname,
  '..',
  'data',
  'source-sequences',
  'xhs-6508552c000000001303f499-legacy-r1-image-1.v1.json',
);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const pilot4ManifestPath = path.join(
  __dirname,
  '..',
  'data',
  'source-sequences',
  'xhs-656861da000000000f024258-recovered-r2-note-desc-interview-learning-v1.json',
);
const pilot4Manifest = JSON.parse(fs.readFileSync(pilot4ManifestPath, 'utf8'));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Pilot 3 SourceSequenceManifest validates', () => {
  const result = validateSourceSequenceManifest(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(manifest.units.length, 7);
  assert.equal(manifest.units[3].fragments.length, 3);
});

test('Pilot 4 interview-learning SourceSequenceManifest validates without fabricating missing technical questions', () => {
  const result = validateSourceSequenceManifest(pilot4Manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(pilot4Manifest.source_revision_id, 'xhs:656861da000000000f024258:recovered-r2');
  assert.equal(pilot4Manifest.sequence_scope, 'interview-learning-narrative:note-desc-lines-5-10');
  assert.equal(pilot4Manifest.units.length, 6);
  assert.deepEqual(pilot4Manifest.units.map((unit) => unit.source_unit_type), [
    'stage-summary',
    'stage-summary',
    'stage-summary',
    'question-like',
    'stage-summary',
    'outcome-reflection-summary',
  ]);
  assert.equal(pilot4Manifest.units[3].fragments.length, 2);
  assert.deepEqual(pilot4Manifest.units[3].fragments.map((fragment) => fragment.text_projection), [
    '薪资要求',
    '你要问他什么问题',
  ]);
  assert.equal(pilot4Manifest.units.slice(0, 5).some((unit) => unit.source_unit_type === 'outcome-reflection-summary'), false);
  assert.equal(pilot4Manifest.units[5].source_unit_type, 'outcome-reflection-summary');
});

test('SourceUnit positions must be contiguous 1..N', () => {
  const value = clone(manifest);
  value.units[4].position = 6;
  const result = validateSourceSequenceManifest(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /position must form contiguous 1\.\.N order/);
});

test('SourceUnit ids must be unique', () => {
  const value = clone(manifest);
  value.units[1].source_unit_id = value.units[0].source_unit_id;
  const result = validateSourceSequenceManifest(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_unit_id must be unique/);
});

test('SourceFragment order must be contiguous', () => {
  const value = clone(manifest);
  value.units[3].fragments[1].order = 3;
  const result = validateSourceSequenceManifest(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /order must form contiguous 1\.\.N order/);
});

test('SourceFragment text must occur in parent unit in order', () => {
  const value = clone(manifest);
  value.units[3].fragments[1].text_projection = '不存在的片段';
  const result = validateSourceSequenceManifest(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must occur within the parent unit text_projection/);
});

test('readable projection remains Derived', () => {
  const value = clone(manifest);
  value.evidence_stream.readable_projection.provenance = 'raw';
  const result = validateSourceSequenceManifest(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /provenance must remain derived/);
});

test('manifest registry loads unique manifest identities for both real Pilots', () => {
  const registry = loadSourceSequenceManifests(path.dirname(manifestPath));
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));
  assert.equal(registry.byId.has(manifest.manifest_id), true);
  assert.equal(registry.byId.has(pilot4Manifest.manifest_id), true);
});
