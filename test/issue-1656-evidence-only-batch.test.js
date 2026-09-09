'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
  atomicWriteJson,
  acquireLock,
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

function fakeApi({ responseLoss = false, commentsByIssue = new Map(), issueByNumber = liveByNumber } = {}) {
  const reads = [];
  const posts = [];
  return {
    reads,
    posts,
    readIssue(number) { reads.push(['issue', number]); return issueByNumber.get(Number(number)); },
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

function applyAt(api, directory, auth = authComment(), overrides = {}) {
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
}

function runApply(api, auth = authComment(), overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-evidence-only-'));
  try { return applyAt(api, directory, auth, overrides); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function writeLockFixture(file, { token = 'stale-token-1656', pid, hostname = os.hostname(), planDigest = plan.canonical_digest, malformed = false } = {}) {
  if (malformed) { fs.writeFileSync(file, '{not-json\n', 'utf8'); return; }
  fs.writeFileSync(file, 'lock fixture\n', { encoding: 'utf8', mode: 0o600 });
  const stat = fs.statSync(file);
  const device = Number(stat.dev);
  const inode = Number(stat.ino);
  const owner = { token, pid, hostname };
  fs.writeFileSync(file, `${JSON.stringify({ schema_version: 'issue-1656-evidence-only-lock.v2', token, pid, hostname, created_at: '2026-09-09T00:00:00.000Z', device, inode, owner, plan_digest: planDigest })}\n`, 'utf8');
  return { token, pid, hostname, device, inode, owner };
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
  journal.entries[0].mutation_attempted = true;
  journal.entries[0].mutation_count = 1;
  journal.entries[0].possibly_performed = true;
  journal.status = 'unknown';
  journal.mutation_count = 1;
  journal.possibly_performed = true;
  delete journal.canonical_digest;
  journal.canonical_digest = sha256(canonicalize(journal));
  assert.equal(validateJournal(journal, plan).ok, true);
  assert.equal(buildPlanOnly(plan).write_operations.mutation, 0);
});

test('restart loads the existing unknown journal, reconciles once, and never reposts the possibly performed row', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-evidence-restart-'));
  const comments = new Map();
  const base = fakeApi({ commentsByIssue: comments });
  const firstRow = plan.proposal_rows[0];
  let hideAcceptedMarker = true;
  let firstPost = true;
  const crashedApi = {
    ...base,
    readComments(number) {
      if (hideAcceptedMarker && Number(number) === firstRow.issue_number && comments.get(firstRow.issue_number)?.length) throw new Error('simulated restart visibility outage');
      return base.readComments(number);
    },
    postEvidenceComment(number, body) {
      const response = base.postEvidenceComment(number, body);
      if (firstPost) { firstPost = false; throw new Error('simulated process crash after acceptance'); }
      return response;
    },
  };
  try {
    assert.throws(() => applyAt(crashedApi, directory), /unknown after 3 bounded reconciliations/);
    const interrupted = JSON.parse(fs.readFileSync(path.join(directory, 'journal.json'), 'utf8'));
    const interruptedEntry = interrupted.entries.find((entry) => entry.issue_number === firstRow.issue_number);
    assert.equal(interruptedEntry.phase, 'unknown');
    assert.equal(interruptedEntry.possibly_performed, true);
    assert.equal(interruptedEntry.mutation_count, 1);
    assert.equal(interrupted.mutation_count, 1);

    hideAcceptedMarker = false;
    const resumedPosts = [];
    const resumedApi = {
      ...base,
      postEvidenceComment(number, body) { resumedPosts.push(Number(number)); return base.postEvidenceComment(number, body); },
    };
    const result = applyAt(resumedApi, directory);
    assert.equal(result.ok, true);
    assert.equal(resumedPosts.length, 12);
    assert.equal(resumedPosts.includes(firstRow.issue_number), false);
    assert.equal(comments.get(firstRow.issue_number).filter((comment) => comment.body === firstRow.evidence_post.body).length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('existing journal digest drift fails closed without replacing the journal or posting', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-evidence-journal-drift-'));
  const journalFile = path.join(directory, 'journal.json');
  const original = initialJournal(plan, '2026-09-09T00:00:00Z');
  original.plan_digest = 'f'.repeat(64);
  atomicWriteJson(journalFile, original);
  const before = fs.readFileSync(journalFile, 'utf8');
  const api = fakeApi();
  try {
    assert.throws(() => applyAt(api, directory), /existing journal validation failed/);
    assert.equal(fs.readFileSync(journalFile, 'utf8'), before);
    assert.equal(api.posts.length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an existing non-object journal is rejected rather than treated as absent', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-evidence-journal-null-'));
  const journalFile = path.join(directory, 'journal.json');
  atomicWriteJson(journalFile, null);
  const before = fs.readFileSync(journalFile, 'utf8');
  const api = fakeApi();
  try {
    assert.throws(() => applyAt(api, directory), /existing journal validation failed/);
    assert.equal(fs.readFileSync(journalFile, 'utf8'), before);
    assert.equal(api.posts.length, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('acquireLock atomically recovers a dead same-host lock and records the recovery binding', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-lock-dead-'));
  const lockFile = path.join(directory, 'lock');
  const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.ok(child.pid > 0);
  const stale = writeLockFixture(lockFile, { pid: child.pid });
  try {
    const lock = acquireLock(lockFile, plan.canonical_digest);
    const recovered = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.notEqual(recovered.token, stale.token);
    assert.equal(recovered.recovered_from.token, stale.token);
    assert.equal(recovered.recovered_from.pid, stale.pid);
    assert.equal(recovered.recovered_from.device, stale.device);
    assert.equal(recovered.recovered_from.inode, stale.inode);
    assert.match(recovered.recovered_from.quarantine, /^lock\.recovery-/);
    assert.equal(recovered.owner.token, recovered.token);
    assert.equal(recovered.owner.pid, process.pid);
    assert.equal(recovered.device, Number(fs.statSync(lockFile).dev));
    assert.equal(recovered.inode, Number(fs.statSync(lockFile).ino));
    lock.assertHeld();
    lock.release();
    assert.equal(fs.existsSync(lockFile), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('acquireLock rejects a live same-host lock and preserves its payload', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-lock-live-'));
  const lockFile = path.join(directory, 'lock');
  writeLockFixture(lockFile, { pid: process.pid });
  const before = fs.readFileSync(lockFile, 'utf8');
  try {
    assert.throws(() => acquireLock(lockFile, plan.canonical_digest), /live or cannot be proven dead/);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), before);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('acquireLock rejects foreign-host and malformed residual locks without reclaiming either', () => {
  const foreignDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-lock-foreign-'));
  const foreignFile = path.join(foreignDirectory, 'lock');
  writeLockFixture(foreignFile, { pid: process.pid, hostname: `${os.hostname()}-foreign` });
  const foreignBefore = fs.readFileSync(foreignFile, 'utf8');
  try {
    assert.throws(() => acquireLock(foreignFile, plan.canonical_digest), /foreign-host lock/);
    assert.equal(fs.readFileSync(foreignFile, 'utf8'), foreignBefore);
  } finally { fs.rmSync(foreignDirectory, { recursive: true, force: true }); }

  const malformedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1656-lock-malformed-'));
  const malformedFile = path.join(malformedDirectory, 'lock');
  writeLockFixture(malformedFile, { malformed: true });
  const malformedBefore = fs.readFileSync(malformedFile, 'utf8');
  try {
    assert.throws(() => acquireLock(malformedFile, plan.canonical_digest), /lock payload is malformed/);
    assert.equal(fs.readFileSync(malformedFile, 'utf8'), malformedBefore);
  } finally { fs.rmSync(malformedDirectory, { recursive: true, force: true }); }
});

test('per-row fresh CAS/idempotency GET stops the batch before posting after a later row drifts', () => {
  const issueByNumber = new Map([...liveByNumber].map(([number, issue]) => [number, { ...issue }]));
  const base = fakeApi({ issueByNumber });
  const firstRow = plan.proposal_rows[0];
  const secondRow = plan.proposal_rows[1];
  const api = {
    ...base,
    postEvidenceComment(number, body) {
      const response = base.postEvidenceComment(number, body);
      if (Number(number) === firstRow.issue_number) {
        issueByNumber.set(secondRow.issue_number, { ...issueByNumber.get(secondRow.issue_number), body: `${issueByNumber.get(secondRow.issue_number).body}\nDRIFT AFTER FIRST POST` });
      }
      return response;
    },
  };
  assert.throws(() => runApply(api), /per-row fresh SourceNote\/CAS validation failed/);
  assert.deepEqual(api.posts, [firstRow.issue_number]);
});
