'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  atomicWriteJson,
  collectOwnershipPages,
  isTransientReadError,
  readReceipt,
  readWithRetry,
  receiptPath,
  main,
} = require('../scripts/apply-issue-1577-source-review-transition');

test('GET retry is limited to transient network and EOF failures', () => {
  let calls = 0;
  const sleeps = [];
  const transient = Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' });
  assert.throws(() => readWithRetry(() => { calls += 1; throw transient; }, 3, 7, (ms) => sleeps.push(ms)), /connection reset/);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [7, 14]);
  for (const error of [new Error('HTTP 404'), Object.assign(new Error('HTTP 408'), { code: 'ETIMEDOUT' }), new SyntaxError('Unexpected token'), new Error('semantic validation failed')]) {
    calls = 0;
    assert.throws(() => readWithRetry(() => { calls += 1; throw error; }, 3, 7, () => {}));
    assert.equal(calls, 1);
    assert.equal(isTransientReadError(error), false);
  }
  assert.equal(isTransientReadError(Object.assign(new Error('EOF'), { code: 'EPIPE' })), true);
});

test('ownership search reads every 100-item page through the terminal empty page', () => {
  const pages = [
    { incomplete_results: false, total_count: 101, items: Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })) },
    { incomplete_results: false, total_count: 101, items: [{ number: 101 }] },
    { incomplete_results: false, total_count: 101, items: [] },
  ];
  const seen = [];
  const result = collectOwnershipPages((page) => { seen.push(page); return pages[page - 1]; }, 'xhs:test');
  assert.equal(result.length, 101);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.throws(() => collectOwnershipPages(() => ({ incomplete_results: true, total_count: 0, items: [] }), 'xhs:bad'), /incomplete/);
  assert.throws(() => collectOwnershipPages((page) => ({ incomplete_results: false, total_count: page === 1 ? 1 : 2, items: page === 1 ? [{ number: 1 }] : [] }), 'xhs:drift'), /total_count changed/);
});

test('atomic progress/receipt writes fsync the renamed file and parent directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-transition-atomic-'));
  const file = path.join(directory, 'progress.json');
  const originalFsync = fs.fsyncSync;
  const fsyncKinds = [];
  fs.fsyncSync = (fd) => { fsyncKinds.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return originalFsync(fd); };
  try {
    atomicWriteJson(file, { durable: true });
    assert.deepEqual(fsyncKinds, ['file', 'directory']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { durable: true });
  } finally {
    fs.fsyncSync = originalFsync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('local transition receipt reader rejects malformed files and path escapes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-transition-receipt-'));
  const request = { issue_number: 1558 };
  try {
    assert.throws(() => receiptPath(directory, { issue_number: '../escape' }), /escapes/);
    const malformed = path.join(directory, 'issue-1558.json');
    fs.writeFileSync(malformed, '{not-json\n');
    assert.throws(() => readReceipt(directory, request), /Unexpected token|JSON/);
    fs.rmSync(malformed);
    atomicWriteJson(malformed, { schema_version: 'wrong' });
    assert.throws(() => readReceipt(directory, request), /malformed|not bound/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const productionFixtureRoot = path.resolve('data/pilot/issue-1577');
const hasProductionFixture = fs.existsSync(path.join(productionFixtureRoot, 'evidence-post-apply-plan.json')) && fs.existsSync(path.join(productionFixtureRoot, 'requests'));
test('production evidence/request fixture uses the real read-only CLI loader contract', { skip: !hasProductionFixture }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-transition-production-cli-'));
  const output = path.join(directory, 'plan.json');
  const calls = [];
  const ghJson = (args) => {
    calls.push(args);
    const endpoint = args.find((value) => typeof value === 'string' && (value.startsWith('repos/') || value.startsWith('search/')));
    if (endpoint.startsWith('search/issues?')) return { incomplete_results: false, total_count: 0, items: [] };
    if (endpoint.includes('/comments?')) return [];
    if (endpoint.startsWith('repos/')) return {};
    throw new Error(`unexpected read-only fixture endpoint: ${endpoint}`);
  };
  try {
    const exitCode = main([
      '--manifest', path.resolve('data/issue-1577/source-review-manifest.json'),
      '--evidence-plan', path.join(productionFixtureRoot, 'evidence-post-apply-plan.json'),
      '--request-dir', path.join(productionFixtureRoot, 'requests'),
      '--output', output,
      '--get-max-attempts', '1',
      '--get-backoff-ms', '0',
    ], { ghJson });
    assert.equal(exitCode, 1, 'malformed live fixture must fail closed in plan-only mode');
    const plan = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(plan.mutation_count, 0);
    assert.equal(plan.possibly_performed, false);
    assert.ok(calls.length > 0);
    assert.equal(calls.some((args) => args.includes('--method')), false, 'read-only loader must not issue mutation requests');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
