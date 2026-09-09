'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SOURCE_REF,
  canonicalize,
  sha256,
  gitBlobSha,
  validateIssueSnapshot,
  sourceBytes,
  sourceProjectionText,
  sourceSnapshotCanonicalDigest,
  fetchSourceSnapshotForPlan,
  proposalFromClassification,
  buildReviewPlan,
  validateReviewPlan,
} = require('../scripts/lib/issue-1656-dynamic-boundary-review');

const SNAPSHOT_FILE = path.join(__dirname, '..', 'data', 'pilot', 'issue-1611', 'source-note-live.snapshot.json');
const INVENTORY = require('../data/pilot/issue-1656/pending-inventory.json');
const SUMMARY = require('../data/pilot/issue-1656/bundle-summary.json');

test('the complete live snapshot is pagination-audited, and pagination tampering fails closed', () => {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  const result = validateIssueSnapshot(snapshot);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.issues.length, 1460);
  const tampered = JSON.parse(JSON.stringify(snapshot));
  tampered.pagination.terminal_page_short = false;
  const rejected = validateIssueSnapshot(tampered);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((error) => /terminal page/.test(error)));
});

test('source projection content must match both the declared byte size and Git blob SHA', () => {
  const text = '一面：面试官追问项目\n手撕合并有序链表';
  const bytes = Buffer.from(text, 'utf8');
  const artifact = { git_blob_sha: gitBlobSha(bytes), byte_size: bytes.length };
  const entry = { git_blob_sha: artifact.git_blob_sha, byte_size: bytes.length, text };
  assert.equal(sourceBytes(entry, artifact).toString('utf8'), text);
  assert.throws(() => sourceBytes({ ...entry, text: `${text}!` }, artifact), /Git blob SHA mismatch/);
  assert.throws(() => sourceBytes({ ...entry, byte_size: bytes.length + 1 }, artifact), /declared byte size mismatch/);
});

test('classification requires personal event/Q&A and independent multi case evidence', () => {
  const item = {
    issue_number: 101,
    title: '面经',
    source_projection: { git_blob_sha: 'a'.repeat(40), kind: 'text_projection', provenance: 'source_projection' },
  };
  const single = proposalFromClassification(item, '一面：面试官追问项目\n手撕合并有序链表\n为什么选择这个方案？');
  assert.equal(single.proposal.decision, 'single-interview');
  assert.equal(single.status, 'proposal-only');
  const multi = proposalFromClassification({ ...item, issue_number: 102 }, 'oppo 一面已完成，面试官追问项目\n1. 如何保证缓存一致性？\n\n得物二面已完成，面试官追问项目\n1. 如何设计限流器？');
  assert.equal(multi.proposal.decision, 'multi-interview');
  assert.ok(multi.proposal.case_count >= 2);
  const multiLocators = multi.proposal.cases.flatMap((candidate) => candidate.evidence.map((evidence) => evidence.locator));
  assert.equal(new Set(multiLocators).size, multiLocators.length);
  assert.equal(multi.status, 'proposal-only');
  const companyOnly = proposalFromClassification({ ...item, issue_number: 103 }, 'oppo、得物、贝壳找房\n多家公司经验总结');
  assert.equal(companyOnly.proposal.decision, null);
  assert.equal(companyOnly.status, 'blocked-proposal');
});

test('JSON projection classification uses only note.desc and blocks metadata/generic regressions', () => {
  const jsonItem = {
    issue_number: 1349,
    source_note_id: 'xhs-note:case-1349',
    title: '[XHS Source] metadata must not be classified',
    source_projection: { git_blob_sha: '0'.repeat(40), kind: 'json', provenance: 'source_projection' },
  };
  const json = {
    global: { ICPInfoList: [{ title: '阿里 腾讯 京东 面试 offer' }], ad: '教程/营销/招聘' },
    note: { noteDetailMap: { 'case-1349': { note: {
      title: '4面进鹅厂后端开发',
      desc: '时间线和面经：\n❇️ 9.1-一面\n1. redis加锁解锁的本身操作是什么？\n2. 如何处理TCP粘包？',
    } } } },
  };
  const bytes = Buffer.from(JSON.stringify(json), 'utf8');
  jsonItem.source_projection.git_blob_sha = gitBlobSha(bytes);
  jsonItem.source_projection.byte_size = bytes.length;
  const projection = sourceProjectionText(bytes, jsonItem.source_projection, jsonItem);
  assert.equal(projection.title, '4面进鹅厂后端开发');
  assert.match(projection.text, /redis加锁/);
  assert.doesNotMatch(projection.text, /ICPInfoList|招聘/);
  const single = proposalFromClassification({ ...jsonItem, source_title: projection.title }, projection.text, false, null, projection.path);
  assert.equal(single.proposal.decision, 'single-interview');
  const metadataOnly = sourceProjectionText(Buffer.from(JSON.stringify({ global: { title: '多家公司面试 offer' }, note: { noteDetailMap: { 'case-1349': { note: { title: '面经', desc: '多家公司经验总结\n建议收藏题库' } } } } }), 'utf8'), jsonItem.source_projection, jsonItem);
  const blocked = proposalFromClassification({ ...jsonItem, source_title: metadataOnly.title }, metadataOnly.text, false, null, metadataOnly.path);
  assert.equal(blocked.proposal.decision, null);
  assert.equal(blocked.status, 'blocked-proposal');
  const missingDesc = sourceProjectionText(Buffer.from(JSON.stringify({ note: { noteDetailMap: { 'case-1349': { note: { title: '面经' } } } } }), 'utf8'), jsonItem.source_projection, jsonItem);
  assert.equal(missingDesc.text, null);
  assert.match(missingDesc.error, /note\.desc is missing/);
});

