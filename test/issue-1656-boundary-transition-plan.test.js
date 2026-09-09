'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const input = JSON.parse(fs.readFileSync('data/pilot/issue-1656/evidence-post-plan.json', 'utf8'));
const {
  buildPlan,
  validatePlan,
  parseArgs,
} = require('../scripts/issue-1656-boundary-transition-plan');

function fixtureReader() {
  const issueByNumber = new Map();
  const commentsByNumber = new Map();
  const live = JSON.parse(fs.readFileSync('data/pilot/issue-1611/source-note-live.snapshot.json', 'utf8'));
  for (const issue of live.issues) issueByNumber.set(Number(issue.number), issue);
  for (const row of input.proposal_rows) {
    commentsByNumber.set(row.issue_number, [{ id: 900000 + row.issue_number, created_at: '2026-09-09T01:02:03Z', body: row.evidence_post.body }]);
  }
  return { readIssue: (number) => issueByNumber.get(number), readComments: (number) => commentsByNumber.get(number) };
}

test('real input and 13 synthetic GET results produce 13 eligible and 4 blocked', () => {
  const plan = buildPlan(input, fixtureReader(), '2026-09-09T02:03:04.000Z');
  assert.equal(plan.scope.eligible_rows, 13);
  assert.equal(plan.scope.blocked_rows, 4);
  assert.equal(plan.summary.target_errors, 0);
  assert.equal(plan.mutation_guard.post, 0);
  assert.equal(plan.mutation_guard.patch, 0);
  assert.equal(plan.mutation_guard.label, 0);
  assert.equal(plan.mutation_guard.materialization, 0);
  assert.equal(plan.mutation_guard.mutation, 0);
  assert.equal(validatePlan(plan, input).ok, true);
  for (const row of plan.proposal_rows) {
    assert.equal(row.status, 'eligible');
    assert.match(row.next_body_sha256, /^[0-9a-f]{64}$/);
    assert.ok(row.evidence_comment_id > 0);
  }
});

test('tampered evidence marker is fail-closed and never becomes eligible', () => {
  const reader = fixtureReader();
  const original = reader.readComments(1309)[0];
  reader.readComments = (number) => number === 1309 ? [{ ...original, body: original.body.replace('"issue_number": 1309', '"issue_number": 1310') }] : fixtureReader().readComments(number);
  const plan = buildPlan(input, reader, '2026-09-09T02:03:04.000Z');
  const row = plan.proposal_rows.find((item) => item.issue_number === 1309);
  assert.equal(row.eligible, false);
  assert.match(row.errors.join('; '), /evidence marker|evidence comment SHA/);
});

test('missing or duplicated evidence comments are fail-closed', () => {
  const base = fixtureReader();
  const missing = { readIssue: base.readIssue, readComments: (number) => number === 1325 ? [] : base.readComments(number) };
  const missingPlan = buildPlan(input, missing, '2026-09-09T02:03:04.000Z');
  assert.equal(missingPlan.proposal_rows.find((row) => row.issue_number === 1325).eligible, false);
  const duplicate = { readIssue: base.readIssue, readComments: (number) => number === 1333 ? [...base.readComments(number), ...base.readComments(number)] : base.readComments(number) };
  const duplicatePlan = buildPlan(input, duplicate, '2026-09-09T02:03:04.000Z');
  assert.equal(duplicatePlan.proposal_rows.find((row) => row.issue_number === 1333).eligible, false);
});

test('writer-shaped CLI flags are rejected before any reader is called', () => {
  assert.throws(() => parseArgs(['--apply']), /write operation is forbidden/);
  assert.throws(() => parseArgs(['--label', 'boundary:single-interview']), /write operation is forbidden/);
});
