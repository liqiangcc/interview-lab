#!/usr/bin/env node
'use strict';

/*
 * Read-only preparation tool for Boundary B (#1607).
 *
 * This command deliberately has no GitHub mutation path. It freezes the live
 * selection and pinned source projections, then emits evidence/request
 * templates and a deterministic dry-run journal. A later, separately
 * authorized runner may consume the request files after durable evidence
 * comments have been created by the controller.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./lib/source-note-issue');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const FIRST_ISSUE = 393;
const LAST_ISSUE = 765;
const EXPECTED_COUNT = 367;
const REQUIRED_LABELS = Object.freeze(['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review']);
const RAW_BASE = `https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/${SOURCE_REF}`;

function sha256Bytes(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256Text(value) { return sha256Bytes(Buffer.from(String(value), 'utf8')); }
function gitBlobSha(bytes) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function issueUrl(number) { return `https://github.com/${REPOSITORY}/issues/${number}`; }
function sourceProjectionRef(externalId) { return `${SOURCE_REPOSITORY}:note_desc/${externalId}.txt@${SOURCE_REF}`; }
function sourceProjectionPath(externalId) { return `note_desc/${externalId}.txt`; }

function parseArgs(argv = process.argv.slice(2)) {
  const args = { action: 'prepare', cache: null, outputDir: 'data/issue-1607', concurrency: 3, allowUnverifiedSource: false, bodyOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fetch-live') args.action = 'fetch-live';
    else if (arg === '--prepare') args.action = 'prepare';
    else if (arg === '--allow-unverified-source') args.allowUnverifiedSource = true;
    else if (arg === '--body-only') { args.allowUnverifiedSource = true; args.bodyOnly = true; }
    else if (arg === '--cache') args.cache = argv[++index];
    else if (arg === '--output-dir') args.outputDir = argv[++index];
    else if (arg === '--concurrency') args.concurrency = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.action === 'prepare' && !args.cache) args.cache = path.join(args.outputDir, 'live-issues.json');
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) throw new Error('--concurrency must be an integer from 1 to 8');
  return args;
}

function graphQlQuery(numbers) {
  const fields = numbers.map((number) => `i${number}: issueOrPullRequest(number:${number}) { __typename ... on Issue { number state title body labels(first:30) { nodes { name } } } ... on PullRequest { number state title body labels(first:30) { nodes { name } } } }`).join(' ');
  return `query { repository(owner:"liqiangcc", name:"interview-lab") { ${fields} } }`;
}

function fetchChunk(numbers) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = execFileSync('gh', ['api', 'graphql', '-f', `query=${graphQlQuery(numbers)}`], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
      });
      const parsed = JSON.parse(raw);
      if (parsed.errors && parsed.errors.length) throw new Error(parsed.errors.map((error) => error.message).join('; '));
      const values = Object.values(parsed.data?.repository || {});
      if (values.length !== numbers.length) throw new Error(`GraphQL returned ${values.length}/${numbers.length} aliases`);
      return values;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`live GraphQL chunk failed after 3 attempts (${numbers[0]}-${numbers[numbers.length - 1]}): ${lastError.message}`);
}

function fetchLiveIssues() {
  const numbers = [];
  for (let number = FIRST_ISSUE; number <= LAST_ISSUE; number += 1) numbers.push(number);
  const chunks = [];
  for (let index = 0; index < numbers.length; index += 25) chunks.push(numbers.slice(index, index + 25));
  const values = [];
  for (const chunk of chunks) values.push(...fetchChunk(chunk));
  const byNumber = new Map(values.filter(Boolean).map((value) => [Number(value.number), value]));
  const missing = numbers.filter((number) => !byNumber.has(number));
  if (missing.length) throw new Error(`live issue inventory is incomplete; missing #${missing.join(', #')}`);
  return { fetched_at: new Date().toISOString(), repository: REPOSITORY, range: [FIRST_ISSUE, LAST_ISSUE], issues: numbers.map((number) => byNumber.get(number)) };
}

function readPinnedText(externalId) {
  const file = sourceProjectionPath(externalId);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const bytes = execFileSync('curl', ['-LfsS', '--connect-timeout', '10', '--max-time', '45', `${RAW_BASE}/${file}`], { maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
      if (bytes.length === 0) throw new Error('source projection is empty');
      return bytes;
    } catch (error) { lastError = error; }
  }
  throw new Error(`pinned source projection read failed for ${file}: ${lastError.message}`);
}

function fetchSourceChunk(shas) {
  const fields = shas.map((sha, index) => `b${index}: object(oid:"${sha}") { oid ... on Blob { byteSize text } }`).join(' ');
  const query = `query { repository(owner:"liqiangcc", name:"xhs") { ${fields} } }`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000,
      });
      const parsed = JSON.parse(raw);
      if (parsed.errors && parsed.errors.length) throw new Error(parsed.errors.map((error) => error.message).join('; '));
      const values = Object.values(parsed.data?.repository || {});
      if (values.length !== shas.length) throw new Error(`Source GraphQL returned ${values.length}/${shas.length} blobs`);
      return values;
    } catch (error) { lastError = error; }
  }
  throw new Error(`pinned Source blob chunk failed after 3 attempts (${shas[0]}..${shas[shas.length - 1]}): ${lastError.message}`);
}

function fetchSourceBlobs(shas) {
  const result = new Map();
  for (let index = 0; index < shas.length; index += 5) {
    for (const blob of fetchSourceChunk(shas.slice(index, index + 5))) result.set(blob.oid, blob);
  }
  return result;
}

function fetchSourceBlobRest(sha) {
  const raw = execFileSync('gh', ['api', `repos/${SOURCE_REPOSITORY}/git/blobs/${sha}`], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000,
  });
  const blob = JSON.parse(raw);
  if (blob.sha !== sha || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`REST Source blob ${sha} did not return base64 content`);
  const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
  if (gitBlobSha(bytes) !== sha) throw new Error(`REST Source blob ${sha} Git object SHA verification failed`);
  return { oid: sha, byteSize: bytes.length, text: bytes.toString('utf8'), bytes };
}

function labelsOf(issue) { return (issue.labels?.nodes || []).map((label) => label.name).filter(Boolean); }
function isSelected(issue) {
  const labels = new Set(labelsOf(issue));
  return String(issue.state).toLowerCase() === 'open' && REQUIRED_LABELS.every((label) => labels.has(label));
}

function validateAndFreezeIssue(issue) {
  const errors = [];
  const labels = labelsOf(issue);
  const validation = validateSourceNoteIssue({ body: issue.body || '', labels, state: String(issue.state || '').toLowerCase() });
  if (!validation.ok) errors.push(...validation.errors);
  const record = validation.parsed?.record;
  if (!record) return { ok: false, errors, record: null };
  if (record.source_note_id !== `xhs-note:${record.source.external_id}`) errors.push('SourceNote identity is not canonically bound to source.external_id');
  if (record.source_revision?.source_repository !== SOURCE_REPOSITORY) errors.push('SourceRevision repository is not the fixed source repository');
  if (record.source_revision?.source_repository_ref !== SOURCE_REF) errors.push('SourceRevision ref is not the fixed source ref');
  if (record.boundary_review?.status !== 'pending') errors.push('boundary_review.status is not pending');
  return { ok: errors.length === 0, errors, record };
}

function lineEvidence(bytes, artifactRef, blobSha) {
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.map((line, index) => ({ line, number: index + 1 })).filter((item) => item.line.trim());
  const selected = nonEmpty.slice(0, 8);
  const excerpt = selected.map((item) => item.line).join('\\n').slice(0, 1200);
  return {
    artifact: { ref: artifactRef, kind: 'text_projection', provenance: 'source_projection', git_blob_sha: blobSha, byte_size: bytes.length, sha256: sha256Bytes(bytes) },
    locator: selected.length ? `note_desc:${selected[0].number}-${selected[selected.length - 1].number}` : 'note_desc:empty',
    excerpt,
  };
}

function bodyProjectionEvidence(issue, record, ref, reason) {
  const section = (issue.body.match(/## 原始正文\n\n([\s\S]*?)\n\n## 原始附件/) || [null, ''])[1];
  const start = Math.max(1, (issue.body.slice(0, issue.body.indexOf(section)).match(/\n/g) || []).length + 1);
  return {
    artifact: { ref, kind: 'text_projection', provenance: 'source_projection', git_blob_sha: record.artifacts.find((artifact) => artifact.ref === ref)?.git_blob_sha || null },
    locator: `issue-body-copy:lines-${start}-${start + Math.max(0, section.split(/\r?\n/).length - 1)}`,
    excerpt: section.trim().slice(0, 1200),
    verification: { status: 'blocked', reason },
  };
}

function buildSelection(cache, options = {}) {
  const scope = cache.issues.filter((issue) => issue.number >= FIRST_ISSUE && issue.number <= LAST_ISSUE);
  const selected = scope.filter(isSelected);
  const excluded = scope.filter((issue) => !isSelected(issue)).map((issue) => ({ issue_number: issue.number, title: issue.title, state: issue.state, labels: labelsOf(issue) }));
  if (selected.length !== EXPECTED_COUNT) throw new Error(`selection count mismatch: expected ${EXPECTED_COUNT}, got ${selected.length}`);
  const items = [];
  const errors = [];
  const candidates = [];
  for (const issue of selected.sort((a, b) => a.number - b.number)) {
    const checked = validateAndFreezeIssue(issue);
    if (!checked.ok) { errors.push({ issue_number: issue.number, errors: checked.errors }); continue; }
    const { record } = checked;
    const externalId = record.source.external_id;
    const ref = sourceProjectionRef(externalId);
    try {
      const liveArtifact = record.artifacts.find((artifact) => artifact.kind === 'text_projection' && artifact.provenance === 'source_projection');
      if (!liveArtifact) throw new Error('SourceNote has no source_projection text_projection artifact');
      if (liveArtifact.ref !== ref) throw new Error('SourceNote text projection ref mismatch');
      candidates.push({ issue, record, externalId, ref, liveArtifact });
    } catch (error) { errors.push({ issue_number: issue.number, errors: [error.message] }); }
  }
  let blobs;
  let sourceReadError = null;
  if (!errors.length && !options.bodyOnly) {
    try { blobs = fetchSourceBlobs(candidates.map((candidate) => candidate.liveArtifact.git_blob_sha)); }
    catch (error) {
      sourceReadError = error.message;
      if (!options.allowUnverifiedSource) errors.push({ issue_number: null, errors: [error.message] });
    }
  } else if (options.bodyOnly) {
    sourceReadError = 'explicit body-only preparation mode: pinned Source projection bytes were not fetched';
  }
  if (sourceReadError && options.allowUnverifiedSource) for (const candidate of candidates) {
    const { issue, record, externalId, ref } = candidate;
    items.push({
      issue_number: issue.number,
      issue_url: issueUrl(issue.number),
      title: issue.title,
      body_sha256: sha256Text(issue.body || ''),
      source_note_id: record.source_note_id,
      source_revision_id: record.source_revision.id,
      source_repository: SOURCE_REPOSITORY,
      source_repository_ref: SOURCE_REF,
      source_projection: bodyProjectionEvidence(issue, record, ref, sourceReadError),
      status: 'blocked',
      block_reason: 'pinned Source projection bytes could not be independently fetched and verified',
    });
  }
  if (!errors.length && !sourceReadError) for (const candidate of candidates) {
    const { issue, record, externalId, ref, liveArtifact } = candidate;
    try {
      let blob = blobs.get(liveArtifact.git_blob_sha);
      if (!blob || typeof blob.text !== 'string') throw new Error('pinned Source GraphQL blob has no UTF-8 text');
      let bytes = Buffer.from(blob.text, 'utf8');
      if (Number(blob.byteSize) !== bytes.length || gitBlobSha(bytes) !== liveArtifact.git_blob_sha) {
        blob = fetchSourceBlobRest(liveArtifact.git_blob_sha);
        bytes = blob.bytes;
      }
      if (Number(blob.byteSize) !== bytes.length) throw new Error(`pinned Source blob byteSize mismatch: declared ${blob.byteSize}, read ${bytes.length}`);
      if (gitBlobSha(bytes) !== liveArtifact.git_blob_sha) throw new Error('pinned source projection Git blob SHA does not verify content');
      const evidence = lineEvidence(bytes, ref, liveArtifact.git_blob_sha);
      items.push({
        issue_number: issue.number,
        issue_url: issueUrl(issue.number),
        title: issue.title,
        body_sha256: sha256Text(issue.body || ''),
        source_note_id: record.source_note_id,
        source_revision_id: record.source_revision.id,
        source_repository: SOURCE_REPOSITORY,
        source_repository_ref: SOURCE_REF,
        source_projection: evidence,
        status: 'verified',
      });
    } catch (error) {
      if (options.allowUnverifiedSource) {
        items.push({
          issue_number: issue.number,
          issue_url: issueUrl(issue.number),
          title: issue.title,
          body_sha256: sha256Text(issue.body || ''),
          source_note_id: record.source_note_id,
          source_revision_id: record.source_revision.id,
          source_repository: SOURCE_REPOSITORY,
          source_repository_ref: SOURCE_REF,
          source_projection: bodyProjectionEvidence(issue, record, ref, error.message),
          status: 'blocked',
          block_reason: 'pinned Source projection bytes could not be independently fetched and verified',
        });
      } else errors.push({ issue_number: issue.number, errors: [error.message] });
    }
  }
  if (errors.length) throw new Error(`selection freeze failed closed for ${errors.length} item(s): ${JSON.stringify(errors.slice(0, 5))}`);
  return {
    schema_version: 'issue-1607-boundary-b-selection.v1',
    repository: REPOSITORY,
    parent_issue: 1605,
    child_issue: 1607,
    scope: { first_issue: FIRST_ISSUE, last_issue: LAST_ISSUE, expected_count: EXPECTED_COUNT },
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    frozen_at: cache.fetched_at,
    source_verification: sourceReadError ? 'blocked' : 'verified',
    source_verification_error: sourceReadError || null,
    excluded,
    items,
  };
}

function main() {
  const args = parseArgs();
  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  if (args.action === 'fetch-live') {
    const live = fetchLiveIssues();
    fs.writeFileSync(path.resolve(args.cache || path.join(outputDir, 'live-issues.json')), `${JSON.stringify(live, null, 2)}\n`);
    process.stdout.write(JSON.stringify({ repository: REPOSITORY, range: live.range, count: live.issues.length, fetched_at: live.fetched_at }, null, 2) + '\n');
    return 0;
  }
  const cache = JSON.parse(fs.readFileSync(path.resolve(args.cache), 'utf8'));
  if (cache.repository !== REPOSITORY || cache.range?.[0] !== FIRST_ISSUE || cache.range?.[1] !== LAST_ISSUE) throw new Error('live cache is not bound to issue #1607 scope');
  const selection = buildSelection(cache, { allowUnverifiedSource: args.allowUnverifiedSource, bodyOnly: args.bodyOnly });
  fs.writeFileSync(path.join(outputDir, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ selection_count: selection.items.length, excluded_count: selection.excluded.length, selection_sha256: sha256Text(canonicalJson(selection)) }, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}

module.exports = { FIRST_ISSUE, LAST_ISSUE, EXPECTED_COUNT, SOURCE_REF, canonicalJson, gitBlobSha, isSelected, lineEvidence, parseArgs, validateAndFreezeIssue, bodyProjectionEvidence, buildSelection };
