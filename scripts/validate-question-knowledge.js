'use strict';

const path = require('path');
const { loadCanonicalQuestionIndex } = require('./lib/canonical-question');
const { loadSourceQuestionSets } = require('./lib/source-question');
const { loadSourceSequenceManifests } = require('./lib/source-sequence-manifest');
const { loadKnowledgeRecords, validateAnalysis, validateAnswer, loadCanonicalById } = require('./lib/question-knowledge');

const manifests = loadSourceSequenceManifests();
const sets = loadSourceQuestionSets(undefined, manifests.byId);
const index = loadCanonicalQuestionIndex(undefined, sets.byQuestionId);
for (const e of [...manifests.errors, ...sets.errors, ...index.errors]) console.error(`ERROR: ${e}`);
if (!manifests.ok || !sets.ok || !index.ok) process.exit(1);

const canonicalById = loadCanonicalById(index.index);
const indexSha = index.index ? index.index.content_sha256 : null;

const analyses = loadKnowledgeRecords(
  path.join(process.cwd(), 'data', 'analysis'),
  validateAnalysis, 'analysis_id', canonicalById, indexSha);
const answers = loadKnowledgeRecords(
  path.join(process.cwd(), 'data', 'answers'),
  validateAnswer, 'answer_id', canonicalById, indexSha);

for (const e of [...analyses.errors, ...answers.errors]) console.error(`ERROR: ${e}`);
if (!analyses.ok || !answers.ok) process.exit(1);
console.log(`Question knowledge PASS: ${analyses.records.length} analysis record(s), ${answers.records.length} answer record(s)`);
