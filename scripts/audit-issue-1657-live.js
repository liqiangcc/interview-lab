#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { canonicalDigest } = require('./lib/aggregate-downstream-pipeline');
const { issueSourceRecord } = require('./lib/interview-note-materialization-batch');
const { validateInterviewNoteIssue } = require('./lib/interview-note-issue');
const { TARGETS, REPOSITORY } = require('./lib/issue-1657-blocker-repair-plan');

const SCHEMA_VERSION = 'issue-1657-live-reaudit-snapshot.v1';
const DEFAULT_OUTPUT = 'data/pilot/issue-1657/live-reaudit.snapshot.json';
const READ_POLICY = 'GitHub GET-only; no PATCH, POST, label mutation, issue comment, or InterviewNote write';

function sha256(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }

function ghJson(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', '--method', 'GET', endpoint], {
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120000,
  }));
}

function ghCollection(endpoint) {
  const rows = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = ghJson(`${endpoint}?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`${endpoint} page ${page} did not return an array`);
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error(`${endpoint} exceeded the 1000-row audit bound`);
}

function markerPayload(body, markerName) {
  const escaped = markerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(body || '').match(new RegExp(`<!--\\s*${escaped}(?:\\.v\\d+)?\\s*\\n([\\s\\S]*?)\\n-->`));
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch (error) { return { parse_error: error.message }; }
}

function commentFact(comment) {
  const body = String(comment.body || '');
  const markers = {};
  for (const name of [
    'source-note-boundary-review-evidence',
    'source-note-boundary-review-applied',
    'interview-note-source-review-evidence',
    'interview-note-source-review-applied',
    'source-note-interview-materialized',
  ]) {
    const payload = markerPayload(body, name);
    if (payload) markers[name] = payload;
  }
  return {
    id: comment.id,
    created_at: comment.created_at,
    body_sha256: sha256(body),
    markers,
    human_header: /^##?\s*\[(?:BOUNDARY REVIEW EVIDENCE|SOURCE REVIEW EVIDENCE)\]/m.test(body) ? body.match(/^##?\s*\[([^\]]+)\]/m)[1] : null,
  };
}

function labelsOf(issue) { return (issue.labels || []).map((label) => label.name).filter(Boolean).sort(); }

function sourceAudit(issue, comments) {
  const parsed = issueSourceRecord(issue);
  const record = parsed.parsed;
  const evidence = comments.filter((comment) => comment.markers['source-note-boundary-review-evidence']);
  const applied = comments.filter((comment) => comment.markers['source-note-boundary-review-applied']);
  const materialized = comments.filter((comment) => comment.markers['source-note-interview-materialized']);
  const humanEvidence = comments.filter((comment) => comment.human_header === 'BOUNDARY REVIEW EVIDENCE');
  return {
    issue_number: issue.number,
    state: issue.state,
    updated_at: issue.updated_at,
    body_sha256: sha256(issue.body),
    labels: labelsOf(issue),
    validation: { ok: parsed.validation.ok, errors: parsed.validation.errors },
    source_note_id: record && record.source_note_id || null,
    source_revision: record && record.source_revision || null,
    boundary_review: record && record.boundary_review || null,
    boundary_evidence: evidence.length === 1 ? { comment_id: evidence[0].id, body_sha256: evidence[0].body_sha256, payload: evidence[0].markers['source-note-boundary-review-evidence'] } : null,
    boundary_applied_receipt: applied.length === 1 ? { comment_id: applied[0].id, body_sha256: applied[0].body_sha256, payload: applied[0].markers['source-note-boundary-review-applied'] } : null,
    materialization_receipt: materialized.length === 1 ? { comment_id: materialized[0].id, body_sha256: materialized[0].body_sha256, payload: materialized[0].markers['source-note-interview-materialized'] } : null,
    human_boundary_evidence_comment_ids: humanEvidence.map((comment) => comment.id),
    comments: comments,
  };
}

function ownerAudit(issue, comments) {
  const parsed = validateInterviewNoteIssue({ body: issue.body, labels: labelsOf(issue), state: issue.state });
  const record = parsed.parsed.record;
  const sourceReviewEvidence = comments.filter((comment) => comment.markers['interview-note-source-review-evidence'] || comment.human_header === 'SOURCE REVIEW EVIDENCE');
  const sourceReviewApplied = comments.filter((comment) => comment.markers['interview-note-source-review-applied']);
  const materialized = comments.filter((comment) => comment.markers['source-note-interview-materialized']);
  return {
    issue_number: issue.number,
    state: issue.state,
    updated_at: issue.updated_at,
    body_sha256: sha256(issue.body),
    labels: labelsOf(issue),
    validation: { ok: parsed.ok, errors: parsed.errors },
    interview_note_id: record && record.interview_note_id || null,
    source_revision: record && record.source_revision || null,
    source: record && record.source || null,
    source_review_evidence_comment_ids: sourceReviewEvidence.map((comment) => comment.id),
    source_review_applied_receipt: sourceReviewApplied.length === 1 ? { comment_id: sourceReviewApplied[0].id, body_sha256: sourceReviewApplied[0].body_sha256, payload: sourceReviewApplied[0].markers['interview-note-source-review-applied'] || null } : null,
    materialization_receipt: materialized.length === 1 ? { comment_id: materialized[0].id, body_sha256: materialized[0].body_sha256, payload: materialized[0].markers['source-note-interview-materialized'] } : null,
    comments,
  };
}

function atomicWrite(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

function snapshotDigest(snapshot) {
  const { canonical_digest: ignored, ...input } = snapshot;
  return canonicalDigest(input);
}

function parseArgs(argv = process.argv.slice(2)) {
  let output = DEFAULT_OUTPUT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output') output = argv[++index];
    else if (['--patch', '--post', '--label', '--apply', '--interview-note'].includes(argv[index])) throw new Error(`${argv[index]} is forbidden: live audit is GET-only`);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return { output };
}

function main(argv = process.argv.slice(2)) {
  const { output } = parseArgs(argv);
  const all = TARGETS.map((target) => {
    const sourceIssue = ghJson(`repos/${REPOSITORY}/issues/${target.source_note_issue_number}`);
    const sourceComments = ghCollection(`repos/${REPOSITORY}/issues/${target.source_note_issue_number}/comments`);
    const ownerIssue = ghJson(`repos/${REPOSITORY}/issues/${target.owner_issue_number}`);
    const ownerComments = ghCollection(`repos/${REPOSITORY}/issues/${target.owner_issue_number}/comments`);
    const source = sourceAudit(sourceIssue, sourceComments.map(commentFact));
    const owner = ownerAudit(ownerIssue, ownerComments.map(commentFact));
    return { ...target, source, owner };
  });
  const snapshot = {
    schema_version: SCHEMA_VERSION,
    repository: REPOSITORY,
    captured_at: new Date().toISOString(),
    read_policy: READ_POLICY,
    target_count: TARGETS.length,
    targets: all,
  };
  snapshot.canonical_digest = snapshotDigest(snapshot);
  atomicWrite(output, snapshot);
  process.stdout.write(`${JSON.stringify({ output: path.resolve(output), schema_version: SCHEMA_VERSION, target_count: all.length, canonical_digest: snapshot.canonical_digest, read_policy: READ_POLICY }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.stack || error.message}\n`); process.exitCode = 1; }
}

module.exports = { SCHEMA_VERSION, DEFAULT_OUTPUT, READ_POLICY, snapshotDigest, markerPayload, commentFact, sourceAudit, ownerAudit, parseArgs, main };
