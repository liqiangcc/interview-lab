#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  REPOSITORY, PARENT_ISSUE, PLAN_SCHEMA, SOURCE_REF,
  validateManifest, requestFiles, validateAuthorization, buildPlan: makePlan, applyBatch, atomicWriteJson,
  readRegularJson,
  acquireExclusiveLock,
} = require('./lib/issue-1605-full-boundary-transition');

const DEFAULT_MANIFEST = 'data/pilot/issue-1605/full-boundary-manifest.json';
const DEFAULT_OUTPUT = 'data/pilot/issue-1605/full-boundary-transition.plan.json';
const DEFAULT_JOURNAL = 'data/pilot/issue-1605/full-boundary-transition.journal.json';
const DEFAULT_LOCK = 'data/pilot/issue-1605/full-boundary-transition.lock';
const READ_RETRY_MAX_ATTEMPTS = 5;
const READ_RETRY_BASE_DELAY_MS = 100;

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    manifest: DEFAULT_MANIFEST, output: DEFAULT_OUTPUT, journal: DEFAULT_JOURNAL,
    lock: DEFAULT_LOCK, authorization: null, confirmPlan: null, maxMutations: null,
    priorPlan: null,
    apply: false, reconcileAttempts: 3, pauseMs: 1000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--manifest') args.manifest = next();
    else if (arg === '--output') args.output = next();
    else if (arg === '--journal') args.journal = next();
    else if (arg === '--lock') args.lock = next();
    else if (arg === '--authorization-proof') args.authorization = next();
    else if (arg === '--confirm-plan') args.confirmPlan = next();
    else if (arg === '--max-mutations') args.maxMutations = Number(next());
    else if (arg === '--prior-plan') args.priorPlan = next();
    else if (arg === '--reconcile-attempts') args.reconcileAttempts = Number(next());
    else if (arg === '--pause-ms') args.pauseMs = Number(next());
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!Number.isInteger(args.reconcileAttempts) || args.reconcileAttempts < 1 || args.reconcileAttempts > 5) throw new Error('--reconcile-attempts must be an integer from 1 to 5');
  if (!Number.isInteger(args.pauseMs) || args.pauseMs < 0) throw new Error('--pause-ms must be a non-negative integer');
  if (args.apply) {
    if (!args.authorization) throw new Error('--apply requires --authorization-proof');
    if (!/^[0-9a-f]{64}$/.test(String(args.confirmPlan || ''))) throw new Error('--apply requires --confirm-plan <sha256>');
    if (!Number.isInteger(args.maxMutations) || args.maxMutations < 1) throw new Error('--apply requires --max-mutations <N>');
  }
  return args;
}

function readJson(file) { return readRegularJson(file); }
function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024, timeout: 120000,
  }));
}

function issueEndpoint(repository, number) { return `repos/${repository}/issues/${number}`; }
function sleepForReadRetry(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isTransientReadFailure(error) {
  const details = [error && error.code, error && error.message, error && error.stderr]
    .filter(Boolean).join(' ').toLowerCase();
  return /eof|tls|ssl|timed? ?out|timeout|connection reset|socket hang up|network is unreachable|temporary failure|temporarily unavailable|econnreset|eai_again|enetunreach/.test(details);
}

function readGhJson(args, input = null, options = {}) {
  const read = options.read || ghJson;
  const maxAttempts = options.maxAttempts == null ? READ_RETRY_MAX_ATTEMPTS : options.maxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > READ_RETRY_MAX_ATTEMPTS) throw new Error(`read retry maxAttempts must be an integer from 1 to ${READ_RETRY_MAX_ATTEMPTS}`);
  const sleep = options.sleep || sleepForReadRetry;
  const shouldRetry = options.shouldRetry || isTransientReadFailure;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try { return read(args, input); }
    catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !shouldRetry(error)) throw error;
      sleep(READ_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
    }
  }
  throw lastError || new Error('bounded read failed without an error');
}

function readCommentsPaged(repository, number, read = ghJson, options = {}) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = readGhJson(['api', `${issueEndpoint(repository, number)}/comments?per_page=100&page=${page}`], null, { ...options, read });
    if (!Array.isArray(batch)) throw new Error(`#${number} comments page ${page} was not an array`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error(`#${number} comments pagination did not expose a short terminal page`);
}

function buildLiveLoader(read = ghJson, options = {}) {
  return (request) => ({
    issue: readGhJson(['api', issueEndpoint(REPOSITORY, request.issue_number)], null, { ...options, read }),
    comments: readCommentsPaged(REPOSITORY, request.issue_number, read, options),
  });
}

function buildMutationWriters(read = ghJson) {
  return {
    patchIssue: (number, bodyAndLabels) => read(['api', '--method', 'PATCH', issueEndpoint(REPOSITORY, number), '--input', '-'], bodyAndLabels),
    postReceipt: (number, body) => read(['api', '--method', 'POST', `${issueEndpoint(REPOSITORY, number)}/comments`, '--input', '-'], { body }),
  };
}

