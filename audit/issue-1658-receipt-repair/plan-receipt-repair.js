#!/usr/bin/env node
'use strict';

// Proposal-only, GET-only dry-run for the historical #1658 applied-receipt
// mismatch. This file intentionally has no POST/PATCH/create/apply path.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  issueSourceRecord,
} = require('../../scripts/lib/interview-note-materialization-batch');
const { buildInterviewProjection } = require('../../scripts/lib/source-note-interview-materialization');
const {
  validateInterviewNoteIssue,
  parseInterviewNoteIssue,
} = require('../../scripts/lib/interview-note-issue');
const {
  validateIssue1608BoundaryEvidenceValue,
  SOURCE_REF,
} = require('../../scripts/lib/issue-1605-materialization-plan');

const SCHEMA_VERSION = 'issue-1658-boundary-receipt-repair-proposal.v1';
const CORRECTION_SCHEMA_VERSION = 'source-note-boundary-review-applied-correction.v1';
const AUTHORIZATION_SCHEMA_VERSION = 'issue-1658-boundary-receipt-repair-authorization.v1';
const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF_PIN = SOURCE_REF;
const MAIN_SHA = 'f01716f6b531e7338ca4c59bdb4e0229df2b3375';
const PARENT_ISSUE = 1611;
const SCOPE = Object.freeze([1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458]);
const DEFAULT_AUDIT = path.join(__dirname, '..', 'issue-1658', '13-reconcile.json');
const DEFAULT_OWNERS = path.join(__dirname, '..', 'issue-1658', 'owner-inventory.json');
const DEFAULT_OUTPUT = path.join(__dirname, 'repair-plan.json');
const DEFAULT_SNAPSHOT = path.join(__dirname, 'current-live-snapshot.json');
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function sha256Text(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digest(value) { return sha256Text(canonical(value)); }
function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function labelsOf(issue) { return [...new Set((issue?.labels || []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean))].sort(); }
function markerMatches(body, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<!--\\s*${escaped}\\s*\\n([\\s\\S]*?)\\n-->`, 'g');
  return [...String(body || '').matchAll(re)].map((match) => {
    let value = null;
    let error = null;
    try { value = JSON.parse(match[1].trim()); } catch (caught) { error = caught.message; }
    return { value, error, raw: match[0] };
  });
}
function compactIssue(issue) {
  return {
    number: Number(issue.number), state: issue.state, title: issue.title, body: issue.body || '',
    labels: labelsOf(issue), url: issue.url || null, html_url: issue.html_url || null,
  };
}
function compactComment(comment) {
  return {
    id: Number(comment.id), body: comment.body || '', created_at: comment.created_at || null,
    updated_at: comment.updated_at || null, issue_url: comment.issue_url || null,
    url: comment.url || null, html_url: comment.html_url || null,
  };
}
function ghGet(endpoint) {
  // The only permitted GitHub operation in this script is `gh api <GET path>`.
  return JSON.parse(execFileSync('gh', ['api', endpoint], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000,
  }));
}
function pagedComments(issueNumber) {
  const comments = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = ghGet(`repos/${REPOSITORY}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`comments page ${page} for #${issueNumber} was not an array`);
    comments.push(...batch.map(compactComment));
    if (batch.length < 100) return { comments, pages: page, terminal_page_short: true };
  }
  throw new Error(`comments pagination for #${issueNumber} exceeded 20 pages without a short terminal page`);
}
function one(values, label, errors) {
  if (values.length !== 1) errors.push(`${label} count=${values.length}`);
  return values.length === 1 ? values[0] : null;
}
function sameJson(left, right) { return canonical(left) === canonical(right); }

function expectedRows(audit) {
  if (!audit || !Array.isArray(audit.targets)) throw new Error('merged audit 13-reconcile.json targets are required');
  if (JSON.stringify(audit.scope) !== JSON.stringify(SCOPE)) throw new Error('merged audit scope differs from fixed 13-row scope');
  return new Map(audit.targets.map((target) => [Number(target.source_issue), {
    source_issue: Number(target.source_issue),
    owner_issue: Number(target.owner_issue),
    identity: target.identity,
    evidence_comment_id: null,
    applied_comment_id: Number(target.boundary_applied_receipt?.comment_id),
    materialization_comment_id: Number(target.materialization_receipt?.comment_id),
    applied_transition_id: target.boundary_applied_receipt?.transition_id || null,
    materialization_id: target.materialization_receipt?.materialization_id || null,
  }]));
}

