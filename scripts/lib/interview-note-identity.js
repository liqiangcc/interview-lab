'use strict';

const crypto = require('crypto');

const CHILD_CASE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/;

function canonicalIdentityInput(sourceNoteId, caseKey) {
  return `${sourceNoteId}\n${caseKey}`;
}

function childInterviewNoteId(source, caseKey) {
  if (!source || typeof source !== 'object' || !source.system || !source.external_id) {
    throw new Error('source.system and source.external_id are required to derive InterviewNote identity');
  }
  if (typeof caseKey !== 'string' || !CHILD_CASE_KEY_RE.test(caseKey)) {
    throw new Error('case_key must use lowercase stable identity syntax');
  }
  const sourceNoteId = `xhs-note:${source.external_id}`;
  const digest = crypto.createHash('sha256')
    .update(canonicalIdentityInput(sourceNoteId, caseKey), 'utf8')
    .digest('hex');
  return `${source.system}:${source.external_id}:event:${digest}`;
}

function isChildInterviewNoteId(value) {
  return typeof value === 'string' && /^[^:]+:[^:]+:event:[0-9a-f]{64}$/.test(value);
}

function expectedInterviewNoteId(record) {
  if (!record || !record.source) return null;
  if (record.identity && record.identity.kind === 'source-note-event') {
    if (record.identity.source_note_id !== `xhs-note:${record.source.external_id}`) return null;
    try {
      return childInterviewNoteId(record.source, record.identity.case_key);
    } catch {
      return null;
    }
  }
  return `${record.source.system}:${record.source.external_id}`;
}

module.exports = {
  CHILD_CASE_KEY_RE,
  canonicalIdentityInput,
  childInterviewNoteId,
  expectedInterviewNoteId,
  isChildInterviewNoteId,
};
