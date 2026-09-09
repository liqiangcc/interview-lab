#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  SCHEMA_VERSION,
  AUTH_SCHEMA_VERSION,
  REPOSITORY,
  ISSUE_NUMBER,
  buildPlan,
  validatePlan,
  validateAuthorization,
  applyPlan,
  sha256Text,
} = require('./lib/issue-1662-context-learning');
const { normalizeLabels } = require('./lib/issue-label-taxonomy');

const DEFAULTS = Object.freeze({
  ownershipInventory: 'data/pilot/issue-1662/fresh-full-ownership-inventory.json',
  materializationPostAudit: 'data/pilot/issue-1662/issue-1658-materialization-post-audit.json',
  sourceReviewReceipts: 'data/pilot/issue-1662/issue-1661-source-review-receipts.json',
  contextArtifacts: 'data/pilot/issue-1662/context-artifacts.json',
  liveIssueSnapshot: 'data/pilot/issue-1662/live-interview-note-snapshot.json',
  labelCatalog: 'data/pilot/issue-1662/label-catalog.json',
  output: 'data/pilot/issue-1662/context-learning.plan.json',
  authorization: null,
  lock: 'data/pilot/issue-1662/context-learning.apply.lock',
  journal: 'data/pilot/issue-1662/context-learning.apply.journal.jsonl',
});

function parseArgs(argv = process.argv.slice(2)) {
  const args = { ...DEFAULTS, apply: false, allowLiveGithub: false, confirmPlanDigest: null, maxMutations: null };
  const names = {
    '--ownership-inventory': 'ownershipInventory',
    '--materialization-post-audit': 'materializationPostAudit',
    '--source-review-receipts': 'sourceReviewReceipts',
    '--context-artifacts': 'contextArtifacts',
    '--live-issue-snapshot': 'liveIssueSnapshot',
    '--label-catalog': 'labelCatalog',
    '--output': 'output',
    '--authorization': 'authorization',
    '--lock': 'lock',
    '--journal': 'journal',
    '--confirm-plan-digest': 'confirmPlanDigest',
    '--max-mutations': 'maxMutations',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--allow-live-github') args.allowLiveGithub = true;
    else if (names[arg]) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      args[names[arg]] = names[arg] === 'maxMutations' ? Number(value) : value;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.apply) {
    if (!args.authorization) throw new Error('--apply requires --authorization <Issue #1662 marker JSON>');
    if (!args.allowLiveGithub) throw new Error('--apply requires explicit --allow-live-github');
    if (!/^[0-9a-f]{64}$/.test(args.confirmPlanDigest || '')) throw new Error('--apply requires --confirm-plan-digest <plan SHA-256>');
    if (!Number.isInteger(args.maxMutations) || args.maxMutations < 0) throw new Error('--apply requires --max-mutations <non-negative integer>');
  }
  return args;
}

function readJson(file) {
  const resolved = path.resolve(file);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function sha256Canonical(value) {
  const { canonicalDigest } = require('./lib/issue-1662-context-learning');
  return canonicalDigest(value);
}

function binding(file, value) {
  return { path: file, sha256: sha256Canonical(value) };
}

function labelsFromCatalog(value) {
  if (Array.isArray(value)) return normalizeLabels(value);
  if (value && Array.isArray(value.labels)) return normalizeLabels(value.labels);
  return [];
}

function loadInputs(args) {
  const values = {
    ownershipInventory: readJson(args.ownershipInventory),
    materializationPostAudit: readJson(args.materializationPostAudit),
    sourceReviewReceipts: readJson(args.sourceReviewReceipts),
    contextArtifacts: readJson(args.contextArtifacts),
    liveIssueSnapshot: readJson(args.liveIssueSnapshot),
    labelCatalog: labelsFromCatalog(readJson(args.labelCatalog)),
  };
  return {
    ...values,
    bindings: {
      ownership_inventory: binding(args.ownershipInventory, values.ownershipInventory),
      materialization_post_audit: binding(args.materializationPostAudit, values.materializationPostAudit),
      source_review_receipts: binding(args.sourceReviewReceipts, values.sourceReviewReceipts),
      context_artifacts: binding(args.contextArtifacts, values.contextArtifacts),
      live_issue_snapshot: binding(args.liveIssueSnapshot, values.liveIssueSnapshot),
    },
  };
}

function writeAtomic(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

function controlledGithubAdapters(repository) {
  return {
    readIssue(issueNumber) { return ghJson(['api', `repos/${repository}/issues/${issueNumber}`]); },
    fetchAuthorizationComment(commentId) { return ghJson(['api', `repos/${repository}/issues/comments/${commentId}`]); },
    patchIssue(issueNumber, projection) {
      return ghJson(['api', '--method', 'PATCH', `repos/${repository}/issues/${issueNumber}`, '--input', '-'], projection);
    },
    postReceipt(issueNumber, receipt) {
      return ghJson(['api', '--method', 'POST', `repos/${repository}/issues/${issueNumber}/comments`, '--input', '-'], {
        body: `<!-- issue-1662-context-learning-receipt\n${JSON.stringify(receipt, null, 2)}\n-->\n`,
      });
    },
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const input = loadInputs(args);
  const result = buildPlan(input);
  const validation = validatePlan(result.plan);
  if (!validation.ok) throw new Error(`generated #1662 plan failed its own validator: ${validation.errors.join('; ')}`);
  writeAtomic(args.output, result.plan);
  const summary = {
    schema_version: SCHEMA_VERSION,
    output: path.resolve(args.output),
    ok: result.ok,
    candidate_count: result.plan.candidate_count,
    source_ready: result.plan.summary.source_ready,
    reviewed_context: result.plan.summary.reviewed_context,
    projectable: result.plan.summary.projectable,
    proposed_mutations: result.plan.summary.proposed_mutations,
    mutation_performed: result.plan.mutation_performed,
    write_operations: result.plan.write_operations,
    canonical_digest: result.plan.canonical_digest,
  };
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return result.ok ? 0 : 1;
  }
  const authorization = readJson(args.authorization);
  const adapters = controlledGithubAdapters(REPOSITORY);
  const auth = validateAuthorization(authorization, result.plan.canonical_digest, args.maxMutations, { allowLiveGithub: args.allowLiveGithub, fetchAuthorizationComment: adapters.fetchAuthorizationComment });
  if (!auth.ok) throw new Error(auth.errors.join('; '));
  if (args.confirmPlanDigest !== result.plan.canonical_digest) throw new Error('confirmed plan digest does not match the generated plan; no mutation attempted');
  const applied = applyPlan(result.plan, {
    authorization,
    allowLiveGithub: args.allowLiveGithub,
    maxMutations: args.maxMutations,
    lockPath: path.resolve(args.lock),
    journalPath: path.resolve(args.journal),
    ...adapters,
    fetchAuthorizationComment: adapters.fetchAuthorizationComment,
  });
  process.stdout.write(`${JSON.stringify({ ...summary, mode: 'controlled-apply', apply: applied }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { DEFAULTS, parseArgs, readJson, binding, loadInputs, writeAtomic, controlledGithubAdapters, main };
