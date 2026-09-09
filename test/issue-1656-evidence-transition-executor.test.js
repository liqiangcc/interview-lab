'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  run,
  authorizationGate,
  freshGetCas,
} = require('../scripts/issue-1656-evidence-transition-executor');

const plan = JSON.parse(fs.readFileSync(path.resolve('data/pilot/issue-1656/evidence-transition-request-plan.json'), 'utf8'));
const live = JSON.parse(fs.readFileSync(path.resolve('data/pilot/issue-1611/source-note-live.snapshot.json'), 'utf8'));
const liveByNumber = new Map(live.issues.map((issue) => [Number(issue.number), issue]));

test('default execution is plan-only with the complete 17/404 partition and zero writes', () => {
  const result = run({ plan });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'plan-only');
  assert.deepEqual(result.counts, { total: 421, proposal: 17, blocked: 404, execution_batch: 0 });
  assert.deepEqual(result.write_operations, { post: 0, patch: 0, label: 0, create: 0, mutation: 0 });
  assert.equal(result.execution.live_writer_implemented, false);
  assert.equal(result.lock.acquired, false);
  assert.equal(result.journal.status, 'not-started');
  assert.equal(result.blocked_ledger.some((row) => row.issue_number === 735), true);
  assert.equal(result.proposal_rows.some((row) => row.issue_number === 735), false);
});

test('apply gate requires all three exact authorization environment values', () => {
  assert.throws(() => run({ plan, apply: true, env: {} }), /AUTHORIZATION_COMMENT_ID/);
  assert.equal(authorizationGate({ AUTHORIZATION_COMMENT_ID: '123', PLAN_DIGEST: plan.canonical_digest, CONFIRM_DIGEST: plan.canonical_digest }, plan.canonical_digest).ok, true);
  assert.equal(authorizationGate({ AUTHORIZATION_COMMENT_ID: '123', PLAN_DIGEST: '0'.repeat(64), CONFIRM_DIGEST: plan.canonical_digest }, plan.canonical_digest).ok, false);
});

test('gated apply performs only fresh GET/CAS validation and preserves all 17 proposal rows', () => {
  let issueReads = 0;
  let commentReads = 0;
  const result = run({
    plan,
    apply: true,
    env: { AUTHORIZATION_COMMENT_ID: '123', PLAN_DIGEST: plan.canonical_digest, CONFIRM_DIGEST: plan.canonical_digest },
    reader: {
      readIssue(number) { issueReads += 1; return liveByNumber.get(number); },
      readComments() { commentReads += 1; return []; },
    },
  });
  assert.equal(issueReads, 17);
  assert.equal(commentReads, 17);
  assert.equal(result.apply_entered, true);
  assert.equal(result.mode, 'apply-gated-fresh-get-cas-only');
  assert.equal(result.counts.proposal, 17);
  assert.equal(result.counts.blocked, 404);
  assert.equal(result.counts.execution_batch, 17);
  assert.deepEqual(result.write_operations, { post: 0, patch: 0, label: 0, create: 0, mutation: 0 });
  assert.equal(result.execution.evidence_stage, 'not-executed');
  assert.equal(result.execution.boundary_stage, 'not-executed');
});

test('fresh CAS drift blocks only the proposal row while retaining the 17-row scope', () => {
  const first = plan.proposal_rows[0];
  const result = freshGetCas(plan, {
    readIssue(number) { const issue = liveByNumber.get(number); return number === first.issue_number ? { ...issue, body: `${issue.body}\nDRIFT` } : issue; },
    readComments() { return []; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.items.length, 17);
  assert.equal(result.items.filter((item) => item.ok).length, 16);
  assert.match(result.items.find((item) => item.issue_number === first.issue_number).errors.join('; '), /body SHA mismatch/);
});

test('executor source contains no GitHub mutation command', () => {
  const source = fs.readFileSync(path.resolve('scripts/issue-1656-evidence-transition-executor.js'), 'utf8');
  assert.doesNotMatch(source, /gh[^\n]*(POST|PATCH)/i);
});
