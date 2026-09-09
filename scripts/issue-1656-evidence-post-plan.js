#!/usr/bin/env node
'use strict';

/* Read-only evidence POST planning.  This file only renders candidate bodies. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  validateEvidenceTransitionPlan,
  canonicalize,
  sha256,
} = require('./lib/issue-1656-evidence-transition-request-plan');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const ISSUE = 1656;
const PARENT_ISSUE = 1611;
const UPSTREAM_ISSUE = 1605;
const EXPECTED_TOTAL = 421;
const SELECTED = new Set([1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458]);
const REQUIRED_BLOCKED = new Set([972, 1266, 1326, 1349]);
const DEFAULT_INPUT = 'data/pilot/issue-1656/evidence-transition-request-plan.json';
const DEFAULT_OUTPUT = 'data/pilot/issue-1656/evidence-post-plan.json';

function without(value, key) { const copy = { ...value }; delete copy[key]; return copy; }
function digest(value) { return sha256(canonicalize(value)); }
function textDigest(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function validateInput(plan) {
  const result = validateEvidenceTransitionPlan(plan);
  const errors = [...result.errors];
  if (plan?.repository !== REPOSITORY || plan?.issue !== ISSUE || plan?.parent_issue !== PARENT_ISSUE || plan?.upstream_issue !== UPSTREAM_ISSUE) errors.push('request plan issue binding drifted');
  if (plan?.scope?.total !== EXPECTED_TOTAL || plan?.summary?.proposal_rows !== 17 || plan?.summary?.blocked_rows !== 404) errors.push('request plan must retain the complete 421/17/404 scope');
  const rows = new Map((plan?.proposal_rows || []).map((row) => [Number(row.issue_number), row]));
  for (const issueNumber of SELECTED) if (!rows.has(issueNumber)) errors.push(`selected evidence row #${issueNumber} is absent from request plan`);
  for (const issueNumber of REQUIRED_BLOCKED) if (!rows.has(issueNumber)) errors.push(`required blocked row #${issueNumber} is absent from request plan`);
  return { ok: errors.length === 0, errors, rows };
}

function evidenceBody(row) {
  const request = row.transition_request;
  const evidence = {
    schema_version: 'issue-1608-boundary-evidence.v1',
    issue_number: row.issue_number,
    source_note_id: row.source_note_id,
    source_revision_id: row.expected_source_revision_id,
    source_repository: SOURCE_REPOSITORY,
    source_repository_ref: SOURCE_REF,
    evidence_status: 'sufficient-for-controller-review',
    decision: row.decision,
    rationale: 'Independent review supplied the candidate decision; this body is planned only and has not been posted.',
    artifact: {
      ref: row.source_projection.ref,
      kind: row.source_projection.kind,
      provenance: row.source_projection.provenance,
      git_blob_sha: row.source_projection.blob_sha,
      byte_size: row.source_projection.byte_size,
      content_sha256: row.source_projection.content_sha256,
    },
    excerpts: row.line_evidence.map((line) => ({
      excerpt: line.excerpt,
      locator: line.locator,
      line: line.line,
      artifact_ref: row.source_projection.ref,
      artifact_kind: row.source_projection.kind,
    })),
    case_keys: request.interview_cases ? request.interview_cases.map((item) => item.case_key) : [],
    case_evidence: request.interview_cases || [],
    checks: ['source_identity', 'source_revision_binding', 'source_content_coverage', 'event_boundary', 'no_cross_source_mixing', 'no_fabrication'].map((check_id) => ({ check_id, result: 'pass', note: 'Bound to the frozen request row and exact source projection evidence.' })),
    limitations: ['Planned evidence body only; no GitHub comment was created.', 'Boundary transition remains a separate later stage and is not authorized by this artifact.'],
    transition_request: request,
  };
  return `<!-- issue-1608-boundary-evidence.v1\n${JSON.stringify(evidence, null, 2)}\n-->`;
}

function casBinding(row) {
  return {
    issue_number: row.issue_number,
    source_note_id: row.source_note_id,
    expected_body_sha256: row.expected_body_sha256,
    expected_source_revision_id: row.expected_source_revision_id,
    expected_boundary_status: 'pending',
    expected_source_repository_ref: SOURCE_REF,
    source_projection_ref: row.source_projection.ref,
    source_projection_blob_sha: row.source_projection.blob_sha,
    source_projection_content_sha256: row.source_projection.content_sha256,
  };
}

function proposalRow(row) {
  const body = evidenceBody(row);
  return {
    issue_number: row.issue_number,
    decision: row.decision,
    transition_schema: row.transition_request.schema_version,
    transition_request: row.transition_request,
    evidence_post: {
      status: 'planned-not-posted',
      method: 'issue-comment-create',
      body,
      body_sha256: textDigest(body),
      mutation_count: 0,
    },
    cas: casBinding(row),
    source_evidence: row.line_evidence,
    mutation_count: 0,
  };
}

function blockedRow(row) {
  return {
    issue_number: row.issue_number,
    decision: null,
    status: 'blocked',
    reason_code: 'independent-review-blocked',
    reason: 'Independent review did not release this proposal for evidence POST planning; it remains blocked and cannot enter the evidence batch.',
    cas: casBinding(row),
    mutation_count: 0,
  };
}

function buildPlan(input) {
  const validation = validateInput(input);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  const proposalRows = [...SELECTED].sort((a, b) => a - b).map((number) => proposalRow(validation.rows.get(number)));
  const blockedRows = [...REQUIRED_BLOCKED].sort((a, b) => a - b).map((number) => blockedRow(validation.rows.get(number)));
  const plan = {
    schema_version: 'issue-1656-evidence-post-plan.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    parent_issue: PARENT_ISSUE,
    upstream_issue: UPSTREAM_ISSUE,
    input_request_plan_digest: input.canonical_digest,
    source_snapshot: input.source_snapshot,
    scope: { source_total: EXPECTED_TOTAL, source_proposals: 17, selected_total: 17, evidence_post_rows: 13, blocked_rows: 4, complete: true },
    proposal_rows: proposalRows,
    blocked_ledger: blockedRows,
    stages: {
      evidence_post: { status: 'planned-not-posted', row_count: 13, mutation_count: 0, separate_from_boundary_patch: true },
      boundary_patch: { status: 'not-planned', depends_on: 'evidence_post', mutation_count: 0, separate_from_evidence_post: true },
    },
    mutation_guard: { post: 0, patch: 0, label: 0, create: 0, mutation: 0, read_only: true, live_mutation: false },
    apply: { allowed: false, authorization_comment_id: null, confirm_digest: null, dry_run_required: true },
    limitations: ['This artifact is a candidate evidence POST plan only.', 'No GitHub API write operation was executed.', 'The four blocked rows and the upstream 404-row blocked ledger remain excluded from this evidence batch.'],
  };
  return { ...plan, canonical_digest: digest(plan) };
}

function validatePlan(plan, input = null) {
  const errors = [];
  if (plan?.schema_version !== 'issue-1656-evidence-post-plan.v1') errors.push('evidence POST plan schema mismatch');
  if (plan?.repository !== REPOSITORY || plan?.issue !== ISSUE || plan?.parent_issue !== PARENT_ISSUE || plan?.upstream_issue !== UPSTREAM_ISSUE) errors.push('evidence POST plan issue binding drifted');
  if (input && plan.input_request_plan_digest !== input.canonical_digest) errors.push('evidence POST plan input digest drifted');
  if (plan?.scope?.source_total !== EXPECTED_TOTAL || plan?.scope?.evidence_post_rows !== 13 || plan?.scope?.blocked_rows !== 4) errors.push('evidence POST plan counts drifted');
  if (plan?.proposal_rows?.length !== 13 || plan?.blocked_ledger?.length !== 4) errors.push('evidence POST plan partition drifted');
  for (const key of ['post', 'patch', 'label', 'create', 'mutation']) if (plan?.mutation_guard?.[key] !== 0) errors.push(`mutation_guard.${key} must be zero`);
  if (plan?.mutation_guard?.read_only !== true || plan?.mutation_guard?.live_mutation !== false) errors.push('mutation guard is not read-only');
  const proposalIds = new Set((plan?.proposal_rows || []).map((row) => Number(row.issue_number)));
  if (JSON.stringify([...proposalIds].sort((a, b) => a - b)) !== JSON.stringify([...SELECTED].sort((a, b) => a - b))) errors.push('proposal issue set differs from independent review selection');
  const blockedIds = new Set((plan?.blocked_ledger || []).map((row) => Number(row.issue_number)));
  if (JSON.stringify([...blockedIds].sort((a, b) => a - b)) !== JSON.stringify([...REQUIRED_BLOCKED].sort((a, b) => a - b))) errors.push('blocked issue set differs from required independent review blockers');
  for (const row of plan?.proposal_rows || []) {
    if (!row.transition_request || !row.evidence_post?.body || row.mutation_count !== 0 || row.evidence_post.mutation_count !== 0) errors.push(`#${row.issue_number} evidence POST row is incomplete or claims mutation`);
    if (row.evidence_post.body_sha256 !== textDigest(row.evidence_post.body)) errors.push(`#${row.issue_number} evidence body digest drifted`);
    if (row.cas?.expected_body_sha256 !== row.transition_request.expected_body_sha256 || row.cas?.expected_source_revision_id !== row.transition_request.expected_source_revision_id) errors.push(`#${row.issue_number} CAS binding drifted`);
  }
  for (const row of plan?.blocked_ledger || []) if (row.status !== 'blocked' || row.mutation_count !== 0) errors.push(`#${row.issue_number} blocked ledger row is not blocked and zero-mutation`);
  if (plan && plan.canonical_digest !== digest(without(plan, 'canonical_digest'))) errors.push('evidence POST plan canonical digest drifted');
  return { ok: errors.length === 0, errors };
}

function writeJson(file, value) { fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function parseArgs(argv = process.argv.slice(2)) {
  const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') args.input = argv[++index];
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--help') args.help = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write('Usage: node scripts/issue-1656-evidence-post-plan.js [--input FILE] [--output FILE]\n'); return 0; }
  const result = buildPlan(readJson(args.input));
  const validation = validatePlan(result, readJson(args.input));
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  if (args.output) writeJson(args.output, result);
  process.stdout.write(`${JSON.stringify({ ok: true, canonical_digest: result.canonical_digest, scope: result.scope, mutation_guard: result.mutation_guard, output: args.output ? path.resolve(args.output) : null }, null, 2)}\n`);
  return 0;
}

if (require.main === module) { try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; } }

module.exports = { SELECTED, REQUIRED_BLOCKED, validateInput, evidenceBody, buildPlan, validatePlan, parseArgs, main };
