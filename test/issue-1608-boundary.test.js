'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { classify, evidenceDecisionConsistent, issueNumbers } = require('../scripts/prepare-issue-1608-boundary');
const { validateDirectory } = require('../scripts/validate-issue-1608-boundary');

test('issue #1608 generator is exactly bounded to #766-#1138', () => {
  assert.deepStrictEqual(issueNumbers(), Array.from({ length: 373 }, (_, index) => 766 + index));
});

test('issue #1608 classification fails closed for empty and generic source text', () => {
  assert.strictEqual(classify(999999, '').disposition, 'blocked');
  assert.strictEqual(classify(999999, '一份面试技巧和复习资料整理').decision, 'not-interview');
});

test('real marketing/question-bank fixtures #796 and #1077 are not interview events', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/issue-1608-boundary-negative-marketing.json'), 'utf8'));
  for (const item of fixture.cases) {
    const result = classify(item.issue_number, item.source_projection);
    assert.strictEqual(result.decision, 'not-interview', `#${item.issue_number} decision`);
    assert.strictEqual(result.stratum, 'generic-or-non-event', `#${item.issue_number} stratum`);
    assert.strictEqual(evidenceDecisionConsistent('single-interview', item.source_projection), false, `#${item.issue_number} must not package as single`);
  }
});

test('multi cases without unique non-hashtag artifact locators are blocked', () => {
  assert.strictEqual(classify(782, '京东物流 京东科技').disposition, 'blocked');
  assert.strictEqual(classify(849, '腾讯 字节跳动').disposition, 'blocked');
  assert.strictEqual(classify(972, '滴滴 字节 美团 快手').disposition, 'blocked');
  assert.strictEqual(classify(849, '#暑期实习精神状态[话题]# #字节跳动[话题]#\n继上次腾讯面试完后的一次线上面试，面试官说基础不牢固').disposition, 'blocked');
});

test('single decision rejects weak packaging without interview facts', () => {
  assert.strictEqual(evidenceDecisionConsistent('single-interview', '字节的效率真的很高'), false);
  assert.strictEqual(evidenceDecisionConsistent('single-interview', '投递时间：5.9'), false);
  assert.strictEqual(evidenceDecisionConsistent('single-interview', '手撕数组逆序和求两个数组的交集'), false);
  assert.strictEqual(evidenceDecisionConsistent('single-interview', '面试结果：又挂了'), false);
  assert.strictEqual(evidenceDecisionConsistent('single-interview', '笔试题。三道sql题，5分钟内做完'), false);
  assert.strictEqual(evidenceDecisionConsistent('single-interview', '结果：hr说下周可以约二面，但是还没约'), false);
  assert.strictEqual(evidenceDecisionConsistent('single-interview', ['线下面试。', '时间：明天', '笔试题。三道sql题，5分钟内做完']), false);
  assert.strictEqual(evidenceDecisionConsistent('single-interview', '4月22日面试官有事推迟，12点面试完'), true);
  assert.strictEqual(classify(767, '字节的效率真的很高\n4.16投递\n4.16约面\n12点面试完').disposition, 'blocked');
});

test('complete four reviewer samples require event context plus substantive Q&A excerpts', () => {
  const complete = [
    ['一面：5.21', '手撕数组逆序和求两个数组的交集', '反问环节总结，面试官人挺好，面完一会儿发二面邮件'],
    ['时间：25-06-06', '面试结果：又挂了', '1.自我介绍\n2.介绍一下你最近项目中你主要开发工作是什么？'],
    ['时间：2025-06-12 15:00', '线下面试。', '笔试题。三道sql题，5分钟内做完。\n10.事务是什么？'],
    ['时间：2025-06-20 14:00', '形式：深圳线下\n总体感觉：答的还行', '1.自我介绍\n2.介绍一下你最近项目的工作和角色'],
  ];
  for (const excerpts of complete) assert.strictEqual(evidenceDecisionConsistent('single-interview', excerpts), true);
});

test('previously reviewed #893/#950/#955/#975 are excluded after live boundary application', () => {
  const selection = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/issue-1608/selection.json'), 'utf8'));
  for (const issueNumber of [893, 950, 955, 975]) {
    const item = selection.items.find((candidate) => candidate.issue_number === issueNumber);
    assert.strictEqual(item, undefined, `#${issueNumber} should no longer be pending in the live snapshot`);
  }
});

test('scheduled-only and question-only projections are blocked', () => {
  assert.strictEqual(classify(999000, '预约面试，面试时间：明天').stratum, 'scheduled-only-source-evidence');
  assert.strictEqual(evidenceDecisionConsistent('single-interview', '预约面试，面试时间：明天'), false);
  assert.strictEqual(classify(999001, '投递时间：5.9\n4月16日约面，等待面试安排，暂时没有面试结果或问答内容').disposition, 'blocked');
  assert.strictEqual(classify(999002, '背景：线下面试\n深圳中小厂\n1.线程池参数以及参数含义？\n2.Redis缓存？\n3.算法题？').disposition, 'blocked');
  assert.strictEqual(classify(999003, '恒生电子java面经\n1、JRE、JDK的区别是什么？\n2、finally？\n3、集合？').disposition, 'blocked');
  assert.strictEqual(classify(1111, '本次岗位因为急招，所以一次面试就通知oc了，还是蛮意外的，面试流程很快且结果明确').decision, 'single-interview');
});

test('issue #1608 frozen artifacts validate with zero mutations', () => {
  const result = validateDirectory();
  assert.strictEqual(result.total, JSON.parse(fs.readFileSync(path.join(__dirname, '../data/issue-1608/selection.json'), 'utf8')).total);
  assert.strictEqual(result.selection_sha256.length, 64);
  assert.strictEqual(result.dry_run_sha256.length, 64);
});
