'use strict';

const fs = require('fs');
const { validateExplorationSessionHistory } = require('./lib/exploration-session-history');
const { loadSourceSequenceManifests } = require('./lib/source-sequence-manifest');
const { loadSourceSequenceReviews } = require('./lib/source-sequence-review');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: node scripts/validate-exploration-session-history.js <issue-comments.json>');
  process.exit(2);
}

let comments;
try {
  comments = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
} catch (error) {
  console.error(`failed to read history input: ${error.message}`);
  process.exit(2);
}

const manifests = loadSourceSequenceManifests();
for (const warning of manifests.warnings) console.warn(`WARN: ${warning}`);
if (!manifests.ok) {
  for (const error of manifests.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

const reviews = loadSourceSequenceReviews(undefined, { manifestsById: manifests.byId });
for (const warning of reviews.warnings) console.warn(`WARN: ${warning}`);
if (!reviews.ok) {
  for (const error of reviews.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

const result = validateExplorationSessionHistory(comments, {
  manifestsById: manifests.byId,
  effectiveReviewsByManifestDigest: reviews.effectiveByManifestDigest,
});
for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
if (!result.ok) {
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`ExplorationSession history PASS: ${result.machine_checkpoints} machine checkpoints across ${result.sessions.length} session(s)`);
