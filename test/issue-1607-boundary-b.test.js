'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FIRST_ISSUE,
  LAST_ISSUE,
  EXPECTED_COUNT,
  SOURCE_REF,
  bodyProjectionEvidence,
  graphQlQuery,
  isSelected,
  parseArgs,
} = require('../scripts/prepare-issue-1607-boundary-batch');
const { classifyProjection, classifyFullSource, evidenceFor, requestFor } = require('../scripts/generate-issue-1607-boundary-evidence');

function issue(number, labels = []) {
  return { number, state: 'OPEN', title: `[XHS Source] ${number}`, body: 'body', labels: { nodes: labels.map((name) => ({ name })) } };
}

function fullSourceItem(title, body) {
  return {
    source_projection: {
      text: body,
      excerpt: body,
      locator: 'note_desc:1-1',
      artifact: { ref: 'liqiangcc/xhs:note_desc/test.txt@95b77bb261048059846273688e4b90a2e108b437' },
    },
    source_artifacts: [
      { kind: 'html', ref: 'liqiangcc/xhs:note_detail/test.html@95b77bb261048059846273688e4b90a2e108b437', semantic: { title: { locator: 'html:head/title', excerpt: title } } },
      { kind: 'json', ref: 'liqiangcc/xhs:note_json/test.json@95b77bb261048059846273688e4b90a2e108b437', semantic: { title: { locator: 'json:/title', excerpt: title }, body: { locator: 'json:/desc', excerpt: body } } },
      { kind: 'text_projection', ref: 'liqiangcc/xhs:note_desc/test.txt@95b77bb261048059846273688e4b90a2e108b437', excerpt: body },
    ],
    source_material_verification: { status: 'verified' },
  };
}

const labels = ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review'];

test('Boundary B constants are frozen to the child issue scope', () => {
  assert.equal(FIRST_ISSUE, 393);
  assert.equal(LAST_ISSUE, 765);
  assert.equal(EXPECTED_COUNT, 367);
  assert.equal(SOURCE_REF, '95b77bb261048059846273688e4b90a2e108b437');
});

test('selection requires every live boundary label and excludes completed state', () => {
  assert.equal(isSelected(issue(393, labels)), true);
  assert.equal(isSelected(issue(392, labels)), true, 'range filtering is performed by the caller');
  assert.equal(isSelected(issue(393, labels.filter((label) => label !== 'task:boundary-review'))), false);
  assert.equal(isSelected(issue(393, [...labels.filter((label) => !label.startsWith('boundary:')), 'boundary:single-interview'])), false);
});

test('body-only evidence is explicitly non-authorizing and preserves the cited artifact', () => {
  const record = { artifacts: [{ ref: 'liqiangcc/xhs:note_desc/x.txt@95b77bb261048059846273688e4b90a2e108b437', git_blob_sha: 'a'.repeat(40) }] };
  const value = bodyProjectionEvidence({ body: 'x\n## 原始正文\n\n### 可读 Source projection — `note_desc`\n\n> one\n\n## 原始附件\n' }, record, record.artifacts[0].ref, 'network blocked');
  assert.equal(value.verification.status, 'blocked');
  assert.equal(value.artifact.git_blob_sha, 'a'.repeat(40));
  assert.match(value.locator, /^issue-body-copy:lines-/);
});

test('generated evidence and requests cannot authorize a transition', () => {
  const item = {
    issue_number: 393,
    issue_url: 'https://github.com/liqiangcc/interview-lab/issues/393',
    source_note_id: 'xhs-note:test',
    body_sha256: 'b'.repeat(64),
    source_revision_id: 'xhs-note:test:snapshot-95b77bb26104',
    source_projection: {
      artifact: { ref: 'liqiangcc/xhs:note_desc/test.txt@95b77bb261048059846273688e4b90a2e108b437', kind: 'text_projection', provenance: 'source_projection', git_blob_sha: 'c'.repeat(40) },
      locator: 'issue-body-copy:lines-1-2',
      excerpt: 'copy',
      verification: { status: 'blocked', reason: 'network blocked' },
    },
  };
  const evidence = evidenceFor(item);
  const request = requestFor(item, evidence);
  assert.equal(evidence.decision, 'blocked');
  assert.equal(evidence.evidence_status, 'blocked');
  assert.equal(request.executable, false);
  assert.equal(request.review_evidence, null);
  assert.equal(request.reviewed_at, null);
});

test('body-only is an explicit preparation mode', () => {
  assert.equal(parseArgs(['--prepare', '--body-only']).bodyOnly, true);
  assert.equal(parseArgs(['--prepare', '--body-only']).allowUnverifiedSource, true);
});

test('scope-clean mode generates only the frozen range and records no out-of-scope reads', () => {
  assert.equal(parseArgs(['--fetch-live', '--scope-clean']).scopeClean, true);
  const numbers = Array.from({ length: LAST_ISSUE - FIRST_ISSUE + 1 }, (_, index) => FIRST_ISSUE + index);
  const query = graphQlQuery(numbers);
  const queried = [...query.matchAll(/issueOrPullRequest\(number:(\d+)\)/g)].map((match) => Number(match[1]));
  assert.equal(queried.length, LAST_ISSUE - FIRST_ISSUE + 1);
  assert.equal(Math.min(...queried), FIRST_ISSUE);
  assert.equal(Math.max(...queried), LAST_ISSUE);
  assert.equal(queried.includes(392), false);
  assert.equal(queried.includes(766), false);
});

