'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyBoundary,
  validateRequest,
} = require('../scripts/lib/issue-1606-boundary');
const {
  recomputeDigest,
  validateInputs,
  validateItemAnchors,
  validateRequestAnchors,
} = require('../scripts/plan-issue-1606-boundary-batch');

const root = path.join(__dirname, '..');
const selection = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/selection-manifest.json'), 'utf8'));
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/source-inventory.json'), 'utf8'));
const plan = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/boundary.dry-run.json'), 'utf8'));
const journal = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/apply-journal.json'), 'utf8'));
const digest = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/canonical-digest.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/boundary-review-report.json'), 'utf8'));
const requestDir = path.join(root, 'data/issue-1606/requests');

function projection(text) {
  return { status: 'verified', lines: [{ line: 1, text }] };
}

test('issue #1606 selection is exactly #20..#392 pending set and never probes outside range', () => {
  assert.equal(selection.selected_count, selection.items.length);
  assert.ok(selection.selected_count > 0);
  assert.deepEqual(selection.read_audit.exact_issue_numbers, Array.from({ length: 373 }, (_, index) => index + 20));
  assert.deepEqual(selection.read_audit.out_of_range_issue_numbers, []);
  assert.equal(new Set(selection.items.map((item) => item.issue_number)).size, selection.selected_count);
  assert.equal(selection.items.every((item) => item.issue_number >= 20 && item.issue_number <= 392), true);
  assert.equal(selection.items.every((item) => item.source_repository_ref === '95b77bb261048059846273688e4b90a2e108b437'), true);
});

test('source inventory binds all selected items to verified Source projection evidence', () => {
  assert.equal(inventory.selection_sha256, selection.selection_sha256);
  assert.equal(inventory.item_count, selection.selected_count);
  assert.equal(inventory.verified_count + inventory.blocked_count, selection.selected_count);
  assert.equal(inventory.items.length, selection.selected_count);
  assert.equal(inventory.items.every((item) => item.artifact.provenance === 'source_projection'), true);
  assert.equal(inventory.items.every((item) => item.source_repository_ref === '95b77bb261048059846273688e4b90a2e108b437'), true);
  assert.equal(inventory.transport_policy.method, 'GET');
  assert.equal(inventory.transport_policy.endpoint, 'raw.githubusercontent.com');
  assert.equal(inventory.transport_policy.source_projection_only, true);
  assert.equal(inventory.transport_policy.single_object_get, true);
  assert.equal(inventory.transport_policy.concurrency, 4);
  assert.equal(inventory.transport_policy.max_attempts_per_item, 3);
  assert.equal(inventory.transport_policy.clone, false);
  assert.equal(inventory.transport_policy.http_range_header, false);
  assert.equal(inventory.items.every((item) => item.verification.method === 'local-cache' || item.verification.method === 'controlled-get'), true);
  assert.equal(inventory.items.every((item) => /^[0-9a-f]{64}$/.test(item.body_sha256)), true);
});

test('canonical digests and per-item anchors are independently recomputable', () => {
  assert.equal(selection.selection_sha256, recomputeDigest(selection, 'selection_sha256'));
  assert.equal(inventory.inventory_sha256, recomputeDigest(inventory, 'inventory_sha256'));
  assert.equal(plan.plan_sha256, recomputeDigest(plan, 'plan_sha256'));
  assert.equal(journal.journal_sha256, recomputeDigest(journal, 'journal_sha256'));
  assert.equal(digest.canonical_sha256, recomputeDigest(digest, 'canonical_sha256'));
  assert.equal(report.report_sha256, recomputeDigest(report, 'report_sha256'));
  assert.equal(report.plan_sha256, plan.plan_sha256);
  assert.equal(report.items.length, selection.selected_count);
  const inventoryByNumber = new Map(inventory.items.map((item) => [item.issue_number, item]));
  for (const item of selection.items) {
    const inventoryItem = inventoryByNumber.get(item.issue_number);
    assert.deepEqual(validateItemAnchors(item, inventoryItem), []);
    const planned = plan.items.find((candidate) => candidate.issue_number === item.issue_number);
    const request = JSON.parse(fs.readFileSync(path.join(root, planned.request_file), 'utf8'));
    assert.deepEqual(validateRequestAnchors(request, item, inventoryItem), []);
    const reported = report.items.find((candidate) => candidate.issue_number === item.issue_number);
    assert.ok(reported);
    assert.equal(reported.request_sha256, planned.request_sha256);
    assert.equal(reported.artifact_ref, request.evidence.artifact_ref);
    assert.equal(reported.artifact_git_blob_sha, request.evidence.git_blob_sha);
    assert.equal(reported.artifact_byte_size, request.evidence.byte_size);
    assert.equal(reported.artifact_provenance, 'source_projection');
    assert.ok(reported.evidence_locator);
    if (reported.disposition === 'ready') assert.ok(reported.evidence_excerpt);
    if (reported.disposition === 'blocked') assert.ok(reported.block_reason);
  }
});

