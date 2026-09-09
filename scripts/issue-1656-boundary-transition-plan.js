#!/usr/bin/env node
'use strict';

/*
 * GET-only boundary transition planner for the 13 evidence comments already
 * posted for Issue #1656.  This module intentionally has no GitHub writer.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  validatePlan: validateEvidencePostPlan,
  parseEvidenceBody,
} = require('./issue-1656-evidence-post-plan');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./lib/source-note-issue');
const {
  planSourceNoteBoundaryReviewTransition,
  normalizeLabels,
} = require('./lib/source-note-boundary-review-transition');

const REPOSITORY = 'liqiangcc/interview-lab';
const ISSUE = 1656;
const PARENT_ISSUE = 1611;
const UPSTREAM_ISSUE = 1605;
const EXPECTED_SOURCE_TOTAL = 421;
const DEFAULT_INPUT = 'data/pilot/issue-1656/evidence-post-plan.json';
const DEFAULT_OUTPUT = 'data/pilot/issue-1656/boundary-transition.plan.json';
const EVIDENCE_MARKER = 'issue-1608-boundary-evidence.v1';
const HEX64 = /^[0-9a-f]{64}$/;
const ZERO_WRITES = Object.freeze({ post: 0, patch: 0, label: 0, create: 0, materialization: 0, mutation: 0 });
const FORMAL_REQUEST_KEYS = [
  'schema_version', 'transition_id', 'repository', 'issue_number', 'source_note_id',
  'expected_body_sha256', 'expected_boundary_status', 'expected_source_revision_id',
  'expected_manifest_sha256', 'expected_source_repository_ref', 'decision',
  'reviewed_at', 'reviewer_kind', 'review_evidence', 'checks', 'limitations',
  'interview_cases',
];

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(value) { return crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex'); }
function textDigest(value) { return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function withoutDigest(value) { const copy = { ...value }; delete copy.canonical_digest; return copy; }

function exactEvidenceComments(comments) {
  return (Array.isArray(comments) ? comments : []).filter((comment) => {
    try { parseEvidenceBody(comment && comment.body); return true; }
    catch { return false; }
  });
}

function formalRequest(row, evidence, comment) {
  const candidate = row.transition_request || {};
  const request = {};
  for (const key of FORMAL_REQUEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(candidate, key)) request[key] = candidate[key];
  }
  request.reviewed_at = comment.created_at;
  request.reviewer_kind = 'ai-assisted';
  request.review_evidence = {
    repository: REPOSITORY,
    issue_number: row.issue_number,
    comment_id: Number(comment.id),
  };
  request.checks = evidence.checks;
  request.limitations = evidence.limitations;
  return request;
}

function validateLiveEvidence(row, issue, comments) {
  const errors = [];
  if (!issue || Number(issue.number) !== row.issue_number) errors.push('live issue number does not match target');
  if (!issue || String(issue.state || '').toLowerCase() !== 'open') errors.push('live target issue is not open');
  const currentBody = String(issue && issue.body || '');
  if (textDigest(currentBody) !== row.transition_request.expected_body_sha256) errors.push('live SourceNote body SHA differs from expected CAS');
  const parsed = parseSourceNoteIssue(currentBody);
  if (parsed.recordParseError) errors.push(`live SourceNote record JSON is invalid: ${parsed.recordParseError}`);
  if (!parsed.record) errors.push('live SourceNote record is missing');
  if (parsed.marker && parsed.marker.source_note_id !== row.transition_request.source_note_id) errors.push('live SourceNote marker identity differs from target');
  if (parsed.record && parsed.record.source_note_id !== row.transition_request.source_note_id) errors.push('live SourceNote record identity differs from target');
  if (parsed.record && parsed.record.boundary_review?.status !== 'pending') errors.push('live SourceNote boundary status is not pending');
  if (parsed.record && parsed.record.source_revision?.id !== row.transition_request.expected_source_revision_id) errors.push('live SourceRevision differs from expected CAS');
  const sourceValidation = validateSourceNoteIssue({ body: currentBody, labels: normalizeLabels(issue && issue.labels || []), state: issue && issue.state });
  if (!sourceValidation.ok) errors.push(...sourceValidation.errors.map((error) => `live SourceNote validation: ${error}`));

  const markerComments = exactEvidenceComments(comments);
  if (markerComments.length !== 1) errors.push(`expected exactly one ${EVIDENCE_MARKER} comment, found ${markerComments.length}`);
  let evidenceComment = markerComments[0] || null;
  let evidence = null;
  if (evidenceComment) {
    try { evidence = parseEvidenceBody(evidenceComment.body); }
    catch (error) { errors.push(error.message); }
    if (textDigest(evidenceComment.body) !== row.evidence_post.body_sha256) errors.push('live evidence comment SHA differs from planned evidence body');
    if (evidence && digest(evidence) !== digest(parseEvidenceBody(row.evidence_post.body))) errors.push('live evidence marker differs from planned evidence marker');
    if (Number(evidenceComment.id) < 1) errors.push('live evidence comment id is invalid');
    if (!evidenceComment.created_at || Number.isNaN(Date.parse(evidenceComment.created_at))) errors.push('live evidence comment created_at is invalid');
  }
  return { errors, evidenceComment, evidence, currentBody, currentLabels: normalizeLabels(issue && issue.labels || []) };
}

function buildProposalRow(row, issue, comments) {
  const checked = validateLiveEvidence(row, issue, comments);
  const result = {
    issue_number: row.issue_number,
    decision: row.decision,
    status: 'blocked',
    eligible: false,
    errors: checked.errors,
    live_issue_id: issue && Number(issue.id) || null,
    current_body_sha256: checked.currentBody ? textDigest(checked.currentBody) : null,
    current_labels: checked.currentLabels,
    labels_unchanged: true,
    evidence_comment_id: checked.evidenceComment ? Number(checked.evidenceComment.id) : null,
    evidence_comment_body_sha256: checked.evidenceComment ? textDigest(checked.evidenceComment.body) : null,
    comments_read: Array.isArray(comments) ? comments.map((comment) => Number(comment.id)).filter((id) => Number.isInteger(id) && id > 0) : [],
    next_body: null,
    next_body_sha256: null,
    next_labels: null,
    mutation_count: 0,
  };
  if (checked.errors.length > 0) return result;

  const request = formalRequest(row, checked.evidence, checked.evidenceComment);
  const planned = planSourceNoteBoundaryReviewTransition(request, issue, { evidenceComment: checked.evidenceComment, receipts: [] });
  result.errors = planned.errors || [];
  if (!planned.ok) return result;
  result.status = 'eligible';
  result.eligible = true;
  result.next_body = planned.next_body;
  result.next_body_sha256 = planned.next_body_sha256;
  result.next_labels = planned.next_labels;
  result.planned_request = request;
  result.planned_label_change = planned.next_labels;
  return result;
}

function blockedRow(row) {
  return {
    issue_number: row.issue_number,
    status: 'blocked',
    eligible: false,
    reason_code: row.reason_code,
    reason: row.reason,
    evidence_comment_id: null,
    next_body: null,
    next_body_sha256: null,
    next_labels: null,
    mutation_count: 0,
  };
}

function validateInput(input) {
  const result = validateEvidencePostPlan(input);
  const errors = [...result.errors];
  if (input?.scope?.source_total !== EXPECTED_SOURCE_TOTAL) errors.push('input evidence plan source_total must be 421');
  if (input?.scope?.evidence_post_rows !== 13 || input?.scope?.blocked_rows !== 4) errors.push('input evidence plan must contain 13 evidence rows and 4 blocked rows');
  return { ok: errors.length === 0, errors };
}

function buildPlan(input, reader, capturedAt = new Date().toISOString()) {
  const inputValidation = validateInput(input);
  if (!inputValidation.ok) throw new Error(inputValidation.errors.join('; '));
  if (!reader || typeof reader.readIssue !== 'function' || typeof reader.readComments !== 'function') throw new Error('GET reader with readIssue/readComments is required');
  const proposalRows = input.proposal_rows.map((row) => {
    try { return buildProposalRow(row, reader.readIssue(row.issue_number), reader.readComments(row.issue_number)); }
    catch (error) {
      return { issue_number: row.issue_number, decision: row.decision, status: 'blocked', eligible: false, errors: [error.message], live_issue_id: null, current_body_sha256: null, current_labels: [], labels_unchanged: true, evidence_comment_id: null, evidence_comment_body_sha256: null, comments_read: [], next_body: null, next_body_sha256: null, next_labels: null, mutation_count: 0 };
    }
  });
  const blockedLedger = input.blocked_ledger.map(blockedRow);
  const plan = {
    schema_version: 'issue-1656-boundary-transition-plan.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    parent_issue: PARENT_ISSUE,
    upstream_issue: UPSTREAM_ISSUE,
    mode: 'get-only',
    captured_at: capturedAt,
    input_plan_digest: input.canonical_digest,
    scope: { source_total: EXPECTED_SOURCE_TOTAL, target_rows: proposalRows.length, eligible_rows: proposalRows.filter((row) => row.eligible).length, blocked_rows: blockedLedger.length },
    proposal_rows: proposalRows,
    blocked_ledger: blockedLedger,
    summary: { eligible: proposalRows.filter((row) => row.eligible).length, blocked: blockedLedger.length, target_errors: proposalRows.filter((row) => !row.eligible).length },
    mutation_guard: { ...ZERO_WRITES, read_only: true, live_mutation: false },
    labels_unchanged: true,
    limitations: ['All live data was read with GitHub GET requests only.', 'This artifact proposes SourceNote body/label changes but does not apply them.', 'No issue comment, label, materialization, or other mutation was performed.'],
  };
  plan.ok = proposalRows.every((row) => row.eligible);
  plan.canonical_digest = digest(withoutDigest(plan));
  return plan;
}

function validatePlan(plan, input = null) {
  const errors = [];
  if (plan?.schema_version !== 'issue-1656-boundary-transition-plan.v1') errors.push('boundary transition plan schema mismatch');
  if (plan?.repository !== REPOSITORY || plan?.issue !== ISSUE || plan?.parent_issue !== PARENT_ISSUE || plan?.upstream_issue !== UPSTREAM_ISSUE) errors.push('boundary transition plan binding drifted');
  if (input && plan.input_plan_digest !== input.canonical_digest) errors.push('input plan digest drifted');
  if (plan?.scope?.source_total !== EXPECTED_SOURCE_TOTAL || plan?.scope?.target_rows !== 13 || plan?.scope?.eligible_rows !== 13 || plan?.scope?.blocked_rows !== 4) errors.push('boundary transition counts must be 13 eligible and 4 blocked');
  if (!plan?.ok) errors.push('real boundary transition plan is not eligible for all 13 targets');
  if (plan?.summary?.eligible !== 13 || plan?.summary?.blocked !== 4 || plan?.summary?.target_errors !== 0) errors.push('boundary transition summary drifted');
  for (const [key, value] of Object.entries(ZERO_WRITES)) if (plan?.mutation_guard?.[key] !== value) errors.push(`mutation_guard.${key} must be zero`);
  if (plan?.mutation_guard?.read_only !== true || plan?.mutation_guard?.live_mutation !== false || plan?.labels_unchanged !== true) errors.push('plan is not marked GET-only/labels unchanged');
  for (const row of plan?.proposal_rows || []) {
    if (row.status !== 'eligible' || row.eligible !== true || row.errors.length !== 0) errors.push(`#${row.issue_number} is not eligible without errors`);
    if (!HEX64.test(String(row.next_body_sha256 || '')) || row.next_body_sha256 !== textDigest(row.next_body)) errors.push(`#${row.issue_number} next body digest drifted`);
    if (!Number.isInteger(row.evidence_comment_id) || row.evidence_comment_id < 1) errors.push(`#${row.issue_number} evidence comment id is missing`);
    if (row.mutation_count !== 0 || row.labels_unchanged !== true) errors.push(`#${row.issue_number} mutation/label guard drifted`);
  }
  if (plan && plan.canonical_digest !== digest(withoutDigest(plan))) errors.push('boundary transition canonical digest drifted');
  return { ok: errors.length === 0, errors };
}

function ghGet(args) { return JSON.parse(execFileSync('gh', ['api', '--method', 'GET', ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 })); }
function readComments(issueNumber) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = ghGet([`repos/${REPOSITORY}/issues/${issueNumber}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`#${issueNumber} comments response is not an array`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error(`#${issueNumber} comments pagination exceeded bound`);
}

function readLiveReader() {
  return { readIssue: (number) => ghGet([`repos/${REPOSITORY}/issues/${number}`]), readComments };
}
function writeJson(file, value) { fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function parseArgs(argv = process.argv.slice(2)) {
  const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') args.input = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--help') args.help = true;
    else if (/--(?:apply|post|patch|label|materialize|materialization)/.test(argv[index])) throw new Error(`write operation is forbidden: ${argv[index]}`);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write('Usage: node scripts/issue-1656-boundary-transition-plan.js [--input FILE] [--output FILE]\n'); return 0; }
  const input = readJson(args.input);
  const plan = buildPlan(input, readLiveReader());
  const validation = validatePlan(plan, input);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (args.output) writeJson(args.output, plan);
  process.stdout.write(`${JSON.stringify({ ok: plan.ok, canonical_digest: plan.canonical_digest, counts: plan.scope, mutation_guard: plan.mutation_guard, output: args.output ? path.resolve(args.output) : null }, null, 2)}\n`);
  return plan.ok ? 0 : 1;
}

if (require.main === module) { try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; } }

module.exports = { REPOSITORY, ISSUE, EVIDENCE_MARKER, canonicalize, digest, textDigest, formalRequest, validateInput, validateLiveEvidence, buildPlan, validatePlan, readComments, parseArgs, main };
