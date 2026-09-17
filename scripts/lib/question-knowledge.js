'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ANALYSIS_SCHEMA = 'analysis.v1';
const ANSWER_SCHEMA = 'answer.v1';
const QUESTION_KINDS = new Set(['knowledge', 'process', 'coding', 'project', 'scenario', 'non-question']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function computeRecordDigest(record) {
  const payload = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (key === 'content_sha256' || key === '__file') continue;
    payload[key] = value;
  }
  return crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function validateShared(record, schema, idField, canonicalById) {
  const errors = [];
  if (record.schema_version !== schema) errors.push(`schema_version must be ${schema}`);
  if (!isNonEmptyString(record[idField])) errors.push(`${idField} must be a non-empty string`);
  if (!isNonEmptyString(record.canonical_question_id)) errors.push('canonical_question_id must be a non-empty string');
  if (!isNonEmptyString(record.canonical_index_sha256) || !/^[0-9a-f]{64}$/.test(record.canonical_index_sha256 || '')) {
    errors.push('canonical_index_sha256 must be a 64-char lowercase hex SHA-256');
  }
  if (!isNonEmptyString(record.question_text)) errors.push('question_text must be a non-empty string');
  if (!/^[0-9a-f]{64}$/.test(String(record.content_sha256 || ''))) {
    errors.push('content_sha256 must be a 64-char lowercase hex SHA-256');
  } else if (record.content_sha256 !== computeRecordDigest(record)) {
    errors.push('content_sha256 mismatch');
  }
  if (canonicalById) {
    const entry = canonicalById.get(record.canonical_question_id);
    if (!entry) {
      errors.push(`canonical_question_id ${record.canonical_question_id} not found in canonical index`);
    } else if (record.question_text && entry.canonical_text !== record.question_text) {
      errors.push('question_text must equal canonical_text verbatim');
    }
  }
  return errors;
}

function validateAnalysis(record, canonicalById, indexSha) {
  const errors = validateShared(record || {}, ANALYSIS_SCHEMA, 'analysis_id', canonicalById);
  if (indexSha && record.canonical_index_sha256 !== indexSha) {
    errors.push('canonical_index_sha256 does not match the current canonical index digest');
  }
  if (!QUESTION_KINDS.has(record.question_kind)) {
    errors.push(`question_kind must be one of ${[...QUESTION_KINDS].join('/')}`);
  }
  for (const f of ['interviewer_intent', 'expected_depth', 'mechanism', 'boundaries']) {
    if (!isNonEmptyString(record[f])) errors.push(`${f} must be a non-empty string`);
  }
  for (const f of ['common_mistakes', 'follow_ups']) {
    if (!Array.isArray(record[f])) errors.push(`${f} must be an array`);
  }
  return { ok: errors.length === 0, errors, record };
}

function validateAnswer(record, canonicalById, indexSha) {
  const errors = validateShared(record || {}, ANSWER_SCHEMA, 'answer_id', canonicalById);
  if (indexSha && record.canonical_index_sha256 !== indexSha) {
    errors.push('canonical_index_sha256 does not match the current canonical index digest');
  }
  for (const f of ['short_answer', 'explanation']) {
    if (!isNonEmptyString(record[f])) errors.push(`${f} must be a non-empty string`);
  }
  if (!Array.isArray(record.skeleton) || record.skeleton.length === 0) {
    errors.push('skeleton must be a non-empty array');
  }
  return { ok: errors.length === 0, errors, record };
}

function loadKnowledgeRecords(directory, schemaValidator, idField, canonicalById, indexSha) {
  const errors = [];
  const records = [];
  const byId = new Map();
  const byCq = new Map();
  if (!fs.existsSync(directory)) return { ok: true, errors, records, byId, byCq };
  for (const name of fs.readdirSync(directory).filter((e) => e.endsWith('.json')).sort()) {
    const filePath = path.join(directory, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      errors.push(`${name}: invalid JSON: ${error.message}`);
      continue;
    }
    const result = schemaValidator(parsed, canonicalById, indexSha);
    errors.push(...result.errors.map((e) => `${name}: ${e}`));
    if (!result.ok) continue;
    if (byId.has(parsed[idField])) { errors.push(`${name}: duplicate ${idField}`); continue; }
    if (byCq.has(parsed.canonical_question_id)) {
      errors.push(`${name}: canonical_question_id ${parsed.canonical_question_id} already has a record`);
      continue;
    }
    records.push(parsed);
    byId.set(parsed[idField], parsed);
    byCq.set(parsed.canonical_question_id, parsed);
  }
  return { ok: errors.length === 0, errors, records, byId, byCq };
}

function loadCanonicalById(index) {
  const map = new Map();
  for (const e of (index && index.entries) || []) map.set(e.canonical_question_id, e);
  return map;
}

module.exports = {
  ANALYSIS_SCHEMA,
  ANSWER_SCHEMA,
  QUESTION_KINDS,
  validateAnalysis,
  validateAnswer,
  loadKnowledgeRecords,
  loadCanonicalById,
  computeRecordDigest,
};