function validateCorrectionMarker(value, row) {
  const errors = [];
  const object = (field, candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) errors.push(`${field} must be an object`);
    return Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate));
  };
  const requiredString = (field, actual, expected = null) => {
    if (typeof actual !== 'string' || !actual.trim()) errors.push(`${field} must be a non-empty string`);
    if (expected !== null && actual !== expected) errors.push(`${field} binding mismatch`);
  };
  const requiredInt = (field, actual, expected = null) => {
    if (!Number.isSafeInteger(actual) || actual < 1) errors.push(`${field} must be a positive integer`);
    if (expected !== null && actual !== expected) errors.push(`${field} binding mismatch`);
  };
  const exactKeys = (field, candidate, allowed) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    for (const key of Object.keys(candidate)) if (!allowed.has(key)) errors.push(`${field} has unsupported field: ${key}`);
  };
  object('correction', value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors };
  exactKeys('correction', value, new Set(['schema_version', 'correction_id', 'reason', 'repository', 'source_note_issue_number', 'source_note_id', 'source_note_body_sha256', 'source_revision_id', 'source_repository_ref', 'transition_id', 'original_receipt', 'corrected_receipt', 'owner_binding', 'materialization_binding', 'evidence_binding']));
  requiredString('schema_version', value.schema_version, CORRECTION_SCHEMA_VERSION);
  requiredString('correction_id', value.correction_id, `issue-1658-receipt-repair-${row.source_issue}-v1`);
  requiredString('reason', value.reason, 'historical-empty-interview-note-ids-reconciled');
  requiredString('repository', value.repository, REPOSITORY);
  requiredInt('source_note_issue_number', value.source_note_issue_number, row.source_issue);
  requiredString('source_note_id', value.source_note_id, row.source_note_id);
  requiredString('source_note_body_sha256', value.source_note_body_sha256, row.source_body_sha256);
  requiredString('source_revision_id', value.source_revision_id, row.source_revision_id);
  requiredString('source_repository_ref', value.source_repository_ref, SOURCE_REF_PIN);
  requiredString('transition_id', value.transition_id, row.transition_id);
  const issueApiUrl = `https://api.github.com/repos/${REPOSITORY}/issues/${row.source_issue}`;
  if (!HEX64.test(String(value.source_note_body_sha256 || ''))) errors.push('source_note_body_sha256 must be a lowercase SHA-256');
  const original = value.original_receipt;
  if (object('original_receipt', original)) {
    exactKeys('original_receipt', original, new Set(['comment_id', 'issue_url', 'schema_version', 'body_sha256', 'marker_sha256', 'interview_note_ids']));
    requiredInt('original_receipt.comment_id', original.comment_id, row.applied_comment_id);
    requiredString('original_receipt.issue_url', original.issue_url, issueApiUrl);
    requiredString('original_receipt.schema_version', original.schema_version, 'source-note-boundary-review-applied.v1');
    requiredString('original_receipt.body_sha256', original.body_sha256);
    requiredString('original_receipt.marker_sha256', original.marker_sha256);
    if (original.body_sha256 !== row.applied_receipt_body_sha256 || original.marker_sha256 !== row.applied_receipt_marker_sha256) errors.push('original_receipt digest binding mismatch');
    if (!HEX64.test(String(original.body_sha256 || '')) || !HEX64.test(String(original.marker_sha256 || ''))) errors.push('original receipt digests must be lowercase SHA-256');
    if (!Array.isArray(original.interview_note_ids) || original.interview_note_ids.length !== 0) errors.push('original_receipt.interview_note_ids must remain exactly []');
  }
  const corrected = value.corrected_receipt;
  if (object('corrected_receipt', corrected)) {
    exactKeys('corrected_receipt', corrected, new Set(['interview_note_ids', 'interview_note_cases']));
    if (!Array.isArray(corrected.interview_note_ids) || corrected.interview_note_ids.length !== 1 || corrected.interview_note_ids[0] !== row.identity) errors.push('corrected_receipt.interview_note_ids must contain exactly the bound identity');
    if (corrected.interview_note_cases !== null) errors.push('corrected_receipt.interview_note_cases must be null for this single-interview scope');
  }
  const owner = value.owner_binding;
  if (object('owner_binding', owner)) {
    exactKeys('owner_binding', owner, new Set(['issue_number', 'interview_note_id', 'body_sha256', 'labels']));
    requiredInt('owner_binding.issue_number', owner.issue_number, row.owner_issue);
    requiredString('owner_binding.interview_note_id', owner.interview_note_id, row.identity);
    requiredString('owner_binding.body_sha256', owner.body_sha256);
    if (!HEX64.test(String(owner.body_sha256 || ''))) errors.push('owner_binding.body_sha256 must be lowercase SHA-256');
    if (!Array.isArray(owner.labels) || owner.labels.length === 0 || owner.labels.some((label) => typeof label !== 'string')) errors.push('owner_binding.labels must be a non-empty string array');
    if (owner.body_sha256 !== row.owner_body_sha256 || !sameJson(owner.labels || [], row.owner_labels || [])) errors.push('owner_binding live owner fact mismatch');
  }
  const materialization = value.materialization_binding;
  if (object('materialization_binding', materialization)) {
    exactKeys('materialization_binding', materialization, new Set(['comment_id', 'issue_url', 'body_sha256', 'marker_sha256', 'source_note_id', 'source_note_body_sha256', 'source_revision_id', 'source_repository_ref', 'interview_note_id', 'interview_issue_number', 'interview_issue_body_sha256']));
    requiredInt('materialization_binding.comment_id', materialization.comment_id, row.materialization_comment_id);
    requiredString('materialization_binding.issue_url', materialization.issue_url, issueApiUrl);
    requiredString('materialization_binding.body_sha256', materialization.body_sha256);
    requiredString('materialization_binding.marker_sha256', materialization.marker_sha256);
    requiredString('materialization_binding.source_note_id', materialization.source_note_id, row.source_note_id);
    requiredString('materialization_binding.source_note_body_sha256', materialization.source_note_body_sha256, value.source_note_body_sha256);
    requiredString('materialization_binding.source_revision_id', materialization.source_revision_id, row.source_revision_id);
    requiredString('materialization_binding.source_repository_ref', materialization.source_repository_ref, SOURCE_REF_PIN);
    requiredString('materialization_binding.interview_note_id', materialization.interview_note_id, row.identity);
    requiredInt('materialization_binding.interview_issue_number', materialization.interview_issue_number, row.owner_issue);
    requiredString('materialization_binding.interview_issue_body_sha256', materialization.interview_issue_body_sha256);
    for (const field of ['body_sha256', 'marker_sha256', 'source_note_body_sha256', 'interview_issue_body_sha256']) if (!HEX64.test(String(materialization[field] || ''))) errors.push(`materialization_binding.${field} must be lowercase SHA-256`);
    if (materialization.body_sha256 !== row.materialization_receipt_body_sha256 || materialization.marker_sha256 !== row.materialization_receipt_marker_sha256 || materialization.interview_issue_body_sha256 !== row.owner_body_sha256) errors.push('materialization_binding live receipt/owner fact mismatch');
  }
  const evidence = value.evidence_binding;
  if (object('evidence_binding', evidence)) {
    exactKeys('evidence_binding', evidence, new Set(['comment_id', 'issue_url', 'body_sha256', 'marker_sha256', 'schema_version', 'transition_id']));
    requiredInt('evidence_binding.comment_id', evidence.comment_id, row.evidence_comment_id);
    requiredString('evidence_binding.issue_url', evidence.issue_url, issueApiUrl);
    requiredString('evidence_binding.body_sha256', evidence.body_sha256);
    requiredString('evidence_binding.marker_sha256', evidence.marker_sha256);
    requiredString('evidence_binding.schema_version', evidence.schema_version, 'issue-1608-boundary-evidence.v1');
    requiredString('evidence_binding.transition_id', evidence.transition_id, row.transition_id);
    if (!HEX64.test(String(evidence.body_sha256 || '')) || !HEX64.test(String(evidence.marker_sha256 || ''))) errors.push('evidence binding digests must be lowercase SHA-256');
    if (evidence.body_sha256 !== row.evidence_body_sha256 || evidence.marker_sha256 !== row.evidence_marker_sha256) errors.push('evidence_binding live comment fact mismatch');
  }
  return { ok: errors.length === 0, errors, value };
}

