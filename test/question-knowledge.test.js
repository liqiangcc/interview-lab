'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSourceSequenceManifests } = require('../scripts/lib/source-sequence-manifest');
const { loadSourceQuestionSets } = require('../scripts/lib/source-question');
const { loadCanonicalQuestionIndex } = require('../scripts/lib/canonical-question');
const {
  loadKnowledgeRecords,
  validateAnalysis,
  validateAnswer,
  loadCanonicalById,
} = require('../scripts/lib/question-knowledge');

const manifests = loadSourceSequenceManifests();
const sets = loadSourceQuestionSets(undefined, manifests.byId);
const index = loadCanonicalQuestionIndex(undefined, sets.byQuestionId);
const canonicalById = loadCanonicalById(index.index);
const indexSha = index.index.content_sha256;

const analysisDir = path.join(__dirname, '..', 'data', 'analysis');
const answerDir = path.join(__dirname, '..', 'data', 'answers');

const analyses = loadKnowledgeRecords(analysisDir, validateAnalysis, 'analysis_id', canonicalById, indexSha);
const answers = loadKnowledgeRecords(answerDir, validateAnswer, 'answer_id', canonicalById, indexSha);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const sampleAnalysis = JSON.parse(
  fs.readFileSync(path.join(analysisDir, 'cq-ca345205e08acc4e.v1.json'), 'utf8'));
const sampleAnswer = JSON.parse(
  fs.readFileSync(path.join(answerDir, 'cq-ca345205e08acc4e.v1.json'), 'utf8'));

test('Analysis/Answer registries load cleanly', () => {
  assert.equal(analyses.ok, true, JSON.stringify(analyses.errors));
  assert.equal(answers.ok, true, JSON.stringify(answers.errors));
  assert.ok(analyses.records.length > 0);
  assert.equal(analyses.records.length, answers.records.length);
});

test('Analysis rejects unknown canonical reference', () => {
  const bad = clone(sampleAnalysis);
  bad.canonical_question_id = 'cq:does-not-exist';
  const result = validateAnalysis(bad, canonicalById, indexSha);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('not found')));
});

test('Analysis rejects question_text that diverges from canonical_text', () => {
  const bad = clone(sampleAnalysis);
  bad.question_text = 'rewritten question text';
  const result = validateAnalysis(bad, canonicalById, indexSha);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('verbatim')));
});

test('Analysis rejects tampered content', () => {
  const bad = clone(sampleAnalysis);
  bad.mechanism = 'tampered mechanism';
  const result = validateAnalysis(bad, canonicalById, indexSha);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('content_sha256 mismatch')));
});

test('Analysis rejects invalid question_kind', () => {
  const bad = clone(sampleAnalysis);
  bad.question_kind = 'trivia';
  const result = validateAnalysis(bad, canonicalById, indexSha);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('question_kind')));
});

test('Answer rejects empty skeleton and mismatched index pin', () => {
  const bad = clone(sampleAnswer);
  bad.skeleton = [];
  bad.canonical_index_sha256 = '0'.repeat(64);
  const result = validateAnswer(bad, canonicalById, indexSha);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('skeleton')));
  assert.ok(result.errors.some((e) => e.includes('canonical_index_sha256')));
});
