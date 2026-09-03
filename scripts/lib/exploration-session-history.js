'use strict';

const { validateExplorationSessionCheckpoint } = require('./exploration-session-checkpoint');
const { findUnit, findFragment } = require('./source-sequence-manifest');

const MACHINE_MARKER_OPEN_RE = /<!--\s*exploration-session-checkpoint\b/;
const MANIFEST_BACKED_SCHEMAS = new Set([
  'exploration-session-checkpoint.v2',
  'exploration-session-checkpoint.v3',
]);

const LOOP_PHASE_ORDER = new Map([
  ['question-like', ['literal', 'classification', 'knowledge', 'response', 'depth', 'anticipation', 'closure']],
  ['stage-summary', ['literal', 'classification', 'preparation', 'routing', 'dynamic-depth', 'plausible-dimensions', 'closure']],
  ['outcome-reflection-summary', ['literal', 'evidence-classification', 'structured-extraction', 'attribution-boundary', 'closure']],
]);

const SAME_POSITION_STATUS_TRANSITIONS = new Map([
  ['active', new Set(['active', 'ready-to-close', 'complete', 'deferred'])],
  ['ready-to-close', new Set(['ready-to-close', 'complete'])],
  ['complete', new Set(['complete'])],
  ['deferred', new Set(['deferred'])],
]);

