#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { paginateInterviewNotes, buildInventory } = require('./generate-issue-1611-interview-note-ownership-inventory');
const { parseInterviewNoteIssue } = require('./lib/interview-note-issue');
const { issueSourceRecord } = require('./lib/interview-note-materialization-batch');
const {
  REPOSITORY, PLAN_SCHEMA, RUNNER_SCHEMA, AUTH_MARKER, ZERO_WRITES, runnerDigestInput,
  validateBoundedInputPlan, validateBoundedAuthorizationComment,
  buildBoundedRunnerPlan, validateBoundedRunnerPlan,
} = require('./lib/issue-1658-bounded-materialization-runner');
const {
  ghGet, readPagedComments, readOrCreateJournal,
} = require('./issue-1658-materialization-runner');
const {
  atomicWriteJson, acquireExclusiveLock, initialJournal, updateJournal, applyOne,
} = require('./lib/issue-1658-materialization-runner');

const DEFAULTS = Object.freeze({
  planFile: '/tmp/materialization-13-plan.bound.json',
  output: 'data/pilot/issue-1658/materialization-13.runner.plan.json',
  sourceOutput: 'data/pilot/issue-1658/materialization-13.source.snapshot.json',
  ownershipOutput: 'data/pilot/issue-1658/materialization-13.ownership.inventory.json',
  journal: 'data/pilot/issue-1658/materialization-13.journal.json',
  lock: 'data/pilot/issue-1658/materialization-13.lock',
  authorizationCommentId: 5602915668,
});

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function readExistingJournal(file) {
  return fs.existsSync(path.resolve(file)) ? readJson(file) : null;
}

function resumeBoundedResults(plan, journal) {
  const completed = new Set((journal && journal.items || []).filter((item) => item.phase === 'complete').map((item) => item.materialization_id));
  return (plan && plan.results || []).filter((result) => !completed.has(result.request.materialization_id));
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { ...DEFAULTS, apply: false, allowLiveGithub: false, maxCreate: null, maxReceipts: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--allow-live-github') args.allowLiveGithub = true;
    else if (arg === '--plan-file' || arg === '--input-plan') args.planFile = argv[++index];
    else if (arg === '--authorization-comment-id') args.authorizationCommentId = Number(argv[++index]);
    else if (arg === '--max-create') args.maxCreate = Number(argv[++index]);
    else if (arg === '--max-receipts') args.maxReceipts = Number(argv[++index]);
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--source-output') args.sourceOutput = argv[++index];
    else if (arg === '--ownership-output') args.ownershipOutput = argv[++index];
    else if (arg === '--journal') args.journal = argv[++index];
    else if (arg === '--lock') args.lock = argv[++index];
    else if (['--post', '--patch', '--create', '--label', '--method', '--source-notes-file'].includes(arg)) throw new Error(`${arg} is forbidden: bounded runner is GET-only unless explicit --apply passes every gate`);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.apply && (!args.allowLiveGithub || args.maxCreate !== 13 || args.maxReceipts !== 13)) throw new Error('--apply requires --allow-live-github, --max-create 13, and --max-receipts 13');
  return args;
}

function freshOwnershipIssues() {
  return paginateInterviewNotes(REPOSITORY, (page) => ghGet(['api', `repos/${REPOSITORY}/issues?state=all&labels=type%3Ainterview-note&per_page=100&page=${page}`]));
}

function freshSourceIssue(number) {
  return ghGet(['api', `repos/${REPOSITORY}/issues/${number}`]);
}

function freshBoundedReplan(args, inputPlan) {
  const sourceRows = new Map();
  for (const row of inputPlan.rows) {
    const number = Number(row.request.source_note_issue_number);
    const issue = freshSourceIssue(number);
    const comments = readPagedComments(number);
    sourceRows.set(number, { issue, comments });
  }
  const ownershipIssues = freshOwnershipIssues();
  const ownershipInventory = buildInventory(ownershipIssues, REPOSITORY);
  const sourceSnapshotInput = {
    schema_version: 'issue-1658-bounded-source-note-snapshot.v1',
    repository: REPOSITORY,
    count: sourceRows.size,
    issues: [...sourceRows.values()].map(({ issue }) => {
      const parsed = issueSourceRecord(issue).parsed;
      return { number: Number(issue.number), body_sha256: require('./lib/aggregate-downstream-pipeline').sha256Text(issue.body || ''), source_note_id: parsed && parsed.source_note_id || null, source_revision_id: parsed && parsed.source_revision && parsed.source_revision.id || null, boundary_status: parsed && parsed.boundary_review && parsed.boundary_review.status || null };
    }).sort((a, b) => a.number - b.number),
  };
  sourceSnapshotInput.canonical_digest = require('./lib/aggregate-downstream-pipeline').canonicalDigest(sourceSnapshotInput);
  atomicWriteJson(args.sourceOutput, sourceSnapshotInput);
  atomicWriteJson(args.ownershipOutput, ownershipInventory);
  return { sourceRows, ownershipIssues, ownershipInventory };
}

function readAuthorization(args, inputPlan) {
  if (!Number.isSafeInteger(args.authorizationCommentId)) return { ok: false, errors: ['authorization comment id is required'], marker: null };
  const comment = ghGet(['api', `repos/${REPOSITORY}/issues/comments/${args.authorizationCommentId}`]);
  return validateBoundedAuthorizationComment(comment, inputPlan, { authorizationCommentId: args.authorizationCommentId, maxCreate: args.maxCreate ?? 13, maxReceipts: args.maxReceipts ?? 13 });
}

