#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJson,
  sha256Text,
  validateBoundaryManifest,
} = require('./lib/issue-1605-materialization-plan');
const {
  requestFiles,
  validateJournal,
  itemDigest,
} = require('./lib/issue-1605-full-boundary-transition');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const PARENT_ISSUE = 1605;
const EXPECTED_COUNT = 419;
const EXPECTED_PLAN_DIGEST = '75af8bc59053022d884a845b98f12229705e03daefdcaaaa7793b36a21cf4906';

function readJson(file) {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`input must be a regular file: ${file}`);
  return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    manifest: 'data/pilot/issue-1605/full-boundary-manifest.json',
    plan: 'data/pilot/issue-1605/full-boundary-transition.plan.json',
    journal: 'data/pilot/issue-1605/full-boundary-transition.journal.json',
    output: 'data/pilot/issue-1605/boundary-transition-report.json',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') args.manifest = argv[++index];
    else if (arg === '--transition-plan') args.plan = argv[++index];
    else if (arg === '--journal') args.journal = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function atomicWrite(file, value) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, absolute);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifestFile = path.resolve(args.manifest);
  const manifest = readJson(manifestFile);
  const manifestValidation = validateBoundaryManifest(manifest);
  if (!manifestValidation.ok) throw new Error(`boundary manifest validation failed: ${manifestValidation.errors.join('; ')}`);
  const plan = readJson(args.plan);
  if (plan.schema_version !== 'issue-1605-full-boundary-transition-plan.v1'
      || plan.repository !== REPOSITORY || plan.parent_issue !== PARENT_ISSUE
      || plan.canonical_digest !== EXPECTED_PLAN_DIGEST
      || plan.manifest?.digest !== manifest.canonical_digest
      || plan.manifest?.item_count !== EXPECTED_COUNT
      || !Array.isArray(plan.items) || plan.items.length !== EXPECTED_COUNT
      || !Array.isArray(plan.errors) || plan.errors.length !== 0) {
    throw new Error('transition plan is not the approved complete #1605 frozen plan');
  }
  const planDigestInput = {
    schema_version: plan.schema_version,
    repository: plan.repository,
    parent_issue: plan.parent_issue,
    source_snapshot: plan.source_snapshot,
    manifest: plan.manifest,
    mutation_count: plan.mutation_count,
    errors: [],
    items: plan.items.map((item) => ({
      issue_number: item.issue_number,
      transition_id: item.transition_id,
      source_note_id: item.source_note_id,
      decision: item.decision,
      expected_body_sha256: item.expected_body_sha256,
      expected_source_revision_id: item.expected_source_revision_id,
      request_marker_sha256: item.request_marker_sha256,
      next_body_sha256: item.next_body_sha256,
      next_labels: item.next_labels,
      interview_note_ids: item.interview_note_ids,
      interview_note_cases: item.interview_note_cases,
    })),
  };
  if (sha256Text(canonicalJson(planDigestInput)) !== plan.canonical_digest
      || plan.items.some((item) => item.item_digest !== itemDigest(item))) {
    throw new Error('transition plan canonical or item digest is invalid');
  }
  const journal = readJson(args.journal);
  if (journal.schema_version !== 'issue-1605-full-boundary-transition-journal.v1'
      || journal.repository !== REPOSITORY || journal.parent_issue !== PARENT_ISSUE
      || journal.manifest_digest !== manifest.canonical_digest
      || journal.plan_digest !== plan.canonical_digest
      || journal.status !== 'complete'
      || journal.mutation_count !== 840
      || !Array.isArray(journal.items) || journal.items.length !== EXPECTED_COUNT
      || journal.items.some((item) => item.phase !== 'complete' || item.possibly_performed)) {
    throw new Error('transition journal is not a complete, uncertainty-free #1605 run');
  }
  const journalValidation = validateJournal(journal, plan, journal.mutation_count);
  if (!journalValidation.ok) throw new Error(`transition journal validation failed: ${journalValidation.errors.join('; ')}`);
  const journalIssues = new Set();
  const receiptIds = new Set();
  for (const journalItem of journal.items) {
    const issueNumber = Number(journalItem.issue_number);
    if (journalIssues.has(issueNumber)) throw new Error(`#${issueNumber}: transition journal repeats an issue`);
    journalIssues.add(issueNumber);
    const receiptCommentId = Number(journalItem.receipt_comment_id);
    if (!Number.isSafeInteger(receiptCommentId) || receiptCommentId < 1) throw new Error(`#${issueNumber}: transition journal receipt comment id is missing`);
    if (receiptIds.has(receiptCommentId)) throw new Error(`#${issueNumber}: transition journal reuses receipt comment id ${receiptCommentId}`);
    receiptIds.add(receiptCommentId);
  }
  if (journalIssues.size !== EXPECTED_COUNT || receiptIds.size !== EXPECTED_COUNT) {
    throw new Error('transition journal does not contain one unique receipt identity per authorized row');
  }
  const recordsResult = requestFiles(manifest, manifestFile);
  if (recordsResult.errors.length) throw new Error(`formal transition request validation failed: ${recordsResult.errors.join('; ')}`);
  const records = new Map(recordsResult.records.map((record) => [Number(record.issue_number), record]));
  const planItems = new Map((plan.items || []).map((item) => [Number(item.issue_number), item]));
  const journalItems = new Map(journal.items.map((item) => [Number(item.issue_number), item]));
  const items = manifest.items.map((manifestItem) => {
    const issueNumber = Number(manifestItem.issue_number);
    const record = records.get(issueNumber);
    const request = record && record.request;
    const planned = planItems.get(issueNumber);
    const journalItem = journalItems.get(issueNumber);
    if (!record || !request || !planned || !journalItem
        || planned.transition_id !== request.transition_id
        || journalItem.transition_id !== request.transition_id
        || record.request_marker_sha256 !== planned.request_marker_sha256
        || planned.source_note_id !== request.source_note_id
        || planned.expected_body_sha256 !== request.expected_body_sha256
        || planned.expected_source_revision_id !== request.expected_source_revision_id
        || planned.decision !== request.decision
        || Number(request.review_evidence && request.review_evidence.comment_id) < 1) {
      throw new Error(`#${issueNumber}: plan/journal/request transition binding is inconsistent`);
    }
    const liveBodySha = planned.next_body_sha256 || planned.current_body_sha256;
    if (!/^[0-9a-f]{64}$/.test(String(liveBodySha || ''))) throw new Error(`#${issueNumber}: transition target body SHA is missing`);
    const receiptCommentId = Number(journalItem.receipt_comment_id);
    if (!Number.isSafeInteger(receiptCommentId) || receiptCommentId < 1) throw new Error(`#${issueNumber}: applied receipt comment id is missing`);
    if (planned.existing_receipt && Number(planned.existing_receipt.comment_id) !== receiptCommentId) {
      throw new Error(`#${issueNumber}: journal receipt identity differs from the frozen plan receipt`);
    }
    return {
      source_note_issue_number: issueNumber,
      source_note_id: request.source_note_id,
      source_note_body_sha256: request.expected_body_sha256,
      evidence_body_sha256: request.expected_body_sha256,
      live_source_note_body_sha256: liveBodySha,
      source_revision_id: request.expected_source_revision_id,
      decision: request.decision,
      transition_id: request.transition_id,
      transition_status: 'applied',
      evidence_comment_id: request.review_evidence.comment_id,
      receipt_comment_id: receiptCommentId,
      interview_note_ids: planned.interview_note_ids || [],
      interview_note_cases: planned.interview_note_cases || [],
    };
  });
  const report = {
    schema_version: 'issue-1605-boundary-transition-report.v1',
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    source_repository: SOURCE_REPOSITORY,
    source_ref: SOURCE_REF,
    boundary_manifest_digest: manifest.canonical_digest,
    transition_plan_digest: plan.canonical_digest,
    transition_journal_digest: journal.canonical_digest,
    transition_mutation_count: journal.mutation_count,
    items,
  };
  report.report_sha256 = sha256Text(canonicalJson(report));
  atomicWrite(args.output, report);
  process.stdout.write(`${JSON.stringify({ output: path.resolve(args.output), report_sha256: report.report_sha256, item_count: items.length, mutation_count: journal.mutation_count }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, main };
