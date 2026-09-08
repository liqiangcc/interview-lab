'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadComments, loadAllIssues, loadLabels, buildInventoryReport, fixedInventoryAudit, parseArgs, resumeProgressItem, receiptPendingPatch, validatePatchResponse, parseGhIncludedJson, formatGhMutationError, ghMutationJson, buildPatchArgs, patchSnapshot, assertPatchSnapshotUnchanged, acquireApplyLock } = require('../scripts/plan-interview-context-learning-discovery');

function discoveryFixture(number, overrides = {}) {
  const id = `xhs:discovery-${String(number).padStart(8, '0')}`;
  const revision = `${id}:r1`;
  const record = {
    schema_version: 'interview-note-issue.v2', interview_note_id: id,
    source: { system: 'xhs', external_id: `discovery-${String(number).padStart(8, '0')}`, url: null },
    source_revision: { id: revision, captured_at: null },
    source_published_at: { precision: 'year', value: '2024' },
    source_edited_at: { precision: 'unknown', value: null },
    interview_occurred_at: { precision: 'year', value: '2023' },
    artifacts: [{ kind: 'html', ref: `${id}.html`, sha256: null, provenance: 'raw_capture' }],
    limitations: ['fixture evidence'],
  };
  const body = `<!-- interview-note: id=${id} schema=interview-note-issue.v2 -->\n<!-- interview-note-record\n${JSON.stringify(record, null, 2)}\n-->\n\n## 来源身份\n\n## 原始标题\n\n## 原始正文\n\nRaw source body ${number}\n\n## 原始附件\n\n- raw\n\n## 来源限制\n\n- fixture\n\n## 派生链接\n`;
  const context = {
    schema_version: 'interview-context.v1', context_id: `${id}:context-v1`, interview_note_id: id,
    source_revision_id: revision, review_status: 'reviewed', reviewed_at: '2026-09-08T00:00:00Z',
    company: { id: 'acme', display_name: 'Acme', basis: 'source-explicit', evidence_refs: ['raw-title:Acme'] },
    role: { family: 'backend', title: '后端', basis: 'source-explicit', evidence_refs: ['raw-title:后端'] },
    recruitment_type: { value: 'campus', basis: 'reviewed-inference', evidence_refs: ['raw-title:校招'] },
    round: { value: '2', basis: 'source-explicit', evidence_refs: ['raw-title:二面'] },
    interview_occurred_at: { precision: 'year', value: '2023', basis: 'source-explicit', evidence_refs: ['record:interview_occurred_at'] },
    outcome_visibility: 'sealed-until-source-reveal',
  };
  return {
    issue: { number, state: 'open', title: `Raw title ${number}`, body, labels: [{ name: 'type:interview-note' }, { name: 'status:source-ready' }, { name: 'source:xhs' }] },
    context, id, ...overrides,
  };
}