test('generic and third-party summary fixtures remain blocked rather than arbitrary single/not-interview', () => {
  for (const [issue, text] of [
    [121, '准备的都没用上，好多概念搞混了'],
    [1074, '1. 请做一个简短的自我介绍。\n2. 为什么选择投递小米？'],
    [1194, '自我介绍+项目学习渠道\n1. 讲讲Spring和SpringBoot'],
    [1212, '1、Java面向对象怎么理解？\n2、HashMap的扩容原理'],
    [1244, '快手面真题拆解分析\n1. 如何设计高并发架构？'],
    [1273, 'AI面试软件开发题库\n1. 选择语言'],
    [1336, '百度面试话术原则\n建议这样回答'],
    [1182, '近期京东3面压力感拉满，综合粉丝投稿\nRedis宕机后本地缓存如何兜底？'],
  ]) {
    const result = proposalFromClassification({ issue_number: issue, title: 'generic', source_projection: { git_blob_sha: 'c'.repeat(40), kind: 'text_projection', provenance: 'source_projection' } }, text);
    assert.equal(result.proposal.decision, null, `#${issue} must remain undecided`);
    assert.equal(result.status, 'blocked-proposal', `#${issue} must remain blocked`);
  }
});

test('source blob retry is bounded per item and preserves blocked scope', async () => {
  const good = Buffer.from('cached-or-network text', 'utf8');
  const goodSha = gitBlobSha(good);
  const plan = { items: [
    { issue_number: 1, source_projection: { blob_sha: goodSha, byte_size: good.length } },
    { issue_number: 2, source_projection: { blob_sha: 'd'.repeat(40), byte_size: 4 } },
  ] };
  const calls = new Map();
  const snapshot = await fetchSourceSnapshotForPlan(plan, async (artifact) => {
    calls.set(artifact.git_blob_sha, (calls.get(artifact.git_blob_sha) || 0) + 1);
    if (artifact.git_blob_sha === goodSha) return good;
    throw new Error('transient TLS test failure');
  }, { maxAttempts: 2, retryDelayMs: 0, cacheDir: null });
  assert.equal(Object.keys(snapshot.items).length, 2);
  assert.equal(snapshot.items['1'].status, 'verified');
  assert.equal(snapshot.items['2'].status, 'blocked');
  assert.equal(snapshot.items['2'].error.attempts, 2);
  assert.equal(calls.get('d'.repeat(40)), 2);
  assert.equal(snapshot.errors.length, 1);
  assert.equal(snapshot.canonical_digest, sourceSnapshotCanonicalDigest(snapshot));
});

