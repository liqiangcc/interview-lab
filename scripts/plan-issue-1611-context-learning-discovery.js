#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildPlan, validatePlan, SCHEMA_VERSION } = require('./lib/issue-1611-context-learning-plan');

const DEFAULTS = Object.freeze({
  boundaryReport: 'data/pilot/issue-1605/boundary-transition-report.json',
  materializationPlan: 'data/pilot/issue-1605/materialization.dry-run.json',
  sourceReviewReceipts: 'data/pilot/issue-1611/source-review.receipts.json',
  contextReport: 'data/pilot/issue-1611/new-context.projections.json',
  liveIssueSnapshot: 'data/pilot/issue-1611/live-interview-note-snapshot.json',
  ownershipInventory: 'data/pilot/issue-1611/interview-note-ownership-inventory.json',
  output: 'data/pilot/issue-1611/context-learning.plan.json',
});

function parseArgs(argv = process.argv.slice(2)) {
  const args = { ...DEFAULTS };
  const names = {
    '--boundary-report': 'boundaryReport',
    '--materialization-plan': 'materializationPlan',
    '--source-review-receipts': 'sourceReviewReceipts',
    '--context-report': 'contextReport',
    '--live-issue-snapshot': 'liveIssueSnapshot',
    '--ownership-inventory': 'ownershipInventory',
    '--output': 'output',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply' || arg === '--method' || arg === '--patch' || arg === '--post') throw new Error(`${arg} is forbidden: Context/learning planner is plan-only`);
    if (!names[arg]) throw new Error(`unknown argument: ${arg}`);
    args[names[arg]] = argv[++index];
    if (!args[names[arg]]) throw new Error(`${arg} requires a path`);
  }
  return args;
}

function readOptional(file) {
  if (!file || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { __read_error: `cannot read ${file}: ${error.message}` }; }
}

function writeAtomic(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const boundaryReport = readOptional(args.boundaryReport);
  const materializationPlan = readOptional(args.materializationPlan);
  const sourceReviewReceipts = readOptional(args.sourceReviewReceipts);
  const contextReport = readOptional(args.contextReport);
  const liveIssueSnapshot = readOptional(args.liveIssueSnapshot);
  const interviewNoteOwnershipInventory = readOptional(args.ownershipInventory);
  const result = buildPlan({
    boundaryReport,
    materializationPlan,
    sourceReviewReceipts,
    contextReport,
    liveIssueSnapshot,
    interviewNoteOwnershipInventory,
    paths: args,
  });
  const validation = validatePlan(result.plan);
  if (!validation.ok) throw new Error(`generated Context/learning plan failed its own validator: ${validation.errors.join('; ')}`);
  writeAtomic(args.output, result.plan);
  process.stdout.write(`${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    output: path.resolve(args.output),
    ok: result.ok,
    candidate_count: result.plan.summary.candidate_count,
    materialization_pending: result.plan.summary.materialization_pending,
    source_review_ready: result.plan.summary.source_review_ready,
    context_ready: result.plan.summary.context_ready,
    learning_projectable: result.plan.summary.learning_projectable,
    blocked_candidate_count: result.plan.summary.blocked_candidate_count,
    blocked_prerequisite_count: result.plan.summary.blocked_prerequisite_count,
    mutation_performed: result.plan.mutation_performed,
    write_operations: result.plan.write_operations,
    canonical_digest: result.plan.canonical_digest,
  }, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { DEFAULTS, parseArgs, readOptional, writeAtomic, main };
