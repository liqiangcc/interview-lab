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

function recomputeDigest(value, digestKey) {
  const payload = { ...value };
  delete payload[digestKey];
  return sha256(Buffer.from(canonicalJson(payload), 'utf8'));
}

function projectionArtifactAnchor(selectionItem, inventoryItem) {
  const artifact = inventoryItem && inventoryItem.artifact;
  if (!artifact) return null;
  return (selectionItem.artifacts || []).find((candidate) => candidate.ref === artifact.ref
    && candidate.git_blob_sha === artifact.git_blob_sha
    && candidate.byte_size === artifact.byte_size
    && candidate.provenance === artifact.provenance);
}

function validateItemAnchors(selectionItem, inventoryItem) {
  const errors = [];
  const number = selectionItem && selectionItem.issue_number;
  if (!inventoryItem) return [`#${number}: inventory item is missing`];
  for (const [field, left, right] of [
    ['issue_number', selectionItem.issue_number, inventoryItem.issue_number],
    ['source_note_id', selectionItem.source_note_id, inventoryItem.source_note_id],
    ['source_revision_id', selectionItem.source_revision_id, inventoryItem.source_revision_id],
    ['body_sha256', selectionItem.body_sha256, inventoryItem.body_sha256],
    ['source_repository_ref', selectionItem.source_repository_ref, inventoryItem.source_repository_ref],
  ]) if (left !== right) errors.push(`#${number}: selection/inventory ${field} anchor mismatch`);
  if (!/^[0-9a-f]{64}$/.test(String(selectionItem.body_sha256 || ''))) errors.push(`#${number}: selection body_sha256 is invalid`);
  if (!/^[0-9a-f]{64}$/.test(String(inventoryItem.body_sha256 || ''))) errors.push(`#${number}: inventory body_sha256 is invalid`);
  if (!inventoryItem.artifact || !inventoryItem.artifact.ref || !inventoryItem.artifact.git_blob_sha) errors.push(`#${number}: inventory artifact ref/blob anchor is missing`);
  else if (!projectionArtifactAnchor(selectionItem, inventoryItem)) errors.push(`#${number}: inventory artifact ref/blob is not the selected Source projection artifact`);
  return errors;
}

function validateRequestAnchors(request, selectionItem, inventoryItem) {
  const errors = [];
  const number = selectionItem && selectionItem.issue_number;
  const expected = [
    ['issue_number', request.issue_number, selectionItem.issue_number],
    ['source_note_id', request.source_note_id, selectionItem.source_note_id],
    ['expected_source_revision_id', request.expected_source_revision_id, selectionItem.source_revision_id],
    ['expected_body_sha256', request.expected_body_sha256, selectionItem.body_sha256],
    ['expected_source_repository_ref', request.expected_source_repository_ref, selectionItem.source_repository_ref],
    ['evidence.artifact_ref', request.evidence && request.evidence.artifact_ref, inventoryItem.artifact && inventoryItem.artifact.ref],
    ['evidence.git_blob_sha', request.evidence && request.evidence.git_blob_sha, inventoryItem.artifact && inventoryItem.artifact.git_blob_sha],
    ['evidence.byte_size', request.evidence && request.evidence.byte_size, inventoryItem.artifact && inventoryItem.artifact.byte_size],
  ];
  for (const [field, actual, expectedValue] of expected) if (actual !== expectedValue) errors.push(`#${number}: request ${field} anchor mismatch`);
  if (!request.evidence || request.evidence.artifact_provenance !== 'source_projection') errors.push(`#${number}: request evidence is not Source projection`);
  return errors;
}

function validateRequestDirectory(requestDir, issueNumbers, requireAll = false) {
  const expected = new Set(issueNumbers.map((number) => `${String(number).padStart(4, '0')}.json`));
  if (!fs.existsSync(requestDir)) return requireAll ? ['request directory is missing'] : [];
  const actual = fs.readdirSync(requestDir).filter((file) => file.endsWith('.json'));
  const errors = [];
  for (const file of actual) if (!expected.has(file)) errors.push(`request directory contains unexpected file ${file}`);
  if (requireAll) for (const file of expected) if (!actual.includes(file)) errors.push(`request directory is missing ${file}`);
  return errors;
}

