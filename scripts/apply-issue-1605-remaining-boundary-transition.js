#!/usr/bin/env node
'use strict';

/*
 * Issue #1605 remaining-boundary transition entry point.
 *
 * The default is plan-only.  The apply path is reachable only with explicit
 * operator confirmation, a matching parent authorization proof, a positive
 * mutation ceiling, and injected/live writers; this PR never invokes it
 * against GitHub.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildPlan: buildEvidencePlan } = require('./issue-1605-full-boundary-coordinator');
const { buildLiveLoader } = require('./apply-issue-1605-full-boundary-transition');
const {
  REPOSITORY, PARENT_ISSUE, SOURCE_REF, PLAN_SCHEMA,
  readRegularJson, validateRemainingManifest, validateFrozenSnapshot,
  validateEvidencePlan, buildTransitionPlan, initialJournal, persistJournal,
  parseRequestSet, validateAuthorization, applyBatch,
} = require('./lib/issue-1605-remaining-boundary-transition');
const { atomicWriteJson, acquireExclusiveLock, buildMutationWriters, loadParentAuthorization } = require('./lib/issue-1605-full-boundary-transition');

const DEFAULT_MANIFEST = 'data/pilot/issue-1605/remaining-boundary.manifest.json';
const DEFAULT_SNAPSHOT = 'data/pilot/issue-1605/pending-inventory.snapshot.json';
const DEFAULT_EVIDENCE_PLAN = 'data/pilot/issue-1605/remaining-boundary-evidence-plan.json';
const DEFAULT_REQUEST_DIR = 'data/pilot/issue-1605/remaining-boundary-evidence-requests';
const DEFAULT_OUTPUT = 'data/pilot/issue-1605/remaining-boundary-transition.plan.json';
const DEFAULT_JOURNAL = 'data/pilot/issue-1605/remaining-boundary-transition.journal.json';
const DEFAULT_LOCK = 'data/pilot/issue-1605/remaining-boundary-transition.lock';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { manifest: DEFAULT_MANIFEST, snapshot: DEFAULT_SNAPSHOT, evidencePlan: DEFAULT_EVIDENCE_PLAN, requestDir: DEFAULT_REQUEST_DIR, output: DEFAULT_OUTPUT, journal: DEFAULT_JOURNAL, lock: DEFAULT_LOCK, authorization: null, confirmPlan: null, maxMutations: 25, apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => argv[++index];
    if (value === '--manifest') args.manifest = next();
    else if (value === '--snapshot') args.snapshot = next();
    else if (value === '--evidence-plan') args.evidencePlan = next();
    else if (value === '--request-dir') args.requestDir = next();
    else if (value === '--output') args.output = next();
    else if (value === '--journal') args.journal = next();
    else if (value === '--lock') args.lock = next();
    else if (value === '--authorization-proof') args.authorization = next();
    else if (value === '--confirm-plan') args.confirmPlan = next();
    else if (value === '--max-mutations') args.maxMutations = Number(next());
    else if (value === '--apply') args.apply = true;
    else if (value === '--help') args.help = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  if (args.help) return args;
  if (!Number.isSafeInteger(args.maxMutations) || args.maxMutations < 1) throw new Error('--max-mutations must be a positive safe integer');
  if (args.apply) {
    if (!args.authorization) throw new Error('--apply requires --authorization-proof');
    if (!/^[0-9a-f]{64}$/.test(String(args.confirmPlan || ''))) throw new Error('--apply requires --confirm-plan <sha256>');
  }
  return args;
}

function loadEvidencePlan(file) {
  if (fs.existsSync(path.resolve(file))) return { plan: readRegularJson(file), path: file, generated: false };
  // The prior coordinator is deterministic and read-only.  This fallback
  // lets the plan CLI operate before the independent evidence stage has
  // persisted its output, while still binding the generated digest in the
  // transition plan and keeping all missing requests fail-closed.
  return { plan: buildEvidencePlan(), path: `${file} (derived read-only)`, generated: true };
}

function main(argv = process.argv.slice(2), injected = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write('Usage: node scripts/apply-issue-1605-remaining-boundary-transition.js [--manifest <file>] [--snapshot <file>] [--evidence-plan <file>] [--request-dir <dir>] [--output <file>] [--journal <file>] [--lock <file>] [--max-mutations <N>] [--apply --confirm-plan <sha256> --authorization-proof <file>]\n');
    return 0;
  }
  const manifest = injected.manifest || readRegularJson(args.manifest);
  const snapshot = injected.snapshot || readRegularJson(args.snapshot);
  const evidence = injected.evidencePlan ? { plan: injected.evidencePlan, path: args.evidencePlan, generated: false } : loadEvidencePlan(args.evidencePlan);
  const manifestCheck = validateRemainingManifest(manifest);
  const snapshotCheck = validateFrozenSnapshot(snapshot);
  if (!manifestCheck.ok || !snapshotCheck.ok) throw new Error([...manifestCheck.errors, ...snapshotCheck.errors].join('; '));
  const evidenceCheck = validateEvidencePlan(evidence.plan, manifest, snapshot);
  if (!evidenceCheck.ok) throw new Error(`remaining evidence plan validation failed: ${evidenceCheck.errors.join('; ')}`);

  const hasRequests = fs.existsSync(path.resolve(args.requestDir));
  const liveLoader = injected.liveLoader || (hasRequests ? buildLiveLoader(injected.read) : null);
  const plan = buildTransitionPlan({ evidencePlan: evidence.plan, evidencePlanPath: evidence.path, manifest, manifestPath: args.manifest, snapshot, snapshotPath: args.snapshot, requestDir: args.requestDir, liveLoader });
  const lock = (injected.acquireLock || acquireExclusiveLock)(args.lock);
  try {
    lock.assertHeld();
    atomicWriteJson(args.output, plan);
    if (!args.apply) {
      const journal = initialJournal(plan);
      persistJournal(args.journal, journal, plan, lock, args.maxMutations);
    } else {
      if (!plan.ok || plan.ready_for_apply !== true) throw new Error(`plan is fail-closed; resolve ${plan.errors.length} actionable errors before apply`);
      const proof = injected.authorization || readRegularJson(args.authorization);
      const parentComments = injected.parentComments || loadParentAuthorization(proof, injected.read);
      const authorization = validateAuthorization(proof, plan.canonical_digest, parentComments);
      if (!authorization.ok) throw new Error(`parent #${PARENT_ISSUE} transition authorization failed closed: ${authorization.errors.join('; ')}`);
      const requests = parseRequestSet(evidence.plan, args.requestDir, manifest.canonical_digest);
      if (requests.errors.length || requests.records.size !== plan.counts.actionable_total) throw new Error(`formal remaining request set is incomplete: ${requests.errors.slice(0, 5).join('; ')}`);
      const existingJournal = fs.existsSync(path.resolve(args.journal)) ? readRegularJson(args.journal) : initialJournal(plan);
      const writers = injected.mutationWriters || buildMutationWriters(injected.read);
      const result = applyBatch({ plan, records: [...requests.records.values()], liveLoader, patchIssue: injected.patchIssue || writers.patchIssue, postReceipt: injected.postReceipt || writers.postReceipt, lock, journal: existingJournal, journalFile: args.journal, maxMutations: args.maxMutations, authorization: proof, apply: true, confirmPlan: args.confirmPlan, writeJournal: () => {}, sleep: injected.sleep, now: injected.now });
      lock.assertHeld();
      atomicWriteJson(args.output, { ...plan, apply_result: { ok: result.ok, mutation_count: result.mutation_count, journal_digest: result.journal.canonical_digest } });
      process.stdout.write(`${JSON.stringify({ status: result.ok ? 'applied' : 'blocked', plan_digest: plan.canonical_digest, mutation_count: result.mutation_count, live_mutation: true }, null, 2)}\n`);
      return result.ok ? 0 : 1;
    }
  } finally { lock.release(); }
  const output = { status: plan.ok ? 'plan-ready' : 'blocked', schema_version: PLAN_SCHEMA, repository: REPOSITORY, parent_issue: PARENT_ISSUE, source_ref: SOURCE_REF, plan_digest: plan.canonical_digest, manifest_digest: manifest.canonical_digest, items: plan.items.length, actionable: plan.counts.actionable_total, blocked: plan.counts.blocked_total, request_bound: plan.counts.request_bound, mutation_count: plan.mutation_count, live_mutation: false, errors: plan.errors.slice(0, 20) };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return plan.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, loadEvidencePlan, main };
