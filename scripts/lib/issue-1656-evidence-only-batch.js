'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  canonicalize,
  sha256,
} = require('./issue-1656-evidence-transition-request-plan');
const {
  validatePlan: validateEvidencePostPlan,
  parseEvidenceBody,
  validateEvidenceBodyBinding,
} = require('../issue-1656-evidence-post-plan');
const { parseSourceNoteIssue } = require('./source-note-issue');
const { parseAppliedBoundaryReviewReceipts } = require('./source-note-boundary-review-transition');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const ISSUE = 1656;
const PARENT_ISSUE = 1611;
const UPSTREAM_ISSUE = 1605;
const PLAN_SCHEMA = 'issue-1656-evidence-post-plan.v1';
const BATCH_SCHEMA = 'issue-1656-evidence-only-batch.v1';
const JOURNAL_SCHEMA = 'issue-1656-evidence-only-journal.v1';
const AUTH_SCHEMA = 'issue-1656-evidence-only-authorization.v1';
const AUTH_MARKER = 'issue-1656-evidence-only-authorization';
const MAX_RECONCILE_ATTEMPTS = 3;
const ZERO_WRITES = Object.freeze({ post: 0, patch: 0, label: 0, create: 0, materialization: 0, mutation: 0 });

function without(value, key) { const copy = { ...value }; delete copy[key]; return copy; }
function digest(value) { return sha256(canonicalize(value)); }
function bodyDigest(issue) { return sha256(String(issue && issue.body || '')); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function planRows(plan) {
  const errors = [];
  if (!plan || plan.schema_version !== PLAN_SCHEMA) errors.push('evidence post plan schema mismatch');
  const validation = validateEvidencePostPlan(plan);
  errors.push(...validation.errors);
  if (plan?.mutation_guard?.mutation !== 0 || plan?.mutation_guard?.post !== 0 || plan?.mutation_guard?.patch !== 0) errors.push('input plan mutation guard is not zero');
  if (plan?.stages?.boundary_patch?.status !== 'not-planned') errors.push('boundary stage must remain not-planned');
  const rows = Array.isArray(plan?.proposal_rows) ? [...plan.proposal_rows].sort((a, b) => a.issue_number - b.issue_number) : [];
  const blocked = Array.isArray(plan?.blocked_ledger) ? plan.blocked_ledger : [];
  if (rows.length !== 13 || blocked.length !== 4) errors.push('input plan must have exactly 13 executable proposals and 4 blocked rows');
  if (blocked.some((row) => rows.some((candidate) => candidate.issue_number === row.issue_number))) errors.push('blocked row is present in executable rows');
  for (const row of rows) {
    errors.push(...validateEvidenceBodyBinding(row).map((error) => `#${row.issue_number}: ${error}`));
    if (row.evidence_post?.status !== 'planned-not-posted') errors.push(`#${row.issue_number}: evidence row is not planned-not-posted`);
  }
  return { ok: errors.length === 0, errors, rows, blocked };
}

function markerValues(body, marker) {
  const re = new RegExp(`<!--\\s*${marker}\\n([\\s\\S]*?)\\n-->`, 'g');
  const values = [];
  for (const match of String(body || '').matchAll(re)) {
    try { values.push(JSON.parse(match[1])); } catch (_) { values.push(null); }
  }
  return values;
}

function authorizationDigest(value) { return digest(without(value, 'authorization_sha256')); }

function validateAuthorization(comment, plan, supplied = {}) {
  const errors = [];
  const marker = markerValues(comment?.body, AUTH_MARKER);
  if (marker.length !== 1 || !marker[0]) errors.push('parent #1611 must contain exactly one valid authorization marker');
  const value = marker[0];
  if (value) {
    if (value.schema_version !== AUTH_SCHEMA || value.repository !== REPOSITORY || value.parent_issue !== PARENT_ISSUE || value.controller_issue !== ISSUE || value.boundary_parent_issue !== UPSTREAM_ISSUE) errors.push('authorization issue binding/schema drifted');
    if (value.action !== 'authorize-evidence-post-only' || value.allow_evidence_post !== true || value.allow_boundary_patch !== false || value.allow_labels !== false || value.allow_materialization !== false) errors.push('authorization does not restrict the operation to evidence comments');
    if (value.plan_digest !== plan.canonical_digest || value.authorization_sha256 !== authorizationDigest(value)) errors.push('authorization digest drifted');
    if (!Number.isSafeInteger(value.comment_id) || value.comment_id !== Number(supplied.authorization_comment_id)) errors.push('authorization comment identity drifted');
    if (value.max_mutations !== Number(supplied.max_mutations)) errors.push('authorization max-mutations differs from supplied ceiling');
  }
  if (String(supplied.plan_digest || '') !== plan.canonical_digest) errors.push('supplied PLAN_DIGEST differs from plan');
  if (String(supplied.confirm_digest || '') !== plan.canonical_digest) errors.push('supplied CONFIRM_DIGEST differs from plan');
  if (!Number.isSafeInteger(Number(supplied.max_mutations)) || Number(supplied.max_mutations) !== plan.proposal_rows.length) errors.push(`max-mutations must exactly equal executable proposal count ${plan.proposal_rows.length}`);
  return { ok: errors.length === 0, errors, marker: value || null };
}

function exactEvidenceMatches(comments, row) {
  const matches = [];
  const markerMatches = [];
  for (const comment of comments || []) {
    if (String(comment?.body || '') === row.evidence_post.body) matches.push(comment);
    try {
      const marker = parseEvidenceBody(comment?.body || '');
      if (marker.transition_request?.transition_id === row.transition_request.transition_id) markerMatches.push({ comment, marker });
    } catch (_) { /* unrelated comments are allowed */ }
  }
  return { matches, markerMatches };
}

function validateFreshRow(row, issue, comments) {
  const errors = [];
  if (!issue || Number(issue.number) !== row.issue_number) errors.push('live issue identity mismatch');
  if (bodyDigest(issue) !== row.cas.expected_body_sha256) errors.push('live body SHA mismatch');
  const parsed = parseSourceNoteIssue(issue?.body || '');
  const record = parsed.record;
  if (!record) errors.push('live SourceNote record is missing');
  if (record?.source_note_id !== row.cas.source_note_id) errors.push('live SourceNote identity mismatch');
  if (record?.boundary_review?.status !== 'pending') errors.push('live boundary status is not pending');
  if (record?.source_revision?.id !== row.cas.expected_source_revision_id) errors.push('live SourceRevision mismatch');
  if (record?.source_revision?.source_repository !== SOURCE_REPOSITORY || record?.source_revision?.source_repository_ref !== SOURCE_REF) errors.push('live SourceRevision source binding mismatch');
  const artifact = (record?.artifacts || []).find((candidate) => candidate?.ref === row.cas.source_projection_ref);
  if (!artifact) errors.push('live source projection ref mismatch');
  else {
    if (artifact.kind !== row.transition_request.source_projection.kind) errors.push('live source projection kind mismatch');
    if (artifact.provenance !== row.transition_request.source_projection.provenance) errors.push('live source projection provenance mismatch');
    if (artifact.git_blob_sha !== row.cas.source_projection_blob_sha) errors.push('live source projection blob SHA mismatch');
    if (artifact.sha256 != null && artifact.sha256 !== row.cas.source_projection_content_sha256) errors.push('live source projection content SHA mismatch');
    if (artifact.byte_size !== row.transition_request.source_projection.byte_size) errors.push('live source projection byte size mismatch');
  }
  if (!Array.isArray(comments)) errors.push('live comments are not an array');
  const receipts = parseAppliedBoundaryReviewReceipts(comments || []);
  errors.push(...receipts.errors);
  const evidence = exactEvidenceMatches(comments || [], row);
  if (evidence.matches.length > 1 || evidence.markerMatches.length > 1) errors.push('duplicate evidence idempotency marker');
  if (evidence.markerMatches.length === 1 && evidence.matches.length !== 1) errors.push('evidence marker exists with a body different from the planned body');
  return {
    ok: errors.length === 0,
    errors,
    issue_number: row.issue_number,
    body_sha256: bodyDigest(issue),
    comments_sha256: digest(comments || []),
    comments_count: Array.isArray(comments) ? comments.length : null,
    idempotency: { exact_marker_count: evidence.matches.length, transition_marker_count: evidence.markerMatches.length, already_posted: evidence.matches.length === 1, safe_to_post: errors.length === 0 && evidence.matches.length === 0 },
  };
}

function freshGetBatch(plan, api) {
  if (!api || typeof api.readIssue !== 'function' || typeof api.readComments !== 'function') throw new Error('fresh GET adapter must provide readIssue and readComments');
  const rows = plan.proposal_rows.map((row) => {
    try {
      const issue = api.readIssue(row.issue_number);
      const comments = api.readComments(row.issue_number);
      return validateFreshRow(row, issue, comments);
    } catch (error) {
      return { ok: false, errors: [error.message], issue_number: row.issue_number, body_sha256: null, comments_sha256: null, comments_count: null, idempotency: { exact_marker_count: 0, transition_marker_count: 0, already_posted: false, safe_to_post: false } };
    }
  });
  return { ok: rows.every((row) => row.ok), rows, digest: digest(rows) };
}

function initialJournal(plan, now = new Date().toISOString()) {
  const content = {
    schema_version: JOURNAL_SCHEMA,
    repository: REPOSITORY,
    issue: ISSUE,
    parent_issue: PARENT_ISSUE,
    upstream_issue: UPSTREAM_ISSUE,
    plan_digest: plan.canonical_digest,
    status: 'planned',
    mutation_count: 0,
    possibly_performed: false,
    created_at: now,
    updated_at: now,
    entries: plan.proposal_rows.map((row) => ({ issue_number: row.issue_number, transition_id: row.transition_request.transition_id, phase: 'pending', mutation_attempted: false, mutation_performed: false, possibly_performed: false, mutation_count: 0 })),
  };
  return { ...content, canonical_digest: digest(content) };
}

function validateJournal(journal, plan) {
  const errors = [];
  if (!journal || journal.schema_version !== JOURNAL_SCHEMA) errors.push('journal schema mismatch');
  if (journal && (journal.plan_digest !== plan.canonical_digest || journal.repository !== REPOSITORY || journal.issue !== ISSUE || journal.parent_issue !== PARENT_ISSUE || journal.upstream_issue !== UPSTREAM_ISSUE)) errors.push('journal binding drifted');
  if (journal && journal.canonical_digest !== digest(without(journal, 'canonical_digest'))) errors.push('journal digest drifted');
  const expected = new Map(plan.proposal_rows.map((row) => [row.issue_number, row.transition_request.transition_id]));
  const seen = new Set(); let total = 0;
  for (const entry of journal?.entries || []) {
    if (!expected.has(entry.issue_number) || seen.has(entry.issue_number)) errors.push(`journal entry identity invalid for #${entry.issue_number}`);
    seen.add(entry.issue_number);
    if (expected.get(entry.issue_number) !== entry.transition_id) errors.push(`journal transition identity drifted for #${entry.issue_number}`);
    if (!['pending', 'evidence-post-pending', 'unknown', 'complete'].includes(entry.phase)) errors.push(`journal phase invalid for #${entry.issue_number}`);
    if (![0, 1].includes(entry.mutation_count) || typeof entry.possibly_performed !== 'boolean' || typeof entry.mutation_attempted !== 'boolean' || typeof entry.mutation_performed !== 'boolean') errors.push(`journal mutation state invalid for #${entry.issue_number}`);
    total += Number(entry.mutation_count || 0);
    if (entry.phase === 'unknown' && !entry.possibly_performed) errors.push(`unknown phase must retain possibly_performed for #${entry.issue_number}`);
  }
  if (seen.size !== expected.size) errors.push('journal entry set does not equal the 13-row executable scope');
  if (journal && journal.mutation_count !== total) errors.push('journal mutation total drifted');
  if (journal && journal.possibly_performed !== journal.entries.some((entry) => entry.possibly_performed)) errors.push('journal unknown aggregate drifted');
  return { ok: errors.length === 0, errors };
}

function atomicWriteJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const directory = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function acquireLock(file, planDigest) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const record = { schema_version: 'issue-1656-evidence-only-lock.v1', lock_id: crypto.randomUUID(), pid: process.pid, hostname: os.hostname(), plan_digest: planDigest, acquired_at: new Date().toISOString() };
  let fd;
  try { fd = fs.openSync(target, 'wx', 0o600); fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8'); fs.fsyncSync(fd); }
  catch (error) { throw new Error(`evidence-only lock is held or unavailable: ${error.message}`); }
  finally { if (fd != null) fs.closeSync(fd); }
  const assertHeld = () => {
    const current = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (current.lock_id !== record.lock_id || current.plan_digest !== planDigest) throw new Error('evidence-only lock ownership changed');
  };
  return { assertHeld, release() { assertHeld(); fs.unlinkSync(target); } };
}

function persistJournal(file, journal, plan, lock) {
  lock.assertHeld();
  const next = { ...journal, updated_at: new Date().toISOString() };
  next.canonical_digest = digest(without(next, 'canonical_digest'));
  const validation = validateJournal(next, plan);
  if (!validation.ok) throw new Error(`journal validation failed: ${validation.errors.join('; ')}`);
  atomicWriteJson(file, next);
  return next;
}

function markUnknown(journal, entry, error, file, plan, lock) {
  entry.phase = 'unknown'; entry.possibly_performed = true; entry.error = String(error?.message || error);
  journal.possibly_performed = true;
  return persistJournal(file, journal, plan, lock);
}

function reconcileEvidence(row, api, attempts = MAX_RECONCILE_ATTEMPTS) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const comments = api.readComments(row.issue_number);
      const evidence = exactEvidenceMatches(comments, row);
      if (evidence.matches.length === 1 && evidence.markerMatches.length === 1) return { ok: true, comment: evidence.matches[0], comments };
      if (evidence.matches.length > 1 || evidence.markerMatches.length > 1) throw new Error('reconcile found duplicate evidence marker');
      last = new Error('planned evidence marker is not visible');
    } catch (error) { last = error; }
  }
  return { ok: false, error: new Error(`evidence POST outcome is unknown after ${attempts} bounded reconciliations: ${last?.message || 'not visible'}`) };
}

