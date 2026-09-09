#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const livePlan = require('./plan-issue-1611-live-materialization');
const { parseInterviewNoteIssue } = require('./lib/interview-note-issue');
const {
  REPOSITORY,
  RUNNER_SCHEMA,
  ZERO_WRITES,
  buildRunnerPlan,
  validateRunnerPlan,
  parseAuthorizationComment,
  atomicWriteJson,
  acquireExclusiveLock,
  initialJournal,
  validateJournal,
  updateJournal,
  applyOne,
  reconcileAlreadyMaterialized,
} = require('./lib/issue-1658-materialization-runner');

const DEFAULTS = Object.freeze({
  output: 'data/pilot/issue-1658/materialization.runner.plan.json',
  sourceOutput: 'data/pilot/issue-1658/source-note-live.snapshot.json',
  ownershipOutput: 'data/pilot/issue-1658/interview-note-ownership.inventory.json',
  boundaryReportOutput: 'data/pilot/issue-1658/live-boundary.materialization-report.json',
  boundaryManifestOutput: 'data/pilot/issue-1658/live-boundary.materialization-manifest.json',
  journal: 'data/pilot/issue-1658/materialization.journal.json',
  lock: 'data/pilot/issue-1658/materialization.lock',
});

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function ghGet(args) {
  const upper = args.map(String).map((arg) => arg.toUpperCase());
  if (upper.some((arg) => ['--METHOD', '--INPUT', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(arg))) throw new Error('runner GET helper refuses mutation-shaped GitHub calls');
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 30_000 }));
}

// Kept physically separate from ghGet and called only after runApply has
// passed the controller authorization, fresh-digest, lock, and journal gates.
function ghWrite(args, input) {
  return JSON.parse(execFileSync('gh', args, {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 30_000,
  }));
}

