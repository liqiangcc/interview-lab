'use strict';

const { expectedInterviewNoteId, isChildInterviewNoteId } = require('./interview-note-identity');

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
const SINGLE_VALUE_LABEL_FAMILIES = ['company:', 'role:', 'recruitment:', 'round:', 'source-year:', 'interview-year:'];
const LEARNING_DISCOVERY_PREFIXES = ['company:', 'role:', 'recruitment:', 'round:', 'source-year:', 'interview-year:'];
const FORBIDDEN_DISCOVERY_PREFIXES = ['result:', 'outcome:'];
const FORBIDDEN_AMBIGUOUS_PREFIXES = ['year:'];
const DISCOURAGED_FACT_PREFIXES = ['note:', 'tech:', 'canonical:'];

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

function yearFromTimeFact(timeFact) {
  if (!timeFact || !['exact', 'month', 'year'].includes(timeFact.precision)) return null;
  if (typeof timeFact.value !== 'string') return null;
  const match = timeFact.value.match(/^(\d{4})/);
  return match ? match[1] : null;
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
  if (record.identity != null) {
    if (!record.identity || typeof record.identity !== 'object' || Array.isArray(record.identity)) {
      errors.push('record.identity must be an object when present');
    } else if (record.identity.kind !== 'source-note-event') {
      errors.push('record.identity.kind must be source-note-event when identity metadata is present');
    }
  }

  if (!record.source || typeof record.source !== 'object') {
    errors.push('record.source is required');
  } else {
    if (!record.source.system) errors.push('record.source.system is required');
    if (!record.source.external_id) errors.push('record.source.external_id is required');
    if (record.interview_note_id && record.source.system && record.source.external_id) {
      const expected = expectedInterviewNoteId(record);
      if (!expected) errors.push('source-note-event identity metadata is invalid');
      else if (record.interview_note_id !== expected) errors.push(`interview_note_id must equal the derived Source identity (${expected})`);
      if (record.identity && record.identity.kind === 'source-note-event' && !isChildInterviewNoteId(record.interview_note_id)) {
        errors.push('source-note-event InterviewNote id must use the child event identity format');
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

function validateLearningLabelFamilies(labelSet, errors, warnings) {
  for (const prefix of SINGLE_VALUE_LABEL_FAMILIES) {
    const found = [...labelSet].filter((label) => label.startsWith(prefix));
    if (found.length > 1) errors.push(`learning discovery label family ${prefix} must have at most one value: ${found.join(', ')}`);
  }

  for (const prefix of FORBIDDEN_DISCOVERY_PREFIXES) {
    const found = [...labelSet].filter((label) => label.startsWith(prefix));
    if (found.length) errors.push(`outcome label forbidden on learning discovery Issue to avoid spoilers: ${found.join(', ')}`);
  }

  for (const prefix of FORBIDDEN_AMBIGUOUS_PREFIXES) {
    const found = [...labelSet].filter((label) => label.startsWith(prefix));
    if (found.length) errors.push(`ambiguous label prefix forbidden; use source-year:/interview-year: instead: ${found.join(', ')}`);
  }

  const companyLabels = [...labelSet].filter((label) => label.startsWith('company:'));
  for (const label of companyLabels) {
    const value = label.slice('company:'.length);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) errors.push(`company label must use normalized machine id: ${label}`);
  }

  const allowedRole = new Set(['role:backend', 'role:frontend', 'role:client', 'role:algorithm', 'role:data', 'role:qa', 'role:product', 'role:other']);
  for (const label of [...labelSet].filter((value) => value.startsWith('role:'))) {
    if (!allowedRole.has(label)) errors.push(`unsupported coarse role learning label: ${label}`);
  }

  const allowedRecruitment = new Set(['recruitment:campus', 'recruitment:social', 'recruitment:internship']);
  for (const label of [...labelSet].filter((value) => value.startsWith('recruitment:'))) {
    if (!allowedRecruitment.has(label)) errors.push(`unsupported recruitment learning label: ${label}`);
  }

  for (const label of [...labelSet].filter((value) => value.startsWith('round:'))) {
    if (!/^round:(?:[1-9]|hr|final)$/.test(label)) errors.push(`unsupported round learning label: ${label}`);
  }

  for (const label of [...labelSet].filter((value) => value.startsWith('source-year:') || value.startsWith('interview-year:'))) {
    if (!/^(?:source-year|interview-year):\d{4}$/.test(label)) errors.push(`year learning label must use YYYY: ${label}`);
  }

  for (const prefix of DISCOURAGED_FACT_PREFIXES) {
    const found = [...labelSet].filter((label) => label.startsWith(prefix));
    if (found.length) warnings.push(`high-cardinality fact labels discouraged: ${found.join(', ')}`);
  }
}

function hasLearningDiscoveryLabels(labelSet) {
  return [...labelSet].some((label) => LEARNING_DISCOVERY_PREFIXES.some((prefix) => label.startsWith(prefix)));
}

function validateSourceYearProjection(record, labelSet, hasDiscovery, errors) {
  if (!record || record.schema_version !== 'interview-note-issue.v2') return;
  const expectedYear = yearFromTimeFact(record.source_published_at);
  const labels = [...labelSet].filter((label) => label.startsWith('source-year:'));

  if (labels.length === 1 && expectedYear == null) {
    errors.push('source-year label requires a year-bearing record.source_published_at');
    return;
  }
  if (labels.length === 1 && labels[0] !== `source-year:${expectedYear}`) {
    errors.push(`source-year label must match record.source_published_at year (${expectedYear})`);
  }
  if (hasDiscovery && expectedYear != null && labels.length === 0) {
    errors.push(`learning discovery projection must include source-year:${expectedYear} when source_published_at proves the year`);
  }
}

function validateInterviewYearProjection(record, labelSet, hasDiscovery, errors) {
  if (!record || record.schema_version !== 'interview-note-issue.v2') return;
  const expectedYear = yearFromTimeFact(record.interview_occurred_at);
  const labels = [...labelSet].filter((label) => label.startsWith('interview-year:'));

  if (labels.length === 1 && expectedYear != null && labels[0] !== `interview-year:${expectedYear}`) {
    errors.push(`interview-year label must match record.interview_occurred_at year (${expectedYear})`);
  }
  if (hasDiscovery && expectedYear != null && labels.length === 0) {
    errors.push(`learning discovery projection must include interview-year:${expectedYear} when interview_occurred_at proves the year`);
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

  validateLearningLabelFamilies(labelSet, errors, warnings);

  const hasDiscovery = hasLearningDiscoveryLabels(labelSet);
  if (hasDiscovery && !labelSet.has('status:source-ready')) {
    errors.push('Learning Discovery Labels require status:source-ready; source-review/blocked InterviewNotes must not enter the learning pool');
  }

  validateSourceYearProjection(parsed.record, labelSet, hasDiscovery, errors);
  validateInterviewYearProjection(parsed.record, labelSet, hasDiscovery, errors);

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
