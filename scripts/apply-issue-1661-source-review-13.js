#!/usr/bin/env node
'use strict';
// Post per-owner Source Review evidence comments and emit transition request
// files for the thirteen prepared issue-1661 source reviews. Evidence posting
// is the only live write here; the lifecycle apply is done by
// scripts/plan-interview-note-source-review-transition.js --apply per request.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseInterviewNoteIssue } = require('./lib/interview-note-issue');
const { sourceReadyGate, analyzeSourceProvenance } = require('./lib/source-note-provenance');
const { verifyManifestItem } = require('./lib/issue-1539-pinned-artifact-manifest');

const REPO = 'liqiangcc/interview-lab';
const PREP_DIR = 'data/pilot/issue-1661/source-review-13';

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}
function ghJson(args, input = null) {
  return JSON.parse(execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input),
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
  }));
}
function postComment(number, body) {
  return ghJson(['api', '--method', 'POST', `repos/${REPO}/issues/${number}/comments`, '--input', '-'], { body });
}
function getComments(number) {
  return ghJson(['api', `repos/${REPO}/issues/${number}/comments?per_page=100`]);
}
const EVIDENCE_RE = /<!--\s*interview-note-source-review-evidence\.v1\n([\s\S]*?)\n-->/g;
function findEvidenceComment(comments, transitionId) {
  for (const comment of comments || []) {
    for (const match of String(comment.body || '').matchAll(EVIDENCE_RE)) {
      try {
        const marker = JSON.parse(match[1].trim());
        if (marker.transition_id === transitionId) return comment;
      } catch (_) { /* ignore malformed markers */ }
    }
  }
  return null;
}
function evidenceBody(request, liveRow, gate) {
  const sourceRecord = liveRow.record;
  const interviewRecord = parseInterviewNoteIssue(liveRow.owner.body || '').record;
  const rawCount = (sourceRecord.artifacts || []).filter((a) => a.provenance === 'raw_capture').length;
  const projectionCount = (sourceRecord.artifacts || []).filter((a) => a.provenance === 'source_projection').length;
  const marker = {
    schema_version: 'interview-note-source-review-evidence.v1',
    repository: request.repository,
    issue_number: request.issue_number,
    interview_note_id: request.interview_note_id,
    source_note_issue_number: request.source_note_issue_number,
    source_revision_id: request.expected_source_revision_id,
    transition_id: request.transition_id,
    evidence_subject_sha256: request.evidence_subject_sha256,
    expected_interview_body_sha256: request.expected_interview_body_sha256,
    expected_source_note_body_sha256: request.expected_source_note_body_sha256,
    provenance_mode: request.provenance_mode,
    provenance_statement: request.provenance_statement,
    pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256,
    decision: request.decision,
    limitations: request.limitations,
    interview_facts: interviewRecord,
    source_facts: sourceRecord,
    checks: request.checks,
    failed_check_ids: request.checks.filter((c) => c.result !== 'pass').map((c) => c.check_id),
    source_revision_evidence: {
      source_repository: 'liqiangcc/xhs',
      source_repository_ref: request.expected_source_repository_ref,
      raw_artifact_count: rawCount,
      source_projection_count: projectionCount,
    },
    source_ready_gate: gate,
    expected_source_repository_ref: request.expected_source_repository_ref,
  };
  return `<!-- interview-note-source-review-evidence.v1\n${JSON.stringify(marker, null, 2)}\n-->\n`;
}
function requestMarker(request) {
  return `<!-- interview-note-source-review-transition\n${JSON.stringify(request, null, 2)}\n-->\n`;
}
function parseArgs(argv) {
  const out = { prepDir: PREP_DIR, postEvidence: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--prep-dir') out.prepDir = argv[++i];
    else if (argv[i] === '--post-evidence') out.postEvidence = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}
function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const requests = JSON.parse(fs.readFileSync(path.join(args.prepDir, 'source-review-requests.json'), 'utf8')).requests;
  const liveRows = new Map(JSON.parse(fs.readFileSync(path.join(args.prepDir, 'live-input.json'), 'utf8')).rows.map((row) => [row.owner.number, row]));
  const manifest = JSON.parse(fs.readFileSync(path.join(args.prepDir, 'pinned-artifact-manifest.json'), 'utf8'));
  const requestDir = path.join(args.prepDir, 'requests');
  fs.mkdirSync(requestDir, { recursive: true });
  const results = [];
  for (const request of requests) {
    const row = liveRows.get(request.issue_number);
    if (!row) throw new Error(`missing live row for owner #${request.issue_number}`);
    const provenance = analyzeSourceProvenance(row.record);
    const itemVerification = verifyManifestItem(manifest, request, row.record);
    if (!itemVerification.ok) throw new Error(`#${request.issue_number}: manifest item verification failed: ${itemVerification.errors.join('; ')}`);
    const gate = sourceReadyGate(request, request.checks, provenance, { ...manifest, item_verified: itemVerification.ok });
    if (!gate.ok) throw new Error(`#${request.issue_number}: source-ready gate failed: ${gate.reason}`);
    let evidence = findEvidenceComment(getComments(request.issue_number), request.transition_id);
    if (!evidence) {
      if (!args.postEvidence) { results.push({ issue_number: request.issue_number, evidence: 'missing (dry-run)' }); continue; }
      evidence = postComment(request.issue_number, evidenceBody(request, row, gate));
      results.push({ issue_number: request.issue_number, evidence: 'posted', comment_id: evidence.id });
    } else {
      results.push({ issue_number: request.issue_number, evidence: 'reused', comment_id: evidence.id });
    }
    const bound = { ...request, review_evidence: { repository: request.repository, issue_number: request.issue_number, comment_id: Number(evidence.id) } };
    fs.writeFileSync(path.join(requestDir, `issue-${request.issue_number}.json`), `${JSON.stringify(bound, null, 2)}\n`);
    fs.writeFileSync(path.join(requestDir, `issue-${request.issue_number}.md`), requestMarker(bound));
  }
  process.stdout.write(`${JSON.stringify({ results, request_dir: requestDir }, null, 2)}\n`);
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = { main };
