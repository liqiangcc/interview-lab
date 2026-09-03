'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateManifest, buildPlan } = require('../scripts/plan-xhs-migration');

const pilot = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'pilot', 'xhs-pilot-selection.json'), 'utf8'));

test('pilot selection validates', () => {
  const result = validateManifest(pilot);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('all historical XHS pilot cases now plan SourceNote Issues', () => {
  const result = buildPlan(pilot);
  assert.equal(result.ok, true);
  assert.equal(result.schema_version, 'xhs-source-note-pilot-plan.v1');
  assert.equal(result.plans.length, pilot.cases.length);
  assert.equal(result.plans.filter((item) => item.create_issue).length, pilot.cases.length);
  assert.ok(result.plans.every((item) => item.action === 'create_or_reconcile_source_note_issue'));
});

test('pilot migration identity is xhs-note source identity, not InterviewNote identity', () => {
  const result = buildPlan(pilot);
  for (const plan of result.plans) {
    assert.equal(plan.source_note_id, `xhs-note:${plan.note_id}`);
    assert.equal(plan.idempotency_key, plan.source_note_id);
    assert.match(plan.machine_marker, /<!-- source-note:/);
    assert.equal(Object.prototype.hasOwnProperty.call(plan, 'interview_note_id'), false);
    assert.deepEqual(plan.labels, [
      'type:source-note',
      'source:xhs',
      'status:captured',
      'boundary:pending',
      'task:boundary-review',
    ]);
  }
});

test('historical boundary-review sample still becomes SourceNote rather than being dropped', () => {
  const result = buildPlan(pilot);
  const boundary = result.plans.find((item) => item.note_id === '625564d70000000001025e46');
  assert.equal(boundary.action, 'create_or_reconcile_source_note_issue');
  assert.equal(boundary.create_issue, true);
  assert.equal(boundary.legacy_review_hint.expected_disposition, 'boundary_review');
  assert.equal(boundary.legacy_review_hint.projected_to_source_note, false);
});

test('derived path cannot be promoted into raw evidence', () => {
  const bad = structuredClone(pilot);
  bad.cases[0].raw_evidence_paths.push('note_tagged/630e2e22000000001103c490.json');
  const result = validateManifest(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /derived path cannot be raw evidence/);
});

test('historical unknown interview-time hint cannot contain invented date', () => {
  const bad = structuredClone(pilot);
  bad.cases[0].interview_occurred_at = { precision: 'unknown', value: '2023-01-01' };
  const result = validateManifest(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unknown interview_occurred_at must have value=null/);
});

test('SourceNote creation chronology uses source publication time even when interview time is known', () => {
  const result = buildPlan(pilot);
  const second = result.plans.find((item) => item.note_id === '63ecd286000000001303fd16');
  assert.equal(second.creation_chronology.basis, 'source_published_at');
  assert.equal(second.creation_chronology.time.value, '2023-02-15T20:39:34+08:00');
  assert.equal(second.legacy_review_hint.interview_occurred_at.value, '2022-08-02');
  assert.equal(second.legacy_review_hint.projected_to_source_note, false);
});

test('unknown publication time stays in unknown SourceNote creation backlog', () => {
  const result = buildPlan(pilot);
  const boundary = result.plans.find((item) => item.note_id === '625564d70000000001025e46');
  assert.equal(boundary.creation_chronology.basis, 'unknown');
  assert.equal(boundary.creation_chronology.time.value, null);
});

test('yearless interview hint is preserved only as non-projected legacy review hint', () => {
  const result = buildPlan(pilot);
  const third = result.plans.find((item) => item.note_id === '6508552c000000001303f499');
  assert.equal(third.legacy_review_hint.interview_occurred_at.precision, 'month_day');
  assert.equal(third.legacy_review_hint.interview_occurred_at.value, '09-18');
  assert.equal(third.creation_chronology.basis, 'source_published_at');
  assert.equal(third.creation_chronology.time.value, '2023-09-18T21:48:28+08:00');
});