test('classification is conservative against #393/#394/#401/#415/#437/#524/#584/#727 and adversaries', () => {
  const examples = {
    393: '想到室友拒了Java的面试\n我也直接说我不面了',
    394: '- 自我介绍\n- JWT原理\n- 做项目有遇到什么困难吗',
    401: '收到一家外包的面试邀约\n据说压力挺大，面试情况怎么样，一般考啥',
    415: '我当过面试者也做过面试官，场景题准备好对面试有所帮助',
    437: '没面的时候会感觉面试有压力，反而实际面了并不感觉到难受。面试的基础问题我都没答上来。',
    524: '我2025第一面，面试官中间笑了几次。算法题：两个数组模拟整数相加。1. Java基本数据类型 2. ArrayList是线程安全的吗',
    584: '三面挂掉的同学朋友整理出阿里前端二面通关秘籍，必问的高频题和标准答案，帮助67位学员成功上岸，关注我不迷路',
    727: '面试官问我的问题回答不上来怎么办。#前端面试题[话题]# #面试题[话题]# #前端培训[话题]#',
    scheduled: '明天上午十点面试，已经约好了，面试问题一般考啥',
    job: '岗位职责和薪资如何，招聘信息里写了面试问题和工作内容',
    advice: '面试经验分享：准备八股和场景题，对求职有所帮助',
    question_only: '自我介绍？项目难点？为什么选择这个岗位？',
  };
  assert.equal(classifyProjection(examples[393]).proposed_decision, 'not-interview');
  assert.equal(classifyProjection(examples[437]).proposed_decision, 'single-interview');
  assert.equal(classifyProjection(examples[524]).proposed_decision, 'single-interview');
  assert.equal(classifyProjection(examples[584]).proposed_decision, 'not-interview');
  assert.equal(classifyProjection(examples[727]).proposed_decision, 'pending');
  for (const [label, text] of Object.entries(examples).filter(([label]) => !['393', '437', '524', '584', '727'].includes(label))) {
    assert.notEqual(classifyProjection(text).proposed_decision, 'single-interview', `${label} must not propose single-interview`);
  }
  assert.equal(classifyProjection('我参加了一面，面试官问了我项目难点和为什么这样设计').proposed_decision, 'single-interview');
});

test('verified evidence carries complete projection text and line-basis without authorizing a decision', () => {
  const item = {
    issue_number: 394,
    issue_url: 'https://github.com/liqiangcc/interview-lab/issues/394',
    source_note_id: 'xhs-note:test',
    body_sha256: 'b'.repeat(64),
    source_revision_id: 'xhs-note:test:snapshot-95b77bb26104',
    source_projection: {
      artifact: { ref: 'liqiangcc/xhs:note_desc/test.txt@95b77bb261048059846273688e4b90a2e108b437', kind: 'text_projection', provenance: 'source_projection', git_blob_sha: 'c'.repeat(40), byte_size: 12, sha256: 'd'.repeat(64) },
      locator: 'note_desc:1-2', excerpt: '我参加了一面\n问了项目', text: '我参加了一面\n问了项目', line_count: 2,
    },
    source_verification: { status: 'verified', fetch: 'cache:test', byte_size: 12, git_blob_sha: 'c'.repeat(40) },
    source_artifacts: fullSourceItem('一面面试记录', '我参加了一面\n问了项目').source_artifacts,
    source_material_verification: { status: 'verified' },
    status: 'verified',
  };
  const evidence = evidenceFor(item);
  assert.equal(evidence.evidence_status, 'reviewed');
  assert.equal(evidence.decision, 'single-interview');
  assert.equal(evidence.source_evidence.text, item.source_projection.text);
  assert.equal(evidence.source_evidence.verification.status, 'verified');
  assert.ok(Array.isArray(evidence.classification.basis_lines));
});

