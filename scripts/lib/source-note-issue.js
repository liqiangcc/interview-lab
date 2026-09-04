'use strict';

const MARKER_RE = /<!--\s*source-note:\s*id=([^\s]+)\s+schema=([^\s]+)\s*-->/g;
const RECORD_RE = /<!--\s*source-note-record\s*\n([\s\S]*?)\n-->/g;
const SCHEMA_V1 = 'source-note-issue.v1';
const SCHEMA_V2 = 'source-note-issue.v2';
const SCHEMA = SCHEMA_V1; // backward-compatible export
const SUPPORTED_SCHEMAS = new Set([SCHEMA_V1, SCHEMA_V2]);
const REQUIRED_SECTIONS = [
  '## 来源身份',
  '## 原始标题',
  '## 原始正文',
  '## 原始附件',
  '## Intake 异常',
  '## 边界审核',
  '## 来源限制',
  '## 派生链接',
];
const BOUNDARY_VALUES = new Set(['pending', 'not-interview', 'single-interview', 'multi-interview']);
const ALLOWED_INTEGRITY = new Set(['present', 'zero-byte']);
const ALLOWED_PROVENANCE_V1 = new Set(['raw_capture', 'source_projection']);
const ALLOWED_PROVENANCE_V2 = new Set(['raw_capture', 'raw_dom_snapshot', 'raw_context_capture', 'source_projection', 'derived_projection']);
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function allMatches(regex, text) {
  const copy = new RegExp(regex.source, regex.flags);
  return [...String(text || '').matchAll(copy)];
}

function parseSourceNoteIssue(body) {
  const markerMatches = allMatches(MARKER_RE, body);
  const recordMatches = allMatches(RECORD_RE, body);
  let record = null;
  let recordParseError = null;
  if (recordMatches.length === 1) {
    try {
      record = JSON.parse(recordMatches[0][1]);
    } catch (error) {
      recordParseError = error.message;
    }
  }
  return {
    markerMatches,
    recordMatches,
    marker: markerMatches.length === 1 ? {
      source_note_id: markerMatches[0][1],
      schema_version: markerMatches[0][2],
    } : null,
    record,
    recordParseError,
  };
}

function validateTimeFact(fieldName, timeFact, errors) {
  if (!timeFact || typeof timeFact !== 'object' || Array.isArray(timeFact)) {
    errors.push(`record.${fieldName} must be an object`);
    return;
  }
  const { precision, value } = timeFact;
  const patterns = {
    exact: /^\d{4}-\d{2}-\d{2}(T.*)?$/,
    month: /^\d{4}-\d{2}$/,
    year: /^\d{4}$/,
    month_day: /^\d{2}-\d{2}$/,
  };
  if (precision === 'unknown') {
    if (value !== null) errors.push(`unknown ${fieldName} must use value=null`);
    return;
  }
  if (!patterns[precision]) {
    errors.push(`unsupported ${fieldName} precision: ${precision}`);
    return;
  }
  if (typeof value !== 'string' || !patterns[precision].test(value)) {
    errors.push(`${fieldName} value does not match precision ${precision}`);
  }
}

function yearFromTimeFact(timeFact) {
  if (!timeFact || !['exact', 'month', 'year'].includes(timeFact.precision)) return null;
  if (typeof timeFact.value !== 'string') return null;
  const match = timeFact.value.match(/^(\d{4})/);
  return match ? match[1] : null;
}

function validateCommonIdentity(record, marker, errors) {
  if (typeof record.source_note_id !== 'string' || !/^xhs-note:.+/.test(record.source_note_id)) {
    errors.push('record.source_note_id must use xhs-note:<external-id>');
  }
  if (marker && marker.source_note_id !== record.source_note_id) {
    errors.push('machine marker id and record.source_note_id differ');
  }
  if (marker && marker.schema_version !== record.schema_version) {
    errors.push('machine marker schema and record.schema_version differ');
  }
  if (!record.source || typeof record.source !== 'object' || Array.isArray(record.source)) {
    errors.push('record.source is required');
  } else {
    if (record.source.system !== 'xhs') errors.push('SourceNote currently requires source.system=xhs');
    if (!record.source.external_id) errors.push('record.source.external_id is required');
    if (record.source.external_id && record.source_note_id !== `xhs-note:${record.source.external_id}`) {
      errors.push('source_note_id must equal xhs-note:<source.external_id>');
    }
    if (record.source.url != null && typeof record.source.url !== 'string') {
      errors.push('record.source.url must be a string or null');
    }
    if (typeof record.source.url === 'string' && /[?&]xsec_token=/.test(record.source.url)) {
      errors.push('record.source.url must not persist XHS ephemeral access parameters');
    }
  }
}

