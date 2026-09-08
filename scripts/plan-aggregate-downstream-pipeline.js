#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  planAggregate,
  validateAuthorization,
  sha256Text,
} = require('./lib/aggregate-downstream-pipeline');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { manifest: null, output: null, apply: false, authorization: null, confirmPlanDigest: null, journal: null, maxMutations: null, pauseMs: 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') out.manifest = argv[++index];
    else if (arg === '--output') out.output = argv[++index];
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--authorization-file') out.authorization = argv[++index];
    else if (arg === '--confirm-plan-digest') out.confirmPlanDigest = argv[++index];
    else if (arg === '--journal') out.journal = argv[++index];
    else if (arg === '--max-mutations') out.maxMutations = Number(argv[++index]);
    else if (arg === '--pause-ms') out.pauseMs = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.manifest) throw new Error('--manifest is required');
  if (out.apply && !out.authorization) throw new Error('--apply requires --authorization-file; live GitHub authorization is never implicit');
  if (out.apply && !/^[0-9a-f]{64}$/.test(out.confirmPlanDigest || '')) throw new Error('--apply requires --confirm-plan-digest <canonical digest>');
  if (out.apply && !out.journal) throw new Error('--apply requires --journal; durable progress is mandatory');
  if (out.maxMutations != null && (!Number.isInteger(out.maxMutations) || out.maxMutations < 1)) throw new Error('--max-mutations must be a positive integer');
  if (!Number.isInteger(out.pauseMs) || out.pauseMs < 0) throw new Error('--pause-ms must be a non-negative integer');
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`cannot read JSON ${file}: ${error.message}`); }
}

function resolveFile(base, file) { return path.resolve(base, file); }

function loadInputs(manifest, manifestFile) {
  const base = path.dirname(path.resolve(manifestFile));
  const read = (file) => readJson(resolveFile(base, file));
  const boundaryReports = {};
  for (const batch of manifest.boundary_batches || []) boundaryReports[batch.issue_number] = read(batch.report);
  return {
    manifest,
    boundaryReports,
    recoveryReport: read(manifest.recovery_report),
    materializationReports: (manifest.materialization_reports || []).map(read),
    sourceReviewReceipts: (() => {
      const value = read(manifest.source_review_receipts);
      return Array.isArray(value) ? value : value.receipts || value.items || value;
    })(),
    contextReports: (manifest.context_reports || []).map(read),
    liveIssues: new Map((() => {
      const value = read(manifest.live_issue_snapshot);
      const items = Array.isArray(value) ? value : value.issues || value.items || [];
      return items.map((issue) => [Number(issue.number || issue.issue_number), issue]);
    })()),
  };
}

function writeAtomic(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const target = path.resolve(file);
  const temporary = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, 'w', 0o644);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const directoryFd = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
}

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }));
}

function applyLive(plan, manifest, args) {
  const authorization = readJson(path.resolve(args.authorization));
  const auth = validateAuthorization(authorization, plan.canonical_digest, manifest);
  if (!auth.ok) throw new Error(`live apply authorization failed closed: ${auth.errors.join('; ')}`);
  if (args.confirmPlanDigest !== plan.canonical_digest) throw new Error('canonical plan digest confirmation mismatch');
  const eligible = plan.selection.filter((item) => item.context && item.source_review && item.source_review.final_status === 'source-ready');
  if (args.maxMutations != null && eligible.length > args.maxMutations) throw new Error(`mutation ceiling ${args.maxMutations} is below ${eligible.length} planned metadata mutations`);
  const journalFile = path.resolve(args.journal);
  if (fs.existsSync(journalFile)) {
    const previous = readJson(journalFile);
    if (previous.plan_digest !== plan.canonical_digest) throw new Error('existing aggregate journal belongs to another plan digest');
    if (previous.receipt_attempted === true || previous.status === 'complete') throw new Error('existing aggregate journal requires live receipt audit before retry; refusing blind replay');
  }
  const journal = {
    schema_version: 'aggregate-downstream-journal.v1',
    aggregate_id: plan.aggregate_id,
    plan_digest: plan.canonical_digest,
    status: 'running',
    mutation_attempted: false,
    receipt_attempted: false,
    items: eligible.map((item) => ({ issue_number: item.interview_issue_number, state: 'pending', expected_body_sha256: item.context.expected_body_sha256 })),
  };
  writeAtomic(journalFile, journal);
  let currentItem = null;
  const persistJournal = (patch) => { Object.assign(journal, patch); writeAtomic(journalFile, journal); };
  const repository = manifest.repository;
  try {
    const applied = require('./lib/aggregate-downstream-pipeline').applyPlan(plan, {
    patchIssueMetadata(issueNumber, projection) {
      currentItem = journal.items.find((item) => Number(item.issue_number) === Number(issueNumber));
      currentItem.state = 'metadata-patch-pending';
      journal.mutation_attempted = true;
      persistJournal({});
      const before = ghJson(['api', `repos/${repository}/issues/${issueNumber}`]);
      const expected = plan.selection.find((item) => Number(item.interview_issue_number) === Number(issueNumber)).context.expected_body_sha256;
      if (sha256Text(before.body || '') !== expected) throw new Error(`Issue #${issueNumber} body SHA drifted before metadata mutation`);
      ghJson(['api', '--method', 'PATCH', `repos/${repository}/issues/${issueNumber}`, '--input', '-'], projection);
      const after = ghJson(['api', `repos/${repository}/issues/${issueNumber}`]);
      if (sha256Text(after.body || '') !== expected) throw new Error(`Issue #${issueNumber} Raw body changed during metadata mutation`);
      const labels = (after.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean).sort();
      if (after.title !== projection.title || JSON.stringify(labels) !== JSON.stringify([...projection.labels].sort())) throw new Error(`Issue #${issueNumber} metadata did not converge`);
      currentItem.state = 'metadata-converged';
      persistJournal({});
    },
    postComment(issueNumber, body) {
      currentItem = journal.items.find((item) => Number(item.issue_number) === Number(issueNumber));
      currentItem.state = 'receipt-pending';
      journal.receipt_attempted = true;
      persistJournal({});
      const response = ghJson(['api', '--method', 'POST', `repos/${repository}/issues/${issueNumber}/comments`, '--input', '-'], { body });
      sleepMs(args.pauseMs);
      currentItem.state = 'complete';
      persistJournal({});
      return response && response.id;
    },
    });
    persistJournal({ status: 'complete' });
    return applied;
  } catch (error) {
    persistJournal({ status: 'failed', error: error.message });
    throw error;
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifestFile = path.resolve(args.manifest);
  const manifest = readJson(manifestFile);
  const result = planAggregate(loadInputs(manifest, manifestFile));
  writeAtomic(args.output, result.plan);
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(result.plan, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  if (!result.ok) throw new Error(`aggregate dry-run failed closed: ${result.errors.join('; ')}`);
  const applied = applyLive(result.plan, manifest, args);
  const output = { ...result.plan, mode: 'apply', mutation_performed: Boolean(applied.mutation_performed), apply_result: applied, post_apply_audit_required: true };
  writeAtomic(args.output, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { parseArgs, readJson, loadInputs, writeAtomic, applyLive, main };
