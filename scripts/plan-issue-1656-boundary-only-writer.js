#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  applyPlan,
  buildPlanOnly,
  createFakeApi,
} = require('./lib/issue-1656-boundary-only-writer');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PLAN = path.join(ROOT, 'data/pilot/issue-1656/boundary-transition.plan.json');
const DEFAULT_OUTPUT = path.join(ROOT, 'data/pilot/issue-1656/boundary-only-writer.plan.json');

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const planPath = valueAfter(args, '--plan') || DEFAULT_PLAN;
  const outputPath = valueAfter(args, '--output') || DEFAULT_OUTPUT;
  const plan = readJson(planPath);

  if (!args.includes('--apply')) {
    const report = buildPlanOnly(plan);
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const statePath = valueAfter(args, '--fake-state');
  const authPath = valueAfter(args, '--authorization');
  if (!statePath || !authPath) throw new Error('apply requires --fake-state and --authorization');
  const journalPath = valueAfter(args, '--journal') || path.join(ROOT, 'data/pilot/issue-1656/boundary-only-writer.journal.json');
  const lockPath = valueAfter(args, '--lock') || `${journalPath}.lock`;
  const report = await applyPlan({
    plan,
    api: createFakeApi(readJson(statePath)),
    authorization: readJson(authPath),
    ceiling: Number(valueAfter(args, '--ceiling')),
    digest: valueAfter(args, '--digest'),
    journalPath,
    lockPath,
  });
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`boundary-only-writer: ${error.message}\n`);
  process.exitCode = 1;
});
