#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  parseMarker, parseReceipts, parseIssueCommentUrl, planBatch, receiptFor, receiptBody,
  sha256Text, normalizeLabels, validateLiveDependencyGate, verifyContextArtifact, planDigest,
} = require('./lib/interview-context-batch');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./lib/interview-note-issue');
const { validateInterviewContext } = require('./lib/interview-context');

const DEFAULT_CONTEXT_DIR = path.resolve('data/interview-contexts');
const DEFAULT_GATE_FILE = path.resolve('data/pilot/issue-923/dependency-gate.json');
const PAGE_SIZE = 100;
const PILOT_TARGET = 50;

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runGhJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

function ghReadJson(args, input = null, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return runGhJson(args, input); } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepMs(500 * attempt);
    }
  }
  const stderr = lastError && lastError.stderr ? String(lastError.stderr).trim() : '';
  throw new Error(`gh read command failed: ${stderr || lastError.message}`);
}

function ghMutationJson(args, input = null) {
  try { return runGhJson(args, input); } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : '';
    throw new Error(`gh mutation command failed without retry: ${stderr || error.message}`);
  }
}

function paginate(readPage, label) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = readPage(page);
    if (!Array.isArray(batch)) throw new Error(`${label} page ${page} did not return an array`);
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all;
  }
  throw new Error(`${label} exceeded the 100-page safety bound`);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { request: null, inventory: false, apply: false, maxItems: 50, maxMutations: null, confirmDryRunDigest: null, rateLimitMs: 1000, contextDir: DEFAULT_CONTEXT_DIR, dependencyGateFile: DEFAULT_GATE_FILE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--request') out.request = argv[++index];
    else if (arg === '--inventory') out.inventory = true;
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--max-items') out.maxItems = Number(argv[++index]);
    else if (arg === '--max-mutations') out.maxMutations = Number(argv[++index]);
    else if (arg === '--confirm-dry-run-digest') out.confirmDryRunDigest = argv[++index];
    else if (arg === '--rate-limit-ms') out.rateLimitMs = Number(argv[++index]);
    else if (arg === '--context-dir') out.contextDir = path.resolve(argv[++index]);
    else if (arg === '--dependency-gate-file') out.dependencyGateFile = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.inventory && !out.request) throw new Error('--request or --inventory is required');
  if (out.inventory && out.apply) throw new Error('--inventory is read-only and cannot be combined with --apply');
  if (out.apply && !/^[0-9a-f]{64}$/.test(out.confirmDryRunDigest || '')) throw new Error('--apply requires --confirm-dry-run-digest <native dry-run SHA-256>');
  if (out.apply && (!Number.isInteger(out.maxMutations) || out.maxMutations < 0 || out.maxMutations > 50)) throw new Error('--apply requires --max-mutations between 0 and 50');
  if (!Number.isInteger(out.maxItems) || out.maxItems < 1 || out.maxItems > 50) throw new Error('--max-items must be an integer between 1 and 50');
  if (!Number.isInteger(out.rateLimitMs) || out.rateLimitMs < 0) throw new Error('--rate-limit-ms must be a non-negative integer');
  return out;
}

function loadIssue(repository, number) { return ghReadJson(['api', `repos/${repository}/issues/${number}`]); }

function loadComments(repository, number, options = {}) {
  const readPage = options.readPage || ((page) => ghReadJson(['api', `repos/${repository}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`]));
  return paginate((page) => readPage(page, `repos/${repository}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`), `Issue #${number} comments`);
}

function loadAllIssues(repository, options = {}) {
  const readPage = options.readPage || ((page) => ghReadJson(['api', `repos/${repository}/issues?state=all&labels=type%3Ainterview-note&per_page=${PAGE_SIZE}&page=${page}`]));
  const issues = paginate((page) => readPage(page, `repos/${repository}/issues?state=all&labels=type%3Ainterview-note&per_page=${PAGE_SIZE}&page=${page}`), `${repository} type:interview-note issues`);
  if (issues.some((issue) => issue.pull_request || !normalizeLabels(issue.labels || []).includes('type:interview-note'))) throw new Error('label-filtered inventory returned a non-InterviewNote object; refusing incomplete inventory');
  return issues;
}