test('anchor gate rejects self-reported digest tampering, substitutions, omissions, and request drift', () => {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const tamperedSelection = clone(selection);
  tamperedSelection.items[0].title = 'substituted title';
  assert.match(validateInputs(tamperedSelection, inventory).join('\n'), /selection canonical SHA-256 does not recompute/);

  const tamperedInventory = clone(inventory);
  tamperedInventory.items[0].artifact.git_blob_sha = '0'.repeat(40);
  tamperedInventory.inventory_sha256 = recomputeDigest(tamperedInventory, 'inventory_sha256');
  assert.match(validateInputs(selection, tamperedInventory).join('\n'), /selected Source projection artifact/);

  const substitutedSelection = clone(selection);
  substitutedSelection.items[0].source_note_id = 'xhs-note:substituted';
  substitutedSelection.selection_sha256 = recomputeDigest(substitutedSelection, 'selection_sha256');
  assert.match(validateInputs(substitutedSelection, inventory).join('\n'), /source_note_id anchor mismatch/);

  const omittedInventory = clone(inventory);
  omittedInventory.items.pop();
  omittedInventory.item_count -= 1;
  omittedInventory.inventory_sha256 = recomputeDigest(omittedInventory, 'inventory_sha256');
  assert.match(validateInputs(selection, omittedInventory).join('\n'), /source inventory must contain exactly 327 items|inventory issue sets differ/);

  const request = JSON.parse(fs.readFileSync(path.join(requestDir, '0103.json'), 'utf8'));
  const driftedRequest = clone(request);
  driftedRequest.expected_body_sha256 = 'f'.repeat(64);
  const item = selection.items.find((candidate) => candidate.issue_number === 103);
  const inventoryItem = inventory.items.find((candidate) => candidate.issue_number === 103);
  assert.match(validateRequestAnchors(driftedRequest, item, inventoryItem).join('\n'), /expected_body_sha256 anchor mismatch/);

  const replacedArtifactRequest = clone(request);
  replacedArtifactRequest.evidence.artifact_ref = inventoryItem.artifact.ref.replace('note_desc/', 'note_json/');
  assert.match(validateRequestAnchors(replacedArtifactRequest, item, inventoryItem).join('\n'), /evidence\.artifact_ref anchor mismatch/);
});

test('same-process rounds are single boundary, aggregate events remain blocked', () => {
  assert.equal(classifyBoundary(projection('百度一面、二面、三面均已面完，属于同一招聘流程')).decision, 'single-interview');
  assert.equal(classifyBoundary(projection('这几天面了几家公司，分别记录如下')).status, 'blocked');
  assert.equal(classifyBoundary(projection('这是一份模拟面试题库')).decision, 'not-interview');
  assert.equal(classifyBoundary(projection('#Java面试题[话题]# #求职[话题]#')).status, 'blocked');
});

test('adversarial boundary cases require completed-event evidence', () => {
  assert.equal(classifyBoundary(projection('刷新简历当天约面\n下面整理可能会问的问题')).status, 'blocked');
  assert.equal(classifyBoundary(projection('7.29约面\n8.5面试\n问的内容如下')).status, 'blocked');
  assert.equal(classifyBoundary(projection('电话约面')).status, 'blocked');
  assert.equal(classifyBoundary(projection('面试题：HashMap 如何扩容？')).decision, 'not-interview');
  assert.equal(classifyBoundary(projection('有看过STL里面的sort吗')).status, 'blocked');
  assert.equal(classifyBoundary(projection('最后挂了，等通知')).status, 'blocked');
  assert.equal(classifyBoundary(projection('周五面的，每天早上看邮箱，生怕挂了')).decision, 'single-interview');
  assert.equal(classifyBoundary(projection('参加面试并完成现场沟通，随后等待结果')).decision, 'single-interview');
});

