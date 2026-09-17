'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadSourceSequenceManifests } = require('./source-sequence-manifest');

const SCHEMA_VERSION = 'source-question-set.v1';
const EXTRACTION_STATUSES = new Set(['extracted', 'ambiguous', 'withheld']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function computeSetDigest(record) {
  const payload = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (key === 'content_sha256' || key === '__file') continue;
    payload[key] = value;
  }
  return crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function validateSourceQuestionSet(record, manifestById) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, errors: ['record must be an object'], record: null };
  }
  if (record.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isNonEmptyString(record.set_id)) errors.push('set_id must be a non-empty string');
  if (!isNonEmptyString(record.interview_note_id)) errors.push('interview_note_id must be a non-empty string');
  if (!isNonEmptyString(record.source_revision_id)) errors.push('source_revision_id must be a non-empty string');
  if (!isNonEmptyString(record.source_manifest_id)) errors.push('source_manifest_id must be a non-empty string');
  if (!/^[0-9a-f]{64}$/.test(String(record.source_manifest_sha256 || ''))) {
    errors.push('source_manifest_sha256 must be a 64-char lowercase hex SHA-256');
  }
  if (!/^[0-9a-f]{64}$/.test(String(record.content_sha256 || ''))) {
    errors.push('content_sha256 must be a 64-char lowercase hex SHA-256');
  } else if (record.content_sha256 !== computeSetDigest(record)) {
    errors.push('content_sha256 mismatch');
  }
  if (!Array.isArray(record.questions) || record.questions.length === 0) {
    errors.push('questions must be a non-empty array');
  }

  const manifest = manifestById ? manifestById.get(record.source_manifest_id) : null;
  if (manifestById && !manifest) {
    errors.push(`source_manifest_id ${record.source_manifest_id} not found in manifest registry`);
  } else if (manifest) {
    if (manifest.content_sha256 !== record.source_manifest_sha256) {
      errors.push('source_manifest_sha256 does not match the referenced manifest digest');
    }
    if (manifest.interview_note_id !== record.interview_note_id) {
      errors.push('interview_note_id does not match the referenced manifest');
    }
    if (manifest.source_revision_id !== record.source_revision_id) {
      errors.push('source_revision_id does not match the referenced manifest');
    }
  }

  const seenIds = new Set();
  const seenPositions = new Set();
  for (const [index, q] of (record.questions || []).entries()) {
    const prefix = `questions[${index}]`;
    if (!q || typeof q !== 'object') { errors.push(`${prefix} must be an object`); continue; }
    if (!isNonEmptyString(q.source_question_id)) errors.push(`${prefix}.source_question_id must be a non-empty string`);
    else if (seenIds.has(q.source_question_id)) errors.push(`${prefix}.source_question_id must be unique within the set`);
    if (q.source_question_id) seenIds.add(q.source_question_id);
    if (!isNonEmptyString(q.source_unit_id)) errors.push(`${prefix}.source_unit_id must be a non-empty string`);
    if (!Number.isInteger(q.unit_position) || q.unit_position < 1) errors.push(`${prefix}.unit_position must be a positive integer`);
    else if (seenPositions.has(q.unit_position)) errors.push(`${prefix}.unit_position duplicates another question in the set`);
    if (Number.isInteger(q.unit_position)) seenPositions.add(q.unit_position);
    if (!isNonEmptyString(q.raw_text)) errors.push(`${prefix}.raw_text must be a non-empty string`);
    if (!EXTRACTION_STATUSES.has(q.extraction_status)) {
      errors.push(`${prefix}.extraction_status must be one of ${[...EXTRACTION_STATUSES].join('/')}`);
    }
    if (manifest) {
      const unit = (manifest.units || []).find((u) => u.source_unit_id === q.source_unit_id);
      if (!unit) {
        errors.push(`${prefix}.source_unit_id ${q.source_unit_id} not present in referenced manifest`);
      } else {
        if (unit.position !== q.unit_position) errors.push(`${prefix}.unit_position does not match unit position in manifest`);
        if (unit.source_unit_type !== 'question-like') errors.push(`${prefix} references a unit that is not question-like`);
        if (q.raw_text && unit.text_projection !== q.raw_text) {
          errors.push(`${prefix}.raw_text must equal the unit text_projection verbatim`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, record };
}

function loadSourceQuestionSets(directory = path.join(process.cwd(), 'data', 'source-questions'), manifestById) {
  const errors = [];
  const sets = [];
  const byId = new Map();
  const byQuestionId = new Map();
  if (!fs.existsSync(directory)) return { ok: true, errors, sets, byId, byQuestionId };
  for (const name of fs.readdirSync(directory).filter((e) => e.endsWith('.json')).sort()) {
    const filePath = path.join(directory, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      errors.push(`${name}: invalid JSON: ${error.message}`);
      continue;
    }
    const result = validateSourceQuestionSet(parsed, manifestById);
    errors.push(...result.errors.map((e) => `${name}: ${e}`));
    if (!result.ok) continue;
    if (byId.has(parsed.set_id)) { errors.push(`${name}: duplicate set_id ${parsed.set_id}`); continue; }
    for (const q of parsed.questions) {
      if (byQuestionId.has(q.source_question_id)) {
        errors.push(`${name}: source_question_id ${q.source_question_id} already claimed by another set`);
      }
      byQuestionId.set(q.source_question_id, { question: q, set: parsed });
    }
    parsed.__file = filePath;
    sets.push(parsed);
    byId.set(parsed.set_id, parsed);
  }
  return { ok: errors.length === 0, errors, sets, byId, byQuestionId };
}

module.exports = {
  SCHEMA_VERSION,
  validateSourceQuestionSet,
  loadSourceQuestionSets,
  loadSourceSequenceManifests,
  computeSetDigest,
};
