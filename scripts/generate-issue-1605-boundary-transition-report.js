#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  canonicalJson,
  sha256Text,
  validateBoundaryManifest,
} = require('./lib/issue-1605-materialization-plan');
const { parseSourceNoteBoundaryReviewTransition } = require('./lib/source-note-boundary-review-transition');

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

function requestFromManifestItem(manifestFile, item) {
  const requestFile = path.resolve(path.dirname(manifestFile), item.request_file);
  const parsed = parseSourceNoteBoundaryReviewTransition(fs.readFileSync(requestFile, 'utf8'));
  if (!parsed.request) throw new Error(`${item.request_file}: ${parsed.errors.join('; ')}`);
  return parsed.request;
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
      || plan.manifest?.digest !== manifest.canonical_digest) {
    throw new Error('transition plan is not the approved complete #1605 frozen plan');
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
  const planItems = new Map((plan.items || []).map((item) => [Number(item.issue_number), item]));
  const journalItems = new Map(journal.items.map((item) => [Number(item.issue_number), item]));
  const items = manifest.items.map((manifestItem) => {
    const issueNumber = Number(manifestItem.issue_number);
    const request = requestFromManifestItem(manifestFile, manifestItem);
    const planned = planItems.get(issueNumber);
    const journalItem = journalItems.get(issueNumber);
    if (!planned || !journalItem || planned.transition_id !== request.transition_id || journalItem.transition_id !== request.transition_id) {
      throw new Error(`#${issueNumber}: plan/journal/request transition binding is inconsistent`);
    }
    const liveBodySha = planned.next_body_sha256 || planned.current_body_sha256;
    if (!/^[0-9a-f]{64}$/.test(String(liveBodySha || ''))) throw new Error(`#${issueNumber}: transition target body SHA is missing`);
    const receiptCommentId = Number(journalItem.receipt_comment_id || planned.existing_receipt?.comment_id);
    if (!Number.isSafeInteger(receiptCommentId) || receiptCommentId < 1) throw new Error(`#${issueNumber}: applied receipt comment id is missing`);
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
