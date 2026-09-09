#!/usr/bin/env node
'use strict';

/* CLI for the read-only Issue #1656 dynamic boundary-review proposal plan. */

const fs = require('node:fs');
const path = require('node:path');
const {
  ISSUE,
  REPOSITORY,
  SOURCE_REF,
  EXPECTED_PENDING_COUNT,
  canonicalize,
  sha256,
  selectedPendingIssues,
  inventoryIndex,
  parseSelectedIssue,
  fetchSourceSnapshotForPlan,
  sourceMap,
  buildReviewPlan,
  validateReviewPlan,
  blockedPlan,
} = require('./lib/issue-1656-dynamic-boundary-review');

const DEFAULT_ISSUES = 'data/pilot/issue-1611/source-note-live.snapshot.json';
const DEFAULT_INVENTORY = 'data/pilot/issue-1656/pending-inventory.json';
const DEFAULT_SUMMARY = 'data/pilot/issue-1656/bundle-summary.json';
const DEFAULT_OUTPUT = 'data/pilot/issue-1656/dynamic-review-plan.json';
const DEFAULT_CAPTURED_AT = '2026-09-09T00:00:00.000Z';
const DEFAULT_CACHE_DIR = '/tmp/xhs-note-desc-cache';

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
    issues: DEFAULT_ISSUES,
    inventory: DEFAULT_INVENTORY,
    summary: DEFAULT_SUMMARY,
    sourceSnapshot: null,
    output: DEFAULT_OUTPUT,
    capturedAt: DEFAULT_CAPTURED_AT,
    cacheDir: DEFAULT_CACHE_DIR,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--issues') args.issues = argv[++index];
    else if (arg === '--inventory') args.inventory = argv[++index];
    else if (arg === '--summary') args.summary = argv[++index];
    else if (arg === '--source-snapshot') args.sourceSnapshot = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--captured-at') args.capturedAt = argv[++index];
    else if (arg === '--cache-dir') args.cacheDir = argv[++index];
    else if (arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && (!args.capturedAt || Number.isNaN(Date.parse(args.capturedAt)))) throw new Error('--captured-at must be an ISO timestamp');
  return args;
}

function issueRowsForFetch(issues, inventory) {
  const expected = inventoryIndex(inventory).byNumber;
  return selectedPendingIssues(issues).map((issue) => parseSelectedIssue(issue, expected.get(Number(issue.number))));
}

async function prepareSourceSnapshot(issues, inventory, provided, cacheDir = DEFAULT_CACHE_DIR) {
  if (provided) return provided;
  const rows = issueRowsForFetch(issues, inventory);
  return fetchSourceSnapshotForPlan({
    items: rows.map((row) => ({ issue_number: row.issue_number, source_note_id: row.source_note_id, source_projection: row.source_projection })),
  }, undefined, { cacheDir });
}

async function generate(args) {
  const issues = readJson(args.issues);
  const inventory = readJson(args.inventory);
  const summary = readJson(args.summary);
  let sourceSnapshot;
  try {
    sourceSnapshot = await prepareSourceSnapshot(issues, inventory, args.sourceSnapshot ? readJson(args.sourceSnapshot) : null, args.cacheDir);
  } catch (error) {
    const plan = blockedPlan([`source snapshot GET failed closed: ${error.message}`], args.capturedAt);
    writeJson(args.output, plan);
    return plan;
  }
  const plan = buildReviewPlan({ issueSnapshot: issues, sourceSnapshot, inventory, bundleSummary: summary, capturedAt: args.capturedAt });
  const validation = validateReviewPlan(plan, inventory);
  if (!validation.ok && plan.ok !== false) {
    plan.ok = false;
    plan.errors = validation.errors;
    plan.canonical_digest = sha256(canonicalize(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'canonical_digest'))));
  }
  writeJson(args.output, plan);
  return plan;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/issue-1656-dynamic-boundary-review.js [--issues FILE] [--source-snapshot FILE] [--cache-dir DIR] [--output FILE]\n');
    return 0;
  }
  const plan = await generate(args);
  process.stdout.write(`${JSON.stringify({
    ok: plan.ok !== false && plan.scope?.complete === true,
    repository: REPOSITORY,
    issue: ISSUE,
    pending: plan.scope?.total || 0,
    expected_pending: EXPECTED_PENDING_COUNT,
    source_ref: SOURCE_REF,
    canonical_digest: plan.canonical_digest,
    summary: plan.summary,
    mutation_guard: plan.mutation_guard,
    output: path.resolve(args.output),
  }, null, 2)}\n`);
  return plan.ok === false ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, issueRowsForFetch, prepareSourceSnapshot, generate, main, canonicalize, sha256, sourceMap };
