#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  planAggregate,
  validateAuthorization,
  sha256Text,
} = require('./lib/aggregate-downstream-pipeline');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { manifest: null, output: null, apply: false, authorization: null, confirmPlanDigest: null, journal: null, lock: null, maxMutations: null, pauseMs: 1000, staleLockMs: 30 * 60 * 1000, maxReceiptReconcile: 3, maxReceiptCommentPages: 10 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') out.manifest = argv[++index];
    else if (arg === '--output') out.output = argv[++index];
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--authorization-file') out.authorization = argv[++index];
    else if (arg === '--confirm-plan-digest') out.confirmPlanDigest = argv[++index];
    else if (arg === '--journal') out.journal = argv[++index];
    else if (arg === '--lock') out.lock = argv[++index];
    else if (arg === '--max-mutations') out.maxMutations = Number(argv[++index]);
    else if (arg === '--pause-ms') out.pauseMs = Number(argv[++index]);
    else if (arg === '--stale-lock-ms') out.staleLockMs = Number(argv[++index]);
    else if (arg === '--max-receipt-reconcile') out.maxReceiptReconcile = Number(argv[++index]);
    else if (arg === '--max-receipt-comment-pages') out.maxReceiptCommentPages = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.manifest) throw new Error('--manifest is required');
  if (out.apply && !out.authorization) throw new Error('--apply requires --authorization-file; live GitHub authorization is never implicit');
  if (out.apply && !/^[0-9a-f]{64}$/.test(out.confirmPlanDigest || '')) throw new Error('--apply requires --confirm-plan-digest <canonical digest>');
  if (out.apply && !out.journal) throw new Error('--apply requires --journal; durable progress is mandatory');
  if (out.apply && !out.lock) throw new Error('--apply requires --lock; single-writer ownership is mandatory');
  if (out.apply && (!Number.isInteger(out.maxMutations) || out.maxMutations < 1)) throw new Error('--apply requires --max-mutations; mutation ceiling is mandatory');
  if (out.maxMutations != null && (!Number.isInteger(out.maxMutations) || out.maxMutations < 1)) throw new Error('--max-mutations must be a positive integer');
  if (!Number.isInteger(out.pauseMs) || out.pauseMs < 0) throw new Error('--pause-ms must be a non-negative integer');
  if (!Number.isInteger(out.staleLockMs) || out.staleLockMs < 1) throw new Error('--stale-lock-ms must be a positive integer');
  if (!Number.isInteger(out.maxReceiptReconcile) || out.maxReceiptReconcile < 1) throw new Error('--max-receipt-reconcile must be a positive integer');
  if (!Number.isInteger(out.maxReceiptCommentPages) || out.maxReceiptCommentPages < 1) throw new Error('--max-receipt-comment-pages must be a positive integer');
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
  const boundaryTransitionReport = manifest.boundary_transition_report ? read(manifest.boundary_transition_report) : null;
  const pendingInventorySnapshot = manifest.pending_inventory_snapshot ? read(manifest.pending_inventory_snapshot) : null;
  const pendingInventoryOwnership = manifest.pending_inventory_ownership ? read(manifest.pending_inventory_ownership) : null;
  const interviewNoteOwnershipInventory = manifest.interview_note_ownership_inventory ? read(manifest.interview_note_ownership_inventory) : null;
  const materializationPlan = manifest.materialization_plan ? read(manifest.materialization_plan) : null;
  return {
    manifest,
    boundaryReports,
    boundaryTransitionReport,
    recoveryReport: read(manifest.recovery_report),
    materializationReports: (manifest.materialization_reports || []).map(read),
    materializationPlan,
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
    pendingInventorySnapshot,
    pendingInventoryOwnership,
    interviewNoteOwnershipInventory,
  };
}

