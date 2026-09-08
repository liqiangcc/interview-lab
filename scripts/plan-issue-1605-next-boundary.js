#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, PARENT_ISSUE, BATCHES,
  buildRemainingScope, readGhJson, readCommentsPaged, initialJournal, validateJournal,
  auditRemainingScope, buildManifest, buildBatchArtifacts, atomicWriteJson, acquireReadLock,
} = require('./lib/issue-1605-next-boundary-coordinator');

const DEFAULT_PENDING = 'data/pilot/issue-1605/pending-inventory.snapshot.json';
const DEFAULT_COMPLETED = 'data/pilot/issue-1605/full-boundary-manifest.json';
const DEFAULT_OUTPUT = 'data/pilot/issue-1605/next-boundary.manifest.json';
const DEFAULT_ARTIFACT_DIR = 'data/pilot/issue-1605/next-boundary-batches';
const DEFAULT_JOURNAL = 'data/pilot/issue-1605/next-boundary-read.journal.json';
const DEFAULT_LOCK = 'data/pilot/issue-1605/next-boundary-read.lock';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { pending: DEFAULT_PENDING, completed: DEFAULT_COMPLETED, output: DEFAULT_OUTPUT, artifactDir: DEFAULT_ARTIFACT_DIR, journal: DEFAULT_JOURNAL, lock: DEFAULT_LOCK, maxPages: 100, maxAttempts: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--pending') args.pending = argv[++index];
    else if (arg === '--completed-manifest') args.completed = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--artifact-dir') args.artifactDir = argv[++index];
    else if (arg === '--journal') args.journal = argv[++index];
    else if (arg === '--lock') args.lock = argv[++index];
    else if (arg === '--max-pages') args.maxPages = Number(argv[++index]);
    else if (arg === '--max-attempts') args.maxAttempts = Number(argv[++index]);
    else if (arg === '--help') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!Number.isSafeInteger(args.maxPages) || args.maxPages < 1 || args.maxPages > 100) throw new Error('--max-pages must be an integer from 1 to 100');
  if (!Number.isSafeInteger(args.maxAttempts) || args.maxAttempts < 1 || args.maxAttempts > 5) throw new Error('--max-attempts must be an integer from 1 to 5');
  return args;
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 }));
}
function sleep(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
function issueEndpoint(number) { return `repos/${REPOSITORY}/issues/${number}`; }

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/plan-issue-1605-next-boundary.js [--pending <snapshot>] [--completed-manifest <419 manifest>] [--output <manifest>] [--artifact-dir <dir>] [--journal <journal>] [--lock <lock>]\n');
    return 0;
  }
  const scope = buildRemainingScope({ frozenSnapshot: readJson(args.pending), completedManifest: readJson(args.completed), completedManifestPath: args.completed });
  if (!scope.ok) throw new Error(`next boundary scope failed closed: ${scope.errors.join('; ')}`);
  const lock = acquireReadLock(args.lock);
  try {
    const journalFile = path.resolve(args.journal);
    let journal = fs.existsSync(journalFile) ? readJson(journalFile) : initialJournal(scope);
    const journalValidation = validateJournal(journal, scope);
    if (!journalValidation.ok) throw new Error(`next boundary read journal failed closed: ${journalValidation.errors.join('; ')}`);
    const persist = (value) => { lock.assertHeld(); atomicWriteJson(journalFile, value); };
    persist(journal);
    const readIssue = (issueNumber) => readGhJson(ghJson, ['api', issueEndpoint(issueNumber)], null, { maxAttempts: args.maxAttempts, sleep });
    const readComments = (issueNumber) => readCommentsPaged({ repository: REPOSITORY, issueNumber, read: ghJson, maxPages: args.maxPages, maxAttempts: args.maxAttempts, sleep });
    const audited = auditRemainingScope({ scope, readIssue, readComments: (issueNumber) => readComments(issueNumber).comments, journal, persist });
    const manifest = buildManifest(scope, audited.observations, path.relative(process.cwd(), path.resolve(args.artifactDir)));
    const artifacts = buildBatchArtifacts(manifest);
    lock.assertHeld();
    atomicWriteJson(args.output, manifest);
    for (const batch of BATCHES) {
      const directory = path.join(args.artifactDir, batch.batch);
      atomicWriteJson(path.join(directory, 'evidence.plan.json'), artifacts[batch.batch].evidence);
      atomicWriteJson(path.join(directory, 'request.plan.json'), artifacts[batch.batch].request);
      atomicWriteJson(path.join(directory, 'transition.plan.json'), artifacts[batch.batch].transition);
    }
    process.stdout.write(`${JSON.stringify({
      schema_version: manifest.schema_version, manifest: path.resolve(args.output), scope_digest: manifest.scope_digest,
      canonical_digest: manifest.canonical_digest, remaining_count: manifest.remaining_count,
      status: manifest.ok ? 'review-required' : 'blocked', errors: manifest.errors.length,
      batches: manifest.batches.map((batch) => ({ batch: batch.batch, count: batch.count, audit_blocked_count: batch.audit_blocked_count })),
      journal: path.resolve(args.journal), source_repository: SOURCE_REPOSITORY, source_ref: SOURCE_REF,
      parent_issue: PARENT_ISSUE, read_only: true, patch_count: 0, post_count: 0,
    }, null, 2)}\n`);
    return 0;
  } finally { lock.release(); }
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { parseArgs, readJson, ghJson, readCommentsPaged, main };
