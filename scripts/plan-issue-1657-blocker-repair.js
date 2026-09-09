#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { planIssue1657BlockerRepair } = require('./lib/issue-1657-blocker-repair-plan');

const DEFAULTS = Object.freeze({
  source: 'data/pilot/issue-1611/source-note-live.snapshot.json',
  ownership: 'data/pilot/issue-1611/interview-note-ownership.inventory.json',
  materialization: 'data/pilot/issue-1611/materialization.live.dry-run.json',
  boundaryReport: 'data/pilot/issue-1611/live-boundary.materialization-report.json',
  boundaryTransitionReport: 'data/pilot/issue-1605/boundary-transition-report.json',
  receipts: 'data/pilot/issue-1657/owner-receipt-audit.snapshot.json',
  liveAudit: 'data/pilot/issue-1657/live-reaudit.snapshot.json',
  output: 'data/pilot/issue-1657/blocker-repair.plan.json',
});

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function parseArgs(argv = process.argv.slice(2)) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') args.source = argv[++index];
    else if (arg === '--ownership') args.ownership = argv[++index];
    else if (arg === '--materialization') args.materialization = argv[++index];
    else if (arg === '--boundary-report') args.boundaryReport = argv[++index];
    else if (arg === '--boundary-transition-report') args.boundaryTransitionReport = argv[++index];
    else if (arg === '--receipts') args.receipts = argv[++index];
    else if (arg === '--live-audit') args.liveAudit = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (['--apply', '--patch', '--post', '--label', '--create', '--interview-note'].includes(arg)) throw new Error(`${arg} is forbidden: Issue #1657 planner is read-only and plan-only`);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function atomicWrite(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const plan = planIssue1657BlockerRepair({
    sourceSnapshot: readJson(args.source),
    ownershipInventory: readJson(args.ownership),
    materializationPlan: readJson(args.materialization),
    boundaryReport: readJson(args.boundaryReport),
    boundaryTransitionReport: readJson(args.boundaryTransitionReport),
    receiptSnapshot: readJson(args.receipts),
    liveAuditSnapshot: readJson(args.liveAudit),
  });
  atomicWrite(args.output, plan);
  process.stdout.write(`${JSON.stringify({
    output: path.resolve(args.output), ok: plan.ok, plan_digest: plan.plan_digest,
    target_count: plan.target_count, blocked_count: plan.blocked_count,
    mutation_performed: false, write_operations: plan.write_operations, errors: plan.errors,
  }, null, 2)}\n`);
  return plan.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = { DEFAULTS, parseArgs, atomicWrite, main };
