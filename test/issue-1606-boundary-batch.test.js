'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyBoundary,
  validateRequest,
} = require('../scripts/lib/issue-1606-boundary');

const root = path.join(__dirname, '..');
const selection = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/selection-manifest.json'), 'utf8'));
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/source-inventory.json'), 'utf8'));
const plan = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/boundary.dry-run.json'), 'utf8'));
const journal = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/apply-journal.json'), 'utf8'));
const digest = JSON.parse(fs.readFileSync(path.join(root, 'data/issue-1606/canonical-digest.json'), 'utf8'));
const requestDir = path.join(root, 'data/issue-1606/requests');

function projection(text) {
  return { status: 'verified', lines: [{ line: 1, text }] };
}

test('issue #1606 selection is exactly #20..#392 pending set and never probes outside range', () => {
  assert.equal(selection.selected_count, 327);
  assert.equal(selection.items.length, 327);
  assert.deepEqual(selection.read_audit.exact_issue_numbers, Array.from({ length: 373 }, (_, index) => index + 20));
  assert.deepEqual(selection.read_audit.out_of_range_issue_numbers, []);
  assert.equal(new Set(selection.items.map((item) => item.issue_number)).size, 327);
  assert.equal(selection.items.every((item) => item.issue_number >= 20 && item.issue_number <= 392), true);
  assert.equal(selection.items.every((item) => item.source_repository_ref === '95b77bb261048059846273688e4b90a2e108b437'), true);
});

test('source inventory binds all selected items to verified Source projection evidence', () => {
  assert.equal(inventory.selection_sha256, selection.selection_sha256);
  assert.equal(inventory.item_count, 327);
  assert.equal(inventory.verified_count, 327);
  assert.equal(inventory.blocked_count, 0);
  assert.equal(inventory.items.every((item) => item.status === 'verified'), true);
  assert.equal(inventory.items.every((item) => item.artifact.provenance === 'source_projection'), true);
  assert.equal(inventory.items.every((item) => item.source_repository_ref === '95b77bb261048059846273688e4b90a2e108b437'), true);
});

test('same-process rounds are single boundary, aggregate events remain blocked', () => {
  assert.equal(classifyBoundary(projection('百度一面、二面、三面均为同一招聘流程')).decision, 'single-interview');
  assert.equal(classifyBoundary(projection('这几天面了几家公司，分别记录如下')).status, 'blocked');
  assert.equal(classifyBoundary(projection('这是一份模拟面试题库')).decision, 'not-interview');
  assert.equal(classifyBoundary(projection('#Java面试题[话题]# #求职[话题]#')).status, 'blocked');
});

test('every selected item has an independent validated request and dry-run has zero mutations', () => {
  assert.equal(plan.counts.total, 327);
  assert.equal(plan.items.length, 327);
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
  assert.equal(fs.readdirSync(requestDir).filter((file) => file.endsWith('.json')).length, 327);
});
