'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateExplorationSessionHistory } = require('../scripts/lib/exploration-session-history');

function record(overrides = {}) {
  return {
    schema_version: 'exploration-session-checkpoint.v1',
    session_id: 'session-history-test',
    target_type: 'InterviewNote',
    target_id: 'case:test',
    mode: 'learning',
    source_revision_id: 'case:test:r1',
    revealed_position: 1,
    revealed_range: '1..1',
    current_source_unit: '1.first question',
    source_unit_type: 'question-like',
    loop_phase: 'literal',
    temporal_cursor: null,
    revealed_within_unit: null,
    has_withheld_within_unit: false,
    position_status: 'active',
    session_status: 'active',
    closure_reason: null,
    completed_at: null,
    ...overrides,
  };
}

function comment(id, value, createdAt) {
  return {
    id,
    created_at: createdAt || `2026-09-03T08:${String(id).padStart(2, '0')}:00Z`,
    updated_at: createdAt || `2026-09-03T08:${String(id).padStart(2, '0')}:00Z`,
    body: `## ExplorationSession checkpoint\n\n<!-- exploration-session-checkpoint\n${JSON.stringify(value, null, 2)}\n-->`,
  };
}

function validHistory() {
  return [
    comment(1, record({ has_withheld_within_unit: true, temporal_cursor: 'p1.a', revealed_within_unit: 'initial prompt' })),
    comment(2, record({ loop_phase: 'classification', has_withheld_within_unit: false })),
    comment(3, record({ loop_phase: 'closure', position_status: 'ready-to-close', closure_reason: 'position 1 minimum loop complete' })),
    comment(4, record({
      revealed_position: 2,
      revealed_range: '1..2',
      current_source_unit: '2.second question',
      loop_phase: 'literal',
    })),
    comment(5, record({
      revealed_position: 2,
      revealed_range: '1..2',
      current_source_unit: '2.second question',
      loop_phase: 'closure',
      position_status: 'complete',
      session_status: 'completed',
      closure_reason: 'target range fully consumed',
      completed_at: '2026-09-03T08:05:00Z',
    })),
  ];
}

test('valid ExplorationSession history passes', () => {
  const result = validateExplorationSessionHistory(validHistory());
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.machine_checkpoints, 5);
  assert.equal(result.sessions.length, 1);
});

test('revealed position cannot regress', () => {
  const comments = validHistory();
  comments.push(comment(6, record({ loop_phase: 'closure', position_status: 'complete', closure_reason: 'duplicate old position' })));
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /revealed_position regressed/);
});

test('revealed position cannot jump over an uncheckpointed position', () => {
  const comments = [
    comment(1, record({ loop_phase: 'closure', position_status: 'ready-to-close', closure_reason: 'done' })),
    comment(2, record({
      revealed_position: 3,
      revealed_range: '1..3',
      current_source_unit: '3.third question',
    })),
  ];
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /jumped from 1 to 3/);
});

test('cannot advance position while previous position is still active', () => {
  const comments = [
    comment(1, record()),
    comment(2, record({
      revealed_position: 2,
      revealed_range: '1..2',
      current_source_unit: '2.second question',
    })),
  ];
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /cannot advance.*previous position 1 is active/);
});

test('source revision is stable within v1 session history', () => {
  const comments = validHistory();
  comments[1] = comment(2, record({ loop_phase: 'classification', source_revision_id: 'case:test:r2' }));
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source_revision_id changed within session/);
});

test('loop phase cannot regress within the same position', () => {
  const comments = [
    comment(1, record({ loop_phase: 'classification' })),
    comment(2, record({ loop_phase: 'literal' })),
  ];
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /loop_phase regressed/);
});

test('within-unit frontier cannot return to withheld after fully revealed', () => {
  const comments = [
    comment(1, record({ has_withheld_within_unit: false })),
    comment(2, record({
      loop_phase: 'classification',
      has_withheld_within_unit: true,
      temporal_cursor: 'p1.regressed',
      revealed_within_unit: 'partial again',
    })),
  ];
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /Source frontier regressed/);
});

test('position closure cannot reopen to active within the same session', () => {
  const comments = [
    comment(1, record({ loop_phase: 'closure', position_status: 'ready-to-close', closure_reason: 'done' })),
    comment(2, record({ loop_phase: 'closure', position_status: 'active', closure_reason: 'reopen' })),
  ];
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /position_status regressed/);
});

test('completed session cannot produce later checkpoints', () => {
  const comments = validHistory();
  comments.push(comment(6, record({
    revealed_position: 3,
    revealed_range: '1..3',
    current_source_unit: '3.resurrected',
  })));
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /completed session.*must not produce later checkpoints/);
});

test('same position keeps source unit identity stable', () => {
  const comments = [
    comment(1, record()),
    comment(2, record({ loop_phase: 'classification', current_source_unit: '1.changed wording' })),
  ];
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /current_source_unit changed/);
});

test('revealed range start remains stable within one session', () => {
  const comments = [
    comment(1, record({ revealed_range: '1..1' })),
    comment(2, record({ revealed_range: '2..2', revealed_position: 2, current_source_unit: '2.second question' })),
  ];
  const result = validateExplorationSessionHistory(comments);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /revealed_range start changed/);
});
