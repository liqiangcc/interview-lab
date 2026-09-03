'use strict';

const { findUnit, findFragment } = require('./source-sequence-manifest');
const { getEffectiveSourceSequenceReview } = require('./source-sequence-review');

const SCHEMA_VERSION_V1 = 'exploration-session-checkpoint.v1';
const SCHEMA_VERSION_V2 = 'exploration-session-checkpoint.v2';
const SUPPORTED_SCHEMA_VERSIONS = new Set([SCHEMA_VERSION_V1, SCHEMA_VERSION_V2]);
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

function validateManifestBinding(record, manifestsById, effectiveReviewsByManifestDigest, errors) {
  if (!isNonEmptyString(record.source_manifest_id)) errors.push('v2 checkpoint requires source_manifest_id');
  if (!/^[0-9a-f]{64}$/.test(String(record.source_manifest_sha256 || ''))) errors.push('v2 checkpoint requires source_manifest_sha256');
  if (!isNonEmptyString(record.source_unit_id)) errors.push('v2 checkpoint requires source_unit_id');
  if (!manifestsById || typeof manifestsById.get !== 'function') {
    errors.push('v2 checkpoint validation requires a SourceSequenceManifest registry');
    return;
  }

  const manifest = manifestsById.get(record.source_manifest_id);
  if (!manifest) {
    errors.push(`source_manifest_id ${record.source_manifest_id} does not resolve to a registered manifest`);
    return;
  }
  if (manifest.content_sha256 !== record.source_manifest_sha256) errors.push('v2 checkpoint source_manifest_sha256 must equal manifest content_sha256');

  if (!effectiveReviewsByManifestDigest || typeof effectiveReviewsByManifestDigest.get !== 'function') {
    errors.push('v2 checkpoint validation requires a SourceSequenceReview registry');
  } else {
    const review = getEffectiveSourceSequenceReview(
      effectiveReviewsByManifestDigest,
      record.source_manifest_id,
      record.source_manifest_sha256,
    );
    if (!review) {
      errors.push('v2 checkpoint referenced manifest digest has no effective SourceSequenceReview');
    } else if (review.decision !== 'approved') {
      errors.push(`v2 checkpoint referenced manifest digest is not approved; effective review=${review.review_id} decision=${review.decision}`);
    }
  }

  if (manifest.interview_note_id !== record.target_id) errors.push('v2 checkpoint target_id must equal manifest.interview_note_id');
  if (manifest.source_revision_id !== record.source_revision_id) errors.push('v2 checkpoint source_revision_id must equal manifest.source_revision_id');

  const unit = findUnit(manifest, record.source_unit_id);
  if (!unit) {
    errors.push(`source_unit_id ${record.source_unit_id} does not exist in the referenced manifest`);
    return;
  }
  if (unit.position !== record.revealed_position) errors.push('v2 checkpoint revealed_position must equal manifest SourceUnit position');
  if (unit.source_unit_type !== record.source_unit_type) errors.push('v2 checkpoint source_unit_type must equal manifest SourceUnit type');
  if (unit.text_projection !== record.current_source_unit) errors.push('v2 checkpoint current_source_unit must equal manifest SourceUnit text_projection');

  const fragments = Array.isArray(unit.fragments) ? [...unit.fragments].sort((a, b) => a.order - b.order) : [];
  if (fragments.length === 0) {
    if (record.source_fragment_id != null) errors.push('v2 checkpoint source_fragment_id must be null when SourceUnit has no fragments');
    if (record.has_withheld_within_unit !== false) errors.push('v2 checkpoint has_withheld_within_unit must be false when SourceUnit has no fragments');
    if (record.temporal_cursor != null) errors.push('v2 checkpoint temporal_cursor must be null when SourceUnit has no fragments');
    return;
  }

  if (!isNonEmptyString(record.source_fragment_id)) {
    errors.push('v2 checkpoint requires source_fragment_id when SourceUnit defines fragments');
    return;
  }
  const fragment = findFragment(unit, record.source_fragment_id);
  if (!fragment) {
    errors.push(`source_fragment_id ${record.source_fragment_id} does not exist in the referenced SourceUnit`);
    return;
  }
  const expectedWithheld = fragment.order < fragments[fragments.length - 1].order;
  if (record.has_withheld_within_unit !== expectedWithheld) {
    errors.push(`v2 checkpoint has_withheld_within_unit must be ${expectedWithheld} at SourceFragment order ${fragment.order}`);
  }
  if (record.temporal_cursor !== record.source_fragment_id) {
    errors.push('v2 checkpoint temporal_cursor must equal source_fragment_id for manifest-backed temporal ordering');
  }
  if (!isNonEmptyString(record.revealed_within_unit)) {
    errors.push('v2 checkpoint revealed_within_unit must describe the revealed fragment frontier');
  }
}

