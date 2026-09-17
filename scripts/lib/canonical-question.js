'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 'canonical-question-index.v1';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function computeIndexDigest(index) {
  const payload = {};
  for (const [key, value] of Object.entries(index || {})) {
    if (key === 'content_sha256' || key === '__file') continue;
    payload[key] = value;
  }
  return crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');
}

function validateCanonicalQuestionIndex(index, questionById) {
  const errors = [];
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    return { ok: false, errors: ['index must be an object'], index: null };
  }
  if (index.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isNonEmptyString(index.index_id)) errors.push('index_id must be a non-empty string');
  if (!/^[0-9a-f]{64}$/.test(String(index.content_sha256 || ''))) {
    errors.push('content_sha256 must be a 64-char lowercase hex SHA-256');
  } else if (index.content_sha256 !== computeIndexDigest(index)) {
    errors.push('content_sha256 mismatch');
  }
  if (!Array.isArray(index.entries)) { errors.push('entries must be an array'); return { ok: false, errors, index }; }

  const seenCq = new Set();
  const seenMember = new Map();
  for (const [i, e] of index.entries.entries()) {
    const prefix = `entries[${i}]`;
    if (!e || typeof e !== 'object') { errors.push(`${prefix} must be an object`); continue; }
    if (!isNonEmptyString(e.canonical_question_id)) errors.push(`${prefix}.canonical_question_id must be a non-empty string`);
    else if (seenCq.has(e.canonical_question_id)) errors.push(`${prefix}.canonical_question_id must be unique`);
    if (e.canonical_question_id) seenCq.add(e.canonical_question_id);
    if (!isNonEmptyString(e.canonical_text)) errors.push(`${prefix}.canonical_text must be a non-empty string`);
    if (!Number.isInteger(e.member_count) || e.member_count < 1) errors.push(`${prefix}.member_count must be a positive integer`);
    if (!Array.isArray(e.members) || e.members.length === 0) { errors.push(`${prefix}.members must be a non-empty array`); continue; }
    if (Number.isInteger(e.member_count) && e.member_count !== e.members.length) {
      errors.push(`${prefix}.member_count does not equal members.length`);
    }
    for (const [j, m] of e.members.entries()) {
      const mp = `${prefix}.members[${j}]`;
      if (!m || typeof m !== 'object') { errors.push(`${mp} must be an object`); continue; }
      if (!isNonEmptyString(m.source_question_id)) errors.push(`${mp}.source_question_id must be a non-empty string`);
      if (!isNonEmptyString(m.interview_note_id)) errors.push(`${mp}.interview_note_id must be a non-empty string`);
      if (!isNonEmptyString(m.raw_text)) errors.push(`${mp}.raw_text must be a non-empty string`);
      if (seenMember.has(m.source_question_id)) {
        errors.push(`${mp}.source_question_id already claimed by ${seenMember.get(m.source_question_id)}`);
      }
      seenMember.set(m.source_question_id, e.canonical_question_id);
      if (questionById) {
        const hit = questionById.get(m.source_question_id);
        if (!hit) {
          errors.push(`${mp}.source_question_id ${m.source_question_id} not found in source-question registry`);
        } else {
          if (hit.set.interview_note_id !== m.interview_note_id) {
            errors.push(`${mp}.interview_note_id does not match the source-question set`);
          }
          if (hit.question.raw_text !== m.raw_text) {
            errors.push(`${mp}.raw_text must equal the SourceQuestion raw_text verbatim`);
          }
        }
      }
    }
  }
  if (questionById) {
    for (const sqid of questionById.keys()) {
      if (!seenMember.has(sqid)) errors.push(`source_question ${sqid} is not covered by any canonical entry`);
    }
  }
  return { ok: errors.length === 0, errors, index };
}

function loadCanonicalQuestionIndex(filePath = path.join(process.cwd(), 'data', 'canonical-questions', 'canonical-index.v1.json'), questionById) {
  if (!fs.existsSync(filePath)) return { ok: true, errors: [], index: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`invalid JSON: ${error.message}`], index: null };
  }
  return validateCanonicalQuestionIndex(parsed, questionById);
}

module.exports = { SCHEMA_VERSION, validateCanonicalQuestionIndex, loadCanonicalQuestionIndex, computeIndexDigest };