function applyEvidenceBatch({ plan, api, authorizationComment, authorization, journalFile, lockFile, now = () => new Date().toISOString(), dryRunDigest }) {
  const input = planRows(plan);
  if (!input.ok) throw new Error(input.errors.join('; '));
  const auth = validateAuthorization(authorizationComment, plan, authorization);
  if (!auth.ok) throw new Error(auth.errors.join('; '));
  if (dryRunDigest !== plan.canonical_digest) throw new Error('apply requires a prior dry-run digest equal to the plan digest');
  if (typeof api?.readIssue !== 'function' || typeof api?.readComments !== 'function' || typeof api?.postEvidenceComment !== 'function') throw new Error('apply requires fresh GET and evidence comment adapters; no boundary writer exists');
  const lock = acquireLock(lockFile, plan.canonical_digest);
  let journal = initialJournal(plan, now());
  try {
    atomicWriteJson(journalFile, journal);
    const fresh = freshGetBatch(plan, api);
    if (!fresh.ok) throw new Error(`fresh SourceNote/CAS validation failed: ${fresh.rows.flatMap((row) => row.errors.map((error) => `#${row.issue_number}: ${error}`)).join('; ')}`);
    const freshByIssue = new Map(fresh.rows.map((row) => [row.issue_number, row]));
    for (const row of plan.proposal_rows) {
      lock.assertHeld();
      const audit = freshByIssue.get(row.issue_number);
      const entry = journal.entries.find((candidate) => candidate.issue_number === row.issue_number);
      if (audit.idempotency.already_posted) { entry.phase = 'complete'; entry.mutation_performed = false; entry.mutation_attempted = false; persistJournal(journalFile, journal, plan, lock); continue; }
      if (!audit.idempotency.safe_to_post) throw new Error(`#${row.issue_number}: idempotency/CAS gate is not safe`);
      entry.phase = 'evidence-post-pending'; entry.mutation_attempted = true; entry.mutation_count = 1; journal.mutation_count += 1; persistJournal(journalFile, journal, plan, lock);
      let response;
      try { lock.assertHeld(); response = api.postEvidenceComment(row.issue_number, row.evidence_post.body); }
      catch (error) {
        markUnknown(journal, entry, error, journalFile, plan, lock);
        const reconciled = reconcileEvidence(row, api);
        if (!reconciled.ok) throw reconciled.error;
      }
      if (response && (!Number.isSafeInteger(Number(response.id)) || String(response.body || '') !== row.evidence_post.body)) {
        markUnknown(journal, entry, new Error('evidence POST response failed exact idempotency validation'), journalFile, plan, lock);
        const reconciled = reconcileEvidence(row, api);
        if (!reconciled.ok) throw reconciled.error;
      } else if (!response) {
        // A reconciled successful POST remains a settled, single evidence marker.
      }
      const final = reconcileEvidence(row, api);
      if (!final.ok) { markUnknown(journal, entry, final.error, journalFile, plan, lock); throw final.error; }
      entry.phase = 'complete'; entry.mutation_performed = true; entry.possibly_performed = false; journal.possibly_performed = journal.entries.some((candidate) => candidate.possibly_performed); persistJournal(journalFile, journal, plan, lock);
    }
    journal.status = 'complete'; persistJournal(journalFile, journal, plan, lock);
    return { ok: true, mode: 'evidence-only-apply', plan_digest: plan.canonical_digest, counts: { total: 421, proposal: 13, blocked: 4, posted_or_already_present: 13 }, write_operations: { ...ZERO_WRITES, post: journal.entries.filter((entry) => entry.mutation_performed).length, mutation: journal.entries.filter((entry) => entry.mutation_performed).length }, journal };
  } finally { lock.release(); }
}

function buildPlanOnly(plan) {
  const input = planRows(plan);
  if (!input.ok) throw new Error(input.errors.join('; '));
  return {
    schema_version: BATCH_SCHEMA,
    repository: REPOSITORY,
    issue: ISSUE,
    parent_issue: PARENT_ISSUE,
    upstream_issue: UPSTREAM_ISSUE,
    mode: 'plan-only',
    plan_digest: plan.canonical_digest,
    counts: { total: 421, proposal: 13, blocked: 4, execution_batch: 0 },
    proposal_rows: input.rows.map((row) => ({ issue_number: row.issue_number, decision: row.decision, transition_id: row.transition_request.transition_id, status: 'not-started', mutation_count: 0 })),
    blocked_ledger: input.blocked.map((row) => ({ issue_number: row.issue_number, status: 'blocked', mutation_count: 0 })),
    lock: { required: true, acquired: false },
    journal: { required: true, status: 'not-started', entries: input.rows.length },
    idempotency: { required: true, duplicate_marker_policy: 'fail-closed', crash_unknown_recovery: 'bounded-read-reconcile' },
    write_operations: { ...ZERO_WRITES },
    evidence_only: true,
    boundary_patch: 'not-implemented',
  };
}

module.exports = {
  REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, ISSUE, PARENT_ISSUE, UPSTREAM_ISSUE,
  PLAN_SCHEMA, BATCH_SCHEMA, JOURNAL_SCHEMA, AUTH_SCHEMA, AUTH_MARKER, ZERO_WRITES,
  planRows, markerValues, authorizationDigest, validateAuthorization, exactEvidenceMatches,
  validateFreshRow, freshGetBatch, initialJournal, validateJournal, atomicWriteJson, acquireLock,
  persistJournal, reconcileEvidence, applyEvidenceBatch, buildPlanOnly,
};
