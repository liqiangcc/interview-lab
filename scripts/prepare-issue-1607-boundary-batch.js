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
  const args = { action: 'prepare', cache: null, outputDir: 'data/issue-1607', sourceCacheDir: '/tmp/xhs-note-desc-cache', sourceArtifactCacheDir: '/tmp/issue-1607-source-artifacts', allowUnverifiedSource: false, bodyOnly: false, fullSource: false, scopeClean: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fetch-live') args.action = 'fetch-live';
    else if (arg === '--prepare') args.action = 'prepare';
    else if (arg === '--allow-unverified-source') args.allowUnverifiedSource = true;
    else if (arg === '--body-only') { args.allowUnverifiedSource = true; args.bodyOnly = true; }
    else if (arg === '--scope-clean') args.scopeClean = true;
    else if (arg === '--full-source') args.fullSource = true;
    else if (arg === '--cache') args.cache = argv[++index];
    else if (arg === '--output-dir') args.outputDir = argv[++index];
    else if (arg === '--source-cache-dir') args.sourceCacheDir = argv[++index];
    else if (arg === '--source-artifact-cache-dir') args.sourceArtifactCacheDir = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.action === 'prepare' && !args.cache) args.cache = path.join(args.outputDir, 'live-issues.json');
  return args;
}

function graphQlQuery(numbers) {
  const fields = numbers.map((number) => `i${number}: issueOrPullRequest(number:${number}) { __typename ... on Issue { number state title body labels(first:30) { nodes { name } } } ... on PullRequest { number state title body labels(first:30) { nodes { name } } } }`).join(' ');
  return `query { repository(owner:"liqiangcc", name:"interview-lab") { ${fields} } }`;
}

function fetchChunk(numbers) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
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
  throw new Error(`live GraphQL chunk failed after 5 attempts (${numbers[0]}-${numbers[numbers.length - 1]}): ${lastError.message}`);
}

function fetchLiveIssues(options = {}) {
  const numbers = [];
  for (let number = FIRST_ISSUE; number <= LAST_ISSUE; number += 1) numbers.push(number);
  const chunks = [];
  for (let index = 0; index < numbers.length; index += 25) chunks.push(numbers.slice(index, index + 25));
  const values = [];
  for (const chunk of chunks) values.push(...fetchChunk(chunk));
  const byNumber = new Map(values.filter(Boolean).map((value) => [Number(value.number), value]));
  const missing = numbers.filter((number) => !byNumber.has(number));
  if (missing.length) throw new Error(`live issue inventory is incomplete; missing #${missing.join(', #')}`);
  return {
    fetched_at: new Date().toISOString(), repository: REPOSITORY, range: [FIRST_ISSUE, LAST_ISSUE],
    scope_compliance: options.scopeClean ? {
      status: 'pass', read_issue_range: [FIRST_ISSUE, LAST_ISSUE], out_of_scope_reads: 0, out_of_scope_mutations: 0,
      method: 'GraphQL aliases are generated only for the frozen inclusive range; no issue outside the range is queried',
    } : { status: 'unverified', reason: 'Use --scope-clean to emit a scope-clean audit record.' },
    issues: numbers.map((number) => byNumber.get(number)),
  };
}

function readPinnedText(externalId, expectedGitBlobSha, expectedByteSize, cacheDir) {
  const file = sourceProjectionPath(externalId);
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFiles = [path.join(cacheDir, `${externalId}.txt`), path.join(cacheDir, `${expectedGitBlobSha}.txt`)].filter((value, index, all) => all.indexOf(value) === index);
  for (const cacheFile of cacheFiles) {
    if (!fs.existsSync(cacheFile)) continue;
    const cached = fs.readFileSync(cacheFile);
    if (cached.length > 0 && (expectedByteSize == null || cached.length === Number(expectedByteSize)) && gitBlobSha(cached) === expectedGitBlobSha) {
      return { bytes: cached, fetch: `cache:${path.basename(cacheFile)}` };
    }
  }
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const bytes = execFileSync('curl', [
        '-LfsS', '--retry', '1', '--retry-delay', '1', '--connect-timeout', '10', '--max-time', '45', `${RAW_BASE}/${file}`,
      ], { maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
      if (bytes.length === 0) throw new Error('source projection is empty');
      if (gitBlobSha(bytes) !== expectedGitBlobSha) throw new Error(`Git blob SHA mismatch for ${file}`);
      fs.writeFileSync(cacheFiles[0], bytes);
      return { bytes, fetch: `raw-attempt-${attempt}` };
    } catch (error) { lastError = error; }
  }
  throw new Error(`pinned source projection read failed for ${file}: ${lastError.message}`);
}

