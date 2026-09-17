'use strict';

const { loadSourceSequenceManifests } = require('./lib/source-sequence-manifest');
const { loadSourceQuestionSets } = require('./lib/source-question');
const { loadCanonicalQuestionIndex } = require('./lib/canonical-question');

const manifests = loadSourceSequenceManifests();
if (!manifests.ok) {
  for (const e of manifests.errors) console.error(`ERROR: ${e}`);
  process.exit(1);
}
const sets = loadSourceQuestionSets(undefined, manifests.byId);
if (!sets.ok) {
  for (const e of sets.errors) console.error(`ERROR: ${e}`);
  process.exit(1);
}
const result = loadCanonicalQuestionIndex(undefined, sets.byQuestionId);
for (const e of result.errors) console.error(`ERROR: ${e}`);
if (!result.ok) process.exit(1);
const entries = result.index ? result.index.entries.length : 0;
const members = result.index ? result.index.entries.reduce((n, e) => n + e.members.length, 0) : 0;
console.log(`CanonicalQuestion index PASS: ${entries} canonical question(s), ${members} member(s)`);