function readRequest(file) {
  const parsed = parseMarker(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!parsed.request) throw new Error(parsed.errors.join('; '));
  return parsed.request;
}

function readDependencyGate(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, gate: JSON.parse(raw), sha256: sha256Text(raw) };
}

function loadDependencyEvidence(repository, gate) {
  const evidence = new Map();
  for (const entry of Object.values(gate.dependencies || {})) {
    for (const url of [entry.evidence, entry.acceptance_evidence]) {
      const parsed = parseIssueCommentUrl(repository, entry.issue_number, url);
      if (parsed) evidence.set(url, ghReadJson(['api', `repos/${repository}/issues/comments/${parsed.comment_id}`]));
    }
  }
  return evidence;
}

function loadLive(request, dependencyGateArtifact, dependencyEvidence, contextArtifactResults = null) {
  const dependencies = request.dependency_issues.map((number) => loadIssue(request.repository, number));
  const liveGate = validateLiveDependencyGate(dependencyGateArtifact, request.repository, dependencies, dependencyEvidence);
  if (!liveGate.ok) return { dependencies, issues: [], receiptsByIssue: new Map(), dependencyGateArtifact, dependencyEvidence, contextArtifactResults, liveGate };
  const issues = request.items.map((item) => loadIssue(request.repository, item.issue_number));
  const receiptsByIssue = new Map();
  for (const issue of issues) {
    const parsed = parseReceipts(loadComments(request.repository, issue.number));
    if (parsed.errors.length) throw new Error(`Issue #${issue.number}: ${parsed.errors.join('; ')}`);
    receiptsByIssue.set(Number(issue.number), parsed.receipts);
  }
  return { dependencies, issues, receiptsByIssue, dependencyGateArtifact, dependencyEvidence, contextArtifactResults, liveGate };
}