function validateArtifactCommon(artifact, index, schemaVersion, errors) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    errors.push(`artifact[${index}] must be an object`);
    return false;
  }
  if (!artifact.kind) errors.push(`artifact[${index}].kind is required`);
  if (!artifact.ref) errors.push(`artifact[${index}].ref is required`);
  const allowedProvenance = schemaVersion === SCHEMA_V2 ? ALLOWED_PROVENANCE_V2 : ALLOWED_PROVENANCE_V1;
  if (!allowedProvenance.has(artifact.provenance)) {
    errors.push(`artifact[${index}].provenance is unsupported for ${schemaVersion}`);
  }
  if (artifact.git_blob_sha != null && !HEX40.test(artifact.git_blob_sha)) {
    errors.push(`artifact[${index}].git_blob_sha must be a lowercase 40-char Git object id or null`);
  }
  if (artifact.sha256 != null && !HEX64.test(artifact.sha256)) {
    errors.push(`artifact[${index}].sha256 must be a lowercase 64-char SHA-256 or null`);
  }
  if (!Number.isInteger(artifact.byte_size) || artifact.byte_size < 0) {
    errors.push(`artifact[${index}].byte_size must be a non-negative integer`);
  }
  if (!ALLOWED_INTEGRITY.has(artifact.integrity)) {
    errors.push(`artifact[${index}].integrity must be present/zero-byte`);
  }
  if (artifact.byte_size === 0 && artifact.integrity !== 'zero-byte') {
    errors.push(`artifact[${index}] with byte_size=0 must use integrity=zero-byte`);
  }
  if (artifact.byte_size > 0 && artifact.integrity !== 'present') {
    errors.push(`artifact[${index}] with byte_size>0 must use integrity=present`);
  }
  if (artifact.sequence != null && (!Number.isInteger(artifact.sequence) || artifact.sequence < 1)) {
    errors.push(`artifact[${index}].sequence must be a positive integer when present`);
  }
  return true;
}

function validateArtifacts(record, schemaVersion, errors) {
  if (!Array.isArray(record.artifacts)) {
    errors.push('record.artifacts must be an array');
    return;
  }
  let rawCount = 0;
  const sequences = new Set();
  record.artifacts.forEach((artifact, index) => {
    if (!validateArtifactCommon(artifact, index, schemaVersion, errors)) return;
    if (typeof artifact.provenance === 'string' && (artifact.provenance === 'raw_capture' || artifact.provenance.startsWith('raw_'))) rawCount += 1;
    if (artifact.sequence != null) {
      if (sequences.has(artifact.sequence)) errors.push(`artifact sequence ${artifact.sequence} is duplicated`);
      sequences.add(artifact.sequence);
    }
    if (schemaVersion === SCHEMA_V2) {
      if (artifact.git_blob_sha !== null) {
        errors.push(`artifact[${index}].git_blob_sha must be null for runtime SourceCapture artifacts`);
      }
      if (!HEX64.test(artifact.sha256 || '')) {
        errors.push(`artifact[${index}].sha256 is required for runtime SourceCapture artifacts`);
      }
      if (typeof artifact.ref !== 'string' || !artifact.ref.startsWith('source-capture:') || !artifact.ref.includes('#')) {
        errors.push(`artifact[${index}].ref must use source-capture:<revision>#<path>`);
      }
      if (typeof artifact.ref === 'string' && /xsec_token=/.test(artifact.ref)) {
        errors.push(`artifact[${index}].ref must not persist XHS ephemeral access parameters`);
      }
      if (artifact.derived_from != null) {
        if (!Array.isArray(artifact.derived_from)) {
          errors.push(`artifact[${index}].derived_from must be an array when present`);
        } else {
          artifact.derived_from.forEach((ref, derivedIndex) => {
            if (typeof ref !== 'string' || !ref.startsWith('source-capture:') || !ref.includes('#')) {
              errors.push(`artifact[${index}].derived_from[${derivedIndex}] must use source-capture:<revision>#<path>`);
            }
          });
        }
      }
    }
  });
  if (schemaVersion === SCHEMA_V2 && rawCount === 0) {
    errors.push('SourceNote v2 requires at least one raw_capture artifact');
  }
}

function validateRevisionV1(revision, errors) {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) {
    errors.push('record.source_revision is required');
    return;
  }
  if (!revision.id) errors.push('record.source_revision.id is required');
  if (!revision.source_repository) errors.push('record.source_revision.source_repository is required');
  if (!HEX40.test(revision.source_repository_ref || '')) {
    errors.push('record.source_revision.source_repository_ref must be a lowercase 40-char Git commit');
  }
}