function buildCorrectionTemplate(row) {
  return {
    schema_version: CORRECTION_SCHEMA_VERSION,
    correction_id: `issue-1658-receipt-repair-${row.source_issue}-v1`,
    reason: 'historical-empty-interview-note-ids-reconciled',
    repository: REPOSITORY,
    source_note_issue_number: row.source_issue,
    source_note_id: row.source_note_id,
    source_note_body_sha256: row.source_body_sha256,
    source_revision_id: row.source_revision_id,
    source_repository_ref: SOURCE_REF_PIN,
    transition_id: row.transition_id,
    original_receipt: {
      comment_id: row.applied_comment_id,
      issue_url: row.applied_comment_issue_url,
      schema_version: 'source-note-boundary-review-applied.v1',
      body_sha256: row.applied_receipt_body_sha256,
      marker_sha256: row.applied_receipt_marker_sha256,
      interview_note_ids: [],
    },
    corrected_receipt: { interview_note_ids: [row.identity], interview_note_cases: null },
    owner_binding: { issue_number: row.owner_issue, interview_note_id: row.identity, body_sha256: row.owner_body_sha256, labels: row.owner_labels },
    materialization_binding: {
      comment_id: row.materialization_comment_id, body_sha256: row.materialization_receipt_body_sha256,
      issue_url: row.materialization_comment_issue_url,
      marker_sha256: row.materialization_receipt_marker_sha256, source_note_id: row.source_note_id,
      source_note_body_sha256: row.source_body_sha256, source_revision_id: row.source_revision_id,
      source_repository_ref: SOURCE_REF_PIN, interview_note_id: row.identity,
      interview_issue_number: row.owner_issue, interview_issue_body_sha256: row.owner_body_sha256,
    },
    evidence_binding: {
      comment_id: row.evidence_comment_id, body_sha256: row.evidence_body_sha256,
      issue_url: row.evidence_comment_issue_url,
      marker_sha256: row.evidence_marker_sha256, schema_version: 'issue-1608-boundary-evidence.v1',
      transition_id: row.transition_id,
    },
  };
}