test('a blocked source item never collapses the complete 421-row review scope', () => {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  const row = INVENTORY.items.find((item) => item.issue_number === 31);
  const plan = buildReviewPlan({
    issueSnapshot: snapshot,
    inventory: INVENTORY,
    bundleSummary: SUMMARY,
    sourceSnapshot: {
      schema_version: 'issue-1656-source-projection-snapshot.v1',
      source_repository: 'liqiangcc/xhs', source_ref: SOURCE_REF,
      items: { '31': { issue_number: 31, status: 'blocked', git_blob_sha: row.source_projection_blob_sha, byte_size: row.source_projection_byte_size, error: { code: 'source-blob-read-failed', message: 'transient TLS' } } },
      errors: [{ issue_number: 31, code: 'source-blob-read-failed', message: 'transient TLS' }],
    },
    capturedAt: '2026-09-09T00:00:00.000Z',
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.scope.total, 421);
  assert.equal(plan.items.length, 421);
  assert.equal(plan.summary.durable_reviews, 0);
  assert.ok(plan.errors.some((error) => /#31/.test(error)));
  assert.equal(plan.mutation_guard.mutation, 0);
});

test('valid text/json local cache is preferred without writing or fetching', async () => {
  const cacheDir = fs.mkdtempSync('/tmp/issue-1656-cache-');
  try {
    const text = Buffer.from('一面已完成\n1. 如何设计缓存？', 'utf8');
    const json = Buffer.from(JSON.stringify({ note: { noteDetailMap: { json1: { note: { title: '面经', desc: '一面已完成\n1. 如何设计缓存？' } } } } }), 'utf8');
    const textItem = { issue_number: 10, source_note_id: 'xhs-note:text1', source_projection: { blob_sha: gitBlobSha(text), byte_size: text.length, kind: 'text_projection' } };
    const jsonItem = { issue_number: 11, source_note_id: 'xhs-note:json1', source_projection: { blob_sha: gitBlobSha(json), byte_size: json.length, kind: 'json' } };
    fs.writeFileSync(path.join(cacheDir, 'text1.txt'), text);
    fs.writeFileSync(path.join(cacheDir, 'json1.json'), json);
    let fetched = 0;
    const snapshot = await fetchSourceSnapshotForPlan({ items: [textItem, jsonItem] }, async () => { fetched += 1; throw new Error('must not fetch cache hits'); }, { maxAttempts: 2, retryDelayMs: 0, cacheDir });
    assert.equal(fetched, 0);
    assert.equal(snapshot.items['10'].retrieval, 'local-cache');
    assert.equal(snapshot.items['11'].retrieval, 'local-cache');
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('#735 is independently marked and never receives a heuristic decision', () => {
  const result = proposalFromClassification({
    issue_number: 735,
    title: '多面经',
    source_projection: { git_blob_sha: 'b'.repeat(40), kind: 'text_projection', provenance: 'source_projection' },
  }, '第一家公司一面\n第二家公司二面\n第三家公司终面', true);
  assert.equal(result.proposal.decision, null);
  assert.equal(result.status, 'independent-review-required');
  assert.match(result.rationale, /#735/);
});

test('body SHA tampering blocks the 421-row plan before source proposal generation', () => {
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  const tampered = JSON.parse(JSON.stringify(snapshot));
  tampered.issues.find((issue) => issue.number === 31).body += '\n tampered';
  const plan = buildReviewPlan({ issueSnapshot: tampered, inventory: INVENTORY, bundleSummary: SUMMARY, capturedAt: '2026-09-09T00:00:00.000Z' });
  assert.equal(plan.ok, false);
  assert.equal(plan.scope.total, 0);
  assert.ok(plan.errors.some((error) => /body SHA/.test(error)));
  assert.equal(plan.mutation_guard.mutation, 0);
});

test('generated plan validator rejects canonical digest or durable-state tampering', () => {
  const file = path.join(__dirname, '..', 'data', 'pilot', 'issue-1656', 'dynamic-review-plan.json');
  if (!fs.existsSync(file)) return;
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (plan.scope?.total !== 421) return;
  const valid = validateReviewPlan(plan, INVENTORY);
  assert.equal(valid.ok, true, valid.errors.join('; '));
  assert.equal(plan.items.length, 421);
  for (const item of plan.items) {
    assert.ok(['single-interview', 'multi-interview', 'not-interview', null].includes(item.proposal.decision));
    assert.ok(['proposal-only', 'blocked-proposal', 'independent-review-required'].includes(item.review.status));
    assert.equal(item.review.durable_review, false);
    assert.equal(item.review.evidence_comment.comment_id, null);
    assert.equal(item.review.transition_id, null);
    assert.ok(Array.isArray(item.line_evidence));
  }
  assert.equal(plan.items.find((item) => item.issue_number === 1349).proposal.decision, 'single-interview');
  assert.notEqual(plan.items.find((item) => item.issue_number === 782).proposal.decision, 'multi-interview');
  const sourceDigest = sha256(canonicalize(plan.items.map((item) => ({
    issue_number: item.issue_number,
    ref: item.source_projection.ref,
    blob_sha: item.source_projection.blob_sha,
    byte_size: item.source_projection.byte_size_verified,
    content_sha256: item.source_projection.content_sha256,
  }))));
  assert.equal(plan.source_snapshot.digest, sourceDigest);
  assert.equal(sha256(canonicalize(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'canonical_digest')))), plan.canonical_digest);
  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.items[0].review.durable_review = true;
  assert.equal(validateReviewPlan(tampered, INVENTORY).ok, false);
  tampered.items[0].review.durable_review = false;
  tampered.canonical_digest = sha256(canonicalize(Object.fromEntries(Object.entries(tampered).filter(([key]) => key !== 'canonical_digest'))));
  tampered.items[0].source_projection_blob_sha = '0'.repeat(40);
  assert.equal(validateReviewPlan(tampered, INVENTORY).ok, false);
});