function readPagedComments(number) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = ghGet(['api', `repos/${REPOSITORY}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`Issue #${number} comments response was not an array`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error(`Issue #${number} comments reached the page bound`);
}

function findOwnershipMarker(issue, interviewNoteId) {
  const parsed = parseInterviewNoteIssue(issue && issue.body || '');
  return parsed.marker && parsed.marker.interview_note_id === interviewNoteId;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { ...DEFAULTS, apply: false, allowLiveGithub: false, authorizationCommentId: null, maxCreate: null, maxReceipts: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--allow-live-github') args.allowLiveGithub = true;
    else if (arg === '--authorization-comment-id') args.authorizationCommentId = Number(argv[++index]);
    else if (arg === '--max-create') args.maxCreate = Number(argv[++index]);
    else if (arg === '--max-receipts') args.maxReceipts = Number(argv[++index]);
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--source-output') args.sourceOutput = argv[++index];
    else if (arg === '--ownership-output') args.ownershipOutput = argv[++index];
    else if (arg === '--boundary-report-output') args.boundaryReportOutput = argv[++index];
    else if (arg === '--boundary-manifest-output') args.boundaryManifestOutput = argv[++index];
    else if (arg === '--journal') args.journal = argv[++index];
    else if (arg === '--lock') args.lock = argv[++index];
    else if (['--post', '--patch', '--create', '--label', '--method', '--source-notes-file'].includes(arg)) throw new Error(`${arg} is forbidden: #1658 runner requires a fresh GET-only re-plan`);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.apply && (!Number.isSafeInteger(args.authorizationCommentId) || !args.allowLiveGithub || !Number.isSafeInteger(args.maxCreate) || !Number.isSafeInteger(args.maxReceipts))) throw new Error('--apply requires --authorization-comment-id, --allow-live-github, --max-create, and --max-receipts');
  return args;
}

function freshReplan(args) {
  execFileSync(process.execPath, [path.resolve(__dirname, 'generate-issue-1611-interview-note-ownership-inventory.js'), '--output', args.ownershipOutput], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  livePlan.main([
    '--source-notes-output', args.sourceOutput,
    '--ownership-file', args.ownershipOutput,
    '--boundary-report-output', args.boundaryReportOutput,
    '--boundary-manifest-output', args.boundaryManifestOutput,
    '--output', args.output.replace(/\.json$/, '.upstream.json'),
  ]);
  return {
    sourceSnapshot: readJson(args.sourceOutput),
    boundaryReport: readJson(args.boundaryReportOutput),
    boundaryManifest: readJson(args.boundaryManifestOutput),
    ownershipInventory: readJson(args.ownershipOutput),
    materializationPlan: readJson(args.output.replace(/\.json$/, '.upstream.json')),
  };
}

function readOrCreateJournal(file, plan, maxCreate, maxReceipts, options = {}) {
  if (!fs.existsSync(path.resolve(file))) return initialJournal(plan, maxCreate, maxReceipts);
  const journal = readJson(file);
  const validation = validateJournal(journal, plan, maxCreate, maxReceipts);
  if (!validation.ok) throw new Error(`durable journal is not resumable: ${validation.errors.join('; ')}`);
  const receiptResume = options.allowReceiptPending === true
    && journal.status !== 'uncertain'
    && journal.items.every((item) => item.phase === 'pending' || item.phase === 'complete' || item.phase === 'receipt-pending');
  if (journal.status === 'uncertain' || (journal.possibly_performed && !receiptResume)) throw new Error('durable journal is uncertain; refusing blind retry');
  const interrupted = journal.items.filter((item) => item.phase !== 'pending' && item.phase !== 'complete' && !(receiptResume && item.phase === 'receipt-pending'));
  if (interrupted.length) throw new Error(`durable journal records attempted incomplete mutation(s): ${interrupted.map((item) => `${item.materialization_id}:${item.phase}`).join(', ')}; refusing duplicate create`);
  return journal;
}

function runApply(plan, args) {
  const validation = validateRunnerPlan(plan);
  if (!validation.ok) throw new Error(`apply is fail-closed: ${validation.errors.join('; ')}`);
  const lock = acquireExclusiveLock(args.lock, plan.plan_digest);
  try {
    const fresh = buildRunnerPlan(freshReplan(args));
    atomicWriteJson(args.output, fresh);
    if (fresh.plan_digest !== plan.plan_digest) throw new Error(`lock-held fresh re-plan digest changed: ${plan.plan_digest} != ${fresh.plan_digest}`);
    const freshValidation = validateRunnerPlan(fresh);
    if (!freshValidation.ok) throw new Error(`lock-held fresh re-plan is fail-closed: ${freshValidation.errors.join('; ')}`);
    const authComment = ghGet(['api', `repos/${REPOSITORY}/issues/comments/${args.authorizationCommentId}`]);
    const auth = parseAuthorizationComment(authComment, fresh, args);
    if (!auth.ok) throw new Error(`authorization is fail-closed: ${auth.errors.join('; ')}`);
    const journal = readOrCreateJournal(args.journal, fresh, args.maxCreate, args.maxReceipts);
    atomicWriteJson(args.journal, journal);
    const api = {
      plan: fresh,
      readIssue: (number) => ghGet(['api', `repos/${REPOSITORY}/issues/${number}`]),
      readComments: (number) => readPagedComments(number),
      readOwners: (interviewNoteId) => {
        const owners = [];
        for (let page = 1; page <= 100; page += 1) {
          const batch = ghGet(['api', `repos/${REPOSITORY}/issues?state=all&labels=type%3Ainterview-note&per_page=100&page=${page}`]);
          if (!Array.isArray(batch)) throw new Error('InterviewNote ownership page was not an array');
          owners.push(...batch.filter((issue) => !issue.pull_request && findOwnershipMarker(issue, interviewNoteId)));
          if (batch.length < 100) return owners;
        }
        throw new Error('InterviewNote ownership search reached the page bound');
      },
      createInterviewNote: (projection) => ghWrite(['api', '--method', 'POST', `repos/${REPOSITORY}/issues`, '--input', '-'], { title: projection.title, body: projection.body, labels: projection.labels }),
      addReceipt: (number, body) => ghWrite(['api', '--method', 'POST', `repos/${REPOSITORY}/issues/${number}/comments`, '--input', '-'], { body }),
    };
    const results = [];
    for (const planResult of fresh.results.filter((item) => item.action === 'already-materialized')) {
      results.push(reconcileAlreadyMaterialized({ planResult, api }));
    }
    for (const planResult of fresh.results.filter((item) => item.action === 'would-materialize')) {
      const journalItem = journal.items.find((item) => item.materialization_id === planResult.request.materialization_id);
      if (!journalItem || journalItem.phase === 'uncertain') throw new Error(`journal item is missing/uncertain for ${planResult.request.materialization_id}`);
      if (journalItem.phase === 'complete') continue;
      results.push(applyOne({ planResult, api, journalItem, journal, journalFile: args.journal, lock, maxCreate: args.maxCreate, maxReceipts: args.maxReceipts }));
    }
    journal.status = 'complete';
    const completedJournal = updateJournal(journal, args.journal, lock, fresh, args.maxCreate, args.maxReceipts);
    return { ok: true, mode: 'apply', plan_digest: fresh.plan_digest, results, mutation_performed: completedJournal.mutation_count > 0 };
  } finally { lock.release(); }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputs = freshReplan(args);
  const plan = buildRunnerPlan(inputs);
  atomicWriteJson(args.output, plan);
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify({ output: path.resolve(args.output), schema_version: RUNNER_SCHEMA, ok: plan.ok, ready_for_apply: plan.ready_for_apply, plan_digest: plan.plan_digest, counts: plan.counts, mutation_performed: false, write_operations: ZERO_WRITES, errors: plan.errors }, null, 2)}\n`);
    return plan.ok ? 0 : 1;
  }
  const result = runApply(plan, args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = { DEFAULTS, parseArgs, ghGet, readPagedComments, freshReplan, readOrCreateJournal, runApply, main };