function applyBounded(plan, inputPlan, args) {
  const validation = validateBoundedRunnerPlan(plan);
  if (!validation.ok) throw new Error(`bounded apply is fail-closed: ${validation.errors.join('; ')}`);
  const lock = acquireExclusiveLock(args.lock, plan.plan_digest);
  try {
    const existingJournal = readExistingJournal(args.journal);
    const fresh = freshBoundedReplan(args, inputPlan);
    const freshPlan = buildBoundedRunnerPlan({ inputPlan, freshRows: fresh.sourceRows, freshOwnershipIssues: fresh.ownershipIssues, journal: existingJournal });
    atomicWriteJson(args.output, freshPlan);
    if (freshPlan.plan_digest !== plan.plan_digest) throw new Error(`lock-held fresh bounded plan digest changed: ${plan.plan_digest} != ${freshPlan.plan_digest}`);
    const auth = readAuthorization(args, inputPlan);
    if (!auth.ok) throw new Error(`authorization is fail-closed: ${auth.errors.join('; ')}`);
    const journal = readOrCreateJournal(args.journal, freshPlan, 13, 13, { allowReceiptPending: true, allowBoundedResume: existingJournal != null });
    atomicWriteJson(args.journal, journal);
    const api = {
      plan: freshPlan,
      readIssue: (number) => freshSourceIssue(number),
      readComments: (number) => readPagedComments(number),
      readOwners: (interviewNoteId) => {
        const issues = freshOwnershipIssues();
        return issues.filter((issue) => {
          const parsed = parseInterviewNoteIssue(issue.body || '');
          return parsed.marker && parsed.marker.interview_note_id === interviewNoteId;
        });
      },
      createInterviewNote: (projection) => {
        return JSON.parse(execFileSync('gh', ['api', '--method', 'POST', `repos/${REPOSITORY}/issues`, '--input', '-'], { input: JSON.stringify({ title: projection.title, body: projection.body, labels: projection.labels }), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 30_000 }));
      },
      addReceipt: (number, body) => JSON.parse(execFileSync('gh', ['api', '--method', 'POST', `repos/${REPOSITORY}/issues/${number}/comments`, '--input', '-'], { input: JSON.stringify({ body }), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 30_000 })),
    };
    const results = [];
    for (const planResult of resumeBoundedResults(freshPlan, journal)) {
      const item = journal.items.find((candidate) => candidate.materialization_id === planResult.request.materialization_id);
      if (item && item.phase === 'complete') continue;
      if (planResult.action === 'already-materialized') {
        results.push({ materialization_id: planResult.request.materialization_id, request_sha256: planResult.request_sha256, interview_note_id: planResult.derived_interview_note_id, interview_issue_number: planResult.existing_issue_number, action: 'already-materialized', mutation_performed: false });
        continue;
      }
      if (!item) throw new Error(`journal item is missing for ${planResult.request.materialization_id}`);
      results.push(applyOne({ planResult, api, journalItem: item, journal, journalFile: args.journal, lock, maxCreate: 13, maxReceipts: 13, allowReceiptResume: true }));
    }
    journal.status = 'complete';
    const completed = updateJournal(journal, args.journal, lock, freshPlan, 13, 13);
    return { ok: true, mode: 'bounded-apply', plan_digest: freshPlan.plan_digest, results, mutation_performed: completed.mutation_count > 0 };
  } finally {
    lock.release();
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputPlan = readJson(args.planFile);
  const inputValidation = validateBoundedInputPlan(inputPlan);
  if (!inputValidation.ok) throw new Error(`bounded input plan is invalid: ${inputValidation.errors.join('; ')}`);
  if (!args.apply) {
    // The default mode is deliberately offline with respect to the 1460-row
    // planner. It still reads the explicitly named authorization comment, but
    // leaves the 13 SourceNote/ownership CAS reads to the gated apply path.
    const plan = buildBoundedRunnerPlan({ inputPlan });
    const auth = readAuthorization(args, inputPlan);
    const outputPlan = auth.ok ? plan : { ...plan, authorization: { ok: false, errors: auth.errors }, errors: [...plan.errors, ...auth.errors.map((error) => `authorization: ${error}`)], ok: false, ready_for_apply: false };
    outputPlan.plan_digest = require('./lib/aggregate-downstream-pipeline').canonicalDigest(runnerDigestInput(outputPlan));
    atomicWriteJson(args.output, outputPlan);
    process.stdout.write(`${JSON.stringify({ output: path.resolve(args.output), schema_version: RUNNER_SCHEMA, input_plan_schema: PLAN_SCHEMA, ok: outputPlan.ok, ready_for_apply: outputPlan.ready_for_apply, plan_digest: outputPlan.plan_digest, input_plan_digest: inputPlan.plan_digest, counts: outputPlan.counts, mutation_performed: false, write_operations: ZERO_WRITES, errors: outputPlan.errors }, null, 2)}\n`);
    return outputPlan.ok ? 0 : 1;
  }
  const existingJournal = readExistingJournal(args.journal);
  const fresh = freshBoundedReplan(args, inputPlan);
  const plan = buildBoundedRunnerPlan({ inputPlan, freshRows: fresh.sourceRows, freshOwnershipIssues: fresh.ownershipIssues, journal: existingJournal });
  const auth = readAuthorization(args, inputPlan);
  const outputPlan = auth.ok ? plan : { ...plan, authorization: { ok: false, errors: auth.errors }, errors: [...plan.errors, ...auth.errors.map((error) => `authorization: ${error}`)], ok: false, ready_for_apply: false };
  outputPlan.plan_digest = require('./lib/aggregate-downstream-pipeline').canonicalDigest(runnerDigestInput(outputPlan));
  atomicWriteJson(args.output, outputPlan);
  process.stdout.write(`${JSON.stringify(applyBounded(outputPlan, inputPlan, args), null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = { DEFAULTS, parseArgs, freshBoundedReplan, readAuthorization, applyBounded, readExistingJournal, resumeBoundedResults, main };
