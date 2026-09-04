#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateSourceNoteIssue } = require('./lib/source-note-issue');
const {
  parseSourceNoteBoundaryReviewTransition,
  parseAppliedBoundaryReviewReceipts,
  buildAppliedReceipt,
  renderAppliedReceiptComment,
  sha256Text,
} = require('./lib/source-note-boundary-review-transition');
const {
  planBoundaryReviewBatch,
  validateDependencyGate,
} = require('./lib/source-note-boundary-review-batch');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { manifest: null, report: null, apply: false, confirmDryRun: null, gateProof: null, maxMutations: 50, pauseMs: 10000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') out.manifest = argv[++i];
    else if (arg === '--report') out.report = argv[++i];
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--confirm-dry-run') out.confirmDryRun = argv[++i];
    else if (arg === '--gate-proof') out.gateProof = argv[++i];
    else if (arg === '--max-mutations') out.maxMutations = Number(argv[++i]);
    else if (arg === '--pause-ms') out.pauseMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.manifest) throw new Error('--manifest is required');
  if (!Number.isInteger(out.maxMutations) || out.maxMutations < 1) throw new Error('--max-mutations must be a positive integer');
  if (!Number.isInteger(out.pauseMs) || out.pauseMs < 0) throw new Error('--pause-ms must be a non-negative integer');
  if (out.apply && (!out.confirmDryRun || !out.gateProof)) throw new Error('--apply requires --confirm-dry-run <sha256> and --gate-proof <file>');
  return out;
}

function ghJson(args, input = null) {
  const raw = execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.length && Array.isArray(value[0]) ? value.flat() : value;
}

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fetchIssue(repository, number) {
  return ghJson(['api', `repos/${repository}/issues/${number}`]);
}

function fetchComments(repository, number) {
  return flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`]));
}

function loadEntries(manifest, manifestPath) {
  const base = path.dirname(path.resolve(manifestPath));
  return manifest.items.map((item) => {
    const requestText = fs.readFileSync(path.resolve(base, item.request_file), 'utf8');
    const parsed = parseSourceNoteBoundaryReviewTransition(requestText);
    if (!parsed.request) throw new Error(`${item.request_file}: ${parsed.errors.join('; ')}`);
    const issue = fetchIssue(manifest.repository, item.issue_number);
    const comments = fetchComments(manifest.repository, item.issue_number);
    const evidenceComment = comments.find((comment) => Number(comment.id) === Number(parsed.request.review_evidence.comment_id)) || null;
    const receipts = parseAppliedBoundaryReviewReceipts(comments);
    if (receipts.errors.length) throw new Error(`#${item.issue_number}: ${receipts.errors.join('; ')}`);
    return { request: parsed.request, issue, evidenceComment, receipts: receipts.receipts };
  });
}

function writeReport(reportPath, report) {
  if (reportPath) fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
}

function applyOne(repository, entry, plan) {
  if (plan.already_applied) {
    if (plan.receipt) return { issue_number: entry.request.issue_number, action: 'already-applied', receipt_comment_id: plan.receipt.comment_id || null };
    const receipt = buildAppliedReceipt(entry.request, plan, new Date().toISOString());
    const comment = ghJson(['api', '--method', 'POST', `repos/${repository}/issues/${entry.request.issue_number}/comments`, '--input', '-'], { body: renderAppliedReceiptComment(receipt) });
    return { issue_number: entry.request.issue_number, action: 'receipt-repair', receipt_comment_id: comment.id };
  }

  ghJson(['api', '--method', 'PATCH', `repos/${repository}/issues/${entry.request.issue_number}`, '--input', '-'], {
    body: plan.next_body,
    labels: plan.next_labels,
  });
  const after = fetchIssue(repository, entry.request.issue_number);
  const labels = (after.labels || []).map((label) => typeof label === 'string' ? label : label.name).sort();
  const validation = validateSourceNoteIssue({ body: after.body || '', labels, state: String(after.state || '').toLowerCase() });
  if (sha256Text(after.body || '') !== plan.next_body_sha256) throw new Error(`#${entry.request.issue_number}: post-write body SHA mismatch`);
  if (JSON.stringify(labels) !== JSON.stringify([...plan.next_labels].sort())) throw new Error(`#${entry.request.issue_number}: post-write labels mismatch`);
  if (!validation.ok) throw new Error(`#${entry.request.issue_number}: post-write SourceNote invalid: ${validation.errors.join('; ')}`);
  const receipt = buildAppliedReceipt(entry.request, plan, new Date().toISOString());
  const comment = ghJson(['api', '--method', 'POST', `repos/${repository}/issues/${entry.request.issue_number}/comments`, '--input', '-'], { body: renderAppliedReceiptComment(receipt) });
  return { issue_number: entry.request.issue_number, action: 'applied', receipt_comment_id: comment.id };
}

function main() {
  const args = parseArgs();
  const manifestPath = path.resolve(args.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entries = loadEntries(manifest, manifestPath);
  let planned = planBoundaryReviewBatch(manifest, entries, { maxItems: manifest.items.length });
  if (!planned.ok) throw new Error(`dry-run failed closed: ${planned.errors.join('; ')}`);
  const dryRunSha = planned.report.dry_run_sha256;
  if (!args.apply) {
    writeReport(args.report, planned.report);
    process.stdout.write(`${JSON.stringify(planned.report, null, 2)}\n`);
    return 0;
  }

  if (args.confirmDryRun !== dryRunSha) throw new Error(`dry-run confirmation mismatch: expected ${dryRunSha}`);
  const gate = JSON.parse(fs.readFileSync(path.resolve(args.gateProof), 'utf8'));
  const liveDependencies = [917, 920].map((number) => fetchIssue(manifest.repository, number));
  const gateResult = validateDependencyGate(gate, liveDependencies);
  if (!gateResult.ok) throw new Error(`dependency gate failed closed: ${gateResult.errors.join('; ')}`);

  // Re-read and re-plan every item immediately before the first mutation.
  const rereadEntries = loadEntries(manifest, manifestPath);
  planned = planBoundaryReviewBatch(manifest, rereadEntries, { maxItems: manifest.items.length });
  if (!planned.ok || planned.report.dry_run_sha256 !== dryRunSha) throw new Error('pre-apply recheck failed: live state changed since dry-run');

  const eligible = planned.plans.filter((item) => item.plan && item.plan.ok && (!item.plan.already_applied || !item.plan.receipt)).slice(0, args.maxMutations);
  const report = { ...planned.report, dry_run_sha256: dryRunSha, mode: 'apply', applied: [], remaining_after_run: Math.max(0, planned.report.counts.ready - eligible.length) };
  for (const item of eligible) {
    const entry = rereadEntries.find((candidate) => candidate.request.issue_number === item.issue_number);
    report.applied.push(applyOne(manifest.repository, entry, item.plan));
    writeReport(args.report, report);
    sleepMs(args.pauseMs);
  }
  writeReport(args.report, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, validateSourceNoteIssue, flattenPages, planBoundaryReviewBatch };