function loadParentAuthorization(proof, read = ghJson) {
  return readCommentsPaged(REPOSITORY, PARENT_ISSUE, read);
}

function assertMutationCeiling(maxMutations, proof) {
  if (!Number.isSafeInteger(proof && proof.max_mutations) || proof.max_mutations < 1) throw new Error('authorization proof max_mutations must be a positive integer');
  if (maxMutations > proof.max_mutations) throw new Error(`--max-mutations ${maxMutations} exceeds authorization proof ceiling ${proof.max_mutations}`);
}

function main(argv = process.argv.slice(2), injected = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/apply-issue-1605-full-boundary-transition.js [--manifest <file>] [--output <file>] [--prior-plan <file>] [--apply --confirm-plan <sha256> --authorization-proof <file> --max-mutations <N>]\n');
    return 0;
  }
  const manifest = injected.manifest || readJson(args.manifest);
  const manifestValidation = validateManifest(manifest);
  if (!manifestValidation.ok) throw new Error(`full-boundary manifest validation failed: ${manifestValidation.errors.join('; ')}`);
  const files = requestFiles(manifest, args.manifest);
  if (files.errors.length) throw new Error(`formal request marker validation failed: ${files.errors.join('; ')}`);
  const read = injected.ghJson || ghJson;
  const liveLoader = injected.liveLoader || buildLiveLoader(read);
  const records = files.records.map((record) => ({ ...record, manifest_digest: manifest.canonical_digest }));
  const priorPlan = args.priorPlan ? readJson(args.priorPlan) : null;
  if (priorPlan) {
    if (priorPlan.schema_version !== PLAN_SCHEMA || priorPlan.repository !== REPOSITORY || priorPlan.parent_issue !== PARENT_ISSUE) throw new Error('--prior-plan is not an Issue #1605 transition plan');
    if (priorPlan.manifest?.digest !== manifest.canonical_digest) throw new Error('--prior-plan manifest digest does not match the current manifest');
    if (args.apply && priorPlan.canonical_digest !== args.confirmPlan) throw new Error('--prior-plan canonical digest must equal --confirm-plan during apply');
  }
  const plan = makePlan({ manifest, manifestFile: args.manifest, records, liveLoader, priorPlan });
  atomicWriteJson(args.output, plan);
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify({ status: plan.ok ? 'plan-ready' : 'blocked', schema_version: PLAN_SCHEMA, plan_digest: plan.canonical_digest, manifest_digest: manifest.canonical_digest, source_ref: SOURCE_REF, items: plan.items.length, errors: plan.errors.slice(0, 20) }, null, 2)}\n`);
    return plan.ok ? 0 : 1;
  }
  if (!plan.ok) throw new Error(`plan is fail-closed; resolve ${plan.errors.length} errors before apply`);
  if (args.confirmPlan !== plan.canonical_digest) throw new Error(`--confirm-plan does not match current plan digest ${plan.canonical_digest}`);
  const proof = injected.authorization || readJson(args.authorization);
  const parentComments = injected.parentComments || loadParentAuthorization(proof, read);
  const authorization = validateAuthorization(proof, manifest.canonical_digest, plan.canonical_digest, parentComments);
  if (!authorization.ok) throw new Error(`parent #${PARENT_ISSUE} transition authorization failed closed: ${authorization.errors.join('; ')}`);
  assertMutationCeiling(args.maxMutations, proof);

  const lock = (injected.acquireLock || acquireExclusiveLock)(args.lock);
  let result;
  let primaryError = null;
  try {
    lock.assertHeld();
    const journalFile = path.resolve(args.journal);
    const readJournal = () => fs.existsSync(journalFile) ? readJson(journalFile) : null;
    const writeJournal = (value) => atomicWriteJson(journalFile, value);
    const mutationWriters = buildMutationWriters(read);
    result = applyBatch({
      plan, records, liveLoader,
      patchIssue: injected.patchIssue || mutationWriters.patchIssue,
      postReceipt: injected.postReceipt || mutationWriters.postReceipt,
      readComments: injected.readComments || ((number) => readCommentsPaged(REPOSITORY, number, read)),
      sleep: injected.sleep || ((milliseconds) => { if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }),
      now: injected.now || (() => new Date().toISOString()),
      reconcileAttempts: args.reconcileAttempts, maxMutations: args.maxMutations,
      journalFile, lock, readJournal, writeJournal,
    });
    atomicWriteJson(args.output, result);
    return result.ok ? 0 : 1;
  } catch (error) {
    primaryError = error;
    if (result) {
      try { atomicWriteJson(args.output, result); } catch (_) { /* preserve primary fail-closed error */ }
    }
    throw error;
  } finally {
    try { lock.release(); } catch (releaseError) { if (!primaryError) throw releaseError; }
  }
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = {
  parseArgs, readGhJson, readCommentsPaged, buildLiveLoader, buildMutationWriters, loadParentAuthorization, assertMutationCeiling, main,
};