function remoteContextArtifactResults(request) {
  const results = new Map();
  for (const item of request.items) {
    const artifact = item.context_artifact;
    const refName = artifact && artifact.ref ? artifact.ref.replace(/^refs\/(heads|tags)\//, 'git/ref/$1/') : '';
    results.set(Number(item.issue_number), verifyContextArtifact(item.context, artifact, request.repository, {
      readRef: () => ghReadJson(['api', `repos/${request.repository}/${refName}`]),
      readCommit: (commit) => ghReadJson(['api', `repos/${request.repository}/commits/${commit}`]),
      readContent: (artifactPath, commit) => {
        const value = ghReadJson(['api', `repos/${request.repository}/contents/${artifactPath}?ref=${commit}`]);
        if (value.type !== 'file' || typeof value.content !== 'string') throw new Error('GitHub contents response is not a file');
        return Buffer.from(value.content.replace(/\n/g, ''), 'base64').toString('utf8');
      },
    }));
  }
  return results;
}

function contextInventory(contextDir) {
  const byInterviewNote = new Map();
  if (!fs.existsSync(contextDir)) return byInterviewNote;
  for (const name of fs.readdirSync(contextDir).filter((value) => value.endsWith('.json')).sort()) {
    const file = path.join(contextDir, name);
    try {
      const context = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (validateInterviewContext(context).ok) byInterviewNote.set(context.interview_note_id, { path: file, context });
    } catch (error) {
      // Invalid local Derived artifacts are deliberately not used as facts.
    }
  }
  return byInterviewNote;
}

function buildInventoryReport(issues, contextDir) {
  const contexts = contextInventory(contextDir);
  const report = {
    schema_version: 'interview-context-learning-discovery-inventory.v1', dry_run: true, mutation_count: 0,
    pilot_target: PILOT_TARGET, interview_note_count: 0, valid_interview_note_count: 0,
    source_ready_count: 0, eligible_count: 0, source_ready_missing_context_count: 0,
    source_review_blocked_count: 0, reviewed_context_count: contexts.size,
    gap_to_50_source_ready: PILOT_TARGET, gap_to_50_eligible: PILOT_TARGET, source_ready_issue_numbers: [],
  };
  for (const issue of issues) {
    const labels = normalizeLabels(issue.labels || []);
    if (!labels.includes('type:interview-note')) continue;
    report.interview_note_count += 1;
    const parsed = parseInterviewNoteIssue(issue.body || '');
    const validation = validateInterviewNoteIssue({ body: issue.body || '', labels, state: String(issue.state || 'open').toLowerCase() });
    if (!parsed.marker || !parsed.record || !validation.ok || parsed.record.schema_version !== 'interview-note-issue.v2') continue;
    report.valid_interview_note_count += 1;
    if (labels.includes('status:source-ready')) {
      report.source_ready_count += 1;
      report.source_ready_issue_numbers.push(Number(issue.number));
      if (contexts.has(parsed.record.interview_note_id)) report.eligible_count += 1;
      else report.source_ready_missing_context_count += 1;
    }
    if (labels.includes('status:blocked') && labels.includes('task:source-recovery')) report.source_review_blocked_count += 1;
  }
  report.gap_to_50_source_ready = Math.max(0, PILOT_TARGET - report.source_ready_count);
  report.gap_to_50_eligible = Math.max(0, PILOT_TARGET - report.eligible_count);
  return report;
}

function patchIssue(request, item) {
  return ghMutationJson(['api', '--method', 'PATCH', `repos/${request.repository}/issues/${item.issue_number}`, '--input', '-'], { title: item.projection.title, labels: item.projection.labels });
}

function addReceipt(request, item, appliedAt) {
  const receipt = receiptFor(request, item, appliedAt);
  const comment = ghMutationJson(['api', '--method', 'POST', `repos/${request.repository}/issues/${item.issue_number}/comments`, '--input', '-'], { body: receiptBody(receipt) });
  return { receipt, comment };
}

function verifyLive(request, item) {
  const live = loadIssue(request.repository, item.issue_number);
  const labels = normalizeLabels(live.labels || []);
  if (sha256Text(live.body || '') !== item.current_body_sha256) throw new Error(`Issue #${item.issue_number} body changed during apply; refusing to continue`);
  if (String(live.title || '') !== item.projection.title) throw new Error(`Issue #${item.issue_number} title did not converge`);
  if (JSON.stringify(labels) !== JSON.stringify(item.projection.labels)) throw new Error(`Issue #${item.issue_number} labels did not converge`);
  const validation = validateInterviewNoteIssue({ body: live.body, labels, state: String(live.state || 'open').toLowerCase() });
  if (!validation.ok) throw new Error(`Issue #${item.issue_number} post-write validator failed: ${validation.errors.join('; ')}`);
  return live;
}

function report(plan, mode, extra = {}) {
  return { ok: plan.ok, mode, blocked: plan.blocked, errors: plan.errors, summary: plan.summary,
    items: plan.items.map((item) => ({ issue_number: item.issue_number, action: item.action, errors: item.errors, unknown_facts: item.unknown_facts,
      title: item.projection && item.projection.title, labels: item.projection && item.projection.labels,
      context_sha256: item.projection && item.projection.context_sha256, context_artifact: item.projection && item.projection.context_artifact })), ...extra };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const gate = readDependencyGate(args.dependencyGateFile);
  const repository = 'liqiangcc/interview-lab';
  const dependencies = [917, 920, 921, 922].map((number) => loadIssue(repository, number));
  const dependencyEvidence = loadDependencyEvidence(repository, gate.gate);
  const liveGate = validateLiveDependencyGate(gate.gate, repository, dependencies, dependencyEvidence);
  if (!liveGate.ok) {
    if (args.inventory) {
      process.stdout.write(`${JSON.stringify({ schema_version: 'interview-context-learning-discovery-inventory.v1', dry_run: true, mutation_count: 0, dependency_gate: liveGate, pilot_target: PILOT_TARGET }, null, 2)}\n`);
      return 1;
    }
    throw new Error(liveGate.errors.join('; '));
  }
  if (args.inventory) {
    const issues = loadAllIssues(repository);
    process.stdout.write(`${JSON.stringify({ dependency_gate: liveGate, inventory: buildInventoryReport(issues, args.contextDir) }, null, 2)}\n`);
    return 0;
  }
  const request = readRequest(args.request);
  if (!Number.isInteger(request.pilot_size) || request.pilot_size > args.maxItems) throw new Error(`request pilot_size=${request.pilot_size} exceeds --max-items=${args.maxItems}; no mutation attempted`);
  if (request.repository !== repository) throw new Error(`request.repository must be ${repository}`);
  if (request.dependency_gate_file !== path.relative(process.cwd(), args.dependencyGateFile)) throw new Error('request dependency_gate_file does not match the selected gate artifact');
  if (request.expected_dependency_gate_sha256 !== gate.sha256) throw new Error(`dependency gate digest mismatch: expected=${request.expected_dependency_gate_sha256} live=${gate.sha256}`);
  const contextArtifactResults = remoteContextArtifactResults(request);
  let live = loadLive(request, gate.gate, dependencyEvidence, contextArtifactResults);
  let plan = planBatch(request, live);
  const dryRunDigest = planDigest(plan);
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(report(plan, 'plan', { dependency_gate: live.liveGate, dry_run_digest: dryRunDigest }), null, 2)}\n`);
    return plan.ok ? 0 : 1;
  }
  if (args.confirmDryRunDigest !== dryRunDigest) throw new Error(`--confirm-dry-run-digest does not match native dry-run digest ${dryRunDigest}; no mutation attempted`);
  if ((plan.summary && plan.summary.mutation_count) > args.maxMutations) throw new Error(`native dry-run mutation_count=${plan.summary.mutation_count} exceeds --max-mutations=${args.maxMutations}; no mutation attempted`);
  if (!plan.ok) {
    process.stdout.write(`${JSON.stringify(report(plan, 'apply-blocked', { dependency_gate: live.liveGate, dry_run_digest: dryRunDigest }), null, 2)}\n`);
    return 1;
  }

  const recheckedEvidence = loadDependencyEvidence(request.repository, gate.gate);
  const recheckedGate = validateLiveDependencyGate(gate.gate, request.repository, request.dependency_issues.map((number) => loadIssue(request.repository, number)), recheckedEvidence);
  if (!recheckedGate.ok) {
    process.stdout.write(`${JSON.stringify(report(plan, 'apply-blocked-after-recheck', { dependency_gate: recheckedGate }), null, 2)}\n`);
    return 1;
  }
  live = loadLive(request, gate.gate, recheckedEvidence, remoteContextArtifactResults(request));
  plan = planBatch(request, live);
  if (planDigest(plan) !== dryRunDigest) {
    process.stdout.write(`${JSON.stringify(report(plan, 'apply-blocked-after-recheck', { dependency_gate: live.liveGate, dry_run_digest: planDigest(plan), confirmed_dry_run_digest: dryRunDigest }), null, 2)}\n`);
    return 1;
  }
  if (!plan.ok) {
    process.stdout.write(`${JSON.stringify(report(plan, 'apply-blocked-after-recheck', { dependency_gate: live.liveGate, dry_run_digest: dryRunDigest }), null, 2)}\n`);
    return 1;
  }

  const applied = [];
  for (const item of plan.items) {
    if (item.action === 'already_applied') {
      applied.push({ issue_number: item.issue_number, action: item.action, context_artifact: item.projection.context_artifact, receipt_comment_id: item.receipt.comment_id });
      continue;
    }
    if (item.action === 'update') {
      patchIssue(request, item);
      verifyLive(request, item);
      sleepMs(args.rateLimitMs);
    }
    const receiptResult = item.receipt ? { receipt: item.receipt, comment: { id: item.receipt.comment_id } } : addReceipt(request, item, new Date().toISOString());
    if (!item.receipt) sleepMs(args.rateLimitMs);
    const final = loadIssue(request.repository, item.issue_number);
    if (sha256Text(final.body || '') !== item.current_body_sha256) throw new Error(`Issue #${item.issue_number} body changed after receipt; recovery required`);
    applied.push({ issue_number: item.issue_number, action: item.action, context_artifact: item.projection.context_artifact, receipt_comment_id: Number(receiptResult.comment.id) });
  }
  process.stdout.write(`${JSON.stringify(report(plan, 'apply', { applied, dry_run_digest: dryRunDigest, confirmed_dry_run_digest: args.confirmDryRunDigest }), null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { parseArgs, paginate, loadComments, loadAllIssues, buildInventoryReport, parseMarker, planBatch, report };
