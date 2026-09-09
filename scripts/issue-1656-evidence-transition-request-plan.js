#!/usr/bin/env node
'use strict';

/* CLI for the read-only Issue #1656 evidence/transition request planner. */

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_PLAN,
  DEFAULT_ISSUES,
  DEFAULT_INVENTORY,
  DEFAULT_OUTPUT,
  DEFAULT_CAPTURED_AT,
  buildEvidenceTransitionPlan,
  validateEvidenceTransitionPlan,
} = require('./lib/issue-1656-evidence-transition-request-plan');

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function writeJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    plan: DEFAULT_PLAN,
    issues: DEFAULT_ISSUES,
    inventory: DEFAULT_INVENTORY,
    output: DEFAULT_OUTPUT,
    capturedAt: DEFAULT_CAPTURED_AT,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan') args.plan = argv[++index];
    else if (arg === '--issues') args.issues = argv[++index];
    else if (arg === '--inventory') args.inventory = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--captured-at') args.capturedAt = argv[++index];
    else if (arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && (!args.capturedAt || Number.isNaN(Date.parse(args.capturedAt)))) throw new Error('--captured-at must be an ISO timestamp');
  return args;
}

function generate(args) {
  const plan = readJson(args.plan);
  const issues = readJson(args.issues);
  const inventory = readJson(args.inventory);
  const result = buildEvidenceTransitionPlan({ reviewPlan: plan, issueSnapshot: issues, inventory, capturedAt: args.capturedAt });
  const validation = validateEvidenceTransitionPlan(result, plan);
  if (!validation.ok && result.ok === true) throw new Error(`generated request plan failed validation: ${validation.errors.join('; ')}`);
  writeJson(args.output, result);
  return result;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/issue-1656-evidence-transition-request-plan.js [--plan FILE] [--issues FILE] [--inventory FILE] [--output FILE]\n');
    return 0;
  }
  const result = generate(args);
  process.stdout.write(`${JSON.stringify({
    ok: result.ok === true,
    issue: result.issue,
    scope: result.scope,
    summary: result.summary,
    canonical_digest: result.canonical_digest,
    mutation_guard: result.mutation_guard,
    output: path.resolve(args.output),
  }, null, 2)}\n`);
  return result.ok === true ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, generate, main };