function validateRevisionV2(revision, errors) {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) {
    errors.push('record.source_revision is required');
    return;
  }
  if (!revision.id) errors.push('record.source_revision.id is required');
  if (!revision.captured_at) errors.push('record.source_revision.captured_at is required');
  if (revision.producer !== 'liqiangcc/source-acquisition-runtime') {
    errors.push('SourceNote v2 source_revision.producer must equal liqiangcc/source-acquisition-runtime');
  }
  if (revision.source_capture_schema !== 'source-capture.v1') {
    errors.push('SourceNote v2 source_revision.source_capture_schema must equal source-capture.v1');
  }
  if (revision.storage_kind !== 'runtime-artifact-store') {
    errors.push('SourceNote v2 source_revision.storage_kind must equal runtime-artifact-store');
  }
  if (typeof revision.manifest_ref !== 'string' || !revision.manifest_ref.startsWith('source-capture:') || !revision.manifest_ref.endsWith('#manifest.json')) {
    errors.push('SourceNote v2 source_revision.manifest_ref must use source-capture:<revision>#manifest.json');
  }
  if (!HEX64.test(revision.manifest_sha256 || '')) {
    errors.push('SourceNote v2 source_revision.manifest_sha256 must be a lowercase 64-char SHA-256');
  }
  if (!Number.isInteger(revision.manifest_byte_size) || revision.manifest_byte_size <= 0) {
    errors.push('SourceNote v2 source_revision.manifest_byte_size must be a positive integer');
  }
  if (!revision.reason) errors.push('record.source_revision.reason is required');
}

function validateAccessBoundary(accessBoundary, errors) {
  if (accessBoundary == null) return;
  if (typeof accessBoundary !== 'object' || Array.isArray(accessBoundary)) {
    errors.push('record.access_boundary must be an object or null');
    return;
  }
  if (typeof accessBoundary.bare_canonical_replay !== 'string' || !accessBoundary.bare_canonical_replay) {
    errors.push('record.access_boundary.bare_canonical_replay is required when access_boundary is present');
  }
  if (typeof accessBoundary.live_rediscovery !== 'string' || !accessBoundary.live_rediscovery) {
    errors.push('record.access_boundary.live_rediscovery is required when access_boundary is present');
  }
  if (accessBoundary.stable_note_id_match != null && typeof accessBoundary.stable_note_id_match !== 'boolean') {
    errors.push('record.access_boundary.stable_note_id_match must be boolean or null');
  }
  if (accessBoundary.ephemeral_access_parameters_persisted !== false) {
    errors.push('record.access_boundary.ephemeral_access_parameters_persisted must be false');
  }
}

function validateRecord(record, marker, errors) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    errors.push('source-note-record must be one JSON object');
    return;
  }
  const schemaVersion = record.schema_version;
  if (!SUPPORTED_SCHEMAS.has(schemaVersion)) {
    errors.push(`unsupported record.schema_version: ${schemaVersion}`);
    return;
  }
  validateCommonIdentity(record, marker, errors);
  if (schemaVersion === SCHEMA_V1) validateRevisionV1(record.source_revision, errors);
  else validateRevisionV2(record.source_revision, errors);

  validateTimeFact('source_published_at', record.source_published_at, errors);
  validateTimeFact('source_edited_at', record.source_edited_at, errors);
  validateArtifacts(record, schemaVersion, errors);

  if (!Array.isArray(record.anomalies)) errors.push('record.anomalies must be an array');
  if (!Array.isArray(record.limitations)) errors.push('record.limitations must be an array');
  if (schemaVersion === SCHEMA_V2) {
    if (!record.observed_metadata || typeof record.observed_metadata !== 'object' || Array.isArray(record.observed_metadata)) {
      errors.push('SourceNote v2 record.observed_metadata must be an object');
    }
    validateAccessBoundary(record.access_boundary, errors);
  }

  if (!record.boundary_review || typeof record.boundary_review !== 'object') {
    errors.push('record.boundary_review is required');
  } else {
    if (!BOUNDARY_VALUES.has(record.boundary_review.status)) {
      errors.push('boundary_review.status must be pending/not-interview/single-interview/multi-interview');
    }
    if (!Array.isArray(record.boundary_review.interview_note_ids)) {
      errors.push('boundary_review.interview_note_ids must be an array');
    } else {
      if (record.boundary_review.status === 'pending' && record.boundary_review.interview_note_ids.length !== 0) {
        errors.push('pending boundary review must not predeclare InterviewNote ids');
      }
      if (record.boundary_review.status === 'not-interview' && record.boundary_review.interview_note_ids.length !== 0) {
        errors.push('not-interview boundary review must not contain InterviewNote ids');
      }
      if (record.boundary_review.status === 'single-interview' && record.boundary_review.interview_note_ids.length !== 1) {
        errors.push('single-interview boundary review must contain exactly one InterviewNote id');
      }
      if (record.boundary_review.status === 'multi-interview' && record.boundary_review.interview_note_ids.length < 2) {
        errors.push('multi-interview boundary review must contain at least two InterviewNote ids');
      }
    }
  }
}

