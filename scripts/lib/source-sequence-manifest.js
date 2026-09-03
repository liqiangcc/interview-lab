'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'source-sequence-manifest.v1';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateSourceSequenceManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest must be an object'], warnings, manifest: null };
  }

  if (manifest.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isNonEmptyString(manifest.manifest_id)) errors.push('manifest_id must be a non-empty string');
  if (!isNonEmptyString(manifest.interview_note_id)) errors.push('interview_note_id must be a non-empty string');
  if (!isNonEmptyString(manifest.source_revision_id)) errors.push('source_revision_id must be a non-empty string');
  if (!isNonEmptyString(manifest.sequence_scope)) errors.push('sequence_scope must be a non-empty string');

  const stream = manifest.evidence_stream;
  if (!stream || typeof stream !== 'object' || Array.isArray(stream)) {
    errors.push('evidence_stream must be an object');
  } else {
    if (!isNonEmptyString(stream.stream_id)) errors.push('evidence_stream.stream_id must be a non-empty string');
    if (!isNonEmptyString(stream.raw_artifact_ref)) errors.push('evidence_stream.raw_artifact_ref must be a non-empty string');
    if (!/^[0-9a-f]{40}$/.test(String(stream.raw_git_blob_sha || ''))) errors.push('evidence_stream.raw_git_blob_sha must be a 40-char lowercase hex SHA');
    if (!/^[0-9a-f]{64}$/.test(String(stream.raw_sha256 || ''))) errors.push('evidence_stream.raw_sha256 must be a 64-char lowercase hex SHA-256');

    if (stream.readable_projection != null) {
      const projection = stream.readable_projection;
      if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
        errors.push('evidence_stream.readable_projection must be an object or null');
      } else {
        if (!isNonEmptyString(projection.ref)) errors.push('readable_projection.ref must be a non-empty string');
        if (!/^[0-9a-f]{40}$/.test(String(projection.git_blob_sha || ''))) errors.push('readable_projection.git_blob_sha must be a 40-char lowercase hex SHA');
        if (projection.provenance !== 'derived') errors.push('readable_projection.provenance must remain derived');
        if (!['unreviewed', 'fidelity-reviewed'].includes(projection.review_status)) errors.push('readable_projection.review_status must be unreviewed or fidelity-reviewed');
      }
    }
  }

  if (!Array.isArray(manifest.units) || manifest.units.length === 0) {
    errors.push('units must be a non-empty array');
    return { ok: errors.length === 0, errors, warnings, manifest };
  }

  const unitIds = new Set();
  const fragmentIds = new Set();
  const orderedUnits = [...manifest.units].sort((a, b) => Number(a.position) - Number(b.position));

  orderedUnits.forEach((unit, index) => {
    const expectedPosition = index + 1;
    const prefix = `units[${index}]`;
    if (!unit || typeof unit !== 'object' || Array.isArray(unit)) {
      errors.push(`${prefix} must be an object`);
      return;
    }
    if (!isNonEmptyString(unit.source_unit_id)) {
      errors.push(`${prefix}.source_unit_id must be a non-empty string`);
    } else if (unitIds.has(unit.source_unit_id)) {
      errors.push(`${prefix}.source_unit_id must be unique`);
    } else {
      unitIds.add(unit.source_unit_id);
    }
    if (!Number.isInteger(unit.position) || unit.position !== expectedPosition) {
      errors.push(`${prefix}.position must form contiguous 1..N order; expected ${expectedPosition}`);
    }
    if (!isNonEmptyString(unit.source_unit_type) || !/^[a-z][a-z0-9-]*$/.test(unit.source_unit_type)) {
      errors.push(`${prefix}.source_unit_type must be a stable lowercase machine identifier`);
    }
    if (!isNonEmptyString(unit.text_projection)) errors.push(`${prefix}.text_projection must be a non-empty string`);
    if (!Array.isArray(unit.fragments)) {
      errors.push(`${prefix}.fragments must be an array`);
      return;
    }

    let previousStart = -1;
    [...unit.fragments].sort((a, b) => Number(a.order) - Number(b.order)).forEach((fragment, fragmentIndex) => {
      const fragmentPrefix = `${prefix}.fragments[${fragmentIndex}]`;
      const expectedOrder = fragmentIndex + 1;
      if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
        errors.push(`${fragmentPrefix} must be an object`);
        return;
      }
      if (!isNonEmptyString(fragment.source_fragment_id)) {
        errors.push(`${fragmentPrefix}.source_fragment_id must be a non-empty string`);
      } else if (fragmentIds.has(fragment.source_fragment_id)) {
        errors.push(`${fragmentPrefix}.source_fragment_id must be globally unique within the manifest`);
      } else {
        fragmentIds.add(fragment.source_fragment_id);
      }
      if (!Number.isInteger(fragment.order) || fragment.order !== expectedOrder) {
        errors.push(`${fragmentPrefix}.order must form contiguous 1..N order; expected ${expectedOrder}`);
      }
      if (!isNonEmptyString(fragment.fragment_type) || !/^[a-z][a-z0-9-]*$/.test(fragment.fragment_type)) {
        errors.push(`${fragmentPrefix}.fragment_type must be a stable lowercase machine identifier`);
      }
      if (!isNonEmptyString(fragment.text_projection)) {
        errors.push(`${fragmentPrefix}.text_projection must be a non-empty string`);
      } else if (isNonEmptyString(unit.text_projection)) {
        const start = unit.text_projection.indexOf(fragment.text_projection);
        if (start < 0) {
          errors.push(`${fragmentPrefix}.text_projection must occur within the parent unit text_projection`);
        } else if (start <= previousStart) {
          errors.push(`${fragmentPrefix}.text_projection must follow the previous fragment in parent text order`);
        } else {
          previousStart = start;
        }
      }
    });
  });

  return { ok: errors.length === 0, errors, warnings, manifest };
}

function loadSourceSequenceManifests(directory = path.join(process.cwd(), 'data', 'source-sequences')) {
  const errors = [];
  const warnings = [];
  const manifests = [];
  const byId = new Map();

  if (!fs.existsSync(directory)) return { ok: true, errors, warnings, manifests, byId };

  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort()) {
    const filePath = path.join(directory, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      errors.push(`${name}: invalid JSON: ${error.message}`);
      continue;
    }
    const result = validateSourceSequenceManifest(parsed);
    errors.push(...result.errors.map((error) => `${name}: ${error}`));
    warnings.push(...result.warnings.map((warning) => `${name}: ${warning}`));
    if (!result.ok) continue;
    if (byId.has(parsed.manifest_id)) {
      errors.push(`${name}: duplicate manifest_id ${parsed.manifest_id}`);
      continue;
    }
    parsed.__file = filePath;
    manifests.push(parsed);
    byId.set(parsed.manifest_id, parsed);
  }

  return { ok: errors.length === 0, errors, warnings, manifests, byId };
}

function findUnit(manifest, sourceUnitId) {
  return manifest && Array.isArray(manifest.units)
    ? manifest.units.find((unit) => unit.source_unit_id === sourceUnitId) || null
    : null;
}

function findFragment(unit, sourceFragmentId) {
  return unit && Array.isArray(unit.fragments)
    ? unit.fragments.find((fragment) => fragment.source_fragment_id === sourceFragmentId) || null
    : null;
}

module.exports = {
  SCHEMA_VERSION,
  validateSourceSequenceManifest,
  loadSourceSequenceManifests,
  findUnit,
  findFragment,
};
