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

test('unknown source time cannot contain invented date', () => {
  const bad = structuredClone(pilot);
  bad.cases[0].source_time = { precision: 'unknown', value: '2023-01-01' };
  const result = validateManifest(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unknown source_time must have value=null/);
});
