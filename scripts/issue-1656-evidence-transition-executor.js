#!/usr/bin/env node
'use strict';

/*
 * Issue #1656 safety gate.  This is deliberately a read-only executor:
 * --apply only enables a fresh GET/CAS audit and never supplies a GitHub
 * mutation primitive.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  validateEvidenceTransitionPlan,
  canonicalize,
  sha256,
} = require('./lib/issue-1656-evidence-transition-request-plan');
const { parseSourceNoteIssue } = require('./lib/source-note-issue');
const { parseAppliedBoundaryReviewReceipts } = require('./lib/source-note-boundary-review-transition');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const ISSUE = 1656;
const PARENT_ISSUE = 1611;
const UPSTREAM_ISSUE = 1605;
const EXPECTED_TOTAL = 421;
const DEFAULT_PLAN = 'data/pilot/issue-1656/evidence-transition-request-plan.json';
const DEFAULT_OUTPUT = null;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ZERO_WRITES = Object.freeze({ post: 0, patch: 0, label: 0, create: 0, mutation: 0 });

function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function digest(value) { return sha256(canonicalize(value)); }
function bodyDigest(issue) { return crypto.createHash('sha256').update(String(issue && issue.body || ''), 'utf8').digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function validateInputPlan(plan) {
  const validation = validateEvidenceTransitionPlan(plan);
  const errors = [...validation.errors];
  if (plan?.scope?.total !== EXPECTED_TOTAL) errors.push('input request plan scope must total 421');
  if (plan?.summary?.proposal_rows !== 17 || plan?.summary?.blocked_rows !== 404) errors.push('input request plan must partition as 17 proposal and 404 blocked rows');
  if (!Array.isArray(plan?.proposal_rows) || plan.proposal_rows.length !== 17) errors.push('input proposal_rows must contain exactly 17 rows');
  if (!Array.isArray(plan?.blocked_ledger) || plan.blocked_ledger.length !== 404) errors.push('input blocked_ledger must contain exactly 404 rows');
  const proposalIds = new Set((plan?.proposal_rows || []).map((row) => Number(row.issue_number)));
  const blockedIds = new Set((plan?.blocked_ledger || []).map((row) => Number(row.issue_number)));
  for (const issueNumber of proposalIds) if (blockedIds.has(issueNumber)) errors.push(`Issue #${issueNumber} appears in both execution and blocked scope`);
  if (proposalIds.size !== 17 || blockedIds.size !== 404) errors.push('input request plan contains duplicate issue rows');
  return { ok: errors.length === 0, errors };
}

function authorizationGate(env, planDigest) {
  const authorizationCommentId = String(env.AUTHORIZATION_COMMENT_ID || '').trim();
  const planDigestValue = String(env.PLAN_DIGEST || '').trim();
  const confirmDigest = String(env.CONFIRM_DIGEST || '').trim();
  const errors = [];
  if (!/^\d+$/.test(authorizationCommentId) || Number(authorizationCommentId) < 1) errors.push('AUTHORIZATION_COMMENT_ID must be a positive integer');
  if (planDigestValue !== planDigest) errors.push('PLAN_DIGEST must exactly match the request plan digest');
  if (confirmDigest !== planDigest) errors.push('CONFIRM_DIGEST must exactly match the request plan digest');
  return { ok: errors.length === 0, errors, authorization_comment_id: Number(authorizationCommentId) || null };
}

function transient(error) {
  return /tls|ssl|timeout|timed out|eof|connection reset|socket hang up|temporary|econnreset|eai_again/i.test(String(error && error.message || error));
}

function boundedRead(read, label, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return read(); }
    catch (error) {
      last = error;
      if (attempt === attempts || !transient(error)) throw new Error(`${label}: ${error.message}`);
    }
  }
  throw new Error(`${label}: ${last ? last.message : 'read failed'}`);
}

function ghGet(args) {
  return JSON.parse(execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 32 * 1024 * 1024,
  }));
}

function readComments(issueNumber) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = boundedRead(() => ghGet([`repos/${REPOSITORY}/issues/${issueNumber}/comments?per_page=100&page=${page}`]), `#${issueNumber} comments page ${page}`);
    if (!Array.isArray(batch)) throw new Error(`#${issueNumber} comments page ${page} is not an array`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error(`#${issueNumber} comments pagination exceeded bound`);
}

function liveProjection(record, ref) {
  const artifact = (record?.artifacts || []).find((candidate) => candidate && candidate.ref === ref);
  if (!artifact) throw new Error('live SourceNote lacks the exact planned source projection artifact');
  return artifact;
}

function validateFreshCas(row, issue, comments) {
  const errors = [];
  if (!issue || Number(issue.number) !== row.issue_number) errors.push('live issue identity mismatch');
  if (bodyDigest(issue) !== row.expected_body_sha256) errors.push('live body SHA mismatch');
  const parsed = parseSourceNoteIssue(issue?.body || '');
  const record = parsed.record;
  if (!record) errors.push('live SourceNote record is missing or invalid');
  if (record?.source_note_id !== row.source_note_id) errors.push('live SourceNote identity mismatch');
  if (record?.boundary_review?.status !== 'pending') errors.push('live boundary status is not pending');
  if (record?.source_revision?.id !== row.expected_source_revision_id) errors.push('live SourceRevision mismatch');
  if (record?.source_revision?.source_repository !== SOURCE_REPOSITORY || record?.source_revision?.source_repository_ref !== SOURCE_REF) errors.push('live SourceRevision source binding mismatch');
  try {
    const artifact = liveProjection(record, row.source_projection.ref);
    if (artifact.kind !== row.source_projection.kind) errors.push('live projection kind mismatch');
    if (artifact.provenance !== row.source_projection.provenance) errors.push('live projection provenance mismatch');
    if (artifact.git_blob_sha !== row.source_projection.blob_sha) errors.push('live projection blob SHA mismatch');
    // SourceNote v1 records may omit the projection content SHA; the frozen
    // request plan remains the authoritative projection digest.  A present
    // live value must still match exactly.
    if (artifact.sha256 != null && artifact.sha256 !== row.source_projection.content_sha256) errors.push('live projection content digest mismatch');
    if (artifact.byte_size !== row.source_projection.byte_size) errors.push('live projection byte size mismatch');
  } catch (error) { errors.push(error.message); }
  if (!Array.isArray(comments)) errors.push('live comments are not an array');
  const receipts = parseAppliedBoundaryReviewReceipts(comments || []);
  errors.push(...receipts.errors);
  const matchingReceipts = receipts.receipts.filter((receipt) => receipt.transition_id === row.transition_request?.transition_id);
  if (matchingReceipts.length > 1) errors.push('duplicate idempotency receipts found');
  return {
    ok: errors.length === 0,
    errors,
    issue_number: row.issue_number,
    body_sha256: bodyDigest(issue),
    comments_sha256: digest(comments || []),
    comments_count: Array.isArray(comments) ? comments.length : null,
    idempotency: { matching_receipts: matchingReceipts.length, safe_to_attempt: errors.length === 0 && matchingReceipts.length === 0 },
  };
}

function freshGetCas(plan, reader = null) {
  const getIssue = reader?.readIssue || ((number) => ghGet([`repos/${REPOSITORY}/issues/${number}`]));
  const getComments = reader?.readComments || readComments;
  const items = plan.proposal_rows.map((row) => {
    try {
      const issue = boundedRead(() => getIssue(row.issue_number), `#${row.issue_number} SourceNote`);
      const comments = boundedRead(() => getComments(row.issue_number), `#${row.issue_number} comments`);
      return validateFreshCas(row, issue, comments);
    } catch (error) {
      return { ok: false, errors: [error.message], issue_number: row.issue_number, body_sha256: null, comments_sha256: null, comments_count: null, idempotency: { matching_receipts: 0, safe_to_attempt: false } };
    }
  });
  return { items, ok: items.every((item) => item.ok), digest: digest(items) };
}

function buildOutput(plan, { applyEntered = false, auth = null, fresh = null } = {}) {
  const proposalRows = plan.proposal_rows.map((row) => ({ issue_number: row.issue_number, decision: row.decision, status: fresh ? (fresh.items.find((item) => item.issue_number === row.issue_number)?.ok ? 'fresh-cas-ok' : 'blocked') : 'not-started' }));
  const blockedLedger = plan.blocked_ledger.map((row) => ({ issue_number: row.issue_number, status: row.status, reason: row.reason }));
  const output = {
    schema_version: 'issue-1656-evidence-transition-executor.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    parent_issue: PARENT_ISSUE,
    upstream_issue: UPSTREAM_ISSUE,
    mode: applyEntered ? 'apply-gated-fresh-get-cas-only' : 'plan-only',
    apply_entered: applyEntered,
    authorization: auth ? { ...auth, parent_issue: PARENT_ISSUE, controller_issue: ISSUE, boundary_parent_issue: UPSTREAM_ISSUE } : { required: true, supplied: false },
    plan_digest: plan.canonical_digest,
    source_snapshot: plan.source_snapshot,
    counts: { total: EXPECTED_TOTAL, proposal: proposalRows.length, blocked: blockedLedger.length, execution_batch: fresh ? proposalRows.filter((row) => row.status === 'fresh-cas-ok').length : 0 },
    proposal_rows: proposalRows,
    blocked_ledger: blockedLedger,
    fresh_get_cas: fresh ? { ok: fresh.ok, digest: fresh.digest, items: fresh.items } : { performed: false },
    lock: { required: true, acquired: false, status: 'not-started', owner: null },
    journal: { required: true, status: 'not-started', entries: proposalRows.map((row) => ({ issue_number: row.issue_number, phase: 'pending', idempotent: true, possibly_performed: false, mutation_count: 0 })) },
    idempotency: { required: true, duplicate_writes_prevented: true, receipts_reconciled: Boolean(fresh), unknown_state_reconciled: false },
    crash_unknown: { fail_closed: true, status: 'not-entered', possibly_performed: false },
    write_operations: { ...ZERO_WRITES },
    execution: { evidence_stage: 'not-executed', boundary_stage: 'not-executed', separate_stages: true, live_writer_implemented: false },
  };
  output.ok = !fresh || fresh.ok;
  output.canonical_digest = digest(output);
  return output;
}

function run({ plan, apply = false, env = process.env, reader = null } = {}) {
  const input = validateInputPlan(plan);
  if (!input.ok) throw new Error(input.errors.join('; '));
  const planDigest = plan.canonical_digest;
  if (!apply) return buildOutput(plan);
  const auth = authorizationGate(env, planDigest);
  if (!auth.ok) throw new Error(auth.errors.join('; '));
  const fresh = freshGetCas(plan, reader);
  return buildOutput(plan, { applyEntered: true, auth, fresh });
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { plan: DEFAULT_PLAN, output: DEFAULT_OUTPUT, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--plan') args.plan = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--apply') args.apply = true;
    else if (argv[index] === '--help') args.help = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write('Usage: node scripts/issue-1656-evidence-transition-executor.js [--plan FILE] [--output FILE] [--apply]\n'); return 0; }
  const result = run({ plan: readJson(args.plan), apply: args.apply, env });
  if (args.output) fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: result.ok, mode: result.mode, plan_digest: result.plan_digest, counts: result.counts, write_operations: result.write_operations }, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, validateInputPlan, authorizationGate, validateFreshCas, freshGetCas, buildOutput, run, parseArgs, main };