function validateExplorationSessionCheckpoint(body, options = {}) {
  const parsed = parseCheckpoint(body);
  const errors = [...parsed.errors];
  const warnings = [];
  const record = parsed.record;

  if (!record) return { ok: false, errors, warnings, record: null };

  if (!SUPPORTED_SCHEMA_VERSIONS.has(record.schema_version)) errors.push(`schema_version must be ${SCHEMA_VERSION_V1} or ${SCHEMA_VERSION_V2}`);
  if (!isNonEmptyString(record.session_id)) errors.push('session_id must be a non-empty string');
  if (record.target_type !== 'InterviewNote') errors.push('checkpoint target_type must be InterviewNote');
  if (!isNonEmptyString(record.target_id)) errors.push('target_id must be a non-empty string');
  if (!MODES.has(record.mode)) errors.push('mode must be a supported ExplorationSession mode');
  if (!isNonEmptyString(record.source_revision_id)) errors.push('source_revision_id must be a non-empty string');

  if (!Number.isInteger(record.revealed_position) || record.revealed_position < 1) errors.push('revealed_position must be a positive integer');

  const rangeMatch = typeof record.revealed_range === 'string'
    ? record.revealed_range.match(/^([1-9][0-9]*)\.\.([1-9][0-9]*)$/)
    : null;
  if (!rangeMatch) {
    errors.push('revealed_range must use start..end positive-integer format');
  } else {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (start > end) errors.push('revealed_range start must not exceed end');
    if (Number.isInteger(record.revealed_position) && end !== record.revealed_position) errors.push('revealed_range end must equal revealed_position');
  }

  if (!isNonEmptyString(record.current_source_unit)) errors.push('current_source_unit must be a non-empty string');
  if (!isNonEmptyString(record.source_unit_type) || !/^[a-z][a-z0-9-]*$/.test(record.source_unit_type)) errors.push('source_unit_type must be a stable lowercase machine identifier');
  if (!isNonEmptyString(record.loop_phase) || !/^[a-z][a-z0-9-]*$/.test(record.loop_phase)) errors.push('loop_phase must be a stable lowercase machine identifier');

  const allowedPhases = LOOP_PHASES.get(record.source_unit_type);
  if (allowedPhases && !allowedPhases.has(record.loop_phase)) {
    errors.push(`loop_phase ${record.loop_phase} is not valid for source_unit_type ${record.source_unit_type}`);
  } else if (!allowedPhases && isNonEmptyString(record.source_unit_type)) {
    warnings.push(`source_unit_type ${record.source_unit_type} has no built-in loop-phase matrix; structural checks only`);
  }

  if (typeof record.has_withheld_within_unit !== 'boolean') errors.push('has_withheld_within_unit must be boolean');
  if (record.has_withheld_within_unit === true) {
    if (!isNonEmptyString(record.temporal_cursor)) errors.push('temporal_cursor is required when has_withheld_within_unit=true');
    if (!isNonEmptyString(record.revealed_within_unit)) errors.push('revealed_within_unit is required when has_withheld_within_unit=true');
  }

  if (!POSITION_STATUSES.has(record.position_status)) errors.push('position_status must be active, ready-to-close, complete, or deferred');
  if (!SESSION_STATUSES.has(record.session_status)) errors.push('session_status must be active or completed');

  if (POSITION_STATUSES.has(record.position_status) && record.position_status !== 'active') {
    if (record.loop_phase !== 'closure') errors.push('non-active position_status requires loop_phase=closure');
    if (!isNonEmptyString(record.closure_reason)) errors.push('non-active position_status requires closure_reason');
  }
  if (record.loop_phase === 'closure' && !isNonEmptyString(record.closure_reason)) errors.push('closure loop_phase requires closure_reason');

  if (record.session_status === 'completed') {
    if (record.position_status !== 'complete') errors.push('completed session requires position_status=complete');
    if (record.loop_phase !== 'closure') errors.push('completed session requires loop_phase=closure');
    if (!isNonEmptyString(record.completed_at) || Number.isNaN(Date.parse(record.completed_at))) errors.push('completed session requires a valid completed_at timestamp');
  } else if (record.completed_at != null) {
    errors.push('active session must not set completed_at');
  }

  if (record.schema_version === SCHEMA_VERSION_V2) {
    validateManifestBinding(
      record,
      options.manifestsById,
      options.effectiveReviewsByManifestDigest,
      errors,
    );
  }

  return { ok: errors.length === 0, errors, warnings, record };
}

module.exports = {
  SCHEMA_VERSION_V1,
  SCHEMA_VERSION_V2,
  SUPPORTED_SCHEMA_VERSIONS,
  parseCheckpoint,
  validateExplorationSessionCheckpoint,
};
