#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { validateSourceNoteIssue } = require('./lib/source-note-issue');
const {
  parseSourceNoteBoundaryReviewTransition,
  parseAppliedBoundaryReviewReceipts,
  planSourceNoteBoundaryReviewTransition,
  buildAppliedReceipt,
  renderAppliedReceiptComment,
  sha256Text,
  normalizeLabels,
} = require('./lib/source-note-boundary-review-transition');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { request: null, repo: null, issue: null, outputBody: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--request') out.request = argv[++i];
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--issue') out.issue = Number(argv[++i]);
    else if (arg === '--output-body') out.outputBody = argv[++i];
    else if (arg === '--apply') out.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.request) throw new Error('--request is required');
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
  if (value.length && Array.isArray(value[0])) return value.flat();
  return value;
}

function fetchIssue(repo, issueNumber) {
  return ghJson(['api', `repos/${repo}/issues/${issueNumber}`]);
}

function fetchComments(repo, issueNumber) {
  return flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${repo}/issues/${issueNumber}/comments?per_page=100`]));
}

function planLive(request, repo, issueNumber) {
  const issue = fetchIssue(repo, issueNumber);
  const comments = fetchComments(repo, issueNumber);
  const evidenceComment = comments.find((comment) => Number(comment.id) === request.review_evidence.comment_id) || null;
  const parsedReceipts = parseAppliedBoundaryReviewReceipts(comments);
  if (parsedReceipts.errors.length) {
    return { ok: false, errors: parsedReceipts.errors, issue, comments, plan: null };
  }
  if (!evidenceComment) {
    return { ok: false, errors: [`review evidence comment ${request.review_evidence.comment_id} not found on issue #${issueNumber}`], issue, comments, plan: null };
  }
  const plan = planSourceNoteBoundaryReviewTransition(request, issue, {
    evidenceComment,
    receipts: parsedReceipts.receipts,
  });
  return { ok: plan.ok, errors: plan.errors || [], issue, comments, plan };
}

function sortedLabels(labels) {
  return [...normalizeLabels(labels)].sort();
}

function main() {
  const args = parseArgs();
  const requestText = fs.readFileSync(args.request, 'utf8');
  const parsed = parseSourceNoteBoundaryReviewTransition(requestText);
  if (!parsed.request) throw new Error(parsed.errors.join('; '));
  const request = parsed.request;
  const repo = args.repo || request.repository;
  const issueNumber = args.issue || request.issue_number;
  if (repo !== request.repository) throw new Error('--repo must match request.repository');
  if (issueNumber !== request.issue_number) throw new Error('--issue must match request.issue_number');

  let live = planLive(request, repo, issueNumber);
  if (!live.ok) throw new Error(live.errors.join('; '));
  let plan = live.plan;
  if (args.outputBody) fs.writeFileSync(args.outputBody, plan.next_body);

  if (!args.apply) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: 'plan',
      transition_id: request.transition_id,
      repository: repo,
      issue_number: issueNumber,
      source_note_id: request.source_note_id,
      decision: plan.decision,
      already_applied: plan.already_applied,
      interview_note_ids: plan.interview_note_ids,
      current_body_sha256: plan.current_body_sha256,
      next_body_sha256: plan.next_body_sha256,
      current_labels: plan.current_labels || sortedLabels(live.issue.labels),
      next_labels: plan.next_labels,
      warnings: plan.warnings || [],
      output_body: args.outputBody,
    }, null, 2)}\n`);
    return;
  }

  if (plan.already_applied) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      mode: 'apply',
      already_applied: true,
      transition_id: request.transition_id,
      issue_number: issueNumber,
      decision: plan.decision,
      interview_note_ids: plan.interview_note_ids,
      body_sha256: plan.current_body_sha256,
      receipt_comment_id: plan.receipt && plan.receipt.comment_id || null,
    }, null, 2)}\n`);
    return;
  }

  // Re-read immediately before mutation and repeat every CAS/validation check.
  live = planLive(request, repo, issueNumber);
  if (!live.ok) throw new Error(`pre-apply recheck failed: ${live.errors.join('; ')}`);
  plan = live.plan;
  if (plan.already_applied) {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'apply', already_applied: true, transition_id: request.transition_id }, null, 2)}\n`);
    return;
  }

  ghJson(['api', '--method', 'PATCH', `repos/${repo}/issues/${issueNumber}`, '--input', '-'], {
    body: plan.next_body,
    labels: plan.next_labels,
  });

  const after = fetchIssue(repo, issueNumber);
  const afterBodySha = sha256Text(after.body || '');
  const afterLabels = sortedLabels(after.labels || []);
  const expectedLabels = [...plan.next_labels].sort();
  const validation = validateSourceNoteIssue({ body: after.body || '', labels: afterLabels, state: String(after.state || '').toLowerCase() });
  const postErrors = [];
  if (afterBodySha !== plan.next_body_sha256) postErrors.push(`post-write body SHA mismatch: expected=${plan.next_body_sha256} actual=${afterBodySha}`);
  if (JSON.stringify(afterLabels) !== JSON.stringify(expectedLabels)) postErrors.push(`post-write labels mismatch: expected=${expectedLabels.join(',')} actual=${afterLabels.join(',')}`);
  if (!validation.ok) postErrors.push(...validation.errors.map((error) => `post-write SourceNote invalid: ${error}`));
  if (postErrors.length) throw new Error(postErrors.join('; '));

  const appliedAt = new Date().toISOString();
  const receipt = buildAppliedReceipt(request, plan, appliedAt);
  const receiptComment = ghJson(['api', '--method', 'POST', `repos/${repo}/issues/${issueNumber}/comments`, '--input', '-'], {
    body: renderAppliedReceiptComment(receipt),
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: 'apply',
    already_applied: false,
    transition_id: request.transition_id,
    repository: repo,
    issue_number: issueNumber,
    decision: request.decision,
    interview_note_ids: plan.interview_note_ids,
    previous_body_sha256: plan.current_body_sha256,
    new_body_sha256: afterBodySha,
    labels: afterLabels,
    live_validator: 'PASS',
    receipt_comment_id: receiptComment.id,
  }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, ghJson, flattenPages, fetchIssue, fetchComments, planLive };
