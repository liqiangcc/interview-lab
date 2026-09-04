#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const { validateInterviewNoteIssue } = require('./lib/interview-note-issue');
const {
  parseRequest,
  parseReceipts,
  buildReceipt,
  planSourceReview,
} = require('./lib/interview-note-source-review-transition');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { request: null, apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--request') out.request = argv[++i];
    else if (argv[i] === '--apply') out.apply = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!out.request) throw new Error('--request is required');
  return out;
}
function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  }));
}
function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  return value.length && Array.isArray(value[0]) ? value.flat() : value;
}
function loadIssue(repository, number) { return ghJson(['api', `repos/${repository}/issues/${number}`]); }
function loadAllIssues(repository) { return flattenPages(ghJson(['api','--paginate','--slurp',`repos/${repository}/issues?state=all&per_page=100`])); }
function loadComments(repository, number) { return flattenPages(ghJson(['api','--paginate','--slurp',`repos/${repository}/issues/${number}/comments?per_page=100`])); }
function loadEvidence(repository, commentId) { return ghJson(['api', `repos/${repository}/issues/comments/${commentId}`]); }
function patchLabels(repository, number, labels) { return ghJson(['api','--method','PATCH',`repos/${repository}/issues/${number}`,'--input','-'], { labels }); }
function addComment(repository, number, body) { return ghJson(['api','--method','POST',`repos/${repository}/issues/${number}/comments`,'--input','-'], { body }); }
function labelNames(issue) { return (issue.labels || []).map((x) => typeof x === 'string' ? x : x.name).filter(Boolean); }
function validateLiveInterview(issue) {
  return validateInterviewNoteIssue({ body: issue.body, labels: labelNames(issue), state: String(issue.state || 'open').toLowerCase() });
}
function planLive(request) {
  const interviewIssue = loadIssue(request.repository, request.issue_number);
  const sourceIssue = loadIssue(request.repository, request.source_note_issue_number);
  const comments = loadComments(request.repository, request.issue_number);
  const parsedReceipts = parseReceipts(comments);
  if (parsedReceipts.errors.length) throw new Error(parsedReceipts.errors.join('\n'));
  const evidence = loadEvidence(request.review_evidence.repository, request.review_evidence.comment_id);
  const allIssues = loadAllIssues(request.repository);
  const plan = planSourceReview(request, interviewIssue, {
    sourceIssue,
    allIssues,
    evidenceComment: evidence,
    receipts: parsedReceipts.receipts,
  });
  return { plan, interviewIssue, sourceIssue };
}
function receiptBody(receipt) {
  return `<!-- interview-note-source-review-applied\n${JSON.stringify(receipt, null, 2)}\n-->\n\nSource Review transition applied and post-write validation passed.`;
}
function summary(plan, mode, extra = {}) {
  return {
    ok: plan.ok,
    mode,
    transition_id: plan.request && plan.request.transition_id,
    issue_number: plan.request && plan.request.issue_number,
    interview_note_id: plan.request && plan.request.interview_note_id,
    current_status: plan.current_status,
    decision: plan.request && plan.request.decision,
    computed_checks: plan.computed_checks,
    begin_labels: plan.begin_labels,
    final_labels: plan.final_labels,
    already_applied: plan.already_applied,
    needs_receipt_repair: plan.needs_receipt_repair,
    ...extra,
  };
}
function failPlan(plan) {
  for (const error of plan.errors || []) process.stderr.write(`ERROR: ${error}\n`);
  return 1;
}
function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const parsed = parseRequest(fs.readFileSync(args.request, 'utf8'));
    if (!parsed.request) throw new Error(parsed.errors.join('\n'));
    const request = parsed.request;
    let live = planLive(request);
    if (!live.plan.ok) return failPlan(live.plan);
    if (!args.apply) {
      process.stdout.write(`${JSON.stringify(summary(live.plan, 'plan'), null, 2)}\n`);
      return 0;
    }
    if (live.plan.already_applied) {
      process.stdout.write(`${JSON.stringify(summary(live.plan, 'apply', { live_validator: 'PASS', receipt_comment_id: live.plan.receipt.comment_id }), null, 2)}\n`);
      return 0;
    }
    if (live.plan.needs_receipt_repair) {
      const validation = validateLiveInterview(live.interviewIssue);
      if (!validation.ok) throw new Error(`cannot repair receipt for invalid final InterviewNote: ${validation.errors.join('; ')}`);
      const receipt = buildReceipt(request, request.decision, new Date().toISOString());
      const comment = addComment(request.repository, request.issue_number, receiptBody(receipt));
      live = planLive(request);
      if (!live.plan.ok || !live.plan.already_applied) throw new Error(`receipt repair did not converge: ${(live.plan.errors || []).join('; ')}`);
      process.stdout.write(`${JSON.stringify(summary(live.plan, 'apply', { live_validator: 'PASS', repaired_receipt: true, receipt_comment_id: Number(comment.id) }), null, 2)}\n`);
      return 0;
    }
    if (live.plan.needs_begin) {
      live = planLive(request);
      if (!live.plan.ok || !live.plan.needs_begin) throw new Error('pre-begin CAS changed; refusing lifecycle write');
      patchLabels(request.repository, request.issue_number, live.plan.begin_labels);
      const begun = loadIssue(request.repository, request.issue_number);
      const validation = validateLiveInterview(begun);
      if (!validation.ok) throw new Error(`source-review intermediate state invalid: ${validation.errors.join('; ')}`);
      if (!labelNames(begun).includes('status:source-review') || !labelNames(begun).includes('task:source-review')) throw new Error('source-review intermediate labels not durable');
    }
    live = planLive(request);
    if (!live.plan.ok) return failPlan(live.plan);
    if (live.plan.current_status !== 'source-review') throw new Error(`completion requires status:source-review, found ${live.plan.current_status}`);
    patchLabels(request.repository, request.issue_number, live.plan.final_labels);
    const finalIssue = loadIssue(request.repository, request.issue_number);
    const finalValidation = validateLiveInterview(finalIssue);
    if (!finalValidation.ok) throw new Error(`post-write InterviewNote validator failed: ${finalValidation.errors.join('; ')}`);
    if (!labelNames(finalIssue).includes(`status:${request.decision}`)) throw new Error('final lifecycle label not durable');
    const receipt = buildReceipt(request, request.decision, new Date().toISOString());
    const comment = addComment(request.repository, request.issue_number, receiptBody(receipt));
    live = planLive(request);
    if (!live.plan.ok || !live.plan.already_applied) throw new Error(`post-write source-review verification did not converge: ${(live.plan.errors || []).join('; ')}`);
    process.stdout.write(`${JSON.stringify(summary(live.plan, 'apply', { live_validator: 'PASS', repaired_receipt: false, receipt_comment_id: Number(comment.id) }), null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    return 1;
  }
}
if (require.main === module) process.exitCode = main();
module.exports = { main, parseArgs, ghJson, planLive };
