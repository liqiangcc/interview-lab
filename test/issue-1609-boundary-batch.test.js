'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, disposition, sha256 } = require('../scripts/issue-1609-boundary-batch');

const ROOT = path.join(__dirname, '..', 'data', 'issue-1609');
const load = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
const files = (directory) => fs.readdirSync(path.join(ROOT, directory)).filter((name) => name.endsWith('.json')).sort();

test('Issue #1609 disposition is conservative and does not treat tags as evidence', () => {
  assert.equal(disposition('').disposition, 'blocked');
  assert.equal(disposition('#面经[话题]# #后端[话题]#').disposition, 'blocked');
  assert.equal(disposition('一面：自我介绍；面试官询问项目；手撕算法题').disposition, 'single-interview');
  assert.equal(disposition('Java 面试题库，整理常见知识点供刷题').disposition, 'not-interview');
  assert.equal(disposition('三场面试：公司甲、公司乙、公司丙').disposition, 'blocked');
});

test('Issue #1609 committed artifacts cover exactly the frozen 366-item scope', () => {
  const selection = load('selection-manifest.json');
  const plan = load('dry-run-plan.json');
  const journal = load('apply-journal.json');
  const digest = load('canonical-digest.json');
  const audit = load('post-apply-audit.json');
  assert.equal(selection.selected_count, 366);
  assert.deepEqual(selection.range, { min_issue: 1139, max_issue: 1508, expected_count: 366 });
  assert.equal(selection.source_repository_ref, '95b77bb261048059846273688e4b90a2e108b437');
  const { selection_sha256: selectionDigest, ...selectionWithoutDigest } = selection;
  assert.equal(selectionDigest, sha256(canonicalJson(selectionWithoutDigest)));
  const selectedNumbers = selection.items.map((item) => item.issue_number);
  assert.equal(new Set(selectedNumbers).size, 366);
  assert.ok(selectedNumbers.every((number) => number >= 1139 && number <= 1508));
  assert.deepEqual(selection.read_audit.exact_issue_numbers, Array.from({ length: 370 }, (_, i) => 1139 + i));
  assert.equal(plan.total, 366);
  assert.equal(plan.mutation_count, 0);
  assert.equal(journal.entries.length, 366);
  assert.equal(journal.mutation_count, 0);
  assert.equal(audit.audit_status, 'not-run');
  assert.equal(audit.mutation_count, 0);
  assert.equal(files('evidence').length, 366);
  assert.equal(files('requests').length, 366);
  assert.equal(files('receipts').length, 366);
  assert.equal(digest.evidence_count, 366);
  assert.equal(digest.request_count, 366);
  assert.equal(digest.receipt_count, 366);
});

test('each evidence record is bound to its frozen body and exact artifact', () => {
  const selection = load('selection-manifest.json');
  const byIssue = new Map(selection.items.map((item) => [item.issue_number, item]));
  for (const file of files('evidence')) {
    const evidence = load(path.join('evidence', file));
    const item = byIssue.get(evidence.issue_number);
    assert.ok(item, file);
    assert.equal(evidence.body_sha256, item.body_sha256, file);
    assert.equal(evidence.source_repository_ref, selection.source_repository_ref, file);
    assert.ok(item.artifacts.some((artifact) => artifact.ref === evidence.source_evidence.ref && artifact.git_blob_sha === evidence.source_evidence.git_blob_sha), file);
    const { evidence_sha256: ignored, ...withoutDigest } = evidence;
    assert.equal(evidence.evidence_sha256, sha256(canonicalJson(withoutDigest)), file);
    assert.ok(evidence.source_evidence.excerpt.locator.startsWith('artifact-line:'), file);
    assert.equal(evidence.source_ready_claimed, false, file);
  }
});

test('all planned receipts are explicitly non-live and no Raw mutation is claimed', () => {
  for (const file of files('receipts')) {
    const receipt = load(path.join('receipts', file));
    assert.equal(receipt.receipt_state, 'not-applied', file);
    assert.equal(receipt.mutation_attempted, false, file);
    assert.equal(receipt.possibly_performed, false, file);
  }
});