function buildRow(expected, source, owner, comments, pagination, ownerInventory = null) {
  const errors = [];
  const sourceResult = issueSourceRecord(source);
  const parsed = sourceResult.parsed;
  if (!sourceResult.validation.ok || !parsed) errors.push(...(sourceResult.validation.errors || ['SourceNote validation failed']));
  if (Number(source.number) !== expected.source_issue) errors.push('SourceNote issue number drift');
  if (parsed?.source_revision?.source_repository_ref !== SOURCE_REF_PIN) errors.push('SourceRevision source ref drift');
  const sourceBodySha = sha256Text(source.body || '');
  const identity = parsed?.boundary_review?.interview_note_ids?.length === 1 ? parsed.boundary_review.interview_note_ids[0] : null;
  if (identity !== expected.identity) errors.push('SourceNote boundary identity drift');
  let projection = null;
  try { if (sourceResult.validation.ok && parsed) projection = buildInterviewProjection(source, sourceResult.validation); } catch (error) { errors.push(`projection failed: ${error.message}`); }
  const ownerParsed = parseInterviewNoteIssue(owner.body || '');
  const ownerValidation = validateInterviewNoteIssue({ body: owner.body, labels: labelsOf(owner), state: owner.state });
  const ownerBodySha = sha256Text(owner.body || '');
  if (Number(owner.number) !== expected.owner_issue) errors.push('owner Issue number drift');
  if (ownerParsed.marker?.interview_note_id !== expected.identity) errors.push('owner identity drift');
  if (!ownerValidation.ok) errors.push(...ownerValidation.errors.map((error) => `owner: ${error}`));
  if (!projection || owner.title !== projection.title || ownerBodySha !== sha256Text(projection.body) || !sameJson(labelsOf(owner), [...projection.labels].sort())) errors.push('owner projection/body/title/labels binding mismatch');
  if (ownerInventory) {
    const candidates = (ownerInventory.entries || []).filter((entry) => entry.interview_note_id === expected.identity);
    if (candidates.length !== 1) errors.push(`owner inventory identity candidate count=${candidates.length}`);
    if (candidates.length === 1 && (Number(candidates[0].issue_number) !== expected.owner_issue || candidates[0].body_sha256 !== ownerBodySha || !sameJson(candidates[0].labels || [], labelsOf(owner)))) errors.push('saved owner inventory binding mismatch');
  }

  const appliedMatches = comments.flatMap((comment) => markerMatches(comment.body, 'source-note-boundary-review-applied').map((match) => ({ comment, match }))).filter(({ match }) => match.value?.issue_number === expected.source_issue);
  const applied = one(appliedMatches, `#${expected.source_issue} applied receipt`, errors);
  const appliedValue = applied?.match.value;
  const expectedIssueApiUrl = `https://api.github.com/repos/${REPOSITORY}/issues/${expected.source_issue}`;
  if (applied && applied.comment.issue_url !== expectedIssueApiUrl) errors.push('applied receipt comment issue_url binding drift');
  if (applied && Number(applied.comment.id) !== expected.applied_comment_id) errors.push('applied receipt comment ID drift');
  if (appliedValue?.schema_version !== 'source-note-boundary-review-applied.v1') errors.push('applied receipt schema drift');
  if (appliedValue?.source_note_id !== parsed?.source_note_id || appliedValue?.transition_id !== expected.applied_transition_id) errors.push('applied receipt source/transition binding drift');
  if (!sameJson(appliedValue?.interview_note_ids, [])) errors.push('historical applied receipt is not the expected empty-id mismatch');
  if (appliedValue?.new_body_sha256 !== sourceBodySha) errors.push('applied receipt new_body_sha256 does not bind current SourceNote body');

  const evidenceMatches = comments.flatMap((comment) => markerMatches(comment.body, 'issue-1608-boundary-evidence.v1').map((match) => ({ comment, match }))).filter(({ match }) => match.value?.transition_request?.transition_id === appliedValue?.transition_id && match.value?.issue_number === expected.source_issue);
  const evidence = one(evidenceMatches, `#${expected.source_issue} issue-1608 evidence`, errors);
  const evidenceValue = evidence?.match.value;
  if (evidence && evidence.comment.issue_url !== expectedIssueApiUrl) errors.push('evidence comment issue_url binding drift');
  const evidenceValidation = evidenceValue && parsed && appliedValue ? validateIssue1608BoundaryEvidenceValue(evidenceValue, {
    source_note_issue_number: expected.source_issue, source_note_id: parsed.source_note_id,
    source_revision_id: parsed.source_revision.id, evidence_body_sha256: appliedValue.previous_body_sha256,
    source_note_body_sha256: appliedValue.previous_body_sha256, live_source_note_body_sha256: sourceBodySha,
    decision: parsed.boundary_review.status, transition_id: appliedValue.transition_id,
  }, source) : { ok: false, errors: ['issue-1608 evidence validation was not runnable'] };
  if (!evidenceValidation.ok) errors.push(...evidenceValidation.errors);

  const materializationMatches = comments.flatMap((comment) => markerMatches(comment.body, 'source-note-interview-materialized').map((match) => ({ comment, match }))).filter(({ match }) => match.value?.source_note_issue_number === expected.source_issue);
  const materialization = one(materializationMatches, `#${expected.source_issue} materialization receipt`, errors);
  const materializationValue = materialization?.match.value;
  if (materialization && materialization.comment.issue_url !== expectedIssueApiUrl) errors.push('materialization receipt comment issue_url binding drift');
  if (materialization && Number(materialization.comment.id) !== expected.materialization_comment_id) errors.push('materialization receipt comment ID drift');
  if (materializationValue && !['source-note-interview-materialized.v1', 'source-note-interview-materialized.v2'].includes(materializationValue.schema_version)) errors.push('materialization receipt schema drift');
  if (materializationValue && (!HEX64.test(String(materializationValue.request_sha256 || '')) || typeof materializationValue.materialization_id !== 'string' || !materializationValue.materialization_id.trim())) errors.push('materialization receipt id/digest shape invalid');
  if (materializationValue?.repository !== REPOSITORY || Number(materializationValue?.source_note_issue_number) !== expected.source_issue) errors.push('materialization receipt repository/source issue binding drift');
  if (materializationValue?.source_note_id !== parsed?.source_note_id || materializationValue?.source_note_body_sha256 !== sourceBodySha || materializationValue?.source_revision_id !== parsed?.source_revision?.id || materializationValue?.source_repository_ref !== SOURCE_REF_PIN) errors.push('materialization source binding drift');
  if (materializationValue?.interview_note_id !== expected.identity || Number(materializationValue?.interview_issue_number) !== expected.owner_issue || materializationValue?.interview_issue_body_sha256 !== ownerBodySha) errors.push('materialization owner binding drift');

  const correctionMatches = comments.flatMap((comment) => markerMatches(comment.body, CORRECTION_SCHEMA_VERSION).map((match) => ({ comment, match })));
  if (correctionMatches.length !== 0) errors.push(`correction marker already exists (${correctionMatches.length})`);
  const row = {
    source_issue: expected.source_issue, source_url: source.html_url || null,
    owner_issue: expected.owner_issue, owner_url: owner.html_url || null,
    source_note_id: parsed?.source_note_id || expected.identity,
    identity: expected.identity, source_body_sha256: sourceBodySha,
    source_revision_id: parsed?.source_revision?.id || null, source_repository_ref: parsed?.source_revision?.source_repository_ref || null,
    owner_body_sha256: ownerBodySha, owner_labels: labelsOf(owner),
    owner_uniqueness: ownerInventory ? { scope: 'saved merged 65-owner inventory', candidate_count: (ownerInventory.entries || []).filter((entry) => entry.interview_note_id === expected.identity).length, current_fetch: false } : { scope: 'known owner Issue only', candidate_count: 1, current_fetch: true },
    evidence_comment_id: evidence ? Number(evidence.comment.id) : null,
    evidence_comment_issue_url: evidence?.comment.issue_url || null,
    evidence_body_sha256: evidence ? sha256Text(evidence.comment.body) : null,
    evidence_marker_sha256: evidence ? sha256Text(evidence.match.raw) : null,
    applied_comment_id: applied ? Number(applied.comment.id) : null,
    applied_comment_issue_url: applied?.comment.issue_url || null,
    applied_receipt_body_sha256: applied ? sha256Text(applied.comment.body) : null,
    applied_receipt_marker_sha256: applied ? sha256Text(applied.match.raw) : null,
    applied_transition_id: appliedValue?.transition_id || null,
    applied_interview_note_ids: appliedValue?.interview_note_ids ?? null,
    materialization_comment_id: materialization ? Number(materialization.comment.id) : null,
    materialization_comment_issue_url: materialization?.comment.issue_url || null,
    materialization_receipt_body_sha256: materialization ? sha256Text(materialization.comment.body) : null,
    materialization_receipt_marker_sha256: materialization ? sha256Text(materialization.match.raw) : null,
    materialization_id: materializationValue?.materialization_id || null,
    result: errors.length === 0 ? 'REPAIR_ELIGIBLE' : 'BLOCKED',
    errors,
    comments_pagination: pagination,
  };
  row.transition_id = row.applied_transition_id;
  row.correction_template = errors.length === 0 ? buildCorrectionTemplate(row) : null;
  return row;
}

