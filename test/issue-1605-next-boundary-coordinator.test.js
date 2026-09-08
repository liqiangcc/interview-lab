'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sourceFixture = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue.valid.md'), 'utf8');
const frozenSnapshot = require('../data/pilot/issue-1605/pending-inventory.snapshot.json');
const completedManifest = require('../data/pilot/issue-1605/full-boundary-manifest.json');
const {
  REPOSITORY, SOURCE_REF, FROZEN_SNAPSHOT_DIGEST, BATCHES, buildRemainingScope, validateFrozenSnapshot, readGhJson, readCommentsPaged,
  auditLiveItem, validateAuditedObservation, initialJournal, auditRemainingScope, buildManifest, buildBatchArtifacts, canonicalDigest, acquireReadLock,
} = require('../scripts/lib/issue-1605-next-boundary-coordinator');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');

function fixtureItem(issueNumber = 42) {
  const record = parseSourceNoteIssue(sourceFixture).record;
  return {
    batch: 'A', child_issue: 1606, issue_number: issueNumber, source_note_id: record.source_note_id,
    expected_body_sha256: require('../scripts/lib/issue-1605-next-boundary-coordinator').bodySha256(sourceFixture),
    expected_source_revision_id: record.source_revision.id, expected_source_repository_ref: SOURCE_REF,
    frozen_labels: ['boundary:pending', 'migration:xhs-bulk', 'source-year:2022', 'source:xhs', 'status:captured', 'task:boundary-review', 'type:source-note'],
  };
}

test('remaining scope is exactly 978 rows split across A-D and excludes only the pinned 419 manifest', () => {
  const scope = buildRemainingScope({ frozenSnapshot, completedManifest, completedManifestPath: 'full-boundary-manifest.json' });
  assert.equal(scope.ok, true, scope.errors.join('; '));
  assert.equal(scope.remaining_count, 978);
  assert.deepEqual(scope.batches.map((batch) => batch.count), [235, 257, 248, 238]);
  assert.equal(scope.excluded_completed_manifest.authorization_reused, false);
  assert.match(scope.scope_digest, /^[0-9a-f]{64}$/);
  assert.equal(scope.items.some((item) => item.issue_number === 42), false);
});

test('read-only JSON wrapper rejects mutation-shaped requests and retries transient failures at most five times', () => {
  let attempts = 0;
  const delays = [];
  const value = readGhJson((args) => {
    attempts += 1;
    if (attempts < 5) throw Object.assign(new Error('TLS EOF'), { code: 'ECONNRESET' });
    return { ok: true, args };
  }, ['api', `repos/${REPOSITORY}/issues/42`], null, { sleep: (milliseconds) => delays.push(milliseconds) });
  assert.equal(value.ok, true);
  assert.equal(attempts, 5);
  assert.deepEqual(delays, [100, 200, 400, 800]);
  assert.throws(() => readGhJson(() => ({}), ['api', '--method', 'POST', 'repos/x'], null), /GET-only/);
});

test('comments pagination retries each page and requires a short terminal page', () => {
  let firstPageAttempts = 0;
  const result = readCommentsPaged({
    repository: REPOSITORY, issueNumber: 42, maxAttempts: 5, sleep: () => {},
    read: (args) => {
      if (args[1].includes('page=1')) {
        firstPageAttempts += 1;
        if (firstPageAttempts === 1) throw Object.assign(new Error('unexpected EOF'), { code: 'ECONNRESET' });
        return [{ id: 1 }];
      }
      throw new Error('unexpected page read');
    },
  });
  assert.deepEqual(result.comments, [{ id: 1 }]);
  assert.equal(firstPageAttempts, 2);
  assert.equal(result.terminal_page_short, true);
});

test('live pending audit records labels, fixed ref, receipts, and blocked read failures without mutation', () => {
  const item = fixtureItem();
  const issue = { number: 42, state: 'open', body: sourceFixture, labels: item.frozen_labels };
  const audit = auditLiveItem(item, issue, [{ id: 1, body: 'ordinary review comment' }]);
  assert.equal(audit.status, 'review-required');
  assert.equal(audit.live_labels.includes('boundary:pending'), true);
  assert.equal(audit.source_ref_verified, true);
  assert.equal(audit.applied_receipts.length, 0);
  const scope = { scope_digest: 'a'.repeat(64), items: [item] };
  const persisted = [];
  const result = auditRemainingScope({
    scope, journal: initialJournal(scope), readIssue: () => { throw new Error('GET EOF'); },
    readComments: () => [], persist: (journal) => persisted.push(journal.status),
  });
  assert.equal(result.observations[0].status, 'blocked');
  assert.match(result.observations[0].errors[0], /GET EOF/);
  assert.equal(result.journal.status, 'complete-with-blockers');
  assert.ok(persisted.length >= 2);
});

