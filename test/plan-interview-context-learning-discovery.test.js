'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadComments, loadAllIssues, parseArgs, resumeProgressItem } = require('../scripts/plan-interview-context-learning-discovery');

test('CLI comments pagination is explicit, bounded, and complete without --slurp', () => {
  const urls = [];
  const comments = loadComments('liqiangcc/interview-lab', 915, { readPage: (page, url) => {
    urls.push(url);
    return page < 3 ? Array.from({ length: 100 }, (_, index) => ({ id: page * 100 + index })) : [{ id: 301 }];
  } });
  assert.equal(comments.length, 201);
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => url.includes('per_page=100') && url.includes('page=')));
  assert.ok(urls.every((url) => !url.includes('slurp')));
});

test('inventory pagination requests only type:interview-note and retains every page', () => {
  const urls = [];
  const issues = loadAllIssues('liqiangcc/interview-lab', { readPage: (page, url) => {
    urls.push(url);
    return page < 3 ? Array.from({ length: 100 }, (_, index) => ({ number: page * 100 + index, labels: [{ name: 'type:interview-note' }] })) : [{ number: 301, labels: [{ name: 'type:interview-note' }] }];
  } });
  assert.equal(issues.length, 201);
  assert.equal(urls.length, 3);
  assert.ok(urls.every((url) => url.includes('labels=type%3Ainterview-note')));
  assert.ok(urls.every((url) => !url.includes('repos/liqiangcc/interview-lab/issues?state=all&per_page')));
});

test('apply requires native dry-run confirmation and mutation ceiling', () => {
  assert.throws(() => parseArgs(['--request', 'request.md', '--apply']), /confirm-dry-run-digest/);
  assert.throws(() => parseArgs(['--request', 'request.md', '--apply', '--confirm-dry-run-digest', 'a'.repeat(64)]), /max-mutations/);
});

test('failed progress resumes only when live re-read proves convergence', () => {
  const failed = { state: 'failed', error: 'uncertain receipt mutation' };
  assert.deepEqual(resumeProgressItem(failed, { ok: true, action: 'already_applied' }), { ok: true, state: 'complete' });
  const held = resumeProgressItem(failed, { ok: true, action: 'repair_receipt' });
  assert.equal(held.ok, false);
  assert.match(held.error, /uncertain receipt mutation/);
});