function parseRange(value) {
  const match = typeof value === 'string' ? value.match(/^([1-9][0-9]*)\.\.([1-9][0-9]*)$/) : null;
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

function checkpointOrder(entry) {
  const timestamp = Date.parse(entry.created_at || '');
  return {
    timestamp: Number.isNaN(timestamp) ? null : timestamp,
    id: Number.isFinite(Number(entry.id)) ? Number(entry.id) : null,
    input_index: entry.input_index,
  };
}

function compareEntries(a, b) {
  const ao = checkpointOrder(a);
  const bo = checkpointOrder(b);
  if (ao.timestamp != null && bo.timestamp != null && ao.timestamp !== bo.timestamp) return ao.timestamp - bo.timestamp;
  if (ao.id != null && bo.id != null && ao.id !== bo.id) return ao.id - bo.id;
  return ao.input_index - bo.input_index;
}

function entryLabel(entry) {
  return entry.id != null ? `comment ${entry.id}` : `checkpoint #${entry.input_index + 1}`;
}

function fragmentOrder(record, manifestsById) {
  if (!MANIFEST_BACKED_SCHEMAS.has(record.schema_version) || !record.source_fragment_id) return null;
  const manifest = manifestsById && manifestsById.get(record.source_manifest_id);
  const unit = findUnit(manifest, record.source_unit_id);
  const fragment = findFragment(unit, record.source_fragment_id);
  return fragment ? fragment.order : null;
}

function validateSessionEntries(sessionId, entries, options = {}) {
  const errors = [];
  const warnings = [];
  const ordered = [...entries].sort(compareEntries);
  const first = ordered[0];
  if (!first) return { session_id: sessionId, ok: true, errors, warnings, checkpoints: 0 };

  const identity = {
    schema_version: first.record.schema_version,
    target_type: first.record.target_type,
    target_id: first.record.target_id,
    mode: first.record.mode,
    source_revision_id: first.record.source_revision_id,
  };
  if (MANIFEST_BACKED_SCHEMAS.has(first.record.schema_version)) {
    identity.source_manifest_id = first.record.source_manifest_id;
    identity.source_manifest_sha256 = first.record.source_manifest_sha256;
  }
  if (first.record.schema_version === 'exploration-session-checkpoint.v3') {
    identity.source_review_id = first.record.source_review_id;
  }

  const firstRange = parseRange(first.record.revealed_range);
  const revealedRangeStart = firstRange ? firstRange.start : null;

  for (const entry of ordered) {
    const record = entry.record;
    const label = entryLabel(entry);
    for (const [field, expected] of Object.entries(identity)) {
      if (record[field] !== expected) {
        errors.push(`${label}: ${field} changed within session ${sessionId}; sequential checkpoint history requires stable ${field}`);
      }
    }
    const range = parseRange(record.revealed_range);
    if (range && revealedRangeStart != null && range.start !== revealedRangeStart) errors.push(`${label}: revealed_range start changed within session ${sessionId}`);
  }

  for (let index = 1; index < ordered.length; index += 1) {
    const previousEntry = ordered[index - 1];
    const currentEntry = ordered[index];
    const previous = previousEntry.record;
    const current = currentEntry.record;
    const label = entryLabel(currentEntry);

    if (previous.session_status === 'completed') errors.push(`${label}: completed session ${sessionId} must not produce later checkpoints`);

    const delta = current.revealed_position - previous.revealed_position;
    if (delta < 0) {
      errors.push(`${label}: revealed_position regressed from ${previous.revealed_position} to ${current.revealed_position}`);
      continue;
    }
    if (delta > 1) {
      errors.push(`${label}: revealed_position jumped from ${previous.revealed_position} to ${current.revealed_position}; sequential checkpoints may advance by at most one position`);
      continue;
    }

    if (delta === 1) {
      if (!['ready-to-close', 'complete', 'deferred'].includes(previous.position_status)) {
        errors.push(`${label}: cannot advance to position ${current.revealed_position} while previous position ${previous.revealed_position} is ${previous.position_status}`);
      }
      continue;
    }

    if (current.current_source_unit !== previous.current_source_unit) errors.push(`${label}: current_source_unit changed while revealed_position stayed at ${current.revealed_position}`);
    if (current.source_unit_type !== previous.source_unit_type) errors.push(`${label}: source_unit_type changed while revealed_position stayed at ${current.revealed_position}`);
    if (MANIFEST_BACKED_SCHEMAS.has(current.schema_version) && current.source_unit_id !== previous.source_unit_id) {
      errors.push(`${label}: source_unit_id changed while revealed_position stayed at ${current.revealed_position}`);
    }

    if (previous.has_withheld_within_unit === false && current.has_withheld_within_unit === true) {
      errors.push(`${label}: within-unit Source frontier regressed from fully revealed back to withheld content at position ${current.revealed_position}`);
    }

    if (MANIFEST_BACKED_SCHEMAS.has(current.schema_version)) {
      const previousFragmentOrder = fragmentOrder(previous, options.manifestsById);
      const currentFragmentOrder = fragmentOrder(current, options.manifestsById);
      if (previousFragmentOrder != null && currentFragmentOrder != null && currentFragmentOrder < previousFragmentOrder) {
        errors.push(`${label}: source_fragment_id regressed from manifest order ${previousFragmentOrder} to ${currentFragmentOrder} at position ${current.revealed_position}`);
      }
    }

    const allowedStatuses = SAME_POSITION_STATUS_TRANSITIONS.get(previous.position_status);
    if (allowedStatuses && !allowedStatuses.has(current.position_status)) {
      errors.push(`${label}: position_status regressed from ${previous.position_status} to ${current.position_status} at position ${current.revealed_position}`);
    }

    const order = LOOP_PHASE_ORDER.get(current.source_unit_type);
    if (order) {
      const previousPhase = order.indexOf(previous.loop_phase);
      const currentPhase = order.indexOf(current.loop_phase);
      if (previousPhase >= 0 && currentPhase >= 0 && currentPhase < previousPhase) {
        errors.push(`${label}: loop_phase regressed from ${previous.loop_phase} to ${current.loop_phase} at position ${current.revealed_position}`);
      }
    }
  }

  return {
    session_id: sessionId,
    ok: errors.length === 0,
    errors,
    warnings,
    checkpoints: ordered.length,
    first_comment_id: ordered[0].id ?? null,
    last_comment_id: ordered[ordered.length - 1].id ?? null,
  };
}

function validateExplorationSessionHistory(comments, options = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(comments)) return { ok: false, errors: ['history input must be an array of Issue comments'], warnings, sessions: [] };

  const grouped = new Map();
  comments.forEach((comment, inputIndex) => {
    const body = String(comment && comment.body || '');
    if (!MACHINE_MARKER_OPEN_RE.test(body)) return;

    const result = validateExplorationSessionCheckpoint(body, {
      manifestsById: options.manifestsById,
      reviewsById: options.reviewsById,
      effectiveReviewsByManifestDigest: options.effectiveReviewsByManifestDigest,
      requireCurrentApproval: false,
    });
    const label = comment && comment.id != null ? `comment ${comment.id}` : `comment #${inputIndex + 1}`;
    if (!result.ok) {
      for (const error of result.errors) errors.push(`${label}: ${error}`);
      for (const warning of result.warnings) warnings.push(`${label}: ${warning}`);
      return;
    }
    for (const warning of result.warnings) warnings.push(`${label}: ${warning}`);

    const entry = {
      id: comment && comment.id != null ? comment.id : null,
      created_at: comment && comment.created_at || null,
      updated_at: comment && comment.updated_at || null,
      input_index: inputIndex,
      record: result.record,
    };
    const sessionId = result.record.session_id;
    if (!grouped.has(sessionId)) grouped.set(sessionId, []);
    grouped.get(sessionId).push(entry);
  });

  const sessions = [];
  for (const [sessionId, entries] of grouped.entries()) {
    const sessionResult = validateSessionEntries(sessionId, entries, options);
    sessions.push(sessionResult);
    errors.push(...sessionResult.errors);
    warnings.push(...sessionResult.warnings);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    sessions,
    machine_checkpoints: [...grouped.values()].reduce((total, entries) => total + entries.length, 0),
  };
}

module.exports = {
  validateExplorationSessionHistory,
};
