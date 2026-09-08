'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BOUNDARY_BATCHES,
  SOURCE_REF,
  buildOwnershipIndex,
  buildSnapshot,
  canonicalDigest,
  validateInventoryItems,
  validateSnapshot,
} = require('../scripts/lib/issue-1605-pending-inventory');
const { fetchInventory } = require('../scripts/plan-issue-1605-pending-inventory');

function syntheticItems() {
  return BOUNDARY_BATCHES.flatMap((batch) => Array.from({ length: batch.expected_count }, (_, index) => {
    const issueNumber = batch.first + index;
    return {
      issue_number: issueNumber,
      issue_url: `https://github.com/liqiangcc/interview-lab/issues/${issueNumber}`,
      state: 'open',
      body_sha256: `${String(issueNumber).padStart(64, '0')}`.slice(-64),
      source_note_id: `xhs-note:synthetic-${issueNumber}`,
      source_revision: { id: `xhs-note:synthetic-${issueNumber}:snapshot`, source_repository: 'liqiangcc/xhs', source_repository_ref: SOURCE_REF },
      labels: ['boundary:pending', 'source:xhs', 'status:captured', 'type:source-note'],
    };
  }));
}

test('validates the frozen four-batch union/disjoint/count contract', () => {
  const items = syntheticItems();
  const result = validateInventoryItems(items);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.total, 1397);
  assert.equal(result.union_count, 1397);
  assert.deepEqual(result.range_counts.map((range) => range.count), [327, 367, 337, 366]);
});

test('fails closed for duplicate ownership and out-of-range items', () => {
  const items = syntheticItems();
  items[1] = { ...items[1], source_note_id: items[0].source_note_id };
  items[0] = { ...items[0], issue_number: 1509 };
  const result = validateInventoryItems(items);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate SourceNote id/);
  assert.match(result.errors.join('\n'), /outside all fixed boundary ranges/);
});

test('canonical snapshot and ownership index are mutually pinned', () => {
  const items = syntheticItems();
  const snapshot = buildSnapshot({
    pages: [{ page: 1, endpoint: 'fixture?page=1', item_count: 1 }],
    items,
    query: 'fixture?page={page}',
  });
  const ownership = buildOwnershipIndex(snapshot.items, snapshot.canonical_digest);
  const result = validateSnapshot(snapshot, ownership);
  assert.equal(result.ok, true, result.errors.join('; '));
  const { canonical_digest: ignoredDigest, validation: ignoredValidation, ...snapshotContent } = snapshot;
  assert.equal(snapshot.canonical_digest, canonicalDigest(snapshotContent));
  assert.equal(ownership.count, 1397);
});

test('pagination stops only at a short page and preserves page evidence', () => {
  const calls = [];
  const result = fetchInventory({
    repository: 'fixture/repo',
    read(repository, page, perPage) {
      calls.push({ repository, page, perPage });
      const issues = page === 1 ? [] : [];
      return { endpoint: `fixture?page=${page}`, issues };
    },
  });
  assert.deepEqual(calls, [{ repository: 'fixture/repo', page: 1, perPage: 100 }]);
  assert.deepEqual(result.pages, [{ page: 1, endpoint: 'fixture?page=1', item_count: 0 }]);
});
