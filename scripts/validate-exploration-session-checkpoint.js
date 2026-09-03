'use strict';

const fs = require('fs');
const { validateExplorationSessionCheckpoint } = require('./lib/exploration-session-checkpoint');
const { loadSourceSequenceManifests } = require('./lib/source-sequence-manifest');
const { loadSourceSequenceReviews } = require('./lib/source-sequence-review');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/validate-exploration-session-checkpoint.js <comment-markdown-file>');
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

const body = fs.readFileSync(file, 'utf8');
const result = validateExplorationSessionCheckpoint(body, {
  manifestsById: manifests.byId,
  reviewsById: reviews.byId,
  effectiveReviewsByManifestDigest: reviews.effectiveByManifestDigest,
  requireCurrentApproval: true,
});

for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
if (!result.ok) {
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`PASS: ${result.record.schema_version} ${result.record.session_id} position=${result.record.revealed_position} phase=${result.record.loop_phase}`);
