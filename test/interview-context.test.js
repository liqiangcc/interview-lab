'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateInterviewContext,
  deriveSourceYearLabel,
  deriveLearningLabels,
  buildNonSpoilerTitle,
  buildLearningDiscovery,
} = require('../scripts/lib/interview-context');

const fixturePath = path.join(__dirname, '..', 'data', 'interview-contexts', 'xhs-6508552c000000001303f499.v1.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function clone(value = fixture) {
  return JSON.parse(JSON.stringify(value));
}

test('Pilot 3 reviewed InterviewContext validates', () => {
  const result = validateInterviewContext(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('reviewed InterviewContext derives learning discovery labels without inventing interview year', () => {
  const result = deriveLearningLabels(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.labels, [
    'company:kuaishou',
    'role:backend',
    'recruitment:campus',
    'round:2',
  ]);
});

test('source publication year is derived independently from InterviewNote source_published_at', () => {
  assert.equal(deriveSourceYearLabel({ precision: 'exact', value: '2023-09-18T21:48:28+08:00' }), 'source-year:2023');
  assert.equal(deriveSourceYearLabel({ precision: 'month', value: '2023-09' }), 'source-year:2023');
  assert.equal(deriveSourceYearLabel({ precision: 'year', value: '2023' }), 'source-year:2023');
});

test('yearless source publication fact does not invent source-year', () => {
  assert.equal(deriveSourceYearLabel({ precision: 'month_day', value: '09-18' }), null);
  assert.equal(deriveSourceYearLabel({ precision: 'unknown', value: null }), null);
});

test('reviewed interview occurrence with explicit year creates interview-year', () => {
  const value = clone();
  value.interview_occurred_at = {
    precision: 'exact',
    value: '2022-08-02',
    basis: 'source-explicit',
    evidence_refs: ['note-desc:line-1'],
  };
  const result = deriveLearningLabels(value);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.labels.at(-1), 'interview-year:2022');
});

test('source year and interview year may legitimately differ', () => {
  const value = clone();
  value.interview_occurred_at = {
    precision: 'exact',
    value: '2022-08-02',
    basis: 'source-explicit',
    evidence_refs: ['note-desc:line-1'],
  };
  const result = buildLearningDiscovery(value, { precision: 'exact', value: '2023-02-15T20:39:34+08:00' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.learning_labels.includes('interview-year:2022'));
  assert.ok(result.learning_labels.includes('source-year:2023'));
});

test('Pilot 3 source year does not leak into unknown interview year', () => {
  const result = buildLearningDiscovery(fixture, { precision: 'exact', value: '2023-09-18T21:48:28+08:00' });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.ok(result.learning_labels.includes('source-year:2023'));
  assert.equal(result.learning_labels.some((label) => label.startsWith('interview-year:')), false);
});

test('non-spoiler title excludes raw outcome wording', () => {
  const result = buildNonSpoilerTitle(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.title, '[快手] 后端 · 校招 · 二面 · 09-18 · 6508552c');
  assert.doesNotMatch(result.title, /凉经|挂|拒绝|未通过|offer/i);
});

test('pre-learning display keeps outcome sealed', () => {
  const result = buildLearningDiscovery(fixture);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.pre_learning_display, {
    company: '快手',
    role: '后端',
    recruitment_type: '校招',
    round: '二面',
    interview_occurred_at: '09-18',
    outcome: 'sealed',
  });
});

test('unknown context facts do not create unknown learning labels', () => {
  const value = clone();
  value.role = { family: 'unknown', title: null, basis: 'unknown', evidence_refs: [] };
  value.recruitment_type = { value: 'unknown', basis: 'unknown', evidence_refs: [] };
  const result = deriveLearningLabels(value);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.labels, ['company:kuaishou', 'round:2']);
});

test('reviewed inference preserves evidence instead of pretending to be explicit source', () => {
  assert.equal(fixture.recruitment_type.value, 'campus');
  assert.equal(fixture.recruitment_type.basis, 'reviewed-inference');
  assert.deepEqual(fixture.recruitment_type.evidence_refs, ['note-desc:topic-24秋招']);
});

test('interview time also preserves explicit evidence provenance', () => {
  assert.equal(fixture.interview_occurred_at.precision, 'month_day');
  assert.equal(fixture.interview_occurred_at.value, '09-18');
  assert.equal(fixture.interview_occurred_at.basis, 'source-explicit');
  assert.ok(fixture.interview_occurred_at.evidence_refs.length > 0);
});

test('known interview time without evidence fails', () => {
  const value = clone();
  value.interview_occurred_at.evidence_refs = [];
  const result = validateInterviewContext(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /interview_occurred_at\.evidence_refs must be non-empty/);
});

test('pre-learning InterviewContext rejects outcome fields', () => {
  const value = clone();
  value.result = 'rejected';
  const result = validateInterviewContext(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /result must not be stored in pre-learning InterviewContext/);
});

test('known fact requires evidence', () => {
  const value = clone();
  value.company.evidence_refs = [];
  const result = validateInterviewContext(value);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /company\.evidence_refs must be non-empty/);
});
