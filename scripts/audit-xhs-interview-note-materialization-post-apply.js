#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
  sha256Text,
  parseMaterializationReceipts,
  planMaterialization,
} = require('./lib/source-note-interview-materialization');
const { parseSourceNoteIssue } = require('./lib/source-note-issue');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./lib/interview-note-issue');
const { childInterviewNoteId } = require('./lib/interview-note-identity');
const { createSearchThrottle } = require('./lib/interview-note-ownership-search');
const {
  ghReadJson,
  loadComments,
  ownership,
  readAuthorizedReport,
  validateLiveDependencyGate,
  findBlockedReview,
  atomicWrite,
} = require('./apply-xhs-interview-note-materialization-batch');

const REPOSITORY = 'liqiangcc/interview-lab';
const APPLY_REPORT = 'data/pilot/issue-922/materialization-batch.dry-run.json';
const APPLY_PROGRESS = `${APPLY_REPORT}.apply-progress.json`;
const RECOVERY_REPORT = 'data/pilot/issue-922/materialization-batch.post-apply-recovery.dry-run.json';
const AUDIT_REPORT = 'data/pilot/issue-922/materialization-batch.post-apply.live-audit.json';
const SEARCH_PAUSE_MS = 2200;

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function labelsOf(issue) { return (issue.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean); }
function readIssue(number) { return ghReadJson(['api', `repos/${REPOSITORY}/issues/${number}`]); }
function digestReport(report) {
  const { dry_run_sha256: ignored, ...withoutDigest } = report;
  return sha256Text(JSON.stringify(withoutDigest));
}
function assert(condition, message, errors) { if (!condition) errors.push(message); }
function markerCount(comments, expression) {
  return (comments || []).reduce((count, comment) => count + [...String(comment.body || '').matchAll(expression)].length, 0);
}

function candidateRows(report, action) {
  return report.results.filter((row) => row.action === action);
}

function auditCandidate(row, source, sourceComments, owners, progressIntent, progressResult, errors) {
  const request = row.request;
  const expected = row.materialization;
  const sourceParsed = parseSourceNoteIssue(source.body);
  const sourceRecord = sourceParsed.record;
  const target = request.case_key == null
    ? `${sourceRecord.source.system}:${sourceRecord.source.external_id}`
    : childInterviewNoteId(sourceRecord.source, request.case_key);
  const owner = owners.length === 1 ? owners[0] : null;
  const receipt = parseMaterializationReceipts(sourceComments).filter((item) => item.materialization_id === request.materialization_id);
  assert(owners.length === 1, `${request.materialization_id}: expected exactly one owner, found ${owners.length}`, errors);
  if (owner) assert(Number(owner.number) === Number(progressResult && progressResult.interview_issue_number), `${request.materialization_id}: live owner does not match apply progress`, errors);
  assert(progressIntent && progressIntent.phase === 'resolved', `${request.materialization_id}: intent is not resolved`, errors);
  assert(progressResult && progressResult.status === 'succeeded', `${request.materialization_id}: progress result is not succeeded`, errors);
  assert(receipt.length === 1, `${request.materialization_id}: expected one SourceNote receipt, found ${receipt.length}`, errors);
  const plan = planMaterialization(request, { repository: REPOSITORY, sourceIssue: source, issues: owners, receipts: parseMaterializationReceipts(sourceComments) });
  assert(plan.ok && plan.already_materialized, `${request.materialization_id}: live materialization plan did not converge`, errors);
  assert(expected && expected.interview_note_id === target, `${request.materialization_id}: report identity disagrees with live derived identity`, errors);
  const item = {
    source_note_issue_number: request.source_note_issue_number,
    source_note_id: request.source_note_id,
    materialization_id: request.materialization_id,
    interview_note_id: target,
    case_key: request.case_key == null ? null : request.case_key,
    interview_issue_number: owner ? Number(owner.number) : null,
    owner_count: owners.length,
    intent_phase: progressIntent && progressIntent.phase,
    progress_status: progressResult && progressResult.status,
    interview_validator: 'fail',
    source_receipt_count: receipt.length,
    receipt_bidirectional_match: false,
    blocked_marker_count: 0,
    task_source_recovery: false,
  };
  if (!owner) return item;
  const ownerLabels = labelsOf(owner);
  const validation = validateInterviewNoteIssue({ body: owner.body, labels: ownerLabels, state: owner.state });
  item.interview_validator = validation.ok ? 'pass' : 'fail';
  assert(validation.ok, `${request.materialization_id}: InterviewNote validator failed: ${(validation.errors || []).join('; ')}`, errors);
  const parsedInterview = parseInterviewNoteIssue(owner.body);
  assert(parsedInterview.record && parsedInterview.record.interview_note_id === target, `${request.materialization_id}: InterviewNote record identity mismatch`, errors);
  assert(String(owner.body).includes(`SourceNote：#${request.source_note_issue_number}`) && String(owner.body).includes(request.source_note_id), `${request.materialization_id}: InterviewNote lacks SourceNote backlink`, errors);
  if (receipt.length === 1) {
    const value = receipt[0];
    item.receipt_bidirectional_match = value.interview_issue_number === Number(owner.number) && value.interview_note_id === target && value.source_note_issue_number === request.source_note_issue_number && value.source_note_id === request.source_note_id && value.request_sha256 === plan.request_sha256;
  }
  assert(item.receipt_bidirectional_match, `${request.materialization_id}: SourceNote receipt does not bidirectionally match owner`, errors);
  const blockedComments = loadComments(REPOSITORY, Number(owner.number));
  item.blocked_marker_count = markerCount(blockedComments, /<!--\s*interview-note-source-review-blocked\s*\n[\s\S]*?\n-->/g);
  item.task_source_recovery = ownerLabels.includes('status:blocked') && ownerLabels.includes('task:source-recovery');
  assert(item.blocked_marker_count === 1, `${request.materialization_id}: expected one blocked Source Review marker, found ${item.blocked_marker_count}`, errors);
  assert(item.task_source_recovery, `${request.materialization_id}: missing status:blocked + task:source-recovery`, errors);
  assert(findBlockedReview(blockedComments, request, target), `${request.materialization_id}: blocked marker identity verification failed`, errors);
  return item;
}

