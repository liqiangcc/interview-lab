'use strict';

const SCHEMA_VERSION = 'exploration-session-checkpoint.v1';
const MARKER_RE = /<!--\s*exploration-session-checkpoint\s*([\s\S]*?)-->/g;

const MODES = new Set(['learning', 'training', 'source-analysis', 'knowledge-audit']);
const POSITION_STATUSES = new Set(['active', 'ready-to-close', 'complete', 'deferred']);
const SESSION_STATUSES = new Set(['active', 'completed']);

const LOOP_PHASES = new Map([
  ['question-like', new Set(['literal', 'classification', 'knowledge', 'response', 'depth', 'anticipation', 'closure'])],
  ['stage-summary', new Set(['literal', 'classification', 'preparation', 'routing', 'dynamic-depth', 'plausible-dimensions', 'closure'])],
  ['outcome-reflection-summary', new Set(['literal', 'evidence-classification', 'structured-extraction', 'attribution-boundary', 'closure'])],
]);

function parseCheckpoint(body) {
  const matches = [...String(body || '').matchAll(MARKER_RE)];
  const errors = [];

  if (matches.length !== 1) {
    errors.push('comment must contain exactly one exploration-session-checkpoint machine marker');
    return { record: null, errors };
  }

  const payload = matches[0][1].trim();
  try {
    return { record: JSON.parse(payload), errors };
  } catch (error) {
    errors.push(`exploration-session-checkpoint marker must contain valid JSON: ${error.message}`);
    return { record: null, errors };
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateExplorationSessionCheckpoint(body) {
  const parsed = parseCheckpoint(body);
  const errors = [...parsed.errors];
  const warnings = [];
  const record = parsed.record;

  if (!record) {
    return { ok: false, errors, warnings, record: null };
  }

  if (record.schema_version !== SCHEMA_VERSION) {
    errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(record.session_id)) errors.push('session_id must be a non-empty string');
  if (record.target_type !== 'InterviewNote') errors.push('v1 checkpoint target_type must be InterviewNote');
  if (!isNonEmptyString(record.target_id)) errors.push('target_id must be a non-empty string');
  if (!MODES.has(record.mode)) errors.push('mode must be a supported ExplorationSession mode');
  if (!isNonEmptyString(record.source_revision_id)) errors.push('source_revision_id must be a non-empty string');

  if (!Number.isInteger(record.revealed_position) || record.revealed_position < 1) {
    errors.push('revealed_position must be a positive integer');
  }

  const rangeMatch = typeof record.revealed_range === 'string'
    ? record.revealed_range.match(/^([1-9][0-9]*)\.\.([1-9][0-9]*)$/)
    : null;
  if (!rangeMatch) {
    errors.push('revealed_range must use start..end positive-integer format');
  } else {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (start > end) errors.push('revealed_range start must not exceed end');
    if (Number.isInteger(record.revealed_position) && end !== record.revealed_position) {
      errors.push('revealed_range end must equal revealed_position');
    }
  }

  if (!isNonEmptyString(record.current_source_unit)) errors.push('current_source_unit must be a non-empty string');
  if (!isNonEmptyString(record.source_unit_type) || !/^[a-z][a-z0-9-]*$/.test(record.source_unit_type)) {
    errors.push('source_unit_type must be a stable lowercase machine identifier');
  }
  if (!isNonEmptyString(record.loop_phase) || !/^[a-z][a-z0-9-]*$/.test(record.loop_phase)) {
    errors.push('loop_phase must be a stable lowercase machine identifier');
  }

  const allowedPhases = LOOP_PHASES.get(record.source_unit_type);
  if (allowedPhases && !allowedPhases.has(record.loop_phase)) {
    errors.push(`loop_phase ${record.loop_phase} is not valid for source_unit_type ${record.source_unit_type}`);
  } else if (!allowedPhases && isNonEmptyString(record.source_unit_type)) {
    warnings.push(`source_unit_type ${record.source_unit_type} has no built-in loop-phase matrix; structural checks only`);
  }

  if (typeof record.has_withheld_within_unit !== 'boolean') {
    errors.push('has_withheld_within_unit must be boolean');
  }
  if (record.has_withheld_within_unit === true) {
    if (!isNonEmptyString(record.temporal_cursor)) {
      errors.push('temporal_cursor is required when has_withheld_within_unit=true');
    }
    if (!isNonEmptyString(record.revealed_within_unit)) {
      errors.push('revealed_within_unit is required when has_withheld_within_unit=true');
    }
  }

  if (!POSITION_STATUSES.has(record.position_status)) {
    errors.push('position_status must be active, ready-to-close, complete, or deferred');
  }
  if (!SESSION_STATUSES.has(record.session_status)) {
    errors.push('session_status must be active or completed');
  }

  if (POSITION_STATUSES.has(record.position_status) && record.position_status !== 'active') {
    if (record.loop_phase !== 'closure') {
      errors.push('non-active position_status requires loop_phase=closure');
    }
    if (!isNonEmptyString(record.closure_reason)) {
      errors.push('non-active position_status requires closure_reason');
    }
  }

  if (record.loop_phase === 'closure' && !isNonEmptyString(record.closure_reason)) {
    errors.push('closure loop_phase requires closure_reason');
  }

  if (record.session_status === 'completed') {
    if (record.position_status !== 'complete') {
      errors.push('completed session requires position_status=complete');
    }
    if (record.loop_phase !== 'closure') {
      errors.push('completed session requires loop_phase=closure');
    }
    if (!isNonEmptyString(record.completed_at) || Number.isNaN(Date.parse(record.completed_at))) {
      errors.push('completed session requires a valid completed_at timestamp');
    }
  } else if (record.completed_at != null) {
    errors.push('active session must not set completed_at');
  }

  return { ok: errors.length === 0, errors, warnings, record };
}

module.exports = {
  SCHEMA_VERSION,
  parseCheckpoint,
  validateExplorationSessionCheckpoint,
};
