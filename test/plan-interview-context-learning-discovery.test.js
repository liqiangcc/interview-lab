'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadComments, loadAllIssues, loadLabels, fixedInventoryAudit, parseArgs, resumeProgressItem, receiptPendingPatch, validatePatchResponse, parseGhIncludedJson, formatGhMutationError, ghMutationJson, buildPatchArgs, patchSnapshot, assertPatchSnapshotUnchanged, acquireApplyLock } = require('../scripts/plan-interview-context-learning-discovery');

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

test('receipt POST crash window never retries after attempted response loss', () => {
  let postCalls = 0;
  const afterPostCrash = {
    state: 'receipt_pending',
    receipt_attempted: true,
    receipt_possibly_performed: true,
    receipt_intent: { intent_id: 'durable-intent' },
  };
  const temporarilyMissingMarker = { ok: true, action: 'repair_receipt' };
  const resume = resumeProgressItem(afterPostCrash, temporarilyMissingMarker);
  if (resume.ok) postCalls += 1;
  assert.equal(resume.ok, false);
  assert.match(resume.error, /refusing blind retry/);
  assert.equal(postCalls, 0);
});

test('receipt POST is recoverable only when durable state proves it was not attempted', () => {
  const resume = resumeProgressItem({
    state: 'receipt_pending',
    receipt_attempted: false,
    receipt_possibly_performed: false,
    receipt_intent: { intent_id: 'durable-intent' },
  }, { ok: true, action: 'repair_receipt' });
  assert.deepEqual(resume, { ok: true, state: 'receipt_pending' });
});

test('legacy receipt_pending progress without attempted marker fails closed', () => {
  const resume = resumeProgressItem({ state: 'receipt_pending' }, { ok: true, action: 'repair_receipt' });
  assert.equal(resume.ok, false);
  assert.match(resume.error, /no durable receipt_attempted marker/);
});

test('receipt-pending patch preserves an existing receipt intent when item already has a receipt', () => {
  const savedIntent = { intent_id: 'existing-intent', applied_at: '2026-09-04T04:02:00Z' };
  assert.deepEqual(receiptPendingPatch({}, { receipt: { comment_id: 123 } }, { receipt_intent: savedIntent, receipt_attempted: false, receipt_possibly_performed: false }), { state: 'receipt_pending' });
});

test('PATCH response missing or dropping labels fails closed', () => {
  const item = { current_labels: ['source:xhs', 'status:source-ready', 'workflow:keep-me', 'type:interview-note'], projection: { labels: ['company:alibaba', 'source:xhs', 'status:source-ready', 'workflow:keep-me', 'type:interview-note'].sort() } };
  assert.throws(() => validatePatchResponse({}, item), /omitted labels/);
  assert.throws(() => validatePatchResponse({ labels: [{ name: 'type:interview-note' }, { name: 'source:xhs' }, { name: 'status:source-ready' }] }, item), /silent label loss/);
  assert.equal(validatePatchResponse({ labels: item.projection.labels }, item), true);
});

test('Issue PATCH uses complete JSON projection without unsupported If-Match CAS', () => {
  const args = buildPatchArgs({ repository: 'liqiangcc/interview-lab' }, { issue_number: 915 });
  assert.deepEqual(args, ['api', '--method', 'PATCH', 'repos/liqiangcc/interview-lab/issues/915', '--header', 'Accept: application/vnd.github+json', '--header', 'Content-Type: application/json', '--input', '-']);
  assert.ok(!args.includes('If-Match'));
});

test('immediate locked snapshot detects body/title/label drift before PATCH', () => {
  const before = { issue_number: 1509, current_body_sha256: 'body-sha', current_title: '[XHS] 63f76452', current_labels: ['source:xhs', 'status:source-ready', 'type:interview-note'] };
  assert.deepEqual(patchSnapshot(before), { issue_number: 1509, body_sha256: 'body-sha', title: '[XHS] 63f76452', labels: ['source:xhs', 'status:source-ready', 'type:interview-note'] });
  assert.equal(assertPatchSnapshotUnchanged(before, { ...before, current_labels: [...before.current_labels] }), true);
  assert.throws(() => assertPatchSnapshotUnchanged(before, { ...before, current_body_sha256: 'changed' }), /body changed/);
  assert.throws(() => assertPatchSnapshotUnchanged(before, { ...before, current_title: 'concurrent edit' }), /title changed/);
  assert.throws(() => assertPatchSnapshotUnchanged(before, { ...before, current_labels: ['source:xhs', 'type:interview-note'] }), /labels changed/);
});

test('PATCH HTTP 400 preserves response body/request id and never retries', () => {
  let calls = 0;
  let captured;
  const response = ['HTTP/2.0 400 Bad Request', 'X-GitHub-Request-Id: MOCK:400', '', JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] })].join('\n');
  const error = Object.assign(new Error('gh exited 1'), { stdout: response, stderr: 'gh: Bad Request (HTTP 400)' });
  assert.throws(() => ghMutationJson(
    buildPatchArgs({ repository: 'liqiangcc/interview-lab' }, { issue_number: 1509 }),
    { title: '[小米] 一面 · 63f76452', labels: ['company:xiaomi', 'source:xhs', 'status:source-ready', 'type:interview-note'] },
    (command, args, options) => { calls += 1; captured = { command, args, options }; throw error; },
  ), (caught) => {
    assert.match(caught.message, /HTTP\/2\.0 400 Bad Request/);
    assert.match(caught.message, /request_id=MOCK:400/);
    assert.match(caught.message, /Validation Failed/);
    assert.match(caught.message, /"field":"labels"/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(captured.command, 'gh');
  assert.equal(captured.args.at(-1), '--include');
  assert.equal(captured.options.input, JSON.stringify({ title: '[小米] 一面 · 63f76452', labels: ['company:xiaomi', 'source:xhs', 'status:source-ready', 'type:interview-note'] }));
  assert.match(captured.args.join(' '), /Content-Type: application\/json/);
  assert.match(formatGhMutationError(error), /request_id=MOCK:400/);
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
