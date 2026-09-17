'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSourceSequenceManifests } = require('../scripts/lib/source-sequence-manifest');
const { validateSourceQuestionSet, loadSourceQuestionSets } = require('../scripts/lib/source-question');
const { validateCanonicalQuestionIndex, loadCanonicalQuestionIndex } = require('../scripts/lib/canonical-question');

const setPath = path.join(
  __dirname,
  '..',
  'data',
  'source-questions',
  'xhs-63ee3f2200000000130109f9.v1.json',
);
const questionSet = JSON.parse(fs.readFileSync(setPath, 'utf8'));

const manifests = loadSourceSequenceManifests();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('SourceQuestionSet validates against its pinned manifest', () => {
  const result = validateSourceQuestionSet(questionSet, manifests.byId);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(questionSet.questions.length > 0);
  assert.equal(questionSet.questions[0].raw_text.length > 0, true);
});

test('SourceQuestionSet rejects tampered raw_text', () => {
  const bad = clone(questionSet);
  bad.questions[0].raw_text = 'fabricated question text';
  bad.content_sha256 = '0'.repeat(64);
  const result = validateSourceQuestionSet(bad, manifests.byId);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('raw_text')));
});

test('SourceQuestionSet rejects unknown manifest', () => {
  const bad = clone(questionSet);
  bad.source_manifest_id = 'xhs:nonexistent:manifest';
  const result = validateSourceQuestionSet(bad, manifests.byId);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not found')));
});

test('SourceQuestion registry loads cleanly', () => {
  const result = loadSourceQuestionSets(undefined, manifests.byId);
  assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 5)));
  assert.ok(result.sets.length > 0);
});

test('CanonicalQuestion index validates with full coverage', () => {
  const sets = loadSourceQuestionSets(undefined, manifests.byId);
  const result = loadCanonicalQuestionIndex(undefined, sets.byQuestionId);
  assert.equal(result.ok, true, JSON.stringify(result.errors.slice(0, 5)));
  assert.ok(result.index.entries.length > 0);
});

test('CanonicalQuestion index rejects member assigned to two canonicals', () => {
  const sets = loadSourceQuestionSets(undefined, manifests.byId);
  const good = loadCanonicalQuestionIndex(undefined, sets.byQuestionId);
  const bad = clone(good.index);
  bad.entries[1].members.push(clone(bad.entries[0].members[0]));
  bad.entries[1].member_count = bad.entries[1].members.length;
  bad.content_sha256 = '0'.repeat(64);
  const result = validateCanonicalQuestionIndex(bad, sets.byQuestionId);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('already claimed')));
});
