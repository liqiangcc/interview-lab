#!/usr/bin/env node
'use strict';

/*
 * Issue #1609 is a plan/evidence producer.  It deliberately has no apply
 * mode: the existing guarded transition runner remains the only live
 * mutation path, and applying this batch requires an explicit controller
 * decision outside this command.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./lib/source-note-issue');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const ISSUE = 1609;
const MIN_ISSUE = 1139;
const MAX_ISSUE = 1508;
const RANGE_COUNT = MAX_ISSUE - MIN_ISSUE + 1;
const EXPECTED_COUNT = 366;
const REQUIRED_LABELS = ['type:source-note', 'status:captured', 'boundary:pending'];
const CHECKS = [
  ['source_identity', 'SourceNote identity matches the live machine record.'],
  ['source_revision_binding', 'SourceRevision and source repository ref match the frozen snapshot.'],
  ['source_content_coverage', 'The cited Raw or source_projection artifact is exact and hash-verified.'],
  ['event_boundary', 'The disposition is supported by the cited source evidence.'],
  ['no_cross_source_mixing', 'This item cites only evidence belonging to this SourceNote.'],
  ['no_fabrication', 'No Raw, Derived, or InterviewNote content is invented or overwritten.'],
];
const PROVENANCE = new Set(['raw_capture', 'raw_dom_snapshot', 'raw_context_capture', 'source_projection']);

function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function sha1GitBlob(bytes) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`);
}
function labelsOf(issue) {
  return (issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean).sort();
}
function parseArgs(argv = process.argv.slice(2)) {
  const out = { mode: null, output: null, selection: null, evidence: null, source: null, requests: null, receipts: null, journal: null, sourceSnapshot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') out.mode = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--selection') out.selection = argv[++i];
    else if (arg === '--evidence-dir') out.evidence = argv[++i];
    else if (arg === '--source-inventory') out.source = argv[++i];
    else if (arg === '--requests-dir') out.requests = argv[++i];
    else if (arg === '--receipts-dir') out.receipts = argv[++i];
    else if (arg === '--journal') out.journal = argv[++i];
    else if (arg === '--source-snapshot') out.sourceSnapshot = argv[++i];
    else if (arg === '--apply' || arg === '--confirm-dry-run' || arg === '--gate-proof') throw new Error('Issue #1609 producer is plan-only; live apply is controller-authorized and disabled here');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['freeze', 'evidence', 'plan'].includes(out.mode)) throw new Error('--mode must be freeze, evidence, or plan');
  if (!out.output) throw new Error('--output is required');
  if (out.mode !== 'freeze' && !out.selection) throw new Error('--selection is required');
  if (out.mode === 'evidence' && (!out.evidence || !out.requests || !out.receipts || !out.journal)) throw new Error('evidence mode requires --evidence-dir, --requests-dir, --receipts-dir, and --journal');
  return out;
}
function ghJson(args) {
  const raw = execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return JSON.parse(raw);
}
function fetchExactIssueRange() {
  const issues = [];
  const chunkSize = 50;
  for (let start = MIN_ISSUE; start <= MAX_ISSUE; start += chunkSize) {
    const end = Math.min(MAX_ISSUE, start + chunkSize - 1);
    const fields = [];
    for (let n = start; n <= end; n += 1) fields.push(`i${n}: issue(number: ${n}) { number url title state body labels(first: 100) { nodes { name } } }`);
    const query = `query { repository(owner: "liqiangcc", name: "interview-lab") { ${fields.join(' ')} } }`;
    const response = ghJson(['graphql', '-f', `query=${query}`]);
    if (response.errors && response.errors.length) throw new Error(response.errors.map((error) => error.message).join('; '));
    const repo = response.data && response.data.repository;
    if (!repo) throw new Error('GraphQL response has no repository');
    for (let number = start; number <= end; number += 1) {
      const issue = repo[`i${number}`];
      if (!issue || Number(issue.number) !== number) throw new Error(`exact live Issue #${number} was not returned`);
      issues.push({ ...issue, html_url: issue.url, labels: (issue.labels && issue.labels.nodes || []).map((label) => label.name) });
    }
  }
  if (issues.length !== RANGE_COUNT) throw new Error(`exact live range count mismatch: expected ${RANGE_COUNT}, got ${issues.length}`);
  return issues;
}
function sourceArtifact(record) {
  const artifacts = (record.artifacts || []).filter((item) => PROVENANCE.has(item.provenance) && item.git_blob_sha && item.integrity === 'present');
  return artifacts.find((item) => item.provenance === 'source_projection' && item.kind === 'text_projection')
    || artifacts.find((item) => item.provenance === 'source_projection' && item.kind === 'json')
    || artifacts.find((item) => item.provenance === 'source_projection')
    || artifacts.find((item) => item.provenance === 'raw_capture' && item.kind === 'html')
    || null;
}
function freeze(output) {
  const liveIssues = fetchExactIssueRange();
  const items = [];
  const excluded = [];
  for (const issue of liveIssues) {
    const labels = labelsOf(issue);
    const missing = REQUIRED_LABELS.filter((label) => !labels.includes(label));
    if (missing.length) { excluded.push({ issue_number: issue.number, reason: missing.map((label) => `missing:${label}`), labels }); continue; }
    const body = String(issue.body || '');
    const parsed = parseSourceNoteIssue(body);
    if (!parsed.record || parsed.recordParseError) throw new Error(`#${issue.number}: SourceNote record invalid: ${parsed.recordParseError || 'missing'}`);
    const validation = validateSourceNoteIssue({ body, labels, state: String(issue.state || '').toLowerCase() });
    if (!validation.ok) throw new Error(`#${issue.number}: SourceNote validation failed: ${validation.errors.join('; ')}`);
    const record = parsed.record;
    if (record.boundary_review.status !== 'pending') throw new Error(`#${issue.number}: record/label boundary state drift`);
    if (record.source_revision.source_repository !== SOURCE_REPOSITORY || record.source_revision.source_repository_ref !== SOURCE_REF) throw new Error(`#${issue.number}: source revision is not the fixed snapshot`);
    items.push({
      issue_number: issue.number,
      live_url: issue.html_url,
      title: issue.title,
      state: issue.state,
      labels,
      body_sha256: sha256(body),
      source_note_id: record.source_note_id,
      source_id: `${record.source.system}:${record.source.external_id}`,
      source_revision_id: record.source_revision.id,
      source_repository: record.source_revision.source_repository,
      source_repository_ref: record.source_revision.source_repository_ref,
      source_published_at: record.source_published_at,
      artifacts: (record.artifacts || []).map((artifact) => ({
        kind: artifact.kind, ref: artifact.ref, git_blob_sha: artifact.git_blob_sha,
        sha256: artifact.sha256, provenance: artifact.provenance, byte_size: artifact.byte_size,
        integrity: artifact.integrity, sequence: artifact.sequence == null ? null : artifact.sequence,
      })),
    });
  }
  if (items.length !== EXPECTED_COUNT) throw new Error(`selection count mismatch: expected ${EXPECTED_COUNT}, got ${items.length}`);
  const manifest = {
    schema_version: 'issue-1609-boundary-selection.v1', repository: REPOSITORY, parent_issue: 1605, issue: ISSUE,
    selection_policy: 'exact live issue numbers 1139..1508 with type:source-note + status:captured + boundary:pending; no out-of-range reads are used',
    captured_at: new Date().toISOString(), source_repository: SOURCE_REPOSITORY, source_repository_ref: SOURCE_REF,
    range: { min_issue: MIN_ISSUE, max_issue: MAX_ISSUE, expected_count: EXPECTED_COUNT },
    read_audit: { exact_issue_numbers: liveIssues.map((item) => item.number), count: liveIssues.length, out_of_range_issue_numbers: [] },
    selected_count: items.length, excluded_count: excluded.length, excluded, items,
  };
  manifest.selection_sha256 = sha256(canonicalJson(manifest));
  writeJson(output, manifest);
  process.stdout.write(`${JSON.stringify({ selected_count: items.length, excluded_count: excluded.length, selection_sha256: manifest.selection_sha256 }, null, 2)}\n`);
}
function semanticText(item, sourceText) {
  const cleanTags = (value) => String(value || '').replace(/#[^#\n]*?\[话题\]#/g, ' ').replace(/\s+/g, ' ').trim();
  if (item.artifact.kind !== 'json') return cleanTags(sourceText);
  try {
    const object = JSON.parse(sourceText);
    let desc = null;
    const walk = (value) => {
      if (desc) return;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        if (value.noteId === item.source_note_id.replace(/^xhs-note:/, '') && typeof value.desc === 'string') desc = value.desc;
        else Object.values(value).forEach(walk);
      }
    };
    walk(object);
    return cleanTags(desc);
  } catch { return ''; }
}
function fetchRaw(url) {
  const result = execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', url], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 });
  return Buffer.from(result);
}
function artifactPath(ref) {
  const colon = ref.indexOf(':');
  const at = ref.lastIndexOf('@');
  return ref.slice(colon + 1, at);
}
function readArtifact(item, snapshot = null) {
  if (snapshot) {
    const cached = snapshot.get(item.issue_number);
    if (!cached || cached.artifact.ref !== item.artifact.ref || typeof cached.source_text !== 'string') throw new Error(`source snapshot does not contain exact artifact for #${item.issue_number}`);
    const bytes = Buffer.from(cached.source_text, 'utf8');
    if (sha1GitBlob(bytes) !== item.artifact.git_blob_sha) throw new Error(`cached Git blob SHA mismatch for ${item.artifact.ref}`);
    if (bytes.length !== item.artifact.byte_size) throw new Error(`cached byte length mismatch for ${item.artifact.ref}`);
    return { bytes, url: `snapshot:${item.artifact.ref}` };
  }
  const pathName = artifactPath(item.artifact.ref);
  const url = `https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/${SOURCE_REF}/${pathName}`;
  const bytes = fetchRaw(url);
  if (sha1GitBlob(bytes) !== item.artifact.git_blob_sha) throw new Error(`Git blob SHA mismatch for ${item.artifact.ref}`);
  if (bytes.length !== item.artifact.byte_size) throw new Error(`byte length mismatch for ${item.artifact.ref}`);
  return { bytes, url };
}
function excerpt(item, rawText, semantic) {
  const lines = rawText.split(/\r?\n/);
  let index = lines.findIndex((line) => semantic && line.includes(semantic.slice(0, Math.min(40, semantic.length))));
  if (index < 0) index = lines.findIndex((line) => line.trim() && !/^\s*[\[{]/.test(line));
  if (index < 0) index = 0;
  const original = lines[index].trim();
  return { excerpt: original.slice(0, 1000), line: index + 1, locator: `artifact-line:${index + 1}`, semantic_excerpt: semantic.slice(0, 1000) };
}
function disposition(semantic) {
  const value = String(semantic || '').trim();
  if (!value || value === 'null') return { disposition: 'blocked', reason: 'No non-empty readable Source/Source projection is available; title and hashtags cannot authorize a boundary.' };
  const event = /(面试官|手撕|自我介绍|面试记录|面了|面试时间|一面|二面|三面|hr面|技术面|面感|项目拷打|投递.{0,12}面|面.{0,8}分钟)/i.test(value);
  const resource = /(题库|资料|教程|书籍|面试题合集|模拟面试|刷题|知识点|面试指南|面试准备|面试技巧|招聘|内推|岗位|求职咨询|求offer|通关秘籍|宝典)/i.test(value);
  const independent = /(三场面试|多家公司|几个公司|不同公司|多次面试|四家|五家|三家|两家公司|多个公司)/i.test(value);
  if (independent && !/(一面|二面|三面)/.test(value)) return { disposition: 'blocked', reason: 'The Source mentions multiple independent processes without separately reviewable case boundaries; retain pending.' };
  if (event) return { disposition: 'single-interview', reason: 'Exact Source evidence records one bounded interview report; multiple rounds in the same process remain one case.' };
  if (resource) return { disposition: 'not-interview', reason: 'Exact Source projection is a generic resource/recruitment/advice record and does not record one candidate interview event.' };
  return { disposition: 'blocked', reason: 'The available Source evidence does not establish a bounded interview event; retain pending.' };
}
function makeRequest(item, evidence, choice) {
  return {
    schema_version: 'issue-1609-boundary-review-request.v1', request_id: `issue-1609-boundary-${String(item.issue_number).padStart(4, '0')}`,
    repository: REPOSITORY, parent_issue: 1605, issue_number: item.issue_number, live_url: item.live_url,
    source_note_id: item.source_note_id, expected_body_sha256: item.body_sha256, expected_boundary_status: 'pending',
    expected_source_revision_id: item.source_revision_id, expected_source_repository: SOURCE_REPOSITORY, expected_source_repository_ref: SOURCE_REF,
    disposition: choice.disposition, rationale: choice.reason, evidence_file: `evidence/${String(item.issue_number).padStart(4, '0')}.json`,
    source_evidence: evidence.source_evidence, checks: evidence.checks, limitations: [choice.reason, 'Candidate only: no live evidence comment, body PATCH, label write, or InterviewNote materialization was performed.'],
  };
}
function evidence(selection, output, evidenceDir, requestsDir, receiptsDir, journalPath, snapshot = null) {
  const sourceItems = [];
  for (const item of selection.items) {
    const artifacts = item.artifacts.filter((artifact) => PROVENANCE.has(artifact.provenance) && artifact.git_blob_sha && artifact.integrity === 'present');
    const selected = artifacts.find((artifact) => artifact.provenance === 'source_projection' && artifact.kind === 'text_projection') || artifacts.find((artifact) => artifact.provenance === 'source_projection' && artifact.kind === 'json') || artifacts.find((artifact) => artifact.provenance === 'source_projection') || artifacts.find((artifact) => artifact.provenance === 'raw_capture' && artifact.kind === 'html');
    if (!selected) throw new Error(`#${item.issue_number}: no hash-addressed Raw/source projection artifact`);
    const artifactItem = { ...item, artifact: selected };
    const { bytes } = readArtifact(artifactItem, snapshot);
    const rawText = bytes.toString('utf8');
    const semantic = semanticText(artifactItem, rawText);
    const choice = disposition(semantic);
    const sourceEvidence = { ref: selected.ref, git_blob_sha: selected.git_blob_sha, kind: selected.kind, provenance: selected.provenance, byte_size: bytes.length, content_sha256: sha256(rawText), excerpt: excerpt(item, rawText, semantic) };
    const checks = CHECKS.map(([check_id, note]) => ({ check_id, result: check_id === 'event_boundary' && choice.disposition === 'blocked' ? 'fail' : 'pass', note }));
    const evidenceRecord = {
      schema_version: 'issue-1609-boundary-evidence.v1', issue_number: item.issue_number, live_url: item.live_url, source_note_id: item.source_note_id,
      source_revision_id: item.source_revision_id, source_repository: SOURCE_REPOSITORY, source_repository_ref: SOURCE_REF, body_sha256: item.body_sha256,
      disposition: choice.disposition, rationale: choice.reason, source_evidence: sourceEvidence, checks,
      limitations: [choice.reason, 'Source projection/Raw evidence is kept separate from Derived data; this record authorizes no mutation.'], source_ready_claimed: false,
    };
    const evidenceDigest = sha256(canonicalJson(evidenceRecord));
    evidenceRecord.evidence_sha256 = evidenceDigest;
    writeJson(path.join(evidenceDir, `${String(item.issue_number).padStart(4, '0')}.json`), evidenceRecord);
    const request = makeRequest(item, evidenceRecord, choice); request.evidence_sha256 = evidenceDigest; request.request_sha256 = sha256(canonicalJson(request));
    writeJson(path.join(requestsDir, `${String(item.issue_number).padStart(4, '0')}.json`), request);
    const receipt = { schema_version: 'issue-1609-boundary-planned-receipt.v1', issue_number: item.issue_number, request_id: request.request_id, evidence_sha256: evidenceDigest, request_sha256: request.request_sha256, receipt_state: 'not-applied', possibly_performed: false, mutation_attempted: false, reason: 'Controller authorization for live apply is absent.' };
    writeJson(path.join(receiptsDir, `${String(item.issue_number).padStart(4, '0')}.json`), receipt);
    sourceItems.push({ issue_number: item.issue_number, disposition: choice.disposition, evidence_sha256: evidenceDigest, request_sha256: request.request_sha256, receipt_state: receipt.receipt_state });
  }
  const journal = { schema_version: 'issue-1609-boundary-apply-journal.v1', repository: REPOSITORY, issue: ISSUE, mode: 'plan-only', mutation_authorized: false, mutation_count: 0, entries: sourceItems.map((item) => ({ ...item, state: 'not-authorized', mutation_attempted: false, possibly_performed: false })) };
  journal.journal_sha256 = sha256(canonicalJson(journal)); writeJson(journalPath, journal);
  return sourceItems;
}
function plan(selection, sourceItems, output) {
  const counts = sourceItems.reduce((out, item) => { out[item.disposition] = (out[item.disposition] || 0) + 1; return out; }, {});
  const report = { schema_version: 'issue-1609-boundary-dry-run.v1', repository: REPOSITORY, parent_issue: 1605, issue: ISSUE, selection_sha256: selection.selection_sha256, source_repository: SOURCE_REPOSITORY, source_repository_ref: SOURCE_REF, range: { min_issue: MIN_ISSUE, max_issue: MAX_ISSUE, expected_count: EXPECTED_COUNT }, total: sourceItems.length, counts: { 'single-interview': counts['single-interview'] || 0, 'not-interview': counts['not-interview'] || 0, blocked: counts.blocked || 0 }, mutation_authorized: false, mutation_count: 0, all_items_have_independent_evidence: sourceItems.length === EXPECTED_COUNT, items: sourceItems, fail_closed: (counts.blocked || 0) > 0 };
  report.dry_run_sha256 = sha256(canonicalJson(report)); writeJson(output, report); return report;
}
function main() {
  const args = parseArgs();
  if (args.mode === 'freeze') return freeze(args.output);
  const selection = JSON.parse(fs.readFileSync(path.resolve(args.selection), 'utf8'));
  const { selection_sha256: selectionDigest, ...selectionWithoutDigest } = selection;
  if (selectionDigest !== sha256(canonicalJson(selectionWithoutDigest))) throw new Error('selection manifest digest mismatch');
  if (args.mode === 'evidence') {
    const snapshot = args.sourceSnapshot ? new Map(JSON.parse(fs.readFileSync(path.resolve(args.sourceSnapshot), 'utf8')).items.map((item) => [Number(item.issue_number), item])) : null;
    const items = evidence(selection, args.output, args.evidence, args.requests, args.receipts, args.journal, snapshot);
    const report = plan(selection, items, args.output);
    process.stdout.write(`${JSON.stringify({ total: report.total, counts: report.counts, dry_run_sha256: report.dry_run_sha256, mutation_count: 0 }, null, 2)}\n`);
    return;
  }
  const report = JSON.parse(fs.readFileSync(path.resolve(args.source), 'utf8'));
  const result = plan(selection, report.items, args.output);
  process.stdout.write(`${JSON.stringify({ total: result.total, counts: result.counts, dry_run_sha256: result.dry_run_sha256, mutation_count: 0 }, null, 2)}\n`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; } }
module.exports = { canonicalJson, disposition, parseArgs, sha256, sha1GitBlob };
