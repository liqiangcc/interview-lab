'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateInterviewContext,
  deriveLearningLabels,
  buildNonSpoilerTitle,
  buildLearningDiscovery,
} = require('../scripts/lib/interview-context');

const contextPath = path.join(__dirname, '..', 'data', 'interview-contexts', 'xhs-656861da000000000f024258.v1.json');
const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
const sourcePublishedAt = { precision: 'exact', value: '2023-11-30T18:20:10+08:00' };

test('Pilot 4 recovered-r2 InterviewContext validates', () => {
  const result = validateInterviewContext(context);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(context.source_revision_id, 'xhs:656861da000000000f024258:recovered-r2');
});

test('Pilot 4 preserves recruitment type as unknown instead of equating fresh graduate with campus recruitment', () => {
  assert.equal(context.recruitment_type.value, 'unknown');
  assert.equal(context.recruitment_type.basis, 'unknown');
  assert.deepEqual(context.recruitment_type.evidence_refs, []);
});

test('Pilot 4 backend role remains reviewed inference with explicit evidence', () => {
  assert.equal(context.role.family, 'backend');
  assert.equal(context.role.basis, 'reviewed-inference');
  assert.ok(context.role.evidence_refs.includes('raw-image-3:role-Java'));
  assert.ok(context.role.evidence_refs.includes('raw-image-1:求职意向-Java后端开发'));
});

test('Pilot 4 derives non-spoiler learning labels with both independent year dimensions', () => {
  const result = buildLearningDiscovery(context, sourcePublishedAt);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.learning_labels, [
    'company:shenghui-logistics',
    'role:backend',
    'round:1',
    'interview-year:2023',
    'source-year:2023',
  ]);
  assert.equal(result.learning_labels.some((label) => label.startsWith('recruitment:')), false);
  assert.equal(result.learning_labels.some((label) => /result:|outcome:/.test(label)), false);
});

test('Pilot 4 non-spoiler title uses reviewed context and excludes outcome', () => {
  const result = buildNonSpoilerTitle(context);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.title, '[盛辉物流] 后端 · 一面 · 2023-11-27 · 656861da');
  assert.doesNotMatch(result.title, /失败|拒绝|未通过|不符合|offer/i);
});

test('Pilot 4 interview date is source-explicit from Raw image 3', () => {
  assert.equal(context.interview_occurred_at.precision, 'exact');
  assert.equal(context.interview_occurred_at.value, '2023-11-27');
  assert.equal(context.interview_occurred_at.basis, 'source-explicit');
  assert.ok(context.interview_occurred_at.evidence_refs.includes('raw-image-3:现场面试邀请-2023.11.27-10:00'));
});

test('deriveLearningLabels does not require or invent recruitment label for Pilot 4', () => {
  const result = deriveLearningLabels(context);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.labels, [
    'company:shenghui-logistics',
    'role:backend',
    'round:1',
    'interview-year:2023',
  ]);
});
