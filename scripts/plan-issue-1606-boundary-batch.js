#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  canonicalJson,
  classifyBoundary,
  makeRequest,
  sha256,
  validateRequest,
} = require('./lib/issue-1606-boundary');

const MIN_ISSUE = 20;
const MAX_ISSUE = 392;
const EXPECTED_COUNT = 327;
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { selection: null, inventory: null, output: null, requestDir: null, journal: null, digest: null, reviewedAt: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--selection') args.selection = argv[++index];
    else if (arg === '--inventory') args.inventory = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--request-dir') args.requestDir = argv[++index];
    else if (arg === '--journal') args.journal = argv[++index];
    else if (arg === '--digest') args.digest = argv[++index];
    else if (arg === '--reviewed-at') args.reviewedAt = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ['selection', 'inventory', 'output', 'requestDir', 'journal', 'digest', 'reviewedAt']) if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  if (Number.isNaN(Date.parse(args.reviewedAt))) throw new Error('--reviewed-at must be an ISO timestamp');
  return args;
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function validateInputs(selection, inventory) {
  const errors = [];
  if (selection.schema_version !== 'issue-1606-boundary-selection.v1') errors.push('selection schema mismatch');
  if (selection.selected_count !== EXPECTED_COUNT || selection.items.length !== EXPECTED_COUNT) errors.push(`selection must contain exactly ${EXPECTED_COUNT} items`);
  if (selection.range.min_issue !== MIN_ISSUE || selection.range.max_issue !== MAX_ISSUE) errors.push('selection range mismatch');
  if (selection.read_audit.out_of_range_issue_numbers.length !== 0) errors.push('selection read audit contains out-of-range issue');
  if (inventory.schema_version !== 'issue-1606-source-inventory.v1') errors.push('source inventory schema mismatch');
  if (inventory.selection_sha256 !== selection.selection_sha256) errors.push('source inventory is not bound to selection digest');
  if (inventory.item_count !== EXPECTED_COUNT || inventory.items.length !== EXPECTED_COUNT) errors.push(`source inventory must contain exactly ${EXPECTED_COUNT} items`);
  if (inventory.source_repository_ref !== SOURCE_REF || selection.source_repository_ref !== SOURCE_REF) errors.push('source ref mismatch');
  const selectionNumbers = selection.items.map((item) => item.issue_number);
  const inventoryNumbers = inventory.items.map((item) => item.issue_number);
  if (new Set(selectionNumbers).size !== EXPECTED_COUNT) errors.push('selection issue numbers are not unique');
  if (new Set(inventoryNumbers).size !== EXPECTED_COUNT) errors.push('inventory issue numbers are not unique');
  if (selectionNumbers.some((number) => number < MIN_ISSUE || number > MAX_ISSUE) || inventoryNumbers.some((number) => number < MIN_ISSUE || number > MAX_ISSUE)) errors.push('selection/inventory issue number outside authorized range');
  if (selectionNumbers.slice().sort((a, b) => a - b).join(',') !== inventoryNumbers.slice().sort((a, b) => a - b).join(',')) errors.push('selection/inventory issue sets differ');
  return errors;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = parseArgs();
  const selection = readJson(args.selection);
  const inventory = readJson(args.inventory);
  const inputErrors = validateInputs(selection, inventory);
  if (inputErrors.length) throw new Error(`input validation failed closed: ${inputErrors.join('; ')}`);

  const selectionByNumber = new Map(selection.items.map((item) => [item.issue_number, item]));
  const inventoryByNumber = new Map(inventory.items.map((item) => [item.issue_number, item]));
  const requestDir = path.resolve(args.requestDir);
  fs.mkdirSync(requestDir, { recursive: true });
  const planItems = [];
  const journalItems = [];
  const counts = { total: EXPECTED_COUNT, ready: 0, blocked: 0, decisions: { 'not-interview': 0, 'single-interview': 0, 'multi-interview': 0, blocked: 0 } };

  for (const item of selection.items.slice().sort((left, right) => left.issue_number - right.issue_number)) {
    const inventoryItem = inventoryByNumber.get(item.issue_number);
    const review = classifyBoundary(inventoryItem);
    const request = makeRequest(item, inventoryItem, review, args.reviewedAt);
    const validation = validateRequest(request);
    if (!validation.ok) throw new Error(`#${item.issue_number}: request validation failed: ${validation.errors.join('; ')}`);
    const requestFile = path.join(requestDir, `${String(item.issue_number).padStart(4, '0')}.json`);
    writeJson(requestFile, request);
    const requestSha = sha256(Buffer.from(`${JSON.stringify(request, null, 2)}\n`, 'utf8'));
    if (review.status === 'ready') {
      counts.ready += 1;
      counts.decisions[review.decision] += 1;
    } else {
      counts.blocked += 1;
      counts.decisions.blocked += 1;
    }
    planItems.push({
      issue_number: item.issue_number,
      request_file: path.relative(process.cwd(), requestFile),
      request_sha256: requestSha,
      body_sha256: item.body_sha256,
      source_note_id: item.source_note_id,
      source_revision_id: item.source_revision_id,
      source_repository_ref: item.source_repository_ref,
      disposition: review.status,
      decision: review.decision,
      event_boundary: review.status === 'ready' ? 'pass' : 'fail',
      block_reason: review.block_reason || null,
      interview_note_ids: review.decision === 'single-interview' ? [item.source_id] : [],
    });
    journalItems.push({
      issue_number: item.issue_number,
      transition_id: request.transition_id,
      action: 'not-applied',
      reason: 'dry-run artifact only; live GitHub apply is explicitly unauthorized',
    });
  }

  const plan = {
    schema_version: 'issue-1606-boundary-dry-run.v1',
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    issue: 1606,
    mode: 'dry-run',
    live_apply_authorized: false,
    reviewed_at: args.reviewedAt,
    source_repository: 'liqiangcc/xhs',
    source_repository_ref: SOURCE_REF,
    selection_sha256: selection.selection_sha256,
    source_inventory_sha256: inventory.inventory_sha256,
    counts,
    mutation: { planned: 0, applied: 0, pending_authorization: counts.ready },
    items: planItems,
  };
  plan.plan_sha256 = sha256(Buffer.from(canonicalJson(plan), 'utf8'));
  writeJson(args.output, plan);

  const journal = {
    schema_version: 'issue-1606-apply-journal.v1',
    repository: 'liqiangcc/interview-lab',
    issue: 1606,
    mode: 'dry-run',
    live_apply_authorized: false,
    selection_sha256: selection.selection_sha256,
    source_inventory_sha256: inventory.inventory_sha256,
    plan_sha256: plan.plan_sha256,
    mutation_count: 0,
    entries: journalItems,
  };
  journal.journal_sha256 = sha256(Buffer.from(canonicalJson(journal), 'utf8'));
  writeJson(args.journal, journal);

  const digest = {
    schema_version: 'issue-1606-canonical-digest.v1',
    repository: 'liqiangcc/interview-lab',
    issue: 1606,
    selection_sha256: selection.selection_sha256,
    source_inventory_sha256: inventory.inventory_sha256,
    plan_sha256: plan.plan_sha256,
    journal_sha256: journal.journal_sha256,
    request_count: planItems.length,
    request_sha256_by_issue: Object.fromEntries(planItems.map((item) => [String(item.issue_number), item.request_sha256])),
    live_mutations: 0,
  };
  digest.canonical_sha256 = sha256(Buffer.from(canonicalJson(digest), 'utf8'));
  writeJson(args.digest, digest);
  process.stdout.write(`${JSON.stringify({ counts, plan_sha256: plan.plan_sha256, journal_sha256: journal.journal_sha256, canonical_sha256: digest.canonical_sha256 }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, validateInputs };