function validateInputs(selection, inventory) {
  const errors = [];
  const selectionItems = Array.isArray(selection.items) ? selection.items : [];
  const inventoryItems = Array.isArray(inventory.items) ? inventory.items : [];
  const expectedCount = selectionItems.length;
  if (selection.schema_version !== 'issue-1606-boundary-selection.v1') errors.push('selection schema mismatch');
  if (selection.selected_count !== expectedCount || expectedCount === 0) errors.push('selection selected_count must match a non-empty item set');
  if (!selection.range || selection.range.min_issue !== MIN_ISSUE || selection.range.max_issue !== MAX_ISSUE) errors.push('selection range mismatch');
  if (!selection.read_audit || !Array.isArray(selection.read_audit.out_of_range_issue_numbers) || selection.read_audit.out_of_range_issue_numbers.length !== 0) errors.push('selection read audit contains out-of-range issue');
  if (selection.selection_sha256 !== recomputeDigest(selection, 'selection_sha256')) errors.push('selection canonical SHA-256 does not recompute');
  if (inventory.schema_version !== 'issue-1606-source-inventory.v1') errors.push('source inventory schema mismatch');
  if (inventory.selection_sha256 !== selection.selection_sha256) errors.push('source inventory is not bound to selection digest');
  if (inventory.inventory_sha256 !== recomputeDigest(inventory, 'inventory_sha256')) errors.push('source inventory canonical SHA-256 does not recompute');
  if (inventory.item_count !== expectedCount || inventoryItems.length !== expectedCount) errors.push(`source inventory must contain exactly ${expectedCount} items`);
  if (inventory.source_repository_ref !== SOURCE_REF || selection.source_repository_ref !== SOURCE_REF) errors.push('source ref mismatch');
  const selectionNumbers = selectionItems.map((item) => item.issue_number);
  const inventoryNumbers = inventoryItems.map((item) => item.issue_number);
  if (new Set(selectionNumbers).size !== expectedCount) errors.push('selection issue numbers are not unique');
  if (new Set(inventoryNumbers).size !== expectedCount) errors.push('inventory issue numbers are not unique');
  for (const [owner, items] of [['selection', selectionItems], ['inventory', inventoryItems]]) for (const [field, values] of [['source_note_id', items.map((item) => item.source_note_id)], ['source_revision_id', items.map((item) => item.source_revision_id)]]) if (new Set(values).size !== expectedCount) errors.push(`${owner} ${field} anchors are not unique`);
  if (selectionNumbers.some((number) => number < MIN_ISSUE || number > MAX_ISSUE) || inventoryNumbers.some((number) => number < MIN_ISSUE || number > MAX_ISSUE)) errors.push('selection/inventory issue number outside authorized range');
  if (selectionNumbers.slice().sort((a, b) => a - b).join(',') !== inventoryNumbers.slice().sort((a, b) => a - b).join(',')) errors.push('selection/inventory issue sets differ');
  const inventoryByNumber = new Map(inventoryItems.map((item) => [item.issue_number, item]));
  for (const item of selectionItems) errors.push(...validateItemAnchors(item, inventoryByNumber.get(item.issue_number)));
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

  const inventoryByNumber = new Map(inventory.items.map((item) => [item.issue_number, item]));
  const requestDir = path.resolve(args.requestDir);
  const issueNumbers = selection.items.map((item) => item.issue_number);
  const preexistingRequestErrors = validateRequestDirectory(requestDir, issueNumbers);
  if (preexistingRequestErrors.length) throw new Error(`request directory validation failed closed: ${preexistingRequestErrors.join('; ')}`);
  fs.mkdirSync(requestDir, { recursive: true });
  const planItems = [];
  const journalItems = [];
  const counts = { total: selection.items.length, ready: 0, blocked: 0, decisions: { 'not-interview': 0, 'single-interview': 0, 'multi-interview': 0, blocked: 0 } };

  for (const item of selection.items.slice().sort((left, right) => left.issue_number - right.issue_number)) {
    const inventoryItem = inventoryByNumber.get(item.issue_number);
    const review = classifyBoundary(inventoryItem);
    const request = makeRequest(item, inventoryItem, review, args.reviewedAt);
    const validation = validateRequest(request);
    if (!validation.ok) throw new Error(`#${item.issue_number}: request validation failed: ${validation.errors.join('; ')}`);
    const anchorErrors = validateRequestAnchors(request, item, inventoryItem);
    if (anchorErrors.length) throw new Error(`request anchor validation failed closed: ${anchorErrors.join('; ')}`);
    const requestFile = path.join(requestDir, `${String(item.issue_number).padStart(4, '0')}.json`);
    writeJson(requestFile, request);
    const persistedRequest = readJson(requestFile);
    const persistedValidation = validateRequest(persistedRequest);
    if (!persistedValidation.ok) throw new Error(`#${item.issue_number}: persisted request validation failed: ${persistedValidation.errors.join('; ')}`);
    const persistedAnchorErrors = validateRequestAnchors(persistedRequest, item, inventoryItem);
    if (persistedAnchorErrors.length) throw new Error(`persisted request anchor validation failed closed: ${persistedAnchorErrors.join('; ')}`);
    const requestSha = sha256(Buffer.from(`${JSON.stringify(persistedRequest, null, 2)}\n`, 'utf8'));
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
  const finalRequestErrors = validateRequestDirectory(requestDir, issueNumbers, true);
  if (finalRequestErrors.length || planItems.length !== selection.items.length) throw new Error(`request set validation failed closed: ${finalRequestErrors.concat(planItems.length !== selection.items.length ? [`expected ${selection.items.length} plan items, got ${planItems.length}`] : []).join('; ')}`);

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

module.exports = { parseArgs, recomputeDigest, validateInputs, validateItemAnchors, validateRequestAnchors, validateRequestDirectory };
