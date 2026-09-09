'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateBundle } = require('../scripts/issue-1656-pending-boundary-bundle');

test('Issue #1656 captured pending bundle is complete, pinned, and read-only', () => {
  const result = validateBundle('data/pilot/issue-1656');
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.request_count, 421);
  assert.deepEqual(result.batch_counts, { A: 86, B: 18, C: 146, D: 171 });
  assert.deepEqual(result.issue_735, { status: 'pending-review', decision: null, transition_id: null });
  assert.equal(result.mutation_count, 0);
  assert.equal(result.inventory_digest, '5ff56a51e3f430020c761239ba5706d4f3c413327c97fb02e1ad4f1a7c901400');
  assert.equal(result.request_plan_digest, 'db1a6ba2a7c31f54d2fa872faa62e7b44ecc41dba69ce8142d63303af8f93eb6');
  assert.equal(result.bundle_digest, '251f9976e7e019ebdf71a22451d9c0b5a2ead43d6dbc483bf8a881fbafa2306c');
});
