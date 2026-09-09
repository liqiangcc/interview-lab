#!/usr/bin/env node
'use strict';

/*
 * Read-only validator for the Issue #1656 pending-boundary bundle.
 *
 * This file deliberately has no GitHub client and no output writer.  It
 * validates a captured GET-only inventory and its per-issue request records;
 * a future live generator may use the same canonical contract, but this
 * command cannot accidentally turn a plan into an apply.
 */

const fs = require('node:fs');
const path = require('node:path');
const { canonicalize, sha256Text, PENDING_LABELS, SOURCE_REF } = require('./lib/issue-1605-pending-inventory');

const DEFAULT_DIR = 'data/pilot/issue-1656';
const EXPECTED_COUNT = 421;
const EXPECTED_BATCH_COUNTS = Object.freeze({ A: 86, B: 18, C: 146, D: 171 });
const EXPECTED_INVENTORY_DIGEST = '5ff56a51e3f430020c761239ba5706d4f3c413327c97fb02e1ad4f1a7c901400';
const EXPECTED_REQUEST_PLAN_DIGEST = 'db1a6ba2a7c31f54d2fa872faa62e7b44ecc41dba69ce8142d63303af8f93eb6';
const EXPECTED_BUNDLE_DIGEST = '251f9976e7e019ebdf71a22451d9c0b5a2ead43d6dbc483bf8a881fbafa2306c';
const EXPECTED_UPSTREAM_DIGEST = '67d848cf88be634d8137cc5ad13798e6d745f87ec19d770e0947be9dd724bb55';

function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function requestBodyFromPlanRecord(record) {
  const request = { ...record };
  delete request.request_file;
  delete request.request_sha256;
  return request;
}

function batchFor(number) {
  if (number >= 20 && number <= 392) return 'A';
  if (number >= 393 && number <= 765) return 'B';
  if (number >= 766 && number <= 1138) return 'C';
  if (number >= 1139 && number <= 1508) return 'D';
  return null;
}