function buildProposal({ audit, rows, pagination }) {
  const immutableRows = rows.map((row) => ({
    source_issue: row.source_issue, owner_issue: row.owner_issue, source_note_id: row.source_note_id,
    identity: row.identity, source_body_sha256: row.source_body_sha256, source_revision_id: row.source_revision_id,
    owner_body_sha256: row.owner_body_sha256, owner_labels: row.owner_labels,
    source_repository_ref: row.source_repository_ref, evidence_comment_id: row.evidence_comment_id,
    evidence_comment_issue_url: row.evidence_comment_issue_url, evidence_body_sha256: row.evidence_body_sha256, evidence_marker_sha256: row.evidence_marker_sha256,
    applied_comment_id: row.applied_comment_id, applied_comment_issue_url: row.applied_comment_issue_url, applied_receipt_body_sha256: row.applied_receipt_body_sha256,
    applied_receipt_marker_sha256: row.applied_receipt_marker_sha256, applied_transition_id: row.applied_transition_id,
    applied_interview_note_ids: row.applied_interview_note_ids, materialization_comment_id: row.materialization_comment_id, materialization_comment_issue_url: row.materialization_comment_issue_url,
    materialization_receipt_body_sha256: row.materialization_receipt_body_sha256,
    materialization_receipt_marker_sha256: row.materialization_receipt_marker_sha256,
    materialization_id: row.materialization_id, result: row.result,
  }));
  const digestInput = {
    schema_version: SCHEMA_VERSION, source_tree_sha: MAIN_SHA, repository: REPOSITORY,
    source_repository: SOURCE_REPOSITORY, source_ref: SOURCE_REF_PIN, scope: SCOPE,
    rows: immutableRows,
  };
  const planDigest = digest(digestInput);
  const scopeDigest = digest(SCOPE);
  const sourceBindingsDigest = digest(immutableRows.map((row) => ({ source_issue: row.source_issue, source_note_id: row.source_note_id, source_body_sha256: row.source_body_sha256, source_revision_id: row.source_revision_id, source_repository_ref: row.source_repository_ref })));
  const ownerBindingsDigest = digest(immutableRows.map((row) => ({ source_issue: row.source_issue, owner_issue: row.owner_issue, identity: row.identity, owner_body_sha256: row.owner_body_sha256, owner_labels: row.owner_labels })));
  const receiptBindingsDigest = digest(immutableRows.map((row) => ({ source_issue: row.source_issue, evidence_comment_id: row.evidence_comment_id, evidence_comment_issue_url: row.evidence_comment_issue_url, evidence_body_sha256: row.evidence_body_sha256, evidence_marker_sha256: row.evidence_marker_sha256, applied_comment_id: row.applied_comment_id, applied_comment_issue_url: row.applied_comment_issue_url, applied_receipt_body_sha256: row.applied_receipt_body_sha256, applied_receipt_marker_sha256: row.applied_receipt_marker_sha256, materialization_comment_id: row.materialization_comment_id, materialization_comment_issue_url: row.materialization_comment_issue_url, materialization_receipt_body_sha256: row.materialization_receipt_body_sha256, materialization_receipt_marker_sha256: row.materialization_receipt_marker_sha256 })));
  const eligible = rows.filter((row) => row.result === 'REPAIR_ELIGIBLE').length;
  return {
    schema_version: SCHEMA_VERSION, mode: 'proposal-only-dry-run', repository: REPOSITORY,
    source_tree_sha: MAIN_SHA, parent_issue: PARENT_ISSUE, scope: SCOPE,
    source_binding: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF_PIN },
    authorization_present: false, authorization_required: true,
    authorization_contract_schema: AUTHORIZATION_SCHEMA_VERSION,
    mutation_performed: false, writes: { post: 0, patch: 0, create: 0, labels: 0, receipts: 0 },
    current_live_comments_get_only: true,
    pagination: { current_live_comments: pagination, source_snapshot: 'not used; live SourceNote GET per fixed 13-row scope' },
    authorization_binding: { plan_digest: planDigest, scope_digest: scopeDigest, source_bindings_digest: sourceBindingsDigest, owner_bindings_digest: ownerBindingsDigest, receipt_bindings_digest: receiptBindingsDigest, max_mutations: 13, max_receipts: 13 },
    counts: { rows: rows.length, repair_eligible: eligible, blocked: rows.length - eligible },
    errors: rows.flatMap((row) => row.errors.map((error) => `#${row.source_issue}: ${error}`)),
    rows,
    plan_digest: planDigest,
    audit_reference: { source_tree_sha: audit.source_tree_sha || null, merged_audit: 'audit/issue-1658/13-reconcile.json', historical_execution: 'UNKNOWN', generic_runner: 'NOT_VERIFIED', bounded_runner: 'NOT_VERIFIED' },
  };
}

