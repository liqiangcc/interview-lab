#!/usr/bin/env node
'use strict';

// Offline audit verifier. Default mode is check-only: it reads snapshots and
// the committed result and never writes. --write is required to regenerate the
// result file. It never calls GitHub or writes business data.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildMaterializationRequest,
  issueSourceRecord,
} = require('../../scripts/lib/interview-note-materialization-batch');
const {
  buildInterviewProjection,
  parseMaterializationReceipts,
  requestSha256,
  sha256Text,
} = require('../../scripts/lib/source-note-interview-materialization');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('../../scripts/lib/interview-note-issue');
const { canonicalDigest } = require('../../scripts/lib/aggregate-downstream-pipeline');

const SCOPE = [1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458];
const POST_1689_SOURCE_TREE_SHA = '92b76907a2edaa86ee8459aff20ed768a4b4b352';
const DEFAULTS = Object.freeze({
  input: path.join(__dirname, 'repro-input.json'),
  owners: path.join(__dirname, 'owner-inventory.json'),
  fullPlan: path.join(__dirname, 'full-plan-summary.json'),
  output: path.join(__dirname, '13-reconcile.json'),
});

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function labelsOf(issue) { return (issue.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean).sort(); }
function markerValues(body, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<!--\\s*${escaped}\\n([\\s\\S]*?)\\n-->`, 'g');
  return [...String(body || '').matchAll(re)].map((match) => JSON.parse(match[1].trim()));
}
function digestFile(file) { return crypto.createHash('sha256').update(fs.readFileSync(path.resolve(file))).digest('hex'); }
function parseArgs(argv) {
  const args = { ...DEFAULTS, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--input') args.input = argv[++i];
    else if (arg === '--owners') args.owners = argv[++i];
    else if (arg === '--full-plan') args.fullPlan = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (!arg.startsWith('-') && !args.inputPositional) args.inputPositional = arg;
    else if (!arg.startsWith('-') && !args.ownersPositional) args.ownersPositional = arg;
    else if (!arg.startsWith('-') && !args.fullPlanPositional) args.fullPlanPositional = arg;
    else if (!arg.startsWith('-') && !args.outputPositional) args.outputPositional = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.inputPositional) args.input = args.inputPositional;
  if (args.ownersPositional) args.owners = args.ownersPositional;
  if (args.fullPlanPositional) args.fullPlan = args.fullPlanPositional;
  if (args.outputPositional) args.output = args.outputPositional;
  return args;
}
function addError(errors, message) { errors.push(message); }
function count(values, field, value) { return values.filter((item) => item.dimensions[field] === value).length; }
function plannerErrorsForSource(errors, sourceIssue) {
  const marker = new RegExp(`#${sourceIssue}\\b`);
  return (errors || []).filter((error) => marker.test(String(error)));
}
function validateOwnerInventory(inventory) {
  const errors = [];
  if (!inventory || inventory.schema_version !== 'aggregate-interview-note-ownership-inventory.v1') errors.push('owner inventory schema mismatch');
  if (inventory?.repository !== 'liqiangcc/interview-lab' || inventory?.coverage !== 'all-repository-interview-note-issues' || inventory?.complete !== true) errors.push('owner inventory is not complete all-repository coverage');
  if (!Array.isArray(inventory?.entries) || inventory.count !== inventory.entries.length || inventory.count !== 65) errors.push('owner inventory must contain exactly 65 entries');
  if (inventory?.canonical_digest) {
    const { canonical_digest: ignored, ...content } = inventory;
    if (canonicalDigest(content) !== inventory.canonical_digest) errors.push('owner inventory canonical digest mismatch');
  } else errors.push('owner inventory canonical digest missing');
  const identities = new Set();
  const issueNumbers = new Set();
  for (const entry of inventory?.entries || []) {
    if (!entry || typeof entry.interview_note_id !== 'string' || identities.has(entry.interview_note_id)) errors.push(`owner inventory duplicate/missing identity ${entry?.interview_note_id || ''}`);
    if (!Number.isInteger(Number(entry?.issue_number)) || issueNumbers.has(Number(entry.issue_number))) errors.push(`owner inventory duplicate/invalid Issue #${entry?.issue_number || ''}`);
    identities.add(entry?.interview_note_id);
    issueNumbers.add(Number(entry?.issue_number));
  }
  return { ok: errors.length === 0, errors, identity_count: identities.size, issue_count: issueNumbers.size };
}

