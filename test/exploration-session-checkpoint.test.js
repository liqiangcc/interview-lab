'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExplorationSessionCheckpoint } = require('../scripts/lib/exploration-session-checkpoint');

const validBody = fs.readFileSync(
  path.join(__dirname, 'fixtures/exploration-session-checkpoint.valid.md'),
  'utf8',
);

function replaceJsonField(body, from, to) {
  return body.replace(from, to);
}

test('valid sequential ExplorationSession checkpoint passes', () => {
  const result = validateExplorationSessionCheckpoint(validBody);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('checkpoint requires exactly one machine marker', () => {
  const result = validateExplorationSessionCheckpoint('## ExplorationSession checkpoint\n');
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /exactly one exploration-session-checkpoint machine marker/);
});

test('revealed_range must end at revealed_position', () => {
  const body = replaceJsonField(validBody, '"revealed_range": "1..4"', '"revealed_range": "1..3"');
  const result = validateExplorationSessionCheckpoint(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /revealed_range end must equal revealed_position/);
});

test('within-unit future boundary requires temporal cursor', () => {
  const body = replaceJsonField(validBody, '"temporal_cursor": "position-4.initial-prompt"', '"temporal_cursor": null');
  const result = validateExplorationSessionCheckpoint(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /temporal_cursor is required/);
});

test('source type constrains normalized loop phase', () => {
  const body = validBody
    .replace('"source_unit_type": "question-like"', '"source_unit_type": "outcome-reflection-summary"')
    .replace('"loop_phase": "classification"', '"loop_phase": "response"');
  const result = validateExplorationSessionCheckpoint(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /loop_phase response is not valid/);
});

test('ready-to-close requires explicit closure phase and reason', () => {
  const body = validBody.replace('"position_status": "active"', '"position_status": "ready-to-close"');
  const result = validateExplorationSessionCheckpoint(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /requires loop_phase=closure/);
  assert.match(result.errors.join('\n'), /requires closure_reason/);
});

test('completed session requires complete position and timestamp', () => {
  const body = validBody
    .replace('"loop_phase": "classification"', '"loop_phase": "closure"')
    .replace('"position_status": "active"', '"position_status": "complete"')
    .replace('"session_status": "active"', '"session_status": "completed"')
    .replace('"closure_reason": null', '"closure_reason": "target range fully consumed"');
  const result = validateExplorationSessionCheckpoint(body);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /valid completed_at timestamp/);
});

test('completed session with closure metadata passes', () => {
  const body = validBody
    .replace('"loop_phase": "classification"', '"loop_phase": "closure"')
    .replace('"position_status": "active"', '"position_status": "complete"')
    .replace('"session_status": "active"', '"session_status": "completed"')
    .replace('"closure_reason": null', '"closure_reason": "target range fully consumed"')
    .replace('"completed_at": null', '"completed_at": "2026-09-03T08:00:00Z"');
  const result = validateExplorationSessionCheckpoint(body);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('unknown source unit type remains extensible but emits warning', () => {
  const body = validBody.replace('"source_unit_type": "question-like"', '"source_unit_type": "future-source-type"');
  const result = validateExplorationSessionCheckpoint(body);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.warnings.length, 1);
});
