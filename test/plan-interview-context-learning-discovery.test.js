'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadComments, loadAllIssues, loadLabels, fixedInventoryAudit, parseArgs, resumeProgressItem, validatePatchResponse, parseGhIncludedJson, normalizeIfMatchEtag, buildPatchArgs, acquireApplyLock } = require('../scripts/plan-interview-context-learning-discovery');

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

test('label inventory pagination is explicit and complete', () => {
  const urls = [];
  const labels = loadLabels('liqiangcc/interview-lab', { readPage: (page, url) => {
    urls.push(url);
    return page < 2 ? Array.from({ length: 100 }, (_, index) => ({ name: `label-${page}-${index}` })) : [{ name: 'label-final' }];
  } });
  assert.equal(labels.length, 101);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.includes('/labels?per_page=100&page=')));
  assert.ok(urls.every((url) => !url.includes('--slurp')));
});

test('fixed inventory audit requires exact source-ready set', () => {
  const issues = [3, 4, 915].map((number) => ({ number, labels: [{ name: 'type:interview-note' }, { name: 'status:source-ready' }] }));
  assert.deepEqual(fixedInventoryAudit(issues, [3, 4, 915]), { ok: true, expected_count: 3, actual_count: 3, expected: [3, 4, 915], actual: [3, 4, 915], missing: [], unexpected: [] });
  const drift = fixedInventoryAudit([...issues, { number: 916, labels: [{ name: 'type:interview-note' }, { name: 'status:source-ready' }] }], [3, 4, 915]);
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.unexpected, [916]);
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

test('PATCH response missing or dropping labels fails closed', () => {
  const item = { projection: { labels: ['company:alibaba', 'type:interview-note'] } };
  assert.throws(() => validatePatchResponse({}, item), /omitted labels/);
  assert.throws(() => validatePatchResponse({ labels: [{ name: 'type:interview-note' }] }, item), /silent label loss/);
  assert.equal(validatePatchResponse({ labels: [{ name: 'type:interview-note' }, { name: 'company:alibaba' }] }, item), true);
});

test('Issue PATCH uses the immediately-read ETag as an atomic CAS precondition', () => {
  const args = buildPatchArgs({ repository: 'liqiangcc/interview-lab' }, { issue_number: 915, issue_etag: 'W/"etag-1"' });
  assert.deepEqual(args, ['api', '--method', 'PATCH', 'repos/liqiangcc/interview-lab/issues/915', '--header', 'If-Match: "etag-1"', '--input', '-']);
  assert.equal(normalizeIfMatchEtag('W/"etag-1"'), '"etag-1"');
  assert.equal(normalizeIfMatchEtag('"etag-1"'), '"etag-1"');
  assert.throws(() => normalizeIfMatchEtag('etag-1'), /quoted opaque tag/);
  assert.throws(() => buildPatchArgs({ repository: 'liqiangcc/interview-lab' }, { issue_number: 915 }), /requires the ETag/);
});

test('GH included response parser requires and captures ETag', () => {
  const parsed = parseGhIncludedJson('HTTP/2.0 200 OK\nEtag: W/"abc"\n\n{"number":915}');
  assert.deepEqual(parsed.json, { number: 915 });
  assert.equal(parsed.etag, 'W/"abc"');
  assert.throws(() => parseGhIncludedJson('{"number":915}'), /separator/);
});

test('apply lock is exclusive, stale locks are not stolen, and release permits a later owner', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1598-lock-'));
  const file = path.join(directory, 'apply.lock');
  const first = acquireApplyLock(file, { batch_id: 'test' });
  assert.throws(() => acquireApplyLock(file, { batch_id: 'test' }), /already exists/);
  first.release();
  const second = acquireApplyLock(file, { batch_id: 'test' });
  second.release();
  fs.writeFileSync(file, JSON.stringify({ token: 'stale-token' }));
  assert.throws(() => acquireApplyLock(file, { batch_id: 'test' }), /already exists/);
  fs.rmSync(directory, { recursive: true, force: true });
});