test('batch artifacts are complete review envelopes but contain no authorization or mutation operation', () => {
  const item = fixtureItem();
  const audit = auditLiveItem(item, { number: 42, state: 'open', body: sourceFixture, labels: item.frozen_labels }, []);
  const scope = { scope_digest: 'b'.repeat(64), excluded_completed_manifest: { authorization_reused: false }, batches: BATCHES.map((batch) => ({ ...batch, count: batch.batch === 'A' ? 1 : 0 })), items: [{ ...item, live_audit: audit }] };
  const manifest = buildManifest(scope, [audit], 'next-boundary-batches');
  const artifacts = buildBatchArtifacts(manifest);
  assert.equal(artifacts.A.evidence.items.length, 1);
  assert.equal(artifacts.A.request.request_count, 0);
  assert.equal(artifacts.A.transition.mutation_count, 0);
  assert.equal(artifacts.A.transition.authorization.reused_completed_419_authorization, false);
  assert.equal(artifacts.A.transition.items[0].status, 'blocked');
  assert.equal(artifacts.A.evidence.items[0].evidence.comment_id, null);
  assert.equal(manifest.artifact_dir, 'next-boundary-batches');
});

test('the old completed manifest is validated as an exclusion only and cannot drift into the next scope', () => {
  const scope = buildRemainingScope({ frozenSnapshot, completedManifest, completedManifestPath: '/tmp/full-boundary-manifest.json' });
  assert.equal(scope.excluded_completed_manifest.canonical_digest, '40fd63cccea624a567778f5c679a9e0e77b0784181de4d54cacad9873ae6c97a');
  assert.equal(Object.hasOwn(scope.excluded_completed_manifest, 'plan_digest'), false);
  assert.equal(Object.hasOwn(scope, 'plan_digest'), false);
  assert.equal(scope.items.some((item) => item.issue_number === 28), true);
  assert.equal(scope.items.some((item) => item.issue_number === 42), false);
});

test('the frozen 1397-row snapshot is pinned to the approved canonical digest', () => {
  const validation = validateFrozenSnapshot(frozenSnapshot);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.equal(frozenSnapshot.canonical_digest, FROZEN_SNAPSHOT_DIGEST);
  const drifted = { ...frozenSnapshot, source_ref: 'wrong-ref' };
  assert.equal(validateFrozenSnapshot(drifted).ok, false);
  assert.match(validateFrozenSnapshot({ ...frozenSnapshot, canonical_digest: '0'.repeat(64) }).errors.join('\n'), /canonical digest/);
});

test('resume validates audited observation bindings and re-reads tampered state instead of blindly skipping', () => {
  const item = fixtureItem(28);
  const scope = { scope_digest: 'c'.repeat(64), items: [item] };
  const issue = { number: 28, state: 'open', body: sourceFixture, labels: item.frozen_labels };
  const first = auditRemainingScope({ scope, journal: initialJournal(scope), readIssue: () => issue, readComments: () => [], persist: () => {} });
  const resumedJournal = JSON.parse(JSON.stringify(first.journal));
  resumedJournal.items[0].observation.live_source_revision_id = 'tampered';
  const unsigned = { ...resumedJournal }; delete unsigned.canonical_digest;
  resumedJournal.canonical_digest = canonicalDigest(unsigned);
  assert.equal(validateAuditedObservation(item, resumedJournal.items[0].observation).ok, false);
  let reads = 0;
  const resumed = auditRemainingScope({ scope, journal: resumedJournal, readIssue: () => { reads += 1; return issue; }, readComments: () => [], persist: () => {} });
  assert.equal(reads, 1);
  assert.equal(resumed.observations[0].status, 'review-required');
  assert.match(resumed.observations[0].observation_digest, /^[0-9a-f]{64}$/);
});

test('read lock keeps its fd identity and refuses pathname replacement during release', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-lock-'));
  const lockPath = path.join(directory, 'read.lock');
  const lock = acquireReadLock(lockPath);
  fs.renameSync(lockPath, path.join(directory, 'original.lock'));
  fs.writeFileSync(lockPath, '{"token":"replacement"}\n');
  assert.throws(() => lock.release(), /ownership\/inode changed/);
  assert.equal(fs.existsSync(lockPath), true);
  fs.unlinkSync(lockPath);
  fs.unlinkSync(path.join(directory, 'original.lock'));
  fs.rmdirSync(directory);
});
