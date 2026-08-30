'use strict';

const MARKER_RE = /<!--\s*interview-note:\s*id=([^\s]+)\s+schema=([^\s]+)\s*-->/g;
const RECORD_RE = /<!--\s*interview-note-record\s*\n([\s\S]*?)\n-->/g;

const REQUIRED_SECTIONS = [
  '## 来源身份',
  '## 原始标题',
  '## 原始正文',
  '## 原始附件',
  '## 来源限制',
  '## 派生链接',
];

const LEGACY_SECTION_ALIASES = {
  '## 来源身份': ['## 来源身份', '## Source identity'],
  '## 原始标题': ['## 原始标题', '## Raw title'],
  '## 原始正文': ['## 原始正文', '## Raw content'],
  '## 原始附件': ['## 原始附件', '## Raw artifacts'],
  '## 来源限制': ['## 来源限制', '## Source limitations'],
  '## 派生链接': ['## 派生链接', '## Derived links'],
};

const SUPPORTED_SCHEMAS = new Set(['interview-note-issue.v1', 'interview-note-issue.v2']);

function allMatches(regex, text) {
  const copy = new RegExp(regex.source, regex.flags);
  return [...String(text || '').matchAll(copy)];
}

function hasSection(body, section) {
  return LEGACY_SECTION_ALIASES[section].some((alias) => String(body || '').includes(alias));
}

function parseInterviewNoteIssue(body) {
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
      interview_note_id: markerMatches[0][1],
      schema_version: markerMatches[0][2],
    } : null,
    record,
    recordParseError,
    sections: REQUIRED_SECTIONS.filter((section) => hasSection(body, section)),
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
    errors.push('interview-note-record must be one JSON object');
    return;
  }
  if (!SUPPORTED_SCHEMAS.has(record.schema_version)) {
    errors.push('record.schema_version must be a supported InterviewNote Issue schema');
  }
  if (typeof record.interview_note_id !== 'string' || !record.interview_note_id.includes(':')) {
    errors.push('record.interview_note_id must be a stable namespaced id');
  }
  if (marker && record.interview_note_id !== marker.interview_note_id) {
    errors.push('machine marker id and record.interview_note_id differ');
  }
  if (marker && record.schema_version !== marker.schema_version) {
    errors.push('machine marker schema and record.schema_version differ');
  }

  if (!record.source || typeof record.source !== 'object') {
    errors.push('record.source is required');
  } else {
    if (!record.source.system) errors.push('record.source.system is required');
    if (!record.source.external_id) errors.push('record.source.external_id is required');
    if (record.interview_note_id && record.source.system && record.source.external_id) {
      const expected = `${record.source.system}:${record.source.external_id}`;
      if (record.interview_note_id !== expected) {
        errors.push(`interview_note_id must equal source system + external id (${expected})`);
      }
    }
  }

  if (!record.source_revision || typeof record.source_revision !== 'object' || !record.source_revision.id) {
    errors.push('record.source_revision.id is required');
  }

  if (record.schema_version === 'interview-note-issue.v1') {
    validateTimeFact('source_time', record.source_time, errors);
  }
  if (record.schema_version === 'interview-note-issue.v2') {
    validateTimeFact('source_published_at', record.source_published_at, errors);
    validateTimeFact('source_edited_at', record.source_edited_at, errors);
    validateTimeFact('interview_occurred_at', record.interview_occurred_at, errors);
    if (Object.prototype.hasOwnProperty.call(record, 'source_time')) {
      errors.push('v2 record must not use ambiguous source_time');
    }
  }

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
      if (artifact.sha256 != null && !/^[0-9a-f]{64}$/.test(artifact.sha256)) {
        errors.push(`artifact[${index}].sha256 must be a lowercase 64-char hex digest or null`);
      }
    });
  }
}

function validateInterviewNoteIssue({ body, labels = [], state = 'open' }) {
  const errors = [];
  const warnings = [];
  const parsed = parseInterviewNoteIssue(body);

  if (parsed.markerMatches.length !== 1) {
    errors.push(`expected exactly one interview-note machine marker, found ${parsed.markerMatches.length}`);
  }
  if (parsed.recordMatches.length !== 1) {
    errors.push(`expected exactly one interview-note-record block, found ${parsed.recordMatches.length}`);
  }
  if (parsed.recordParseError) errors.push(`interview-note-record JSON is invalid: ${parsed.recordParseError}`);

  for (const section of REQUIRED_SECTIONS) {
    if (!hasSection(body, section)) errors.push(`missing required section: ${section}`);
  }

  if (parsed.marker && !SUPPORTED_SCHEMAS.has(parsed.marker.schema_version)) {
    errors.push('machine marker schema must be a supported InterviewNote Issue schema');
  }
  validateRecord(parsed.record, parsed.marker, errors);

  const labelSet = new Set(labels);
  if (!labelSet.has('type:interview-note')) errors.push('missing required label type:interview-note');

  const lifecycle = [...labelSet].filter((label) => label.startsWith('status:'));
  if (lifecycle.length > 1) errors.push(`contradictory lifecycle labels: ${lifecycle.join(', ')}`);
  if (state === 'closed' && !labelSet.has('status:source-ready')) {
    errors.push('closed InterviewNote must carry status:source-ready under the normal completion contract');
  }

  for (const prefix of ['company:', 'role:', 'year:', 'note:', 'tech:']) {
    const found = [...labelSet].filter((label) => label.startsWith(prefix));
    if (found.length) warnings.push(`high-cardinality fact labels discouraged: ${found.join(', ')}`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    parsed: {
      marker: parsed.marker,
      record: parsed.record,
      sections: parsed.sections,
    },
  };
}

module.exports = {
  REQUIRED_SECTIONS,
  SUPPORTED_SCHEMAS,
  parseInterviewNoteIssue,
  validateInterviewNoteIssue,
};
