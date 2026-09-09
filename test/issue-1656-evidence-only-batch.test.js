'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canonicalize, sha256 } = require('../scripts/lib/issue-1656-evidence-transition-request-plan');
const {
  AUTH_SCHEMA,
  AUTH_MARKER,
  authorizationDigest,
  validateAuthorization,
  validateFreshRow,
  freshGetBatch,
  initialJournal,
  validateJournal,
  applyEvidenceBatch,
  buildPlanOnly,
} = require('../scripts/lib/issue-1656-evidence-only-batch');

const plan = JSON.parse(fs.readFileSync(path.resolve('data/pilot/issue-1656/evidence-post-plan.json'), 'utf8'));
const liveSnapshot = JSON.parse(fs.readFileSync(path.resolve('data/pilot/issue-1611/source-note-live.snapshot.json'), 'utf8'));
const liveByNumber = new Map(liveSnapshot.issues.map((issue) => [Number(issue.number), issue]));

function authComment(overrides = {}) {
  const value = {
    schema_version: AUTH_SCHEMA,
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1611,
    controller_issue: 1656,
    boundary_parent_issue: 1605,
    action: 'authorize-evidence-post-only',
    allow_evidence_post: true,
    allow_boundary_patch: false,
    allow_labels: false,
    allow_materialization: false,
    comment_id: 7001,
    authorized_by: 'fixture-reviewer',
    authorized_at: '2026-09-09T00:00:00Z',
    plan_digest: plan.canonical_digest,
    max_mutations: 13,
    ...overrides,
  };
  value.authorization_sha256 = authorizationDigest(value);
  return { id: value.comment_id, body: `<!-- ${AUTH_MARKER}\n${JSON.stringify(value, null, 2)}\n-->` };
}

function fakeApi({ responseLoss = false, commentsByIssue = new Map() } = {}) {
  const reads = [];
  const posts = [];
  return {
    reads,
    posts,
    readIssue(number) { reads.push(['issue', number]); return liveByNumber.get(Number(number)); },
    readComments(number) { reads.push(['comments', number]); return commentsByIssue.get(Number(number)) || []; },
    postEvidenceComment(number, body) {
      posts.push(number);
      const comments = commentsByIssue.get(Number(number)) || [];
      comments.push({ id: 9000 + Number(number), body });
      commentsByIssue.set(Number(number), comments);
      if (responseLoss) throw new Error('simulated response loss after server acceptance');
      return { id: 9000 + Number(number), body };
    },
  };
}

function runApply(api, auth = authComment(), overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-evidence-only-'));
  try {
    return applyEvidenceBatch({
      plan,
      api,
      authorizationComment: auth,
      authorization: { authorization_comment_id: auth.id, plan_digest: plan.canonical_digest, confirm_digest: plan.canonical_digest, max_mutations: 13 },
      dryRunDigest: plan.canonical_digest,
      journalFile: path.join(directory, 'journal.json'),
      lockFile: path.join(directory, 'lock'),
      now: () => '2026-09-09T00:00:00Z',
      ...overrides,
    });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('evidence-only apply reads and writes only the 13 released rows, never the four blocked rows', () => {
  const api = fakeApi();
  const result = runApply(api);
  assert.equal(result.ok, true);
  assert.equal(result.counts.proposal, 13);
  assert.equal(result.counts.blocked, 4);
  assert.equal(api.posts.length, 13);
  assert.equal(api.reads.some(([, number]) => [972, 1266, 1326, 1349].includes(Number(number))), false);
  assert.equal(result.write_operations.patch, 0);
  assert.equal(result.write_operations.label, 0);
});

test('duplicate evidence marker is not idempotent and fails closed', () => {
  const row = plan.proposal_rows[0];
  const comments = [{ id: 1, body: row.evidence_post.body }, { id: 2, body: row.evidence_post.body }];
  const audit = validateFreshRow(row, liveByNumber.get(row.issue_number), comments);
  assert.equal(audit.ok, false);
  assert.match(audit.errors.join('\n'), /duplicate evidence idempotency marker/);
});

test('lost evidence response is recovered by exact marker GET without a second post', () => {
  const api = fakeApi({ responseLoss: true });
  const result = runApply(api);
  assert.equal(result.ok, true);
  assert.equal(api.posts.length, 13);
  assert.equal(result.journal.status, 'complete');
  assert.equal(result.journal.entries.every((entry) => entry.phase === 'complete'), true);
});

test('authorization drift and a non-exact mutation ceiling block before any evidence post', () => {
  const api = fakeApi();
  assert.throws(() => runApply(api, authComment({ plan_digest: '0'.repeat(64) })), /authorization digest drifted/);
  assert.equal(api.posts.length, 0);
  const ceiling = validateAuthorization(authComment({ max_mutations: 12 }), plan, { authorization_comment_id: 7001, plan_digest: plan.canonical_digest, confirm_digest: plan.canonical_digest, max_mutations: 12 });
  assert.equal(ceiling.ok, false);
  assert.match(ceiling.errors.join('\n'), /exactly equal executable proposal count 13/);
});

test('journal has exact 13-row identity, crash-unknown, and idempotency fields', () => {
  const journal = initialJournal(plan, '2026-09-09T00:00:00Z');
  assert.equal(validateJournal(journal, plan).ok, true);
  assert.equal(journal.entries.length, 13);
  journal.entries[0].phase = 'unknown';
  journal.entries[0].possibly_performed = true;
  journal.possibly_performed = true;
  journal.canonical_digest = sha256(canonicalize({ ...journal, canonical_digest: undefined }));
  delete journal.canonical_digest;
  journal.canonical_digest = sha256(canonicalize(journal));
  assert.equal(validateJournal(journal, plan).ok, true);
  assert.equal(buildPlanOnly(plan).write_operations.mutation, 0);
});