function validateBundle(directory = DEFAULT_DIR) {
  const root = path.resolve(directory);
  const errors = [];
  const add = (message) => errors.push(message);
  let summary;
  let inventory;
  let requestPlan;
  try { summary = readJson(path.join(root, 'bundle-summary.json')); }
  catch (error) { add(`bundle-summary.json: ${error.message}`); }
  try { inventory = readJson(path.join(root, 'pending-inventory.json')); }
  catch (error) { add(`pending-inventory.json: ${error.message}`); }
  try { requestPlan = readJson(path.join(root, 'request-plan.json')); }
  catch (error) { add(`request-plan.json: ${error.message}`); }
  if (!summary || !inventory || !requestPlan) return { ok: false, errors };

  if (summary.schema_version !== 'issue-1656-boundary-plan-bundle.v1') add('summary schema mismatch');
  if (summary.inventory_digest !== inventory.canonical_digest) add('summary inventory digest binding mismatch');
  if (summary.request_plan_digest !== requestPlan.canonical_digest) add('summary request plan digest binding mismatch');
  if (summary.request_count !== EXPECTED_COUNT) add(`summary request_count must be ${EXPECTED_COUNT}`);
  for (const key of ['mutation_count', 'patch_count', 'post_count', 'label_write_count', 'interview_note_write_count']) {
    if (summary[key] !== 0) add(`summary ${key} must be zero`);
  }
  if (sha256Text(canonicalize(without(summary, 'bundle_digest'))) !== summary.bundle_digest) add('summary bundle_digest does not match content');
  if (summary.bundle_digest !== EXPECTED_BUNDLE_DIGEST) add('summary bundle_digest is not the approved captured bundle');

  if (inventory.schema_version !== 'issue-1656-boundary-pending-inventory.v1') add('inventory schema mismatch');
  if (inventory.repository !== 'liqiangcc/interview-lab' || inventory.issue !== 1656 || inventory.parent_issue !== 1611) add('inventory repository/issue/parent binding mismatch');
  if (inventory.source_ref !== SOURCE_REF) add('inventory source ref mismatch');
  if (inventory.upstream?.materialization_plan_digest !== EXPECTED_UPSTREAM_DIGEST) add('inventory upstream materialization digest mismatch');
  if (inventory.scope?.boundary_label !== 'boundary:pending') add('inventory boundary label mismatch');
  if (inventory.scope?.total !== EXPECTED_COUNT || inventory.items?.length !== EXPECTED_COUNT) add(`inventory must contain exactly ${EXPECTED_COUNT} rows`);
  if (sha256Text(canonicalize(without(inventory, 'canonical_digest'))) !== inventory.canonical_digest) add('inventory canonical_digest does not match content');
  if (inventory.canonical_digest !== EXPECTED_INVENTORY_DIGEST) add('inventory canonical_digest is not the approved captured inventory');
  if (inventory.mutation_guard?.read_only !== true || inventory.mutation_guard?.live_mutation !== false) add('inventory mutation guard is not read-only');
  for (const key of ['patch_count', 'post_count', 'label_write_count', 'interview_note_write_count']) {
    if (inventory.mutation_guard?.[key] !== 0) add(`inventory mutation_guard.${key} must be zero`);
  }

  const inventoryByIssue = new Map();
  const actualBatches = { A: 0, B: 0, C: 0, D: 0 };
  for (const item of inventory.items || []) {
    const number = Number(item.issue_number);
    if (!Number.isSafeInteger(number)) { add('inventory contains a non-integer issue number'); continue; }
    if (inventoryByIssue.has(number)) add(`inventory duplicates #${number}`);
    inventoryByIssue.set(number, item);
    const batch = batchFor(number);
    if (!batch) add(`#${number} is outside the frozen boundary ranges`);
    else actualBatches[batch] += 1;
    for (const label of PENDING_LABELS) if (!item.labels?.includes(label)) add(`#${number} is missing ${label}`);
    if (item.state !== 'open') add(`#${number} is not open`);
    if (item.source_revision?.source_repository_ref !== SOURCE_REF) add(`#${number} SourceRevision ref drifted`);
  }
  for (const [batch, expected] of Object.entries(EXPECTED_BATCH_COUNTS)) {
    if (actualBatches[batch] !== expected || inventory.scope?.batch_counts?.[batch] !== expected) add(`batch ${batch} count must be ${expected}`);
  }

  if (requestPlan.schema_version !== 'issue-1656-boundary-review-request-plan.v1') add('request plan schema mismatch');
  if (requestPlan.repository !== inventory.repository || requestPlan.issue !== 1656 || requestPlan.parent_issue !== 1611) add('request plan repository/issue/parent binding mismatch');
  if (requestPlan.inventory_digest !== inventory.canonical_digest) add('request plan inventory digest binding mismatch');
  if (requestPlan.upstream_materialization_plan_digest !== EXPECTED_UPSTREAM_DIGEST) add('request plan upstream digest mismatch');
  if (requestPlan.scope?.request_count !== EXPECTED_COUNT || requestPlan.requests?.length !== EXPECTED_COUNT) add(`request plan must contain exactly ${EXPECTED_COUNT} requests`);
  if (requestPlan.authorization?.authorized !== false || requestPlan.authorization?.allow_live_github !== false) add('request plan authorization must be false');
  for (const key of ['patch_count', 'post_count', 'label_write_count', 'interview_note_write_count']) {
    if (requestPlan.mutation_guard?.[key] !== 0) add(`request plan mutation_guard.${key} must be zero`);
  }
  if (sha256Text(canonicalize(without(requestPlan, 'canonical_digest'))) !== requestPlan.canonical_digest) add('request plan canonical_digest does not match content');
  if (requestPlan.canonical_digest !== EXPECTED_REQUEST_PLAN_DIGEST) add('request plan canonical_digest is not the approved captured plan');

  const requestIssues = new Set();
  for (const record of requestPlan.requests || []) {
    const number = Number(record.issue_number);
    if (requestIssues.has(number)) add(`request plan duplicates #${number}`);
    requestIssues.add(number);
    const inventoryItem = inventoryByIssue.get(number);
    if (!inventoryItem) { add(`request #${number} is outside inventory`); continue; }
    if (record.source_note_id !== inventoryItem.source_note_id) add(`#${number} request SourceNote binding drifted`);
    if (record.expected_body_sha256 !== inventoryItem.body_sha256) add(`#${number} request body binding drifted`);
    if (record.expected_source_revision_id !== inventoryItem.source_revision?.id) add(`#${number} request SourceRevision binding drifted`);
    if (record.expected_labels?.join('\n') !== inventoryItem.labels?.join('\n')) add(`#${number} request label binding drifted`);
    if (record.transition_id !== null || record.decision !== null || record.mutation_authorized !== false || record.mutation_count !== 0) add(`#${number} request is not a read-only pending request`);
    const relative = String(record.request_file || '');
    const target = path.resolve(root, relative);
    const relativeToRoot = path.relative(root, target);
    if (!relative || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { add(`#${number} request path escapes bundle`); continue; }
    let body;
    try { body = fs.readFileSync(target, 'utf8'); }
    catch (error) { add(`#${number} request file missing: ${error.message}`); continue; }
    if (sha256Text(body) !== record.request_sha256) add(`#${number} request_sha256 does not match file bytes`);
    try {
      const parsed = JSON.parse(body);
      if (canonicalize(parsed) !== canonicalize(requestBodyFromPlanRecord(record))) add(`#${number} request file content does not match request plan`);
    } catch (error) { add(`#${number} request file is invalid JSON: ${error.message}`); }
  }
  if (requestIssues.size !== EXPECTED_COUNT || [...inventoryByIssue.keys()].some((number) => !requestIssues.has(number))) add('request plan does not cover exactly the inventory issue set');

  const issue735 = requestPlan.requests?.find((record) => Number(record.issue_number) === 735);
  if (!issue735 || issue735.status !== 'pending-review' || issue735.decision !== null || issue735.transition_id !== null) add('#735 must remain pending with no invented decision/case transition');
  return {
    ok: errors.length === 0,
    errors,
    directory: root,
    inventory_digest: inventory.canonical_digest,
    request_plan_digest: requestPlan.canonical_digest,
    bundle_digest: summary.bundle_digest,
    request_count: requestIssues.size,
    batch_counts: actualBatches,
    issue_735: issue735 ? { status: issue735.status, decision: issue735.decision, transition_id: issue735.transition_id } : null,
    mutation_count: summary.mutation_count,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { directory: DEFAULT_DIR, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--directory') args.directory = argv[++index];
    else if (arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/issue-1656-pending-boundary-bundle.js [--directory data/pilot/issue-1656]\n');
    return 0;
  }
  const result = validateBundle(args.directory);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { batchFor, validateBundle, parseArgs, main };
