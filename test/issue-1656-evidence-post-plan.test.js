'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildPlan, validatePlan, SELECTED, REQUIRED_BLOCKED } = require('../scripts/issue-1656-evidence-post-plan');
const { canonicalize, sha256 } = require('../scripts/lib/issue-1656-evidence-transition-request-plan');

const input = JSON.parse(fs.readFileSync(path.resolve('data/pilot/issue-1656/evidence-transition-request-plan.json'), 'utf8'));

test('independent review selection emits exactly 13 evidence POST rows and keeps four rows blocked', () => {
  const plan = buildPlan(input);
  assert.equal(validatePlan(plan, input).ok, true);
  assert.deepEqual(plan.scope, { source_total: 421, source_proposals: 17, selected_total: 17, evidence_post_rows: 13, blocked_rows: 4, complete: true });
  assert.deepEqual(plan.proposal_rows.map((row) => row.issue_number), [...SELECTED].sort((a, b) => a - b));
  assert.deepEqual(plan.blocked_ledger.map((row) => row.issue_number), [...REQUIRED_BLOCKED].sort((a, b) => a - b));
  assert.equal(plan.blocked_ledger.some((row) => row.issue_number === 1349), true);
});

test('every evidence body reuses transition schema and exact body/source/projection CAS facts', () => {
  const plan = buildPlan(input);
  for (const row of plan.proposal_rows) {
    assert.match(row.evidence_post.body, /issue-1608-boundary-evidence\.v1/);
    assert.match(row.evidence_post.body, new RegExp(row.transition_request.transition_id));
    assert.match(row.evidence_post.body, new RegExp(row.cas.expected_body_sha256));
    assert.match(row.evidence_post.body, new RegExp(row.cas.expected_source_revision_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(row.evidence_post.body, new RegExp(row.cas.source_projection_blob_sha));
    assert.equal(row.evidence_post.status, 'planned-not-posted');
    assert.equal(row.mutation_count, 0);
  }
  assert.equal(plan.stages.evidence_post.mutation_count, 0);
  assert.equal(plan.stages.boundary_patch.mutation_count, 0);
});

test('canonical digest is reproducible and all mutation counters remain zero', () => {
  const plan = buildPlan(input);
  const copy = { ...plan }; delete copy.canonical_digest;
  const rebuilt = buildPlan(input);
  assert.equal(plan.canonical_digest, rebuilt.canonical_digest);
  assert.equal(plan.canonical_digest, sha256(canonicalize(copy)));
  assert.deepEqual(plan.mutation_guard, { post: 0, patch: 0, label: 0, create: 0, mutation: 0, read_only: true, live_mutation: false });
});

test('scope drift or selected-row tampering fails closed', () => {
  const plan = buildPlan(input);
  const changed = JSON.parse(JSON.stringify(plan));
  changed.proposal_rows[0].cas.expected_body_sha256 = '0'.repeat(64);
  assert.equal(validatePlan(changed, input).ok, false);
  const missing = JSON.parse(JSON.stringify(input));
  missing.summary.proposal_rows = 16;
  assert.throws(() => buildPlan(missing), /complete 421\/17\/404 scope/);
});

test('swapping complete evidence bodies and recomputing the plan digest still fails marker cross-binding', () => {
  const plan = buildPlan(input);
  const changed = JSON.parse(JSON.stringify(plan));
  const first = changed.proposal_rows[0].evidence_post;
  const second = changed.proposal_rows[1].evidence_post;
  [first.body, second.body] = [second.body, first.body];
  [first.body_sha256, second.body_sha256] = [second.body_sha256, first.body_sha256];
  const { canonical_digest: ignored, ...withoutDigest } = changed;
  changed.canonical_digest = sha256(canonicalize(withoutDigest));
  const validation = validatePlan(changed, input);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join('\n'), /marker issue binding mismatch/);
});