function loadFreshInputs(manifest, manifestFile) {
  const inputs = loadInputs(manifest, manifestFile);
  const freshIssues = new Map();
  for (const number of inputs.liveIssues.keys()) freshIssues.set(number, ghJson(['api', `repos/${manifest.repository}/issues/${number}`]));
  inputs.liveIssues = freshIssues;
  return inputs;
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

function acquireWriterLock(lockFile, options = {}) {
  const staleAfterMs = options.staleAfterMs == null ? 30 * 60 * 1000 : options.staleAfterMs;
  const now = options.now || (() => Date.now());
  const target = path.resolve(lockFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch (error) { throw new Error(`aggregate writer lock is active or unreadable: ${error.message}`); }
    if (!existing || existing.schema_version !== 'aggregate-downstream-writer-lock.v1') throw new Error('aggregate writer lock has an unknown schema; refusing to steal');
    const acquiredAt = Date.parse(existing.acquired_at || '');
    if (!Number.isFinite(acquiredAt)) throw new Error('aggregate writer lock has no valid acquired_at; refusing to steal');
    if (now() - acquiredAt >= staleAfterMs) throw new Error('aggregate writer lock is stale; refusing to steal automatically');
    throw new Error(`aggregate writer lock is held by ${existing.owner || existing.lock_id || 'unknown owner'}`);
  }
  const lock = {
    schema_version: 'aggregate-downstream-writer-lock.v1',
    lock_id: crypto.randomUUID(),
    owner: `${os.hostname()}:${process.pid}`,
    pid: process.pid,
    acquired_at: new Date(now()).toISOString(),
  };
  let fd;
  let lockStat;
  try {
    fd = fs.openSync(target, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(lock)}\n`, 'utf8');
    fs.fsyncSync(fd);
    lockStat = fs.fstatSync(fd);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('aggregate writer lock appeared during acquisition; refusing to race');
    throw error;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  return {
    lock,
    assertHeld() {
      let current;
      try { current = JSON.parse(fs.readFileSync(target, 'utf8')); }
      catch (error) { throw new Error(`aggregate writer lock disappeared or became unreadable: ${error.message}`); }
      let currentStat;
      try { currentStat = fs.lstatSync(target); }
      catch (error) { throw new Error(`aggregate writer lock disappeared or became unreadable: ${error.message}`); }
      if (currentStat.dev !== lockStat.dev || currentStat.ino !== lockStat.ino) throw new Error('aggregate writer lock inode changed');
      if (current.lock_id !== lock.lock_id) throw new Error('aggregate writer lock ownership changed');
    },
    release() {
      this.assertHeld();
      const currentStat = fs.lstatSync(target);
      if (currentStat.dev !== lockStat.dev || currentStat.ino !== lockStat.ino) throw new Error('aggregate writer lock inode changed during release');
      fs.unlinkSync(target);
    },
  };
}

function labelsOf(issue) {
  return (issue && issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean).sort();
}

function applyLive(plan, manifest, args, dependencies = {}) {
  const authorization = readJson(path.resolve(args.authorization));
  const auth = validateAuthorization(authorization, plan.canonical_digest, manifest);
  if (!auth.ok) throw new Error(`live apply authorization failed closed: ${auth.errors.join('; ')}`);
  if (args.confirmPlanDigest !== plan.canonical_digest) throw new Error('canonical plan digest confirmation mismatch');
  if (!Number.isInteger(args.maxMutations) || args.maxMutations < 1) throw new Error('apply requires a positive mutation ceiling');
  const replan = dependencies.replan || (() => ({ ok: true, plan }));
  const readIssue = dependencies.readIssue || ((issueNumber) => ghJson(['api', `repos/${manifest.repository}/issues/${issueNumber}`]));
  const patchIssueMetadata = dependencies.patchIssueMetadata || ((issueNumber, projection) => ghJson(['api', '--method', 'PATCH', `repos/${manifest.repository}/issues/${issueNumber}`, '--input', '-'], projection));
  const postComment = dependencies.postComment || ((issueNumber, body) => ghJson(['api', '--method', 'POST', `repos/${manifest.repository}/issues/${issueNumber}/comments`, '--input', '-'], { body }));
  const readComments = dependencies.readComments || ((issueNumber, page) => ghJson(['api', `repos/${manifest.repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`]));
  const sleep = dependencies.sleep || sleepMs;
  const acquireLock = dependencies.acquireLock || ((file) => acquireWriterLock(file, { staleAfterMs: args.staleLockMs }));
  const maxReceiptReconcile = Number.isInteger(args.maxReceiptReconcile) && args.maxReceiptReconcile > 0 ? args.maxReceiptReconcile : 3;
  const maxReceiptCommentPages = Number.isInteger(args.maxReceiptCommentPages) && args.maxReceiptCommentPages > 0 ? args.maxReceiptCommentPages : 10;
  const pauseMs = Number.isInteger(args.pauseMs) && args.pauseMs >= 0 ? args.pauseMs : 1000;
  const journalFile = path.resolve(args.journal);
  const writerLock = acquireLock(args.lock);
  let journal = null;
  let persistJournal = null;
  try {
    writerLock.assertHeld();
    const freshResult = replan();
    const freshPlan = freshResult && freshResult.plan ? freshResult.plan : freshResult;
    if (!freshResult || freshResult.ok !== true || !freshPlan || freshPlan.blocked || freshPlan.canonical_digest !== plan.canonical_digest) {
      throw new Error('fresh re-plan failed or canonical digest drifted; refusing apply');
    }
    const eligible = freshPlan.selection.filter((item) => item.context && item.source_review && item.source_review.final_status === 'source-ready' && !(item.kind === 'existing-source-ready-audit' && item.context.action === 'already_applied'));
    if (eligible.length > args.maxMutations) throw new Error(`mutation ceiling ${args.maxMutations} is below ${eligible.length} planned metadata mutations`);
    if (fs.existsSync(journalFile)) {
      const previous = readJson(journalFile);
      if (previous.plan_digest !== freshPlan.canonical_digest) throw new Error('existing aggregate journal belongs to another plan digest');
      if (previous.mutation_attempted || previous.receipt_attempted || previous.possibly_performed || previous.status === 'complete' || previous.status === 'uncertain') throw new Error('existing aggregate journal requires live audit before retry; refusing blind replay');
    }
    journal = {
      schema_version: 'aggregate-downstream-journal.v1',
      aggregate_id: freshPlan.aggregate_id,
      plan_digest: freshPlan.canonical_digest,
      status: 'running',
      mutation_ceiling: args.maxMutations,
      mutation_attempted: false,
      mutation_performed: false,
      possibly_performed: false,
      receipt_attempted: false,
      receipt_reconcile_max_attempts: maxReceiptReconcile,
      receipt_reconcile_max_comment_pages: maxReceiptCommentPages,
      items: eligible.map((item) => ({ issue_number: item.interview_issue_number, state: 'pending', expected_body_sha256: item.context.expected_body_sha256, mutation_attempted: false, mutation_performed: false, possibly_performed: false, receipt_attempted: false })),
    };
    writeAtomic(journalFile, journal);
    let currentItem = null;
    persistJournal = (patch) => { Object.assign(journal, patch); writeAtomic(journalFile, journal); };
    const itemFor = (issueNumber) => {
      currentItem = journal.items.find((item) => Number(item.issue_number) === Number(issueNumber));
      if (!currentItem) throw new Error(`Issue #${issueNumber} has no journal entry`);
      return currentItem;
    };
    const refreshPossible = () => { journal.possibly_performed = journal.items.some((item) => item.possibly_performed); };
    const reconcileReceipt = (issueNumber, expectedBody) => {
      for (let attempt = 1; attempt <= maxReceiptReconcile; attempt += 1) {
        const matches = [];
        let observedShortPage = false;
        for (let page = 1; page <= maxReceiptCommentPages; page += 1) {
          writerLock.assertHeld();
          let comments;
          try { comments = readComments(issueNumber, page); }
          catch (error) { throw new Error(`receipt response unknown and marker GET failed on attempt ${attempt}, page ${page}: ${error.message}`); }
          if (!Array.isArray(comments)) throw new Error('receipt marker GET returned a non-array response; refusing unknown state');
          matches.push(...comments.filter((comment) => typeof comment.body === 'string' && comment.body.includes(expectedBody)));
          if (comments.length < 100) { observedShortPage = true; break; }
        }
        if (!observedShortPage) throw new Error(`receipt marker pagination incomplete for Issue #${issueNumber} after ${maxReceiptCommentPages} full pages; refusing unknown state`);
        if (matches.length > 1) throw new Error(`receipt marker GET found multiple matching markers for Issue #${issueNumber}; refusing unknown state`);
        const found = matches[0];
        if (found && Number.isInteger(Number(found.id)) && Number(found.id) > 0) return { id: Number(found.id), attempts: attempt };
        if (attempt < maxReceiptReconcile) sleep(pauseMs);
      }
      return null;
    };
    const applied = require('./lib/aggregate-downstream-pipeline').applyPlan(freshPlan, {
    patchIssueMetadata(issueNumber, projection) {
      const item = itemFor(issueNumber);
      writerLock.assertHeld();
      const expectedItem = freshPlan.selection.find((candidate) => Number(candidate.interview_issue_number) === Number(issueNumber));
      const expected = expectedItem.context.expected_body_sha256;
      let before;
      try { before = readIssue(issueNumber); } catch (error) { persistJournal({ error: error.message }); throw error; }
      if (sha256Text(before.body || '') !== expected) throw new Error(`Issue #${issueNumber} body SHA drifted before metadata mutation`);
      if (expectedItem.context.live_issue && expectedItem.context.live_issue.title !== undefined && before.title !== expectedItem.context.live_issue.title) throw new Error(`Issue #${issueNumber} title drifted before metadata mutation`);
      if (expectedItem.context.live_issue && JSON.stringify(labelsOf(before)) !== JSON.stringify(labelsOf(expectedItem.context.live_issue))) throw new Error(`Issue #${issueNumber} labels drifted before metadata mutation`);
      writerLock.assertHeld();
      currentItem.state = 'metadata-patch-pending';
      journal.mutation_attempted = true;
      item.mutation_attempted = true;
      item.possibly_performed = true;
      refreshPossible();
      persistJournal({});
      patchIssueMetadata(issueNumber, projection);
      writerLock.assertHeld();
      const after = readIssue(issueNumber);
      if (sha256Text(after.body || '') !== expected) throw new Error(`Issue #${issueNumber} Raw body changed during metadata mutation`);
      const labels = labelsOf(after);
      if (after.title !== projection.title || JSON.stringify(labels) !== JSON.stringify([...projection.labels].sort())) throw new Error(`Issue #${issueNumber} metadata did not converge`);
      item.mutation_performed = true;
      item.possibly_performed = false;
      journal.mutation_performed = true;
      refreshPossible();
      currentItem.state = 'metadata-converged';
      persistJournal({});
    },
    postComment(issueNumber, body) {
      const item = itemFor(issueNumber);
      writerLock.assertHeld();
      currentItem.state = 'receipt-pending';
      journal.receipt_attempted = true;
      item.receipt_attempted = true;
      item.possibly_performed = true;
      refreshPossible();
      persistJournal({});
      let response;
      try { response = postComment(issueNumber, body); }
      catch (error) { response = null; currentItem.post_error = error.message; }
      if (!response || !Number.isInteger(Number(response.id))) {
        const reconciled = reconcileReceipt(issueNumber, body);
        if (!reconciled) {
          journal.status = 'uncertain';
          refreshPossible();
          persistJournal({ error: `receipt response unknown for Issue #${issueNumber} after ${maxReceiptReconcile} bounded marker GET attempts` });
          throw new Error(`receipt response unknown for Issue #${issueNumber}; refusing retry`);
        }
        response = reconciled;
        currentItem.receipt_reconciled = true;
        currentItem.receipt_reconcile_attempts = reconciled.attempts;
      }
      writerLock.assertHeld();
      item.possibly_performed = false;
      refreshPossible();
      currentItem.state = 'complete';
      persistJournal({});
      return response && response.id;
    },
    });
    persistJournal({ status: 'complete' });
    return applied;
  } catch (error) {
    if (journal && persistJournal) persistJournal({ status: journal.status === 'uncertain' || journal.possibly_performed ? 'uncertain' : 'failed', error: error.message });
    throw error;
  } finally {
    writerLock.release();
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
  const applied = applyLive(result.plan, manifest, args, { replan: () => planAggregate(loadFreshInputs(manifest, manifestFile)) });
  const output = { ...result.plan, mode: 'apply', mutation_performed: Boolean(applied.mutation_performed), apply_result: applied, post_apply_audit_required: true };
  writeAtomic(args.output, output);
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { parseArgs, readJson, loadInputs, loadFreshInputs, writeAtomic, acquireWriterLock, applyLive, main };
