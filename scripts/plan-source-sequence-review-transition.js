'use strict';

const fs = require('fs');
const { loadSourceSequenceManifests } = require('./lib/source-sequence-manifest');
const { loadSourceSequenceReviews } = require('./lib/source-sequence-review');
const {
  parseSourceSequenceReviewTransition,
  planSourceSequenceReviewTransition,
} = require('./lib/source-sequence-review-transition');
const { analyzeSourceSequenceReviewImpact } = require('./lib/source-sequence-review-impact');

const requestPath = process.argv[2];
const commentsPath = process.argv[3] || null;
if (!requestPath) {
  console.error('usage: node scripts/plan-source-sequence-review-transition.js <transition-comment.md> [issue-comments.json]');
  process.exit(2);
}

const manifests = loadSourceSequenceManifests();
if (!manifests.ok) {
  for (const error of manifests.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}
const reviews = loadSourceSequenceReviews(undefined, { manifestsById: manifests.byId });
if (!reviews.ok) {
  for (const error of reviews.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

const parsed = parseSourceSequenceReviewTransition(fs.readFileSync(requestPath, 'utf8'));
if (!parsed.request) {
  for (const error of parsed.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}
const plan = planSourceSequenceReviewTransition(parsed.request, {
  manifestsById: manifests.byId,
  reviewsById: reviews.byId,
  effectiveReviewsByManifestDigest: reviews.effectiveByManifestDigest,
});
if (!plan.ok) {
  for (const error of plan.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

let impact = null;
if (commentsPath) {
  let comments;
  try {
    comments = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
  } catch (error) {
    console.error(`ERROR: failed to read comments: ${error.message}`);
    process.exit(2);
  }
  impact = analyzeSourceSequenceReviewImpact(comments, {
    manifestId: plan.review.manifest_id,
    manifestSha256: plan.review.manifest_sha256,
    effectiveReview: plan.review,
  });
  if (!impact.ok) {
    for (const error of impact.errors) console.error(`ERROR: ${error}`);
    process.exit(1);
  }
}

console.log(JSON.stringify({
  ok: true,
  transition_id: parsed.request.transition_id,
  previous_effective_review_id: plan.previous_effective_review_id,
  proposed_review: plan.review,
  predicted_impact: impact,
}, null, 2));
