'use strict';

const MARKER_RE = /<!--\s*source-note:\s*id=([^\s]+)\s+schema=([^\s]+)\s*-->/g;
const RECORD_RE = /<!--\s*source-note-record\s*\n([\s\S]*?)\n-->/g;
const SCHEMA = 'source-note-issue.v1';
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

function validateRecord(record, marker, errors) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    errors.push('source-note-record must be one JSON object');
    return;
  }
  if (record.schema_version !== SCHEMA) errors.push(`record.schema_version must equal ${SCHEMA}`);
  if (typeof record.source_note_id !== 'string' || !/^xhs-note:.+/.test(record.source_note_id)) {
    errors.push('record.source_note_id must use xhs-note:<external-id>');
  }
  if (marker && marker.source_note_id !== record.source_note_id) {
    errors.push('machine marker id and record.source_note_id differ');
  }
  if (marker && marker.schema_version !== record.schema_version) {
    errors.push('machine marker schema and record.schema_version differ');
  }
  if (!record.source || typeof record.source !== 'object') {
    errors.push('record.source is required');
  } else {
    if (record.source.system !== 'xhs') errors.push('SourceNote v1 currently requires source.system=xhs');
    if (!record.source.external_id) errors.push('record.source.external_id is required');
    if (record.source.external_id && record.source_note_id !== `xhs-note:${record.source.external_id}`) {
      errors.push('source_note_id must equal xhs-note:<source.external_id>');
    }
  }
  if (!record.source_revision || typeof record.source_revision !== 'object') {
    errors.push('record.source_revision is required');
  } else {
    if (!record.source_revision.id) errors.push('record.source_revision.id is required');
    if (!record.source_revision.source_repository_ref) errors.push('record.source_revision.source_repository_ref is required');
  }

  validateTimeFact('source_published_at', record.source_published_at, errors);
  validateTimeFact('source_edited_at', record.source_edited_at, errors);

  if (!Array.isArray(record.artifacts)) {
    errors.push('record.artifacts must be an array');
  } else {
    record.artifacts.forEach((artifact, index) => {
      if (!artifact || typeof artifact !== 'object') {
        errors.push(`artifact[${index}] must be an object`);
        return;
      }
      if (!artifact.kind) errors.push(`artifact[${index}].kind is required`);
      if (!artifact.ref) errors.push(`artifact[${index}].ref is required`);
      if (!['raw_capture', 'source_projection'].includes(artifact.provenance)) {
        errors.push(`artifact[${index}].provenance must distinguish raw_capture/source_projection`);
      }
      if (artifact.git_blob_sha != null && !/^[0-9a-f]{40}$/.test(artifact.git_blob_sha)) {
        errors.push(`artifact[${index}].git_blob_sha must be a lowercase 40-char Git object id or null`);
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
    });
  }

  if (!Array.isArray(record.anomalies)) errors.push('record.anomalies must be an array');
  if (!Array.isArray(record.limitations)) errors.push('record.limitations must be an array');

  if (!record.boundary_review || typeof record.boundary_review !== 'object') {
    errors.push('record.boundary_review is required');
  } else {
    if (!BOUNDARY_VALUES.has(record.boundary_review.status)) {
      errors.push('boundary_review.status must be pending/not-interview/single-interview/multi-interview');
    }
    if (!Array.isArray(record.boundary_review.interview_note_ids)) {
      errors.push('boundary_review.interview_note_ids must be an array');
    }
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
  if (parsed.marker && parsed.marker.schema_version !== SCHEMA) errors.push(`machine marker schema must equal ${SCHEMA}`);
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

  const forbiddenLearningPrefixes = ['company:', 'role:', 'recruitment:', 'round:', 'source-year:', 'interview-year:', 'result:', 'outcome:'];
  for (const prefix of forbiddenLearningPrefixes) {
    const found = [...labelSet].filter((label) => label.startsWith(prefix));
    if (found.length) errors.push(`SourceNote must not carry InterviewNote learning labels: ${found.join(', ')}`);
  }

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
  REQUIRED_SECTIONS,
  parseSourceNoteIssue,
  validateSourceNoteIssue,
};