function compute(args) {
  const input = readJson(args.input);
  const inventory = readJson(args.owners);
  const fullPlan = readJson(args.fullPlan);
  const errors = [];
  const sourceTreeSha = fullPlan.source_tree_sha;
  if (sourceTreeSha !== POST_1689_SOURCE_TREE_SHA) {
    addError(errors, `full plan source_tree_sha must equal post-#1689 main ${POST_1689_SOURCE_TREE_SHA}`);
  }
  if (!Array.isArray(input.scope) || JSON.stringify(input.scope) !== JSON.stringify(SCOPE)) addError(errors, 'snapshot scope is not exactly the authorized 13 rows');
  if (!Array.isArray(input.rows) || input.rows.length !== SCOPE.length) addError(errors, 'snapshot row count is not 13');
  const sourceNumbers = (input.rows || []).map((row) => Number(row?.source?.number));
  if (new Set(sourceNumbers).size !== sourceNumbers.length) addError(errors, 'snapshot contains duplicate SourceNote numbers');
  if (JSON.stringify([...sourceNumbers].sort((a, b) => a - b)) !== JSON.stringify([...SCOPE].sort((a, b) => a - b))) addError(errors, 'snapshot SourceNote numbers do not exactly equal the authorized scope');
  const inventoryCheck = validateOwnerInventory(inventory);
  const inventoryEntries = inventory?.entries || [];
  const targets = [];

  for (const row of input.rows || []) {
    const source = row.source;
    const owner = row.owner;
    const sourceNumber = Number(source?.number);
    const { validation, parsed } = issueSourceRecord(source || {});
    let projection = null;
    try {
      if (validation.ok && parsed) projection = buildInterviewProjection(source, validation);
    } catch (error) { addError(errors, `#${sourceNumber}: projection failed: ${error.message}`); }
    const identity = projection?.interview_note_id || null;
    const expectedLabels = projection ? [...projection.labels].sort() : [];
    const actualLabels = labelsOf(owner || {});
    const ownerParsed = parseInterviewNoteIssue(owner?.body || '');
    const ownerBodySha = sha256Text(owner?.body || '');
    const ownerMatches = inventoryEntries.filter((entry) => entry.interview_note_id === identity);
    const ownerValidation = validateInterviewNoteIssue({ body: owner?.body, labels: actualLabels, state: owner?.state });
    const ownerFact = Boolean(inventoryCheck.ok && validation.ok && projection && ownerMatches.length === 1
      && ownerMatches[0].issue_number === Number(owner.number)
      && ownerMatches[0].body_sha256 === ownerBodySha
      && JSON.stringify(ownerMatches[0].labels || []) === JSON.stringify(actualLabels)
      && ownerParsed.marker?.interview_note_id === identity
      && owner.title === projection.title
      && ownerBodySha === sha256Text(projection.body)
      && JSON.stringify(actualLabels) === JSON.stringify(expectedLabels)
      && ownerValidation.ok);
    if (!ownerFact) addError(errors, `#${sourceNumber}: owner_fact failed`);

    let applied = [];
    let materialized = [];
    try {
      applied = (row.marker_comments || []).flatMap((comment) => markerValues(comment.body, 'source-note-boundary-review-applied').map((value) => ({ comment_id: Number(comment.id), value })));
      materialized = parseMaterializationReceipts(row.marker_comments || []);
    } catch (error) { addError(errors, `#${sourceNumber}: receipt marker parse failed: ${error.message}`); }
    const receipt = materialized.length === 1 ? materialized[0] : null;
    const receiptFact = Boolean(receipt && parsed && projection && ownerFact
      && receipt.source_note_issue_number === sourceNumber
      && receipt.source_note_id === parsed.source_note_id
      && receipt.source_note_body_sha256 === sha256Text(source.body)
      && receipt.source_revision_id === parsed.source_revision.id
      && (receipt.source_repository_ref ?? null) === (parsed.source_revision.source_repository_ref ?? null)
      && receipt.interview_note_id === identity
      && Number(receipt.interview_issue_number) === Number(ownerMatches[0]?.issue_number)
      && receipt.interview_issue_body_sha256 === ownerBodySha);
    if (applied.length !== 1) addError(errors, `#${sourceNumber}: boundary applied marker count=${applied.length}`);
    if (materialized.length !== 1) addError(errors, `#${sourceNumber}: materialization marker count=${materialized.length}`);
    if (!receiptFact) addError(errors, `#${sourceNumber}: receipt_fact failed`);

    let request = null;
    try { if (projection) request = buildMaterializationRequest(source, 'liqiangcc/interview-lab'); }
    catch (error) { addError(errors, `#${sourceNumber}: request derivation failed: ${error.message}`); }
    const plannerErrors = plannerErrorsForSource(fullPlan.errors, sourceNumber);
    const fullPlannerStatus = plannerErrors.length ? 'FAIL' : 'PASS';
    const appliedValue = applied[0]?.value || {};
    targets.push({
      source_issue: sourceNumber,
      source_url: source?.html_url || null,
      identity,
      source_body_sha256: sha256Text(source?.body || ''),
      source_revision_id: parsed?.source_revision?.id || null,
      source_ref: parsed?.source_revision?.source_repository_ref ?? null,
      boundary_status: parsed?.boundary_review?.status || null,
      owner_issue: Number(owner?.number),
      owner_url: owner?.html_url || null,
      owner_body_sha256: ownerBodySha,
      projected_body_sha256: projection ? sha256Text(projection.body) : null,
      owner_title: owner?.title || null,
      projected_title: projection?.title || null,
      owner_labels: actualLabels,
      projected_labels: expectedLabels,
      boundary_applied_receipt: {
        comment_id: applied[0]?.comment_id || null,
        transition_id: appliedValue.transition_id ?? null,
        interview_note_ids: appliedValue.interview_note_ids ?? null,
      },
      materialization_receipt: receipt ? {
        comment_id: Number((row.marker_comments || []).find((comment) => markerValues(comment.body, 'source-note-interview-materialized').length)?.id),
        materialization_id: receipt.materialization_id,
        request_sha256: receipt.request_sha256,
        source_note_id: receipt.source_note_id,
        source_note_body_sha256: receipt.source_note_body_sha256,
        source_revision_id: receipt.source_revision_id,
        source_repository_ref: receipt.source_repository_ref ?? null,
        interview_note_id: receipt.interview_note_id,
        interview_issue_number: Number(receipt.interview_issue_number),
        interview_issue_body_sha256: receipt.interview_issue_body_sha256,
      } : null,
      binding_comparison: request && receipt ? {
        named_consumer: 'full-live-planner-current-request-binding',
        observed_materialization_id: receipt.materialization_id,
        expected_materialization_id: request.materialization_id,
        observed_request_sha256: receipt.request_sha256,
        expected_request_sha256: requestSha256(request),
        result: receipt.materialization_id === request.materialization_id && receipt.request_sha256 === requestSha256(request) ? 'MATCH' : 'MISMATCH',
      } : null,
      planner_diagnostics: {
        full_live_planner_errors: plannerErrors,
        full_live_planner: fullPlannerStatus,
      },
      dimensions: {
        owner_fact: ownerFact ? 'PASS' : 'FAIL',
        receipt_fact: receiptFact ? 'PASS' : 'FAIL',
        historical_execution: 'UNKNOWN',
        historical_execution_reason: '在本次查找范围内未找到原授权 input plan 或 durable journal',
        consumer_compatibility: {
          full_live_planner: fullPlannerStatus,
          generic_runner: 'NOT_VERIFIED',
          bounded_runner: 'NOT_VERIFIED',
        },
      },
    });
  }

  const globalPlannerErrors = (fullPlan.errors || []).filter((error) => !SCOPE.some((number) => new RegExp(`#${number}\\b`).test(String(error))));
  const output = {
    audit_type: 'issue-1658-read-only-reconciliation-v3',
    generated_at: fullPlan.audit_generated_at || input.captured_at,
    source_tree_sha: sourceTreeSha || null,
    input_snapshot_sha256: digestFile(args.input),
    owner_inventory_snapshot_sha256: digestFile(args.owners),
    full_plan_summary_sha256: digestFile(args.fullPlan),
    scope: SCOPE,
    owner_inventory: {
      coverage: inventory?.coverage || null,
      complete: inventory?.complete === true,
      count: inventory?.count || null,
      identity_count: inventoryCheck.identity_count,
      issue_count: inventoryCheck.issue_count,
      uniqueness: inventoryCheck.ok ? 'PASS' : 'FAIL',
      errors: inventoryCheck.errors,
    },
    dimensions: {
      owner_fact: { PASS: count(targets, 'owner_fact', 'PASS'), FAIL: count(targets, 'owner_fact', 'FAIL') },
      receipt_fact: { PASS: count(targets, 'receipt_fact', 'PASS'), FAIL: count(targets, 'receipt_fact', 'FAIL') },
      historical_execution: { UNKNOWN: targets.length },
      consumer_compatibility: {
        full_live_planner: { PASS: targets.filter((x) => x.dimensions.consumer_compatibility.full_live_planner === 'PASS').length, FAIL: targets.filter((x) => x.dimensions.consumer_compatibility.full_live_planner === 'FAIL').length },
        generic_runner: { NOT_VERIFIED: targets.length },
        bounded_runner: { NOT_VERIFIED: targets.length },
      },
    },
    full_planner_global: {
      plan_ok: fullPlan.ok === true,
      global_errors: globalPlannerErrors,
      global_error_count: globalPlannerErrors.length,
    },
    targets,
    notes: [
      'materialization_id/request SHA mismatch is scoped to the named full-live-planner current request binding; it is not a historical validity judgment.',
      'The bounded runner consumes inputPlan.rows[].request, supports exact already-materialized, and was not executed because the original bounded input plan is absent.',
      'Historical UNKNOWN and NOT_VERIFIED statuses are evidence states, not verifier errors.',
    ],
  };
  return { output, errors };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const { output, errors } = compute(args);
  const outputPath = path.resolve(args.output);
  if (args.write) {
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  } else {
    if (!fs.existsSync(outputPath)) addError(errors, `committed result is missing: ${outputPath}`);
    else {
      const committed = readJson(outputPath);
      if (JSON.stringify(committed) !== JSON.stringify(output)) addError(errors, 'recomputed result differs from committed result; use --write explicitly to regenerate');
    }
  }
  process.stdout.write(JSON.stringify({ mode: args.write ? 'write' : 'check', output: outputPath, rows: output.targets.length, dimensions: output.dimensions, owner_inventory: output.owner_inventory, errors }, null, 2) + '\n');
  if (errors.length) process.exitCode = 1;
}

try { main(); } catch (error) { process.stderr.write(`ERROR: ${error.stack || error.message}\n`); process.exitCode = 1; }