function auditExcluded(row, source, sourceComments, owners, errors) {
  const parsed = parseSourceNoteIssue(source.body).record;
  const receipts = parseMaterializationReceipts(sourceComments);
  const identity = `${parsed.source.system}:${parsed.source.external_id}`;
  assert(owners.length === 0, `Issue #${row.source_note_issue_number} ${row.action}: expected exact owner=0, found ${owners.length}`, errors);
  assert(receipts.length === 0, `Issue #${row.source_note_issue_number} ${row.action}: expected receipt=0, found ${receipts.length}`, errors);
  return { source_note_issue_number: row.source_note_issue_number, source_note_id: row.source_note_id, identity, owner_count: owners.length, receipt_count: receipts.length };
}

function main() {
  const applyReport = JSON.parse(fs.readFileSync(APPLY_REPORT, 'utf8'));
  const recoveryReport = JSON.parse(fs.readFileSync(RECOVERY_REPORT, 'utf8'));
  const progress = JSON.parse(fs.readFileSync(APPLY_PROGRESS, 'utf8'));
  const errors = [];
  assert(applyReport.dry_run_sha256 === '0bd3303bf35b649b32a523e2b80d295930277fe8374af749f1708e0d4b214808', 'apply report digest is not the authorized digest', errors);
  assert(digestReport(applyReport) === applyReport.dry_run_sha256, 'apply report digest is invalid', errors);
  assert(digestReport(recoveryReport) === recoveryReport.dry_run_sha256, 'recovery report digest is invalid', errors);
  assert(recoveryReport.mutation_performed === false, 'recovery report records mutation', errors);
  assert(recoveryReport.ready_for_apply === true, 'recovery report is not ready', errors);
  assert(validateLiveDependencyGate(recoveryReport), 'live dependency gate did not pass', errors);
  assert(progress.dry_run_sha256 === applyReport.dry_run_sha256 && progress.status === 'complete', 'apply progress digest/status is invalid', errors);
  const applyCandidates = candidateRows(applyReport, 'would-materialize').concat(candidateRows(applyReport, 'would-repair-receipt'));
  const recoveryMaterialized = candidateRows(recoveryReport, 'already-materialized');
  const recoveryPending = candidateRows(recoveryReport, 'blocked').filter((row) => row.boundary_status === 'pending');
  const recoveryNotInterview = candidateRows(recoveryReport, 'skip-not-interview');
  const resultsById = new Map((progress.results || []).filter((item) => item.status === 'succeeded').map((item) => [item.materialization_id, item]));
  const intents = progress.intents || {};
  assert(applyCandidates.length === 30, `expected 30 apply candidates, found ${applyCandidates.length}`, errors);
  assert(recoveryMaterialized.length === 30, `expected materialized=30, found ${recoveryMaterialized.length}`, errors);
  assert(recoveryPending.length === 5, `expected boundary_pending=5, found ${recoveryPending.length}`, errors);
  assert(recoveryNotInterview.length === 18, `expected not_interview=18, found ${recoveryNotInterview.length}`, errors);
  assert((progress.results || []).length === 30 && resultsById.size === 30, 'apply progress does not contain exactly 30 successful results', errors);
  assert(Object.keys(intents).length === 30 && Object.values(intents).every((intent) => intent && intent.phase === 'resolved'), 'not all 30 mutation intents are resolved', errors);
  const searchThrottle = createSearchThrottle(SEARCH_PAUSE_MS, sleepMs);
  const ownerCache = new Map();
  const getOwners = (identity) => {
    if (!ownerCache.has(identity)) ownerCache.set(identity, ownership(REPOSITORY, identity, searchThrottle));
    return ownerCache.get(identity);
  };
  const materializedItems = [];
  for (const row of recoveryMaterialized) {
    const source = readIssue(row.source_note_issue_number);
    const sourceComments = loadComments(REPOSITORY, row.source_note_issue_number);
    const owners = getOwners(row.materialization.interview_note_id);
    const item = auditCandidate(row, source, sourceComments, owners, intents[row.request.materialization_id], resultsById.get(row.request.materialization_id), errors);
    materializedItems.push(item);
  }
  const excluded = { not_interview: [], boundary_pending: [] };
  for (const row of recoveryNotInterview) {
    const source = readIssue(row.source_note_issue_number);
    const sourceComments = loadComments(REPOSITORY, row.source_note_issue_number);
    const parsed = parseSourceNoteIssue(source.body).record;
    excluded.not_interview.push(auditExcluded(row, source, sourceComments, getOwners(`${parsed.source.system}:${parsed.source.external_id}`), errors));
  }
  for (const row of recoveryPending) {
    const source = readIssue(row.source_note_issue_number);
    const sourceComments = loadComments(REPOSITORY, row.source_note_issue_number);
    const parsed = parseSourceNoteIssue(source.body).record;
    excluded.boundary_pending.push(auditExcluded(row, source, sourceComments, getOwners(`${parsed.source.system}:${parsed.source.external_id}`), errors));
  }
  const sourceReviewBlocked = materializedItems.filter((item) => item.task_source_recovery && item.blocked_marker_count === 1).length;
  const sourceReady = materializedItems.filter((item) => item.interview_validator === 'pass' && !item.task_source_recovery).length;
  const audit = {
    schema_version: 'xhs-interview-note-materialization-post-apply-live-audit.v1',
    repository: REPOSITORY,
    source: { apply_report: APPLY_REPORT, recovery_report: RECOVERY_REPORT, apply_progress: APPLY_PROGRESS, search_pause_ms: SEARCH_PAUSE_MS },
    evidence: { authorized_dry_run_sha256: applyReport.dry_run_sha256, recovery_dry_run_sha256: recoveryReport.dry_run_sha256, apply_progress_sha256: sha256Text(JSON.stringify(progress)) },
    counts: { materialized: materializedItems.length, source_ready: sourceReady, source_review_blocked: sourceReviewBlocked, boundary_pending: excluded.boundary_pending.length, not_interview: excluded.not_interview.length },
    checks: { owner_unique: materializedItems.every((item) => item.owner_count === 1), interview_validator: materializedItems.every((item) => item.interview_validator === 'pass'), source_receipt_unique: materializedItems.every((item) => item.source_receipt_count === 1), bidirectional_receipt: materializedItems.every((item) => item.receipt_bidirectional_match), blocked_marker_unique: materializedItems.every((item) => item.blocked_marker_count === 1), blocked_task_label: materializedItems.every((item) => item.task_source_recovery), intents_resolved: Object.keys(intents).length === 30 && Object.values(intents).every((intent) => intent.phase === 'resolved'), not_interview_owner_zero: excluded.not_interview.every((item) => item.owner_count === 0), pending_owner_zero: excluded.boundary_pending.every((item) => item.owner_count === 0), pending_receipt_zero: excluded.boundary_pending.every((item) => item.receipt_count === 0) },
    materialized: materializedItems,
    excluded,
    errors,
    ok: errors.length === 0 && materializedItems.length === 30 && sourceReady === 0 && sourceReviewBlocked === 30 && excluded.boundary_pending.length === 5 && excluded.not_interview.length === 18,
  };
  atomicWrite(AUDIT_REPORT, audit);
  process.stdout.write(`${JSON.stringify({ ok: audit.ok, report: AUDIT_REPORT, counts: audit.counts, errors: audit.errors }, null, 2)}\n`);
  return audit.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { main, digestReport };
