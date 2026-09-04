#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  parseMarker,
  parseReceipts,
  planBatch,
  receiptFor,
  receiptBody,
  sha256Text,
  normalizeLabels,
} = require('./lib/interview-context-batch');

const DEFAULT_CONTEXT_DIR = path.resolve('data/interview-contexts');

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ghJson(args, input = null, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return JSON.parse(execFileSync('gh', args, {
        input: input == null ? undefined : JSON.stringify(input),
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }));
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepMs(500 * attempt);
    }
  }
  const stderr = lastError && lastError.stderr ? String(lastError.stderr).trim() : '';
  throw new Error(`gh command failed: ${stderr || lastError.message}`);
}

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.length && Array.isArray(value[0]) ? value.flat() : value;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    request: null,
    apply: false,
    maxItems: 50,
    rateLimitMs: 1000,
    contextDir: DEFAULT_CONTEXT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--request') out.request = argv[++index];
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--max-items') out.maxItems = Number(argv[++index]);
    else if (arg === '--rate-limit-ms') out.rateLimitMs = Number(argv[++index]);
    else if (arg === '--context-dir') out.contextDir = path.resolve(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.request) throw new Error('--request is required');
  if (!Number.isInteger(out.maxItems) || out.maxItems < 1 || out.maxItems > 50) throw new Error('--max-items must be an integer between 1 and 50');
  if (!Number.isInteger(out.rateLimitMs) || out.rateLimitMs < 0) throw new Error('--rate-limit-ms must be a non-negative integer');
  return out;
}

function loadIssue(repository, number) {
  return ghJson(['api', `repos/${repository}/issues/${number}`]);
}

function loadComments(repository, number) {
  return flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`]));
}

function readRequest(file) {
  const parsed = parseMarker(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!parsed.request) throw new Error(parsed.errors.join('; '));
  return parsed.request;
}

function loadLive(request) {
  const dependencies = request.dependency_issues.map((number) => loadIssue(request.repository, number));
  if (dependencies.some((issue) => String(issue.state || '').toLowerCase() !== 'closed')) return { dependencies, issues: [], receiptsByIssue: new Map() };
  const issues = request.items.map((item) => loadIssue(request.repository, item.issue_number));
  const receiptsByIssue = new Map();
  for (const issue of issues) {
    const parsed = parseReceipts(loadComments(request.repository, issue.number));
    if (parsed.errors.length) throw new Error(`Issue #${issue.number}: ${parsed.errors.join('; ')}`);
    receiptsByIssue.set(Number(issue.number), parsed.receipts);
  }
  return { dependencies, issues, receiptsByIssue };
}

function contextFilePath(contextDir, interviewNoteId) {
  const safeId = String(interviewNoteId).replace(/[^A-Za-z0-9_-]/g, '-');
  return path.join(contextDir, `${safeId}.v1.json`);
}

function assertContextFiles(plan, contextDir) {
  for (const item of plan.items) {
    if (!item.ok) continue;
    const file = contextFilePath(contextDir, item.projection.interview_note_id);
    if (!fs.existsSync(file)) continue;
    const existing = fs.readFileSync(file, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(existing);
    } catch (error) {
      throw new Error(`context file ${file} is invalid JSON: ${error.message}`);
    }
    if (sha256Text(JSON.stringify(parsed)) !== item.projection.context_sha256) {
      throw new Error(`context file ${file} conflicts with requested reviewed Context; refusing to overwrite`);
    }
  }
}

