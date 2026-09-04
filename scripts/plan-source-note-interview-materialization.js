#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const {
  sha256Text,
  parseMaterializationRequest,
  parseMaterializationReceipts,
  planMaterialization,
  findOwnershipMatches,
} = require('./lib/source-note-interview-materialization');
const { validateInterviewNoteIssue } = require('./lib/interview-note-issue');

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ghRaw(args, input = null, attempts = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return execFileSync('gh', args, {
        input: input == null ? undefined : JSON.stringify(input),
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) sleepMs(800 * attempt);
    }
  }
  const stderr = lastError && lastError.stderr ? String(lastError.stderr).trim() : '';
  throw new Error(`gh command failed: ${stderr || lastError.message}`);
}

function ghJson(args, input = null, attempts = 3) {
  return JSON.parse(ghRaw(args, input, attempts));
}

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  if (value.length && Array.isArray(value[0])) return value.flat();
  return value;
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { request: null, apply: false, outputBody: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--request') out.request = argv[++i];
    else if (arg === '--apply') out.apply = true;
    else if (arg === '--output-body') out.outputBody = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.request) throw new Error('--request is required');
  return out;
}

function loadSourceIssue(repository, number) {
  return ghJson(['api', `repos/${repository}/issues/${number}`]);
}

function loadSourceComments(repository, number) {
  return flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`]));
}

function loadAllIssues(repository) {
  return flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${repository}/issues?state=all&per_page=100`]));
}

function labelsOf(issue) {
  return (issue.labels || []).map((label) => typeof label === 'string' ? label : label.name).sort();
}

function waitForOwnership(repository, interviewNoteId, expectedIssueNumber, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 6;
  const scan = typeof options.scan === 'function'
    ? options.scan
    : () => findOwnershipMatches(loadAllIssues(repository), interviewNoteId);
  const sleep = typeof options.sleep === 'function' ? options.sleep : sleepMs;

  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const matches = scan();
    last = matches;
    if (matches.length > 1) {
      throw new Error(`post-create duplicate ownership conflict for ${interviewNoteId}: ${matches.map((issue) => issue.number).join(',')}`);
    }
    if (matches.length === 1) {
      const actual = Number(matches[0].number);
      if (actual !== Number(expectedIssueNumber)) {
        throw new Error(`post-create ownership points to unexpected Issue #${actual}; expected #${expectedIssueNumber}`);
      }
      return matches;
    }
    if (attempt < attempts) sleep(500 * attempt);
  }
  throw new Error(`post-create ownership invariant did not become visible after ${attempts} scans: expected Issue #${expectedIssueNumber}, found ${last.map((issue) => issue.number).join(',')}`);
}

function loadPlan(request) {
  const sourceIssue = loadSourceIssue(request.repository, request.source_note_issue_number);
  const comments = loadSourceComments(request.repository, request.source_note_issue_number);
  const issues = loadAllIssues(request.repository);
  const receipts = parseMaterializationReceipts(comments);
  const plan = planMaterialization(request, {
    repository: request.repository,
    sourceIssue,
    issues,
    receipts,
  });
  return { plan, sourceIssue, comments, issues };
}

function buildReceipt(request, plan, issueNumber, materializedAt) {
  return {
    schema_version: 'source-note-interview-materialized.v1',
    materialization_id: request.materialization_id,
    request_sha256: plan.request_sha256,
    repository: request.repository,
    source_note_issue_number: request.source_note_issue_number,
    source_note_id: request.source_note_id,
    source_note_body_sha256: request.expected_source_note_body_sha256,
    source_revision_id: request.expected_source_revision_id,
    manifest_sha256: request.expected_manifest_sha256 ?? null,
    source_repository_ref: request.expected_source_repository_ref ?? null,
    interview_note_id: plan.interview_note_id,
    interview_issue_number: Number(issueNumber),
    interview_issue_body_sha256: sha256Text(plan.projection.body),
    materialized_at: materializedAt,
  };
}

function receiptBody(receipt) {
  return `<!-- source-note-interview-materialized\n${JSON.stringify(receipt, null, 2)}\n-->\n\nInterviewNote materialization completed and post-create validation passed.`;
}

function createInterviewIssue(request, projection) {
  return ghJson(['api', '--method', 'POST', `repos/${request.repository}/issues`, '--input', '-'], {
    title: projection.title,
    body: projection.body,
    labels: projection.labels,
  });
}