test('checked-in audit outputs are complete and mutation-free', () => {
  const dir = path.join(__dirname, '..', 'data', 'issue-1607');
  const selection = JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'dry-run.plan.json'), 'utf8'));
  const journal = JSON.parse(fs.readFileSync(path.join(dir, 'apply.journal.json'), 'utf8'));
  const classification = JSON.parse(fs.readFileSync(path.join(dir, 'classification-ledger.json'), 'utf8'));
  const evidence = JSON.parse(fs.readFileSync(path.join(dir, 'evidence-ledger.json'), 'utf8'));
  const requestSet = JSON.parse(fs.readFileSync(path.join(dir, 'request-set.json'), 'utf8'));
  assert.equal(selection.items.length, selection.scope.expected_count);
  assert.equal(selection.scope.baseline_pending_count, EXPECTED_COUNT);
  assert.equal(selection.scope.first_issue, FIRST_ISSUE);
  assert.equal(selection.scope.last_issue, LAST_ISSUE);
  assert.equal(plan.counts.mutation_count, 0);
  assert.equal(journal.mutation_count, 0);
  assert.equal(journal.status, 'not-started');
  assert.equal(plan.fail_closed, true);
  assert.equal(selection.scope_compliance.status, 'pass');
  assert.equal(plan.scope_compliance.status, 'pass');
  assert.equal(plan.scope_regression.status, 'pass');
  assert.equal(plan.scope_regression.out_of_scope_reads, 0);
  assert.equal(plan.scope_compliance.out_of_scope_mutations, 0);
  assert.equal(classification.total, selection.items.length);
  assert.equal(classification.status, 'semantic-review');
  assert.equal(evidence.items.length, selection.items.length);
  assert.ok(evidence.items.every((item) => ['single-interview', 'multi-interview', 'not-interview', 'blocked'].includes(item.decision) && item.source_evidence.text !== undefined && item.source_evidence.line_count !== undefined));
  const blocked = new Set(evidence.items.filter((item) => item.decision === 'blocked').map((item) => item.issue_number));
  assert.equal(requestSet.items.length, selection.items.length);
  assert.ok(requestSet.items.every((item) => blocked.has(item.issue_number) ? item.request_file === null : item.request_file === `requests/${String(item.issue_number).padStart(4, '0')}.json`));
  const requestFiles = fs.readdirSync(path.join(dir, 'requests')).filter((file) => /^\d{4}\.json$/.test(file));
  assert.equal(requestFiles.length, selection.items.length - blocked.size);
  assert.ok([...blocked].every((issueNumber) => !requestFiles.includes(`${String(issueNumber).padStart(4, '0')}.json`)));
});

test('full-source semantic boundary keeps events, rounds, and non-events distinct', () => {
  const cases = [
    ['question-only', '百度面试真题', '- 自我介绍\n- JWT原理\n- 算法题', 'not-interview'],
    ['invitation', '求助面试邀约', '收到一家外包的面试邀约，明天上午十点面试，一般考啥', 'not-interview'],
    ['refusal', '拒面', '这次面试我拒了，没有参加', 'not-interview'],
    ['interviewer-sharing', '面试经验分享', '我当过面试者也做过面试官，建议大家准备场景题', 'not-interview'],
    ['actual-437', '面试经历', '没面的时候会感觉有压力，反而实际面了。面试的基础问题我都没答上来。', 'single-interview'],
    ['actual-524', '2025第一面', '面试官中间笑了几次。算法题：两个数组模拟整数相加。1. Java基本数据类型', 'single-interview'],
    ['marketing-584', '前端二面通关秘籍', '三面挂掉的同学整理出的通关秘籍，必问的高频题和标准答案，帮助67位学员成功上岸', 'not-interview'],
    ['single-event-with-bank-words', '候选人一面记录', '我参加了一面，面试官问了我项目难点和八股问题，最后拿到了结果', 'single-interview'],
    ['multi-round', '面试复盘', '我参加了一面和二面，分别记录面试官的问题和回答', 'multi-interview'],
    ['timeline-multi-round', '后端开发面经', '投简历 11.18 一面 11.20 挂；投简历 11.29 一面 12.02 挂', 'multi-interview'],
    ['telephone-review', '电话面试复盘', 'Java基础类型和占的字节数\n讲讲二分查找和二叉搜索树\n算法题：两个队列实现栈', 'single-interview'],
    ['advice-question', '面试官问我的问题', '面试官问我的问题回答不上来怎么办，如何准备面试', 'not-interview'],
    ['marketing-repost', '前端二面通关秘籍', '三面挂掉的同学整理出的通关秘籍，必问的高频题和标准答案，关注我不迷路', 'not-interview'],
  ];
  for (const [name, title, body, expected] of cases) {
    const result = classifyFullSource(fullSourceItem(title, body));
    assert.equal(result.proposed_decision, expected, `${name} should classify as ${expected}`);
    assert.ok(result.semantic_evidence.every((entry) => entry.ref && entry.locator && entry.excerpt !== undefined), `${name} must retain independent evidence`);
  }
});

test('actual high-risk B samples keep candidate events ahead of advice and title duplication', () => {
  const selection = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'issue-1607', 'selection.json'), 'utf8'));
  const expected = { 406: 'multi-interview', 418: 'multi-interview', 514: 'single-interview', 748: 'multi-interview' };
  for (const [number, decision] of Object.entries(expected)) {
    const item = selection.items.find((candidate) => candidate.issue_number === Number(number));
    assert.ok(item, `#${number} must remain selected`);
    assert.equal(classifyFullSource(item).proposed_decision, decision, `#${number} should classify as ${decision}`);
  }
  const item444 = selection.items.find((candidate) => candidate.issue_number === 444);
  assert.ok(item444, '#444 must remain selected');
  assert.notEqual(classifyFullSource(item444).proposed_decision, 'not-interview');
  const repeatedTitleOnly = classifyFullSource(fullSourceItem('快手二面面经', '1. JVM内存模型\n2. 线程池拒绝策略\n3. 算法题'));
  assert.equal(repeatedTitleOnly.proposed_decision, 'single-interview');
});
