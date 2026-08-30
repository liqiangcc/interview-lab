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

test('pilot plans four Issue candidates and one boundary review', () => {
  const result = buildPlan(pilot);
  assert.equal(result.ok, true);
  assert.equal(result.schema_version, 'xhs-migration-plan.v2');
  assert.equal(result.plans.filter((item) => item.create_issue).length, 4);
  assert.equal(result.plans.filter((item) => item.action === 'boundary_review').length, 1);
});

test('migration identity is source-system plus external note id', () => {
  const result = buildPlan(pilot);
  for (const plan of result.plans) {
    assert.equal(plan.interview_note_id, `xhs:${plan.note_id}`);
  }
});

test('derived path cannot be promoted into raw evidence', () => {
  const bad = structuredClone(pilot);
  bad.cases[0].raw_evidence_paths.push('note_tagged/630e2e22000000001103c490.json');
  const result = validateManifest(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /derived path cannot be raw evidence/);
});

test('unknown interview time cannot contain invented date', () => {
  const bad = structuredClone(pilot);
  bad.cases[0].interview_occurred_at = { precision: 'unknown', value: '2023-01-01' };
  const result = validateManifest(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unknown interview_occurred_at must have value=null/);
});

test('real interview time is preferred for chronology when year is known', () => {
  const result = buildPlan(pilot);
  const second = result.plans.find((item) => item.note_id === '63ecd286000000001303fd16');
  assert.equal(second.chronology.basis, 'interview_occurred_at');
  assert.equal(second.chronology.time.value, '2022-08-02');
});

test('source publication time is fallback when interview time is unknown', () => {
  const result = buildPlan(pilot);
  const first = result.plans.find((item) => item.note_id === '630e2e22000000001103c490');
  assert.equal(first.chronology.basis, 'source_published_at_fallback');
  assert.equal(first.chronology.time.value, '2022-08-30');
});

test('yearless month_day is preserved but cannot drive cross-year chronology', () => {
  const result = buildPlan(pilot);
  const third = result.plans.find((item) => item.note_id === '6508552c000000001303f499');
  assert.equal(third.interview_occurred_at.precision, 'month_day');
  assert.equal(third.interview_occurred_at.value, '09-18');
  assert.equal(third.chronology.basis, 'source_published_at_fallback');
  assert.equal(third.chronology.time.value, '2023-09-18T21:48:28+08:00');
});
