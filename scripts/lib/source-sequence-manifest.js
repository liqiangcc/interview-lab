'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'source-sequence-manifest.v1';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateArtifactIdentity(artifact, prefix, errors, options = {}) {
  const shaField = options.shaField || 'raw_git_blob_sha';
  const sha = artifact[shaField];
  const storageKind = artifact.storage_kind;
  if (sha === null) {
    if (storageKind !== 'runtime-artifact-store') {
      errors.push(`${prefix}.${shaField}=null requires storage_kind=runtime-artifact-store`);
    }
  } else if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) {
    errors.push(`${prefix}.${shaField} must be a 40-char lowercase hex SHA or null for runtime artifacts`);
  } else if (storageKind === 'runtime-artifact-store') {
    errors.push(`${prefix}.${shaField} must be null for runtime-artifact-store artifacts`);
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function computeManifestDigest(manifest) {
  const payload = {};
  for (const [key, value] of Object.entries(manifest || {})) {
    if (key === 'content_sha256' || key === '__file') continue;
    payload[key] = value;
  }
  return crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function validateSourceSequenceManifest(manifest) {
  const errors = [];
  const warnings = [];

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest must be an object'], warnings, manifest: null };
  }

  if (manifest.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isNonEmptyString(manifest.manifest_id)) errors.push('manifest_id must be a non-empty string');
  if (!/^[0-9a-f]{64}$/.test(String(manifest.content_sha256 || ''))) {
    errors.push('content_sha256 must be a 64-char lowercase hex SHA-256');
  } else {
    const expectedDigest = computeManifestDigest(manifest);
    if (manifest.content_sha256 !== expectedDigest) errors.push(`content_sha256 mismatch; expected ${expectedDigest}`);
  }
  if (!isNonEmptyString(manifest.interview_note_id)) errors.push('interview_note_id must be a non-empty string');
  if (!isNonEmptyString(manifest.source_revision_id)) errors.push('source_revision_id must be a non-empty string');
  if (!isNonEmptyString(manifest.sequence_scope)) errors.push('sequence_scope must be a non-empty string');

  const stream = manifest.evidence_stream;
  if (!stream || typeof stream !== 'object' || Array.isArray(stream)) {
    errors.push('evidence_stream must be an object');
  } else {
    if (!isNonEmptyString(stream.stream_id)) errors.push('evidence_stream.stream_id must be a non-empty string');
    if (!isNonEmptyString(stream.raw_artifact_ref)) errors.push('evidence_stream.raw_artifact_ref must be a non-empty string');
    validateArtifactIdentity(stream, 'evidence_stream', errors);
    if (!/^[0-9a-f]{64}$/.test(String(stream.raw_sha256 || ''))) errors.push('evidence_stream.raw_sha256 must be a 64-char lowercase hex SHA-256');

    if (stream.readable_projection != null) {
      const projection = stream.readable_projection;
      if (!projection || typeof projection !== 'object' || Array.isArray(projection)) {
        errors.push('evidence_stream.readable_projection must be an object or null');
      } else {
        if (!isNonEmptyString(projection.ref)) errors.push('readable_projection.ref must be a non-empty string');
        validateArtifactIdentity(projection, 'readable_projection', errors, { shaField: 'git_blob_sha' });
        if (projection.sha256 != null && !/^[0-9a-f]{64}$/.test(String(projection.sha256))) errors.push('readable_projection.sha256 must be a 64-char lowercase hex SHA-256');
        if (!['derived', 'source_projection'].includes(projection.provenance)) errors.push('readable_projection.provenance must remain derived or source_projection');
        if (!['unreviewed', 'fidelity-reviewed'].includes(projection.review_status)) errors.push('readable_projection.review_status must be unreviewed or fidelity-reviewed');
      }
    }
    if (stream.storage_kind === 'runtime-artifact-store') {
      if (!stream.readable_projection || typeof stream.readable_projection !== 'object' || Array.isArray(stream.readable_projection)) {
        errors.push('runtime-artifact-store sequences require a readable_projection');
      } else if (!/^[0-9a-f]{64}$/.test(String(stream.readable_projection.sha256 || ''))) {
        errors.push('runtime readable_projection requires sha256');
      } else if (stream.readable_projection.provenance !== 'source_projection') {
        errors.push('runtime readable_projection.provenance must be source_projection');
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
    if (manifest.evidence_stream && manifest.evidence_stream.storage_kind === 'runtime-artifact-store') {
      const provenance = unit.source_provenance;
      if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
        errors.push(`${prefix}.source_provenance is required for runtime-artifact-store sequences`);
      } else {
        if (!isNonEmptyString(provenance.source_projection_ref)) errors.push(`${prefix}.source_provenance.source_projection_ref must be a non-empty string`);
        if (!/^[0-9a-f]{64}$/.test(String(provenance.source_projection_sha256 || ''))) errors.push(`${prefix}.source_provenance.source_projection_sha256 must be a 64-char lowercase hex SHA-256`);
        if (!isNonEmptyString(provenance.raw_artifact_ref)) errors.push(`${prefix}.source_provenance.raw_artifact_ref must be a non-empty string`);
        if (!/^[0-9a-f]{64}$/.test(String(provenance.raw_sha256 || ''))) errors.push(`${prefix}.source_provenance.raw_sha256 must be a 64-char lowercase hex SHA-256`);
        if (!Number.isInteger(provenance.source_projection_item_number) || provenance.source_projection_item_number !== unit.position) {
          errors.push(`${prefix}.source_provenance.source_projection_item_number must equal SourceUnit position`);
        }
        if (provenance.source_projection_ref !== manifest.evidence_stream.readable_projection?.ref) {
          errors.push(`${prefix}.source_provenance.source_projection_ref must equal evidence_stream.readable_projection.ref`);
        }
        if (provenance.source_projection_sha256 !== manifest.evidence_stream.readable_projection?.sha256) {
          errors.push(`${prefix}.source_provenance.source_projection_sha256 must equal evidence_stream.readable_projection.sha256`);
        }
        if (provenance.raw_artifact_ref !== manifest.evidence_stream.raw_artifact_ref) {
          errors.push(`${prefix}.source_provenance.raw_artifact_ref must equal evidence_stream.raw_artifact_ref`);
        }
        if (provenance.raw_sha256 !== manifest.evidence_stream.raw_sha256) {
          errors.push(`${prefix}.source_provenance.raw_sha256 must equal evidence_stream.raw_sha256`);
        }
      }
    }
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
  computeManifestDigest,
  validateSourceSequenceManifest,
  loadSourceSequenceManifests,
  findUnit,
  findFragment,
};
