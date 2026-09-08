'use strict';

const assert = require('assert');
const test = require('node:test');
const { classify, issueNumbers } = require('../scripts/prepare-issue-1608-boundary');
const { validateDirectory } = require('../scripts/validate-issue-1608-boundary');

test('issue #1608 generator is exactly bounded to #766-#1138', () => {
  assert.deepStrictEqual(issueNumbers(), Array.from({ length: 373 }, (_, index) => 766 + index));
});

test('issue #1608 classification fails closed for empty and generic source text', () => {
  assert.strictEqual(classify(999999, '').disposition, 'blocked');
  assert.strictEqual(classify(999999, '一份面试技巧和复习资料整理').decision, 'not-interview');
});

test('issue #1608 frozen artifacts validate with zero mutations', () => {
  const result = validateDirectory();
  assert.strictEqual(result.total, 337);
  assert.strictEqual(result.selection_sha256.length, 64);
  assert.strictEqual(result.dry_run_sha256.length, 64);
});
