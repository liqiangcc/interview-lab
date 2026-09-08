'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const frozenSnapshot = require('../data/pilot/issue-1605/pending-inventory.snapshot.json');
const completedManifest = require('../data/pilot/issue-1605/full-boundary-manifest.json');
const manifest = require('../data/pilot/issue-1605/remaining-boundary.manifest.json');
const journal = require('../data/pilot/issue-1605/remaining-boundary.journal.json');
const {
  MANIFEST_SCHEMA, SOURCE_REPOSITORY, SOURCE_REF, buildRemainingScope, canonical, canonicalDigest,
  validateFrozenSnapshot, validateJournal, validateAuditedObservation,
} = require('../scripts/lib/issue-1605-next-boundary-coordinator');

test('persisted Issue #1605 next-boundary artifacts retain the validated read-only 978-row audit', () => {
  const frozen = validateFrozenSnapshot(frozenSnapshot);
  assert.equal(frozen.ok, true, frozen.errors.join('; '));
  const scope = buildRemainingScope({
    frozenSnapshot,
    completedManifest,
    completedManifestPath: manifest.excluded_completed_manifest.path,
  });
  assert.equal(scope.ok, true, scope.errors.join('; '));
  assert.equal(manifest.schema_version, MANIFEST_SCHEMA);
  assert.equal(manifest.ok, true);
  assert.equal(manifest.scope_digest, '6ef4fa26e838fe8c30d571c08807c09d5a3280eb40aa4af57d679274f6a131a1');
  assert.equal(manifest.canonical_digest, 'fea78669500c0986eff96b67b7e2d35afdf46355bc7caa9b862116eca40b4ba9');
  const manifestContent = { ...manifest };
  delete manifestContent.ok;
  delete manifestContent.canonical_digest;
  assert.equal(canonicalDigest(manifestContent), manifest.canonical_digest);
  assert.equal(manifest.scope_digest, scope.scope_digest);
  assert.deepEqual(manifest.source_snapshot, { repository: SOURCE_REPOSITORY, ref: SOURCE_REF });
  assert.deepEqual(manifest.batches.map((item) => [item.batch, item.count, item.audit_blocked_count]), [['A', 235, 0], ['B', 257, 0], ['C', 248, 0], ['D', 238, 0]]);
  assert.equal(manifest.items.length, 978);
  assert.equal(new Set(manifest.items.map((item) => item.issue_number)).size, 978);
  for (const item of manifest.items) {
    const expected = scope.items.find((candidate) => candidate.issue_number === item.issue_number);
    assert(expected, `missing scope row #${item.issue_number}`);
    assert.equal(canonical(item), canonical({ ...expected, live_audit: item.live_audit }));
    const observation = validateAuditedObservation(expected, item.live_audit);
    assert.equal(observation.ok, true, `manifest #${item.issue_number}: ${observation.errors.join('; ')}`);
  }
  assert.equal(validateJournal(journal, scope).ok, true);
  assert.equal(journal.status, 'complete');
  assert.equal(journal.completed_count, 978);
  assert.equal(journal.blocked_count, 0);
  assert.equal(journal.items.length, 978);
  const journalContent = { ...journal };
  delete journalContent.canonical_digest;
  assert.equal(canonicalDigest(journalContent), journal.canonical_digest);
  for (const number of [698, 951]) {
    const item = journal.items.find((candidate) => candidate.issue_number === number);
    assert.equal(item.status, 'audited');
    assert.equal(item.attempts, 2);
    assert.equal(item.observation.status, 'review-required');
    assert.deepEqual(item.observation.errors, []);
  }
});
