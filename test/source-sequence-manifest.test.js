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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('Pilot 3 SourceSequenceManifest validates', () => {
  const result = validateSourceSequenceManifest(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(manifest.units.length, 7);
  assert.equal(manifest.units[3].fragments.length, 3);
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

test('manifest registry loads unique manifest identity', () => {
  const registry = loadSourceSequenceManifests(path.dirname(manifestPath));
  assert.equal(registry.ok, true, JSON.stringify(registry.errors));
  assert.equal(registry.byId.has(manifest.manifest_id), true);
});