test('P1 spot checks use completed evidence and block appointment/question-only notes', () => {
  assert.equal(classifyBoundary(inventory.items.find((item) => item.issue_number === 103)).decision, 'single-interview');
  assert.match(classifyBoundary(inventory.items.find((item) => item.issue_number === 103)).evidence_line.text, /面的/);
  assert.equal(classifyBoundary(inventory.items.find((item) => item.issue_number === 143)).decision, 'single-interview');
  assert.equal(classifyBoundary(inventory.items.find((item) => item.issue_number === 285)).decision, 'single-interview');
  assert.equal(classifyBoundary(inventory.items.find((item) => item.issue_number === 305)).decision, 'not-interview');
  assert.equal(classifyBoundary(projection('电话约面')).status, 'blocked');
  assert.equal(classifyBoundary(inventory.items.find((item) => item.issue_number === 389)).decision, 'single-interview');
  assert.match(classifyBoundary(inventory.items.find((item) => item.issue_number === 389)).evidence_line.text, /面完/);
});

test('semantic negative spot checks never become single-interview', () => {
  const expected = {
    116: 'not-interview',
    186: 'not-interview',
    227: 'blocked',
    234: 'multi-interview',
    262: 'not-interview',
    266: 'not-interview',
    303: 'not-interview',
    351: 'blocked',
    355: 'blocked',
    381: 'not-interview',
    388: 'multi-interview',
  };
  for (const [issueNumber, disposition] of Object.entries(expected)) {
    const review = classifyBoundary(inventory.items.find((item) => item.issue_number === Number(issueNumber)));
    assert.equal(review.status, disposition === 'blocked' ? 'blocked' : 'ready', `#${issueNumber}`);
    assert.equal(review.decision, disposition === 'blocked' ? null : disposition, `#${issueNumber}`);
    const planned = plan.items.find((item) => item.issue_number === Number(issueNumber));
    assert.equal(planned.disposition, review.status, `plan #${issueNumber}`);
    assert.equal(planned.decision, review.decision, `plan #${issueNumber}`);
  }
  assert.equal(classifyBoundary(inventory.items.find((item) => item.issue_number === 28)).decision, 'single-interview');
  assert.equal(classifyBoundary(inventory.items.find((item) => item.issue_number === 28)).evidence_line.line, 6);
});

test('semantic adversarial cases distinguish curated advice, recruiting calendars, aggregate, and isolated outcomes', () => {
  assert.equal(classifyBoundary(projection('小孙同学投稿：网易云音乐二面')).decision, 'not-interview');
  assert.equal(classifyBoundary(projection('面试资料整理，欢迎提问')).decision, 'not-interview');
  assert.equal(classifyBoundary(projection('秋招宣讲日程：本周六、本周日安排面试')).decision, 'not-interview');
  assert.equal(classifyBoundary(projection('面完国内所有大厂后的面试总结')).status, 'blocked');
  assert.ok(['blocked', 'ready'].includes(classifyBoundary(projection('美团和百度两个独立流程，分别等待结果')).status));
  assert.equal(classifyBoundary(projection('面试资料整理，欢迎提问')).decision, 'not-interview');
  assert.equal(classifyBoundary(projection('二面完秒拒信')).status, 'blocked');
  assert.equal(classifyBoundary(projection('面试通过了，求助这家公司靠谱吗')).status, 'blocked');
  assert.equal(classifyBoundary(projection('美团在招 Java，二面过后就知道能不能拿 offer')).decision, 'not-interview');
});

test('every selected item has an independent validated request and dry-run has zero mutations', () => {
  assert.equal(plan.counts.total, selection.selected_count);
  assert.equal(plan.items.length, selection.selected_count);
  assert.equal(journal.mutation_count, 0);
  assert.equal(journal.live_apply_authorized, false);
  assert.equal(digest.live_mutations, 0);
  for (const item of plan.items) {
    const request = JSON.parse(fs.readFileSync(path.join(root, item.request_file), 'utf8'));
    const validation = validateRequest(request);
    assert.equal(validation.ok, true, `#${item.issue_number}: ${validation.errors.join('; ')}`);
    assert.equal(request.issue_number, item.issue_number);
    assert.equal(request.expected_body_sha256, item.body_sha256);
    assert.equal(request.expected_source_repository_ref, '95b77bb261048059846273688e4b90a2e108b437');
    assert.equal(request.evidence.artifact_provenance, 'source_projection');
  }
  assert.equal(fs.readdirSync(requestDir).filter((file) => file.endsWith('.json')).length, selection.selected_count);
});