function addReceiptComment(request, receipt) {
  return ghJson(['api', '--method', 'POST', `repos/${request.repository}/issues/${request.source_note_issue_number}/comments`, '--input', '-'], {
    body: receiptBody(receipt),
  });
}

function main() {
  const args = parseArgs();
  const parsed = parseMaterializationRequest(fs.readFileSync(args.request, 'utf8'));
  if (!parsed.request) {
    for (const error of parsed.errors) console.error(`ERROR: ${error}`);
    return 1;
  }
  const request = parsed.request;
  let loaded = loadPlan(request);
  let plan = loaded.plan;
  if (!plan.ok) {
    for (const error of plan.errors) console.error(`ERROR: ${error}`);
    return 1;
  }
  if (args.outputBody) fs.writeFileSync(args.outputBody, plan.projection.body);

  if (!args.apply) {
    console.log(JSON.stringify({
      ok: true,
      mode: 'plan',
      materialization_id: request.materialization_id,
      source_note_issue_number: request.source_note_issue_number,
      source_note_id: request.source_note_id,
      source_note_body_sha256: plan.source_note_body_sha256,
      interview_note_id: plan.interview_note_id,
      action: plan.action,
      ownership_count: plan.ownership_count,
      existing_issue_number: plan.existing_issue_number,
      already_materialized: plan.already_materialized,
      needs_receipt_repair: plan.needs_receipt_repair,
      proposed_title: plan.projection.title,
      proposed_labels: plan.projection.labels,
      proposed_body_sha256: sha256Text(plan.projection.body),
      output_body: args.outputBody,
    }, null, 2));
    return 0;
  }

  // Apply gate: read everything again immediately before any write.
  loaded = loadPlan(request);
  plan = loaded.plan;
  if (!plan.ok) {
    for (const error of plan.errors) console.error(`ERROR: ${error}`);
    return 1;
  }

  let interviewIssueNumber = plan.existing_issue_number;
  let created = false;
  let repairedReceipt = false;
  if (plan.action === 'create') {
    const createdIssue = createInterviewIssue(request, plan.projection);
    interviewIssueNumber = Number(createdIssue.number);
    created = true;
  }

  const liveInterview = loadSourceIssue(request.repository, interviewIssueNumber);
  const liveLabels = labelsOf(liveInterview);
  const liveValidation = validateInterviewNoteIssue({ body: liveInterview.body, labels: liveLabels, state: liveInterview.state });
  if (!liveValidation.ok) throw new Error(`post-create InterviewNote validator failed: ${liveValidation.errors.join('; ')}`);
  if (sha256Text(liveInterview.body) !== sha256Text(plan.projection.body)) throw new Error('post-create InterviewNote body digest mismatch');
  if (JSON.stringify(liveLabels) !== JSON.stringify([...plan.projection.labels].sort())) throw new Error('post-create InterviewNote labels mismatch');

  const ownershipAfter = waitForOwnership(request.repository, plan.interview_note_id, interviewIssueNumber);
  if (ownershipAfter.length !== 1) throw new Error('post-create ownership invariant failed after retry');

  let receiptCommentId = plan.receipt ? Number(plan.receipt.comment_id) : null;
  if (!plan.receipt) {
    const receipt = buildReceipt(request, plan, interviewIssueNumber, new Date().toISOString());
    const comment = addReceiptComment(request, receipt);
    receiptCommentId = Number(comment.id);
    repairedReceipt = !created;
  }

  // Final re-plan must now resolve as existing + receipt.
  const finalLoaded = loadPlan(request);
  const finalPlan = finalLoaded.plan;
  if (!finalPlan.ok) throw new Error(`final materialization re-plan failed: ${finalPlan.errors.join('; ')}`);
  if (!finalPlan.already_materialized || finalPlan.existing_issue_number !== interviewIssueNumber) throw new Error('final idempotency state was not established');

  console.log(JSON.stringify({
    ok: true,
    mode: 'apply',
    materialization_id: request.materialization_id,
    source_note_issue_number: request.source_note_issue_number,
    interview_note_id: plan.interview_note_id,
    interview_issue_number: interviewIssueNumber,
    created,
    repaired_receipt: repairedReceipt,
    already_materialized: !created,
    live_validator: 'PASS',
    ownership_count: 1,
    interview_issue_body_sha256: sha256Text(liveInterview.body),
    receipt_comment_id: receiptCommentId,
  }, null, 2));
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  waitForOwnership,
};