function parseArgs(argv) {
  const args = { audit: DEFAULT_AUDIT, owners: DEFAULT_OWNERS, output: DEFAULT_OUTPUT, snapshot: DEFAULT_SNAPSHOT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--audit') args.audit = argv[++i];
    else if (argv[i] === '--owners') args.owners = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
    else if (argv[i] === '--snapshot') args.snapshot = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const audit = readJson(args.audit);
  const ownerInventory = readJson(args.owners);
  const expected = expectedRows(audit);
  const rows = [];
  const liveRows = [];
  const pagination = [];
  for (const sourceIssue of SCOPE) {
    const target = expected.get(sourceIssue);
    if (!target) throw new Error(`missing merged audit target #${sourceIssue}`);
    const source = compactIssue(ghGet(`repos/${REPOSITORY}/issues/${sourceIssue}`));
    const commentsResult = pagedComments(sourceIssue);
    const owner = compactIssue(ghGet(`repos/${REPOSITORY}/issues/${target.owner_issue}`));
    pagination.push({ source_issue: sourceIssue, pages: commentsResult.pages, terminal_page_short: commentsResult.terminal_page_short });
    rows.push(buildRow({ ...target, source_note_id: null, source_revision_id: null, transition_id: target.applied_transition_id }, source, owner, commentsResult.comments, { pages: commentsResult.pages, terminal_page_short: commentsResult.terminal_page_short }, ownerInventory));
    const built = rows[rows.length - 1];
    // Fill audit-independent identity/revision expectations from the live row;
    // buildRow performs all actual source/receipt/owner binding checks.
    if (!built.source_note_id || !built.source_revision_id) built.result = 'BLOCKED';
    liveRows.push({ ...built, source, owner, comments: commentsResult.comments });
  }
  const snapshot = { schema_version: 'issue-1658-boundary-receipt-repair-live-snapshot.v1', captured_at: new Date().toISOString(), source_tree_sha: MAIN_SHA, repository: REPOSITORY, source_repository: SOURCE_REPOSITORY, source_ref: SOURCE_REF_PIN, scope: SCOPE, owner_inventory: { provenance: 'saved merged audit input', path: path.relative(process.cwd(), path.resolve(args.owners)), current_fetch: false, count: ownerInventory.count }, pagination, rows: liveRows };
  // The snapshot is evidence output only; writing it cannot reach GitHub.
  fs.mkdirSync(path.dirname(path.resolve(args.snapshot)), { recursive: true });
  fs.writeFileSync(path.resolve(args.snapshot), `${JSON.stringify(snapshot, null, 2)}\n`);
  const proposal = buildProposal({ audit, rows, pagination });
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(proposal, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ mode: proposal.mode, output: path.resolve(args.output), snapshot: path.resolve(args.snapshot), plan_digest: proposal.plan_digest, counts: proposal.counts, errors: proposal.errors, mutation_performed: proposal.mutation_performed, writes: proposal.writes }, null, 2)}\n`);
  if (proposal.errors.length) process.exitCode = 1;
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`ERROR: ${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = {
  SCHEMA_VERSION, CORRECTION_SCHEMA_VERSION, AUTHORIZATION_SCHEMA_VERSION, REPOSITORY, SOURCE_REPOSITORY,
  SOURCE_REF_PIN, MAIN_SHA, SCOPE, canonical, digest, sha256Text, markerMatches,
  validateCorrectionMarker, buildCorrectionTemplate, buildProposal, buildRow,
};