function writeContext(directory, fixture, name = `${fixture.number || fixture.issue.number}.v1.json`) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${JSON.stringify(fixture.context, null, 2)}\n`);
  return file;
}

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

test('pagination handles an empty terminal page and propagates page exceptions', () => {
  const pages = [];
  assert.deepEqual(loadAllIssues('liqiangcc/interview-lab', { readPage: (page) => { pages.push(page); return []; } }), []);
  assert.deepEqual(pages, [1]);
  assert.throws(() => loadAllIssues('liqiangcc/interview-lab', { readPage: (page) => { throw new Error(`page ${page} unavailable`); } }), /page 1 unavailable/);
});

test('full source-ready inventory emits stable plan-only discovery digest without changing Raw body', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-discovery-'));
  const fixtures = Array.from({ length: 100 }, (_, index) => discoveryFixture(index + 1));
  for (const fixture of fixtures) writeContext(directory, fixture);
  const issues = fixtures.map((fixture) => fixture.issue);
  const before = issues.map((issue) => issue.body);
  const first = buildInventoryReport(issues, directory);
  const second = buildInventoryReport(issues, directory);
  assert.equal(first.schema_version, 'interview-context-learning-discovery-plan.v2');
  assert.equal(first.plan_only, true);
  assert.equal(first.mutation_authorized, false);
  assert.deepEqual(first.transport, { method: 'GET', writes: false });
  assert.equal(first.source_ready_count, 100);
  assert.equal(first.eligible_count, 100);
  assert.equal(first.planned_count, 100);
  assert.equal(first.mutation_count, 0);
  assert.equal(first.blocked_count, 0);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(issues.map((issue) => issue.body), before);
  assert.deepEqual(first.items[0].proposed_labels.filter((label) => label.startsWith('company:')), ['company:acme']);
  assert.ok(first.items[0].proposed_labels.includes('source-year:2024'));
  assert.ok(first.items[0].proposed_labels.includes('interview-year:2023'));
  assert.equal(first.items[0].raw_body_modified, false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('Unknown context facts stay unknown and do not become invented labels', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-discovery-unknown-'));
  const fixture = discoveryFixture(201);
  fixture.context.company = { id: null, display_name: null, basis: 'unknown', evidence_refs: [] };
  fixture.context.role = { family: 'unknown', title: null, basis: 'unknown', evidence_refs: [] };
  fixture.context.recruitment_type = { value: 'unknown', basis: 'unknown', evidence_refs: [] };
  fixture.context.round = { value: 'unknown', basis: 'unknown', evidence_refs: [] };
  fixture.context.interview_occurred_at = { precision: 'unknown', value: null, basis: 'unknown', evidence_refs: [] };
  writeContext(directory, fixture);
  const item = buildInventoryReport([fixture.issue], directory).items[0];
  assert.deepEqual(item.unknown_facts, ['company', 'role', 'recruitment_type', 'round', 'interview_occurred_at']);
  assert.equal(item.proposed_labels.some((label) => /^(company|role|recruitment|round|interview-year):/.test(label)), false);
  assert.ok(item.proposed_labels.includes('source-year:2024'));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('missing, malformed, invalid, and mismatched Context evidence are blocked in the ledger', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-discovery-blocked-'));
  const good = discoveryFixture(301);
  const missing = discoveryFixture(302);
  const malformed = discoveryFixture(303);
  malformed.issue.body = `${malformed.issue.body}\n<!-- interview-note: id=wrong schema=interview-note.v99 -->`;
  const invalid = discoveryFixture(304);
  invalid.context.review_status = 'pending';
  const mismatch = discoveryFixture(305);
  mismatch.context.source_revision_id = `${mismatch.id}:r2`;
  writeContext(directory, good);
  writeContext(directory, invalid);
  writeContext(directory, mismatch);
  fs.writeFileSync(path.join(directory, 'broken.json'), '{not json');
  const report = buildInventoryReport([good.issue, missing.issue, malformed.issue, invalid.issue, mismatch.issue], directory);
  assert.equal(report.eligible_count, 1);
  assert.equal(report.items.length, 1);
  assert.equal(report.source_ready_missing_context_count, 1);
  assert.ok(report.blocked_count >= 4);
  assert.ok(report.blocked.some((entry) => entry.issue_number === 302 && /Context artifact is missing/.test(entry.reason)));
  assert.ok(report.blocked.some((entry) => entry.issue_number === 303));
  assert.ok(report.blocked.some((entry) => entry.issue_number === 305 && /source_revision_id/.test(entry.reason)));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('duplicate reviewed Context identities fail closed instead of selecting an arbitrary artifact', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-discovery-duplicate-context-'));
  const fixture = discoveryFixture(401);
  const second = discoveryFixture(402);
  second.context.interview_note_id = fixture.id;
  second.context.context_id = `${fixture.id}:context-v2`;
  writeContext(directory, fixture, 'a.json');
  writeContext(directory, second, 'b.json');
  const report = buildInventoryReport([fixture.issue], directory);
  assert.equal(report.eligible_count, 0);
  assert.equal(report.items.length, 0);
  assert.ok(report.blocked.some((entry) => entry.reason === 'duplicate reviewed Context identity'));
  fs.rmSync(directory, { recursive: true, force: true });
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
