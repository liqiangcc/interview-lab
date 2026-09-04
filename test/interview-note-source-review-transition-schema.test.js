'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRequest } = require('../scripts/lib/interview-note-source-review-transition');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../schemas/interview-note-source-review-transition.schema.json'), 'utf8'));
const validFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/interview-note-source-review-transition.blocked-recovery.valid.json'), 'utf8'));
const invalidFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/interview-note-source-review-transition.blocked-recovery.invalid.json'), 'utf8'));

function recoveryCondition(mode) {
  return schema.allOf.find((condition) => condition.if
    && condition.if.properties
    && condition.if.properties.recovery_mode
    && condition.if.properties.recovery_mode.const === mode);
}

function assertValidRequest(request, label) {
  const result = validateRequest(request);
  assert.equal(result.ok, true, `${label}: ${result.errors.join('; ')}`);
}

function assertInvalidRequest(request, label) {
  const result = validateRequest(request);
  assert.equal(result.ok, false, `${label} unexpectedly passed`);
  return result.errors.join('\n');
}

test('transition schema declares every code-supported field and strict top-level properties', () => {
  assert.equal(schema.additionalProperties, false);
  for (const field of [
    'case_key', 'expected_source_repository_ref', 'provenance_mode', 'provenance_statement',
    'pinned_artifact_manifest_sha256', 'evidence_subject_sha256', 'recovery_mode',
  ]) assert.ok(schema.properties[field], `schema.properties.${field} is missing`);
  assert.deepEqual(schema.allOf[0].anyOf.map((branch) => branch.required), [
    ['expected_manifest_sha256'],
    ['expected_source_repository_ref'],
  ]);
});

test('both recovery if conditions require recovery_mode before applying their then branch', () => {
  for (const [mode, expectedInitialStatus, expectedFields] of [
    ['blocked-source-recovery', 'blocked', ['recovery_mode', 'provenance_mode', 'provenance_statement', 'pinned_artifact_manifest_sha256', 'evidence_subject_sha256']],
    ['source-ready-receipt-repair', 'source-ready', ['recovery_mode', 'evidence_subject_sha256']],
  ]) {
    const condition = recoveryCondition(mode);
    assert.ok(condition, `${mode} condition is missing`);
    assert.deepEqual(condition.if.required, ['recovery_mode']);
    assert.ok(condition.then.required.every((field) => expectedFields.includes(field)));
    assert.equal(condition.then.properties.expected_initial_status.const, expectedInitialStatus);
    assert.equal(condition.then.properties.decision.const, 'source-ready');
  }
  const ordinary = schema.allOf.find((condition) => condition.if && condition.if.not && condition.if.not.required && condition.if.not.required[0] === 'recovery_mode');
  assert.ok(ordinary, 'ordinary no-recovery condition is missing');
  assert.equal(ordinary.then.properties.expected_initial_status.const, 'captured');
});

test('valid and invalid fixtures are semantically checked by the production request validator', () => {
  assertValidRequest(validFixture, 'blocked recovery fixture');
  const errors = assertInvalidRequest(invalidFixture, 'invalid blocked recovery fixture');
  assert.match(errors, /blocked-source-recovery|pinned-source-artifact|evidence_subject_sha256|expected_initial_status/);
});

test('production validator preserves ref-only and ordinary captured compatibility', () => {
  const refOnly = { ...validFixture };
  delete refOnly.expected_manifest_sha256;
  assertValidRequest(refOnly, 'ref-only request');

  const ordinary = { ...validFixture, expected_initial_status: 'captured' };
  for (const field of ['case_key', 'provenance_mode', 'provenance_statement', 'pinned_artifact_manifest_sha256', 'evidence_subject_sha256', 'recovery_mode']) delete ordinary[field];
  assertValidRequest(ordinary, 'ordinary captured request');
});

test('production validator rejects incompatible recovery and provenance combinations', () => {
  for (const request of [
    { ...validFixture, recovery_mode: 'source-ready-receipt-repair' },
    { ...validFixture, provenance_mode: 'pinned-source-artifact', provenance_statement: 'wrong' },
    { ...validFixture, recovery_mode: undefined, expected_initial_status: 'blocked' },
    { ...validFixture, unexpected: true },
  ]) assert.equal(validateRequest(request).ok, false);
});