function artifactPath(ref) {
  const match = String(ref || '').match(/^[^:]+:(.+)@95b77bb261048059846273688e4b90a2e108b437$/);
  if (!match) throw new Error(`artifact ref is not bound to the fixed source ref: ${ref}`);
  return match[1];
}

function artifactExtension(kind, filePath) {
  const extension = path.extname(filePath);
  if (extension) return extension;
  if (kind === 'html') return '.html';
  if (kind === 'json') return '.json';
  return '.bin';
}

function readPinnedArtifact(artifact, cacheDir) {
  if (!artifact || artifact.integrity !== 'present') throw new Error(`artifact is not present: ${artifact?.ref || 'unknown'}`);
  const relativePath = artifactPath(artifact.ref);
  const basename = path.basename(relativePath);
  const extension = artifactExtension(artifact.kind, relativePath);
  const safeCacheNames = [basename, `${artifact.git_blob_sha}${extension}`].filter((value, index, all) => all.indexOf(value) === index);
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const cacheName of safeCacheNames) {
    const cacheFile = path.join(cacheDir, cacheName);
    if (!fs.existsSync(cacheFile)) continue;
    const cached = fs.readFileSync(cacheFile);
    if (cached.length > 0 && cached.length === Number(artifact.byte_size) && gitBlobSha(cached) === artifact.git_blob_sha) {
      return { bytes: cached, fetch: `cache:${cacheName}`, cache_file: cacheName };
    }
  }
  const url = `${RAW_BASE}/${relativePath}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = JSON.parse(execFileSync('gh', [
        'api', `repos/${SOURCE_REPOSITORY}/contents/${relativePath}?ref=${SOURCE_REF}`,
      ], { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024, timeout: 35000 }));
      if (response.encoding !== 'base64' || typeof response.content !== 'string') throw new Error('Contents API did not return base64 content');
      const bytes = Buffer.from(response.content.replace(/\s/g, ''), 'base64');
      if (bytes.length === 0) throw new Error(`artifact is empty: ${relativePath}`);
      if (bytes.length !== Number(artifact.byte_size)) throw new Error(`byte size mismatch for ${relativePath}: ${bytes.length}/${artifact.byte_size}`);
      if (gitBlobSha(bytes) !== artifact.git_blob_sha) throw new Error(`Git blob SHA mismatch for ${relativePath}`);
      const cacheFile = path.join(cacheDir, basename);
      fs.writeFileSync(cacheFile, bytes);
      return { bytes, fetch: `contents-api-or-raw-attempt-${attempt}`, cache_file: basename };
    } catch (error) { lastError = error; }
  }
  try {
    const bytes = execFileSync('curl', [
      '-LfsS', '--retry', '2', '--retry-delay', '1', '--connect-timeout', '10', '--max-time', '45', url,
    ], { maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
    if (bytes.length === 0) throw new Error(`artifact is empty: ${relativePath}`);
    if (bytes.length !== Number(artifact.byte_size)) throw new Error(`byte size mismatch for ${relativePath}: ${bytes.length}/${artifact.byte_size}`);
    if (gitBlobSha(bytes) !== artifact.git_blob_sha) throw new Error(`Git blob SHA mismatch for ${relativePath}`);
    const cacheFile = path.join(cacheDir, basename);
    fs.writeFileSync(cacheFile, bytes);
    return { bytes, fetch: 'raw-fallback', cache_file: basename };
  } catch (error) { lastError = error; }
  throw new Error(`pinned source artifact read failed for ${relativePath}: ${lastError.message}`);
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function sourceArtifactRecord(artifact, fetched, externalId) {
  const bytes = fetched.bytes;
  const text = bytes.toString('utf8');
  const result = {
    kind: artifact.kind,
    ref: artifact.ref,
    provenance: artifact.provenance,
    git_blob_sha: artifact.git_blob_sha,
    byte_size: bytes.length,
    sha256: sha256Bytes(bytes),
    verification: { status: 'verified', fetch: fetched.fetch, byte_size: bytes.length, git_blob_sha: artifact.git_blob_sha },
    cache_file: fetched.cache_file,
  };
  if (artifact.kind === 'text_projection') {
    result.locator = 'note_desc:full-file';
    result.excerpt = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 8).join('\n').slice(0, 1200);
  } else if (artifact.kind === 'json') {
    let parsed;
    try { parsed = JSON.parse(text); } catch (error) { throw new Error(`note_json is not valid JSON for ${externalId}: ${error.message}`); }
    const note = parsed.note?.noteDetailMap?.[externalId]?.note;
    if (!note || typeof note !== 'object') throw new Error(`note_json has no canonical note object for ${externalId}`);
    if (typeof note.title !== 'string' || typeof note.desc !== 'string') throw new Error(`note_json lacks title/desc for ${externalId}`);
    result.semantic = {
      title: { locator: `/note/noteDetailMap/${externalId}/note/title`, excerpt: note.title },
      body: { locator: `/note/noteDetailMap/${externalId}/note/desc`, excerpt: note.desc.slice(0, 1200) },
    };
  } else if (artifact.kind === 'html') {
    const titleMatch = text.match(/<title>([\s\S]*?)<\/title>/i) || text.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i);
    if (!titleMatch) throw new Error(`note_detail HTML has no title metadata for ${externalId}`);
    result.semantic = { title: { locator: 'html:head/title', excerpt: decodeHtmlEntities(titleMatch[1]).trim() } };
  }
  return result;
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
  const excerpt = selected.map((item) => item.line).join('\n').slice(0, 1200);
  return {
    artifact: { ref: artifactRef, kind: 'text_projection', provenance: 'source_projection', git_blob_sha: blobSha, byte_size: bytes.length, sha256: sha256Bytes(bytes) },
    locator: selected.length ? `note_desc:${selected[0].number}-${selected[selected.length - 1].number}` : 'note_desc:empty',
    excerpt,
    text,
    line_count: lines.length,
  };
}

function bodyProjectionEvidence(issue, record, ref, reason) {
  const section = (issue.body.match(/## 原始正文\n\n([\s\S]*?)\n\n## 原始附件/) || [null, ''])[1];
  const start = Math.max(1, (issue.body.slice(0, issue.body.indexOf(section)).match(/\n/g) || []).length + 1);
  return {
    artifact: { ref, kind: 'text_projection', provenance: 'source_projection', git_blob_sha: record.artifacts.find((artifact) => artifact.ref === ref)?.git_blob_sha || null, byte_size: null, sha256: null },
    locator: `issue-body-copy:lines-${start}-${start + Math.max(0, section.split(/\r?\n/).length - 1)}`,
    excerpt: section.trim().slice(0, 1200),
    text: section.trim(),
    line_count: section.trim() ? section.trim().split(/\r?\n/).length : 0,
    verification: { status: 'blocked', reason },
  };
}

function buildSelection(cache, options = {}) {
  const scope = cache.issues.filter((issue) => issue.number >= FIRST_ISSUE && issue.number <= LAST_ISSUE);
  const selected = scope.filter(isSelected);
  const excluded = scope.filter((issue) => !isSelected(issue)).map((issue) => ({ issue_number: issue.number, title: issue.title, state: issue.state, labels: labelsOf(issue) }));
  if (!options.scopeClean && selected.length !== EXPECTED_COUNT) throw new Error(`selection count mismatch: expected ${EXPECTED_COUNT}, got ${selected.length}`);
  const items = [];
  const errors = [];
  const candidates = [];
  const sourceFailures = [];
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
      const sourceArtifacts = record.artifacts.filter((artifact) => ['html', 'json', 'text_projection'].includes(artifact.kind));
      if (options.fullSource && sourceArtifacts.length !== 3) throw new Error(`SourceNote must expose html/json/note_desc artifacts: found ${sourceArtifacts.map((artifact) => artifact.kind).join(',')}`);
      candidates.push({ issue, record, externalId, ref, liveArtifact, sourceArtifacts });
    } catch (error) { errors.push({ issue_number: issue.number, errors: [error.message] }); }
  }
  if (!errors.length) for (const candidate of candidates) {
    const { issue, record, externalId, ref, liveArtifact, sourceArtifacts } = candidate;
    try {
      if (options.bodyOnly) throw new Error('explicit body-only preparation mode: pinned Source projection bytes were not fetched');
      const fetched = readPinnedText(externalId, liveArtifact.git_blob_sha, liveArtifact.byte_size, options.sourceCacheDir || '/tmp/xhs-note-desc-cache');
      const bytes = fetched.bytes;
      const evidence = lineEvidence(bytes, ref, liveArtifact.git_blob_sha);
      let fullSourceArtifacts = null;
      if (options.fullSource) {
        fullSourceArtifacts = sourceArtifacts.map((artifact) => sourceArtifactRecord(
          artifact,
          artifact.kind === 'text_projection'
            ? { bytes, fetch: fetched.fetch, cache_file: path.basename(path.join(options.sourceCacheDir || '/tmp/xhs-note-desc-cache', `${externalId}.txt`)) }
            : readPinnedArtifact(artifact, options.sourceArtifactCacheDir || '/tmp/issue-1607-source-artifacts'),
          externalId,
        ));
      }
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
        source_verification: { status: 'verified', fetch: fetched.fetch, byte_size: bytes.length, git_blob_sha: liveArtifact.git_blob_sha },
        ...(fullSourceArtifacts ? {
          source_artifacts: fullSourceArtifacts,
          source_material_verification: { status: 'verified', required_kinds: ['html', 'json', 'text_projection'], artifacts: fullSourceArtifacts.map((artifact) => ({ kind: artifact.kind, ref: artifact.ref, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size, sha256: artifact.sha256, verification: artifact.verification })) },
        } : {}),
        status: 'verified',
      });
    } catch (error) {
      sourceFailures.push({ issue_number: issue.number, reason: error.message });
      if (options.allowUnverifiedSource || options.bodyOnly) {
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
          source_verification: { status: 'blocked', reason: error.message },
          ...(options.fullSource ? { source_material_verification: { status: 'blocked', reason: error.message } } : {}),
          status: 'blocked',
          block_reason: 'pinned Source projection bytes could not be independently fetched and verified',
        });
      } else errors.push({ issue_number: issue.number, errors: [error.message] });
    }
  }
  if (errors.length) throw new Error(`selection freeze failed closed for ${errors.length} item(s): ${JSON.stringify(errors.slice(0, 5))}`);
  if (items.length !== candidates.length) throw new Error(`selection freeze failed to produce one record per candidate: ${items.length}/${candidates.length}`);
  const verifiedCount = items.filter((item) => item.status === 'verified').length;
  const scopeCompliance = options.scopeClean && cache.scope_compliance?.status === 'pass'
    ? cache.scope_compliance
    : {
      status: 'blocked',
      reason: 'Selection was not generated by the explicit scope-clean rerun; no apply authorization may be inferred.',
      out_of_scope_reads: null,
      out_of_scope_mutations: 0,
    };
  if (options.scopeClean && cache.scope_compliance?.status !== 'pass') throw new Error('scope-clean preparation requires a fresh live cache carrying scope_compliance.status=pass');
  return {
    schema_version: 'issue-1607-boundary-b-selection.v1',
    repository: REPOSITORY,
    parent_issue: 1605,
    child_issue: 1607,
    scope: { first_issue: FIRST_ISSUE, last_issue: LAST_ISSUE, expected_count: items.length, baseline_pending_count: EXPECTED_COUNT },
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    source_fetch: { transport: 'controlled-raw-get', concurrency: 1, retries_per_item: 3, cache_validation: ['byte_size', 'git_blob_sha'], cache_directory: options.sourceCacheDir || '/tmp/xhs-note-desc-cache', artifact_kinds: options.fullSource ? ['html', 'json', 'text_projection'] : ['text_projection'], artifact_cache_directory: options.sourceArtifactCacheDir || '/tmp/issue-1607-source-artifacts' },
    scope_compliance: scopeCompliance,
    frozen_at: cache.fetched_at,
    source_verification: verifiedCount === items.length ? 'verified' : (verifiedCount ? 'partial' : 'blocked'),
    source_verification_failures: sourceFailures,
    excluded,
    items,
  };
}

function main() {
  const args = parseArgs();
  const outputDir = path.resolve(args.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  if (args.action === 'fetch-live') {
    const live = fetchLiveIssues({ scopeClean: args.scopeClean });
    fs.writeFileSync(path.resolve(args.cache || path.join(outputDir, 'live-issues.json')), `${JSON.stringify(live, null, 2)}\n`);
    process.stdout.write(JSON.stringify({ repository: REPOSITORY, range: live.range, count: live.issues.length, fetched_at: live.fetched_at }, null, 2) + '\n');
    return 0;
  }
  const cache = JSON.parse(fs.readFileSync(path.resolve(args.cache), 'utf8'));
  if (cache.repository !== REPOSITORY || cache.range?.[0] !== FIRST_ISSUE || cache.range?.[1] !== LAST_ISSUE) throw new Error('live cache is not bound to issue #1607 scope');
  const selection = buildSelection(cache, {
    allowUnverifiedSource: args.allowUnverifiedSource,
    bodyOnly: args.bodyOnly,
    sourceCacheDir: args.sourceCacheDir,
    sourceArtifactCacheDir: args.sourceArtifactCacheDir,
    fullSource: args.fullSource,
    scopeClean: args.scopeClean,
  });
  fs.writeFileSync(path.join(outputDir, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ selection_count: selection.items.length, excluded_count: selection.excluded.length, selection_sha256: sha256Text(canonicalJson(selection)) }, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}

module.exports = { FIRST_ISSUE, LAST_ISSUE, EXPECTED_COUNT, SOURCE_REF, canonicalJson, gitBlobSha, graphQlQuery, isSelected, lineEvidence, parseArgs, validateAndFreezeIssue, bodyProjectionEvidence, buildSelection, readPinnedArtifact, sourceArtifactRecord };
