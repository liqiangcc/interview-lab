'use strict';

const path = require('path');
const { loadSourceSequenceManifests } = require('./lib/source-sequence-manifest');
const { loadSourceQuestionSets } = require('./lib/source-question');

const manifests = loadSourceSequenceManifests();
if (!manifests.ok) {
  for (const e of manifests.errors) console.error(`ERROR: ${e}`);
  process.exit(1);
}
const result = loadSourceQuestionSets(undefined, manifests.byId);
for (const e of result.errors) console.error(`ERROR: ${e}`);
if (!result.ok) process.exit(1);

const total = result.sets.reduce((n, s) => n + s.questions.length, 0);
console.log(`SourceQuestion registry PASS: ${result.sets.length} set(s), ${total} question(s)`);