function validateSourceYearProjection(record, labelSet, errors) {
  const labels = [...labelSet].filter((label) => label.startsWith('source-year:'));
  if (labels.length > 1) {
    errors.push(`SourceNote source-year family must have at most one value: ${labels.join(', ')}`);
    return;
  }
  const expectedYear = record ? yearFromTimeFact(record.source_published_at) : null;
  if (expectedYear == null && labels.length) {
    errors.push('source-year label requires a year-bearing record.source_published_at');
    return;
  }
  if (expectedYear != null && labels.length === 0) {
    errors.push(`SourceNote with year-bearing source_published_at must include source-year:${expectedYear}`);
    return;
  }
  if (expectedYear != null && labels[0] !== `source-year:${expectedYear}`) {
    errors.push(`source-year label must match record.source_published_at year (${expectedYear})`);
  }
}

function validateSourceNoteIssue({ body, labels = [], state = 'open' }) {
  const errors = [];
  const warnings = [];
  const parsed = parseSourceNoteIssue(body);
  if (parsed.markerMatches.length !== 1) errors.push(`expected exactly one source-note machine marker, found ${parsed.markerMatches.length}`);
  if (parsed.recordMatches.length !== 1) errors.push(`expected exactly one source-note-record block, found ${parsed.recordMatches.length}`);
  if (parsed.recordParseError) errors.push(`source-note-record JSON is invalid: ${parsed.recordParseError}`);
  for (const section of REQUIRED_SECTIONS) {
    if (!String(body || '').includes(section)) errors.push(`missing required section: ${section}`);
  }
  if (parsed.marker && !SUPPORTED_SCHEMAS.has(parsed.marker.schema_version)) {
    errors.push(`machine marker schema must be one of ${[...SUPPORTED_SCHEMAS].join(', ')}`);
  }
  validateRecord(parsed.record, parsed.marker, errors);

  const labelSet = new Set(labels);
  if (!labelSet.has('type:source-note')) errors.push('missing required label type:source-note');
  if (labelSet.has('type:interview-note')) errors.push('SourceNote must not also carry type:interview-note');

  const boundaryLabels = [...labelSet].filter((label) => label.startsWith('boundary:'));
  if (boundaryLabels.length !== 1) errors.push(`SourceNote must carry exactly one boundary:* label, found ${boundaryLabels.length}`);
  const expectedBoundary = parsed.record && parsed.record.boundary_review ? `boundary:${parsed.record.boundary_review.status}` : null;
  if (expectedBoundary && boundaryLabels.length === 1 && boundaryLabels[0] !== expectedBoundary) {
    errors.push(`boundary label must match record.boundary_review.status (${expectedBoundary})`);
  }
  if (expectedBoundary === 'boundary:pending' && !labelSet.has('task:boundary-review')) {
    errors.push('pending SourceNote requires task:boundary-review');
  }
  if (expectedBoundary !== 'boundary:pending' && labelSet.has('task:boundary-review')) {
    warnings.push('completed boundary review should normally remove task:boundary-review');
  }

  const forbiddenInterviewPrefixes = ['company:', 'role:', 'recruitment:', 'round:', 'interview-year:', 'result:', 'outcome:'];
  for (const prefix of forbiddenInterviewPrefixes) {
    const found = [...labelSet].filter((label) => label.startsWith(prefix));
    if (found.length) errors.push(`SourceNote must not carry InterviewNote-only labels: ${found.join(', ')}`);
  }
  validateSourceYearProjection(parsed.record, labelSet, errors);

  if (state === 'closed' && expectedBoundary === 'boundary:pending') {
    errors.push('pending SourceNote must not be closed');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    parsed: { marker: parsed.marker, record: parsed.record },
  };
}

module.exports = {
  SCHEMA,
  SCHEMA_V1,
  SCHEMA_V2,
  SUPPORTED_SCHEMAS,
  REQUIRED_SECTIONS,
  parseSourceNoteIssue,
  validateSourceNoteIssue,
  yearFromTimeFact,
};