function writeContext(item, contextDir) {
  fs.mkdirSync(contextDir, { recursive: true });
  const file = contextFilePath(contextDir, item.projection.interview_note_id);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify(item.projection.context, null, 2)}\n`, 'utf8');
  return file;
}

function patchIssue(request, item) {
  return ghJson(['api', '--method', 'PATCH', `repos/${request.repository}/issues/${item.issue_number}`, '--input', '-'], {
    title: item.projection.title,
    labels: item.projection.labels,
  });
}

function addReceipt(request, item, appliedAt) {
  const receipt = receiptFor(request, item, appliedAt);
  const comment = ghJson(['api', '--method', 'POST', `repos/${request.repository}/issues/${item.issue_number}/comments`, '--input', '-'], {
    body: receiptBody(receipt),
  });
  return { receipt, comment };
}

function verifyLive(request, item) {
  const live = loadIssue(request.repository, item.issue_number);
  const labels = normalizeLabels(live.labels || []);
  if (sha256Text(live.body || '') !== item.current_body_sha256) throw new Error(`Issue #${item.issue_number} body changed during apply; refusing to continue`);
  if (String(live.title || '') !== item.projection.title) throw new Error(`Issue #${item.issue_number} title did not converge`);
  if (JSON.stringify(labels) !== JSON.stringify(item.projection.labels)) throw new Error(`Issue #${item.issue_number} labels did not converge`);
  const { validateInterviewNoteIssue } = require('./lib/interview-note-issue');
  const validation = validateInterviewNoteIssue({ body: live.body, labels, state: String(live.state || 'open').toLowerCase() });
  if (!validation.ok) throw new Error(`Issue #${item.issue_number} post-write validator failed: ${validation.errors.join('; ')}`);
  return live;
}

function report(plan, mode, extra = {}) {
  return {
    ok: plan.ok,
    mode,
    blocked: plan.blocked,
    errors: plan.errors,
    summary: plan.summary,
    items: plan.items.map((item) => ({
      issue_number: item.issue_number,
      action: item.action,
      errors: item.errors,
      unknown_facts: item.unknown_facts,
      title: item.projection && item.projection.title,
      labels: item.projection && item.projection.labels,
      context_sha256: item.projection && item.projection.context_sha256,
    })),
    ...extra,
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const request = readRequest(args.request);
  if (!Number.isInteger(request.pilot_size) || request.pilot_size > args.maxItems) throw new Error(`request pilot_size=${request.pilot_size} exceeds --max-items=${args.maxItems}; no mutation attempted`);
  let live = loadLive(request);
  let plan = planBatch(request, live);
  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(report(plan, 'plan'), null, 2)}\n`);
    return 0;
  }
  if (!plan.ok) {
    process.stdout.write(`${JSON.stringify(report(plan, 'apply-blocked'), null, 2)}\n`);
    return 1;
  }
  assertContextFiles(plan, args.contextDir);

  // Re-read all dependencies, Issues and receipts immediately before the first write.
  live = loadLive(request);
  plan = planBatch(request, live);
  if (!plan.ok) {
    process.stdout.write(`${JSON.stringify(report(plan, 'apply-blocked-after-recheck'), null, 2)}\n`);
    return 1;
  }

  const applied = [];
  for (const item of plan.items) {
    if (item.action === 'already_applied') {
      applied.push({ issue_number: item.issue_number, action: item.action });
      continue;
    }
    // Persist the reviewed Derived artifact before projecting it into the Issue.
    const contextFile = writeContext(item, args.contextDir);
    if (item.action === 'update') {
      patchIssue(request, item);
      verifyLive(request, item);
      sleepMs(args.rateLimitMs);
    }
    const receiptResult = addReceipt(request, item, new Date().toISOString());
    sleepMs(args.rateLimitMs);
    const final = loadIssue(request.repository, item.issue_number);
    const finalBodySha = sha256Text(final.body || '');
    if (finalBodySha !== item.current_body_sha256) throw new Error(`Issue #${item.issue_number} body changed after receipt; recovery required`);
    applied.push({ issue_number: item.issue_number, action: item.action, context_file: contextFile, receipt_comment_id: Number(receiptResult.comment.id) });
  }
  process.stdout.write(`${JSON.stringify(report(plan, 'apply', { applied }), null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
  parseMarker,
  planBatch,
  contextFilePath,
  assertContextFiles,
  report,
};
