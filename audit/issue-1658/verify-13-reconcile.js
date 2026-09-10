#!/usr/bin/env node
'use strict';

// Offline audit verifier. It reads only the committed repro-input snapshot and
// never calls GitHub or writes business data.
const fs = require('node:fs');
const path = require('node:path');
const {
  buildMaterializationRequest,
  issueSourceRecord,
} = require('../../scripts/lib/interview-note-materialization-batch');
const {
  buildInterviewProjection,
  parseMaterializationReceipts,
  sha256Text,
} = require('../../scripts/lib/source-note-interview-materialization');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('../../scripts/lib/interview-note-issue');

const SCOPE = [1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458];
const FULL_PLAN = path.resolve(__dirname, 'full-plan-summary.json');

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function labelsOf(issue) { return (issue.labels || []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean).sort(); }
function markerValues(body, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<!--\\s*${escaped}\\n([\\s\\S]*?)\\n-->`, 'g');
  return [...String(body || '').matchAll(re)].map((match) => JSON.parse(match[1].trim()));
}
function assert(condition, message) { if (!condition) throw new Error(message); }

function main(argv = process.argv.slice(2)) {
  const inputFile = argv[0] || path.join(__dirname, 'repro-input.json');
  const outputFile = argv[1] || path.join(__dirname, '13-reconcile.json');
  const input = readJson(inputFile);
  const fullPlan = readJson(FULL_PLAN);
  assert(JSON.stringify(input.scope) === JSON.stringify(SCOPE), 'snapshot scope is not the authorized 13 rows');
  assert(input.rows.length === SCOPE.length, 'snapshot row count is not 13');
  const targets = [];

  for (const row of input.rows) {
    const source = row.source;
    const owner = row.owner;
    const sourceNumber = Number(source.number);
    assert(SCOPE.includes(sourceNumber), `unexpected SourceNote #${sourceNumber}`);
    const { validation, parsed } = issueSourceRecord(source);
    assert(validation.ok && parsed, `SourceNote #${sourceNumber} failed source validation`);
    const projection = buildInterviewProjection(source, validation);
    const expectedLabels = [...projection.labels].sort();
    const actualLabels = labelsOf(owner);
    const ownerParsed = parseInterviewNoteIssue(owner.body || '');
    const ownerMatches = input.rows.filter((candidate) => {
      const parsedOwner = parseInterviewNoteIssue(candidate.owner.body || '');
      return parsedOwner.marker && parsedOwner.marker.interview_note_id === projection.interview_note_id;
    });
    const ownerBodySha = sha256Text(owner.body || '');
    const ownerValidation = validateInterviewNoteIssue({ body: owner.body, labels: actualLabels, state: owner.state });
    const ownerFact = ownerMatches.length === 1
      && Number(owner.number) === Number(row.owner.number)
      && ownerParsed.marker?.interview_note_id === projection.interview_note_id
      && owner.title === projection.title
      && ownerBodySha === sha256Text(projection.body)
      && JSON.stringify(actualLabels) === JSON.stringify(expectedLabels)
      && ownerValidation.ok;

    const applied = row.marker_comments.flatMap((comment) => markerValues(comment.body, 'source-note-boundary-review-applied').map((value) => ({ comment_id: Number(comment.id), value })));
    const materialized = parseMaterializationReceipts(row.marker_comments);
    assert(applied.length === 1, `SourceNote #${sourceNumber} applied boundary marker count is ${applied.length}`);
    assert(materialized.length === 1, `SourceNote #${sourceNumber} materialization marker count is ${materialized.length}`);
    const receipt = materialized[0];
    const receiptFact = receipt.source_note_issue_number === sourceNumber
      && receipt.source_note_id === parsed.source_note_id
      && receipt.source_note_body_sha256 === sha256Text(source.body)
      && receipt.source_revision_id === parsed.source_revision.id
      && (receipt.source_repository_ref ?? null) === (parsed.source_revision.source_repository_ref ?? null)
      && receipt.interview_note_id === projection.interview_note_id
      && Number(receipt.interview_issue_number) === Number(owner.number)
      && receipt.interview_issue_body_sha256 === ownerBodySha;
    const request = buildMaterializationRequest(source, 'liqiangcc/interview-lab');
    const appliedValue = applied[0].value;
    targets.push({
      source_issue: sourceNumber,
      source_url: source.html_url,
      identity: projection.interview_note_id,
      source_body_sha256: sha256Text(source.body),
      source_revision_id: parsed.source_revision.id,
      source_ref: parsed.source_revision.source_repository_ref ?? null,
      boundary_status: parsed.boundary_review.status,
      owner_issue: Number(owner.number),
      owner_url: owner.html_url,
      owner_body_sha256: ownerBodySha,
      projected_body_sha256: sha256Text(projection.body),
      owner_title: owner.title,
      projected_title: projection.title,
      owner_labels: actualLabels,
      projected_labels: expectedLabels,
      boundary_applied_receipt: {
        comment_id: applied[0].comment_id,
        transition_id: appliedValue.transition_id ?? null,
        interview_note_ids: appliedValue.interview_note_ids ?? null,
      },
      materialization_receipt: {
        comment_id: Number(row.marker_comments.find((comment) => markerValues(comment.body, 'source-note-interview-materialized').length)?.id),
        materialization_id: receipt.materialization_id,
        request_sha256: receipt.request_sha256,
        source_note_id: receipt.source_note_id,
        source_note_body_sha256: receipt.source_note_body_sha256,
        source_revision_id: receipt.source_revision_id,
        source_repository_ref: receipt.source_repository_ref ?? null,
        interview_note_id: receipt.interview_note_id,
        interview_issue_number: Number(receipt.interview_issue_number),
        interview_issue_body_sha256: receipt.interview_issue_body_sha256,
      },
      binding_comparison: {
        named_consumer: 'full-live-planner-current-request-binding',
        observed_materialization_id: receipt.materialization_id,
        expected_materialization_id: request.materialization_id,
        observed_request_sha256: receipt.request_sha256,
        expected_request_sha256: require('../../scripts/lib/source-note-interview-materialization').requestSha256(request),
        result: receipt.materialization_id === request.materialization_id && receipt.request_sha256 === require('../../scripts/lib/source-note-interview-materialization').requestSha256(request) ? 'MATCH' : 'MISMATCH',
      },
      dimensions: {
        owner_fact: ownerFact ? 'PASS' : 'FAIL',
        receipt_fact: receiptFact ? 'PASS' : 'FAIL',
        historical_execution: 'UNKNOWN',
        historical_execution_reason: '本次查找范围内未找到原授权 input plan 或 durable journal',
        consumer_compatibility: {
          full_live_planner: fullPlan.ok === false ? 'FAIL' : 'PASS',
          generic_runner: 'NOT_VERIFIED',
          bounded_runner: 'NOT_VERIFIED',
        },
      },
    });
  }

  const output = {
    audit_type: 'issue-1658-read-only-reconciliation-v2',
    generated_at: input.captured_at,
    source_tree_sha: 'e443f7d5303da500981e24c65c7a6e1ba417a7d1',
    input_snapshot_sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(path.resolve(inputFile))).digest('hex'),
    scope: SCOPE,
    dimensions: {
      owner_fact: { PASS: targets.filter((x) => x.dimensions.owner_fact === 'PASS').length, FAIL: targets.filter((x) => x.dimensions.owner_fact === 'FAIL').length },
      receipt_fact: { PASS: targets.filter((x) => x.dimensions.receipt_fact === 'PASS').length, FAIL: targets.filter((x) => x.dimensions.receipt_fact === 'FAIL').length },
      historical_execution: { UNKNOWN: targets.length },
      consumer_compatibility: { full_live_planner: { FAIL: targets.length }, generic_runner: { NOT_VERIFIED: targets.length }, bounded_runner: { NOT_VERIFIED: targets.length } },
    },
    targets,
    notes: [
      'materialization_id/request SHA MISMATCH is scoped to the named full-live-planner current request binding; it is not a historical validity judgment.',
      'The bounded runner uses inputPlan.rows[].request and was not executed because the original bounded input plan is absent.',
    ],
  };
  fs.writeFileSync(path.resolve(outputFile), JSON.stringify(output, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ output: path.resolve(outputFile), rows: targets.length, dimensions: output.dimensions }, null, 2) + '\n');
}

try { main(); } catch (error) { process.stderr.write(`ERROR: ${error.stack || error.message}\n`); process.exitCode = 1; }
