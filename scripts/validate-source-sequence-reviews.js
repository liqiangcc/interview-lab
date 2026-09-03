'use strict';

const { loadSourceSequenceManifests } = require('./lib/source-sequence-manifest');
const { loadSourceSequenceReviews } = require('./lib/source-sequence-review');

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

const approved = [...reviews.effectiveByManifestDigest.values()].filter((review) => review.decision === 'approved').length;
console.log(`SourceSequenceReview registry PASS: ${reviews.reviews.length} review(s), ${approved} effective approval(s)`);
