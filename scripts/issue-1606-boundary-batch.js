#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./lib/source-note-issue');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const MIN_ISSUE = 20;
const MAX_ISSUE = 392;
const EXPECTED_SELECTION_COUNT = 327;
const REQUIRED_LABELS = ['status:captured', 'boundary:pending', 'type:source-note'];
const SOURCE_PROVENANCE = new Set(['raw_capture', 'raw_dom_snapshot', 'raw_context_capture', 'source_projection']);
const SOURCE_FETCH_CONCURRENCY = 4;
const SOURCE_FETCH_MAX_ATTEMPTS = 3;
const SOURCE_FETCH_TIMEOUT_SECONDS = 20;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { mode: null, selection: null, output: null, transport: 'gh', sourceRepository: SOURCE_REPOSITORY, sourceRef: SOURCE_REF };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') out.mode = argv[++index];
    else if (arg === '--selection') out.selection = argv[++index];
    else if (arg === '--output') out.output = argv[++index];
    else if (arg === '--transport') out.transport = argv[++index];
    else if (arg === '--source-repository') out.sourceRepository = argv[++index];
    else if (arg === '--source-ref') out.sourceRef = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['freeze', 'source-inventory'].includes(out.mode)) throw new Error('--mode must be freeze or source-inventory');
  if (!['gh', 'web'].includes(out.transport)) throw new Error('--transport must be gh or web');
  if (!out.output) throw new Error('--output is required');
  if (out.mode === 'source-inventory' && !out.selection) throw new Error('--selection is required for source-inventory');
  return out;
}

function labelsOf(issue) {
  return (issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean).sort();
}

function fetchIssueChunk(numbers) {
  const aliases = numbers.map((issueNumber) => `i${issueNumber}: issue(number: ${issueNumber}) { number url title state body labels(first: 20) { nodes { name } } }`);
  const query = `query { repository(owner: "liqiangcc", name: "interview-lab") { ${aliases.join(' ')} } }`;
  const authToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const result = require('child_process').spawnSync('curl', [
    '-sS', '--compressed', '--retry', '4', '--retry-delay', '2', '--retry-all-errors', '--max-time', '120', '-X', 'POST', 'https://api.github.com/graphql',
    '-H', `Authorization: bearer ${authToken}`,
    '-H', 'Content-Type: application/json',
    '--data-raw', JSON.stringify({ query }),
  ], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !result.stdout) throw new Error(`GraphQL chunk curl failed with status ${result.status}: ${result.stderr || ''}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch (error) {
    throw new Error(`GraphQL chunk response was incomplete (curl status ${result.status}): ${error.message}`);
  }
  return parsed;
}

function fetchIssueRange() {
  const allNumbers = Array.from({ length: MAX_ISSUE - MIN_ISSUE + 1 }, (_, index) => MIN_ISSUE + index);
  const result = { data: { repository: {} } };
  for (let start = 0; start < allNumbers.length; start += 25) {
    const chunk = allNumbers.slice(start, start + 25);
    const chunkResult = fetchIssueChunk(chunk);
    if (Array.isArray(chunkResult.errors) && chunkResult.errors.length) throw new Error(`GraphQL errors: ${chunkResult.errors.map((error) => error.message).join('; ')}`);
    for (const number of chunk) result.data.repository[`i${number}`] = chunkResult.data && chunkResult.data.repository && chunkResult.data.repository[`i${number}`];
  }
  const repository = result.data && result.data.repository;
  if (!repository || typeof repository !== 'object') throw new Error('GraphQL response missing repository');
  const issues = [];
  for (let issueNumber = MIN_ISSUE; issueNumber <= MAX_ISSUE; issueNumber += 1) {
    const issue = repository[`i${issueNumber}`];
    if (!issue || Number(issue.number) !== issueNumber) throw new Error(`GraphQL response missing exact issue #${issueNumber}`);
    issues.push({ ...issue, html_url: issue.url, labels: (issue.labels && issue.labels.nodes || []).map((label) => label.name) });
  }
  return issues;
}

function fetchWebIssue(issueNumber, authToken) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', [
      '-L', '--silent', '--show-error', '--max-time', '45',
      '-H', `Authorization: token ${authToken}`,
      `https://github.com/liqiangcc/interview-lab/issues/${issueNumber}`,
    ]);
    const chunks = [];
    const errors = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => {
      const html = Buffer.concat(chunks).toString('utf8');
      const parsed = parseIssueHtml(html, issueNumber);
      if (!parsed) {
        reject(new Error(`web issue #${issueNumber}: unable to parse issue payload (curl status ${status}, signal ${signal}, stderr ${(Buffer.concat(errors).toString('utf8') || '').trim()})`));
        return;
      }
      resolve(parsed);
    });
  });
}

async function fetchIssueRangeWeb() {
  const authToken = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const numbers = Array.from({ length: MAX_ISSUE - MIN_ISSUE + 1 }, (_, index) => MIN_ISSUE + index);
  const issues = [];
  const concurrency = 12;
  for (let start = 0; start < numbers.length; start += concurrency) {
    const batch = numbers.slice(start, start + concurrency);
    issues.push(...await Promise.all(batch.map((issueNumber) => fetchWebIssue(issueNumber, authToken))));
  }
  return issues;
}

function parseIssueHtml(html, expectedNumber) {
  let body = null;
  let issue = null;
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ld) {
    try { body = JSON.parse(ld[1]).articleBody; } catch { /* use embedded payload below */ }
  }
  for (const match of html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const json = JSON.parse(match[1]);
      for (const query of json.payload && json.payload.preloadedQueries || []) {
        const candidate = query.result && query.result.data && query.result.data.repository && query.result.data.repository.issue;
        if (candidate && Number(candidate.number) === Number(expectedNumber)) issue = candidate;
      }
      if (!body && json.payload && json.payload.structured_data) body = json.payload.structured_data.articleBody;
    } catch { /* unrelated embedded JSON */ }
  }
  if (!issue || typeof body !== 'string') return null;
  return {
    number: issue.number,
    url: `https://github.com/liqiangcc/interview-lab/issues/${expectedNumber}`,
    html_url: `https://github.com/liqiangcc/interview-lab/issues/${expectedNumber}`,
    title: issue.title,
    state: String(issue.state || '').toLowerCase(),
    body,
    labels: (issue.labels && issue.labels.edges || []).map((edge) => edge.node && edge.node.name).filter(Boolean),
  };
}

function assertFixedSource(record, issueNumber) {
  const errors = [];
  if (!record || !record.source_revision) errors.push('missing source_revision');
  if (record && record.source_revision && record.source_revision.source_repository !== SOURCE_REPOSITORY) {
    errors.push(`source_repository must be ${SOURCE_REPOSITORY}`);
  }
  if (record && record.source_revision && record.source_revision.source_repository_ref !== SOURCE_REF) {
    errors.push(`source_repository_ref must be ${SOURCE_REF}`);
  }
  if (errors.length) throw new Error(`#${issueNumber}: ${errors.join('; ')}`);
}

async function freeze(outputPath, transport = 'gh') {
  const capturedAt = new Date().toISOString();
  const items = [];
  const excluded = [];
  const readIssueNumbers = [];
  const liveIssues = transport === 'web' ? await fetchIssueRangeWeb() : fetchIssueRange();
  for (const issue of liveIssues) {
    const issueNumber = Number(issue.number);
    readIssueNumbers.push(issueNumber);
    const labels = labelsOf(issue);
    const missing = REQUIRED_LABELS.filter((label) => !labels.includes(label));
    if (missing.length) {
      excluded.push({ issue_number: issueNumber, reasons: missing.map((label) => `missing:${label}`), labels });
      continue;
    }
    const body = String(issue.body || '');
    const parsed = parseSourceNoteIssue(body);
    if (!parsed.record || parsed.recordParseError) throw new Error(`#${issueNumber}: invalid SourceNote record: ${parsed.recordParseError || 'missing'}`);
    const validation = validateSourceNoteIssue({ body, labels, state: String(issue.state || '').toLowerCase() });
    if (!validation.ok) throw new Error(`#${issueNumber}: SourceNote validator failed: ${validation.errors.join('; ')}`);
    assertFixedSource(parsed.record, issueNumber);
    if (parsed.record.boundary_review.status !== 'pending') throw new Error(`#${issueNumber}: pending label disagrees with record boundary status`);
    const source = parsed.record.source;
    const revision = parsed.record.source_revision;
    items.push({
      issue_number: issueNumber,
      live_url: issue.html_url,
      title: issue.title,
      state: issue.state,
      labels,
      body_sha256: sha256(Buffer.from(body, 'utf8')),
      source_note_id: parsed.record.source_note_id,
      source_id: `${source.system}:${source.external_id}`,
      source_revision_id: revision.id,
      source_repository: revision.source_repository,
      source_repository_ref: revision.source_repository_ref,
      source_published_at: parsed.record.source_published_at,
      artifacts: parsed.record.artifacts.map((artifact) => ({
        kind: artifact.kind,
        ref: artifact.ref,
        git_blob_sha: artifact.git_blob_sha,
        sha256: artifact.sha256,
        provenance: artifact.provenance,
        byte_size: artifact.byte_size,
        integrity: artifact.integrity,
        sequence: artifact.sequence == null ? null : artifact.sequence,
      })),
    });
  }
  if (items.length !== EXPECTED_SELECTION_COUNT) {
    throw new Error(`selection count mismatch: expected ${EXPECTED_SELECTION_COUNT}, got ${items.length}`);
  }
  const manifest = {
    schema_version: 'issue-1606-boundary-selection.v1',
    repository: REPOSITORY,
    issue: 1606,
    selection_policy: 'exact issue numbers 20..392 inclusive with all required labels; no out-of-range probe',
    captured_at: capturedAt,
    source_repository: SOURCE_REPOSITORY,
    source_repository_ref: SOURCE_REF,
    range: { min_issue: MIN_ISSUE, max_issue: MAX_ISSUE, expected_count: EXPECTED_SELECTION_COUNT },
    read_audit: {
      exact_issue_numbers: readIssueNumbers,
      count: readIssueNumbers.length,
      out_of_range_issue_numbers: [],
    },
    selected_count: items.length,
    excluded_count: excluded.length,
    excluded,
    items,
  };
  manifest.selection_sha256 = sha256(Buffer.from(canonicalJson(manifest), 'utf8'));
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ selected_count: items.length, excluded_count: excluded.length, selection_sha256: manifest.selection_sha256 }, null, 2)}\n`);
}

function gitBlobSha(buffer) {
  return sha1(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`), buffer]));
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function sourceArtifactUrl(ref, sourceRepository, sourceRef) {
  const prefix = `${sourceRepository}:`;
  const suffix = `@${sourceRef}`;
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) throw new Error(`source artifact ref is not bound to ${sourceRepository}@${sourceRef}: ${ref}`);
  const sourcePath = ref.slice(prefix.length, -suffix.length);
  if (!sourcePath || sourcePath.startsWith('/') || sourcePath.includes('..')) throw new Error(`unsafe source artifact path: ${sourcePath}`);
  return `https://raw.githubusercontent.com/${sourceRepository}/${sourceRef}/${sourcePath.split('/').map(encodeURIComponent).join('/')}`;
}

function isTransientSourceFetchError(status, message) {
  return [28, 35, 52, 55, 56].includes(status)
    || /(?:tls|ssl|eof|empty reply|connection reset|timed out|timeout|network)/i.test(message);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchSourceArtifactAsync(ref, sourceRepository, sourceRef, retryTag = null, maxAttempts = SOURCE_FETCH_MAX_ATTEMPTS) {
  let url;
  try { url = sourceArtifactUrl(ref, sourceRepository, sourceRef); } catch (error) { return { ok: false, error: error.message, attempts: 0, transient: false }; }
  const requestUrl = retryTag ? `${url}?source_blob_sha=${encodeURIComponent(retryTag)}` : url;
  let lastError = 'source GET failed';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await new Promise((resolve) => {
      const child = spawn('curl', [
        '-L', '-sS', '--fail', '--connect-timeout', '10', '--max-time', String(SOURCE_FETCH_TIMEOUT_SECONDS), '--retry', '0', requestUrl,
      ]);
      const chunks = [];
      const errors = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => errors.push(chunk));
      child.on('error', (error) => resolve({ status: null, content: null, error: error.message }));
      child.on('close', (status) => resolve({ status, content: Buffer.concat(chunks), error: (Buffer.concat(errors).toString('utf8') || '').trim() }));
    });
    if (result.status === 0) return { ok: true, content: result.content, attempts: attempt, transient: false };
    lastError = result.error || `curl status ${result.status}`;
    const transient = isTransientSourceFetchError(result.status, lastError);
    if (!transient || attempt === maxAttempts) return { ok: false, error: lastError, attempts: attempt, transient };
    await wait(250 * attempt);
  }
  return { ok: false, error: lastError, attempts: maxAttempts, transient: true };
}

function projectionArtifact(item) {
  const candidates = item.artifacts.filter((artifact) => SOURCE_PROVENANCE.has(artifact.provenance) && artifact.git_blob_sha && artifact.integrity === 'present');
  return candidates.find((artifact) => artifact.kind === 'text_projection')
    || candidates.find((artifact) => artifact.kind === 'json')
    || candidates.find((artifact) => artifact.kind === 'html')
    || null;
}

function cachedProjection(selectionItem, artifact, cachedItem) {
  if (!cachedItem || cachedItem.status !== 'verified' || cachedItem.source_note_id !== selectionItem.source_note_id) return null;
  if (!cachedItem.artifact || cachedItem.artifact.ref !== artifact.ref || cachedItem.artifact.git_blob_sha !== artifact.git_blob_sha || cachedItem.artifact.byte_size !== artifact.byte_size || cachedItem.artifact.provenance !== artifact.provenance) return null;
  if (!Array.isArray(cachedItem.lines)) return null;
  const content = Buffer.from(cachedItem.lines.map((line) => line.text).join('\n'), 'utf8');
  if (gitBlobSha(content) !== artifact.git_blob_sha || content.length !== artifact.byte_size) return null;
  return {
    ...cachedItem,
    body_sha256: selectionItem.body_sha256,
    verification: { method: 'local-cache', attempts: 0, transient_retries: 0 },
  };
}

async function sourceInventory(selection, outputPath) {
  if (selection.source_repository !== SOURCE_REPOSITORY || selection.source_repository_ref !== SOURCE_REF) throw new Error('selection source binding mismatch');
  const items = [];
  let cachedInventory = null;
  try { cachedInventory = JSON.parse(fs.readFileSync(path.resolve(outputPath), 'utf8')); } catch { /* no usable local cache */ }
  const cachedByIssue = cachedInventory && cachedInventory.selection_sha256 === selection.selection_sha256
    ? new Map((cachedInventory.items || []).map((item) => [item.issue_number, item]))
    : new Map();
  let cacheHits = 0;
  let networkFetches = 0;
  let transientRetries = 0;
  for (let start = 0; start < selection.items.length; start += SOURCE_FETCH_CONCURRENCY) {
    const batch = selection.items.slice(start, start + SOURCE_FETCH_CONCURRENCY);
    const fetched = await Promise.all(batch.map((item) => {
      const artifact = projectionArtifact(item);
      const cached = artifact && cachedProjection(item, artifact, cachedByIssue.get(item.issue_number));
      if (cached) {
        cacheHits += 1;
        return Promise.resolve({ cached });
      }
      networkFetches += 1;
      return artifact ? fetchSourceArtifactAsync(artifact.ref, SOURCE_REPOSITORY, SOURCE_REF) : Promise.resolve({ ok: false, error: 'no non-empty Raw/Source projection artifact with Git blob SHA', attempts: 0, transient: false });
    }));
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const fetchedArtifact = fetched[index];
      const artifact = projectionArtifact(item);
      if (fetchedArtifact.cached) {
        items.push(fetchedArtifact.cached);
        continue;
      }
      if (!artifact) {
        items.push({ issue_number: item.issue_number, source_note_id: item.source_note_id, source_revision_id: item.source_revision_id, source_repository_ref: item.source_repository_ref, body_sha256: item.body_sha256, status: 'blocked', block_reason: fetchedArtifact.error });
        continue;
      }
      if (!fetchedArtifact.ok) {
        transientRetries += Math.max(0, fetchedArtifact.attempts - 1);
        items.push({ issue_number: item.issue_number, source_note_id: item.source_note_id, source_revision_id: item.source_revision_id, source_repository_ref: item.source_repository_ref, body_sha256: item.body_sha256, status: 'blocked', block_reason: `source artifact fetch failed after ${fetchedArtifact.attempts} controlled GET attempt(s): ${fetchedArtifact.error}`, artifact: { ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size }, verification: { method: 'controlled-get', attempts: fetchedArtifact.attempts, transient: fetchedArtifact.transient, transient_retries: Math.max(0, fetchedArtifact.attempts - 1) } });
        continue;
      }
      transientRetries += Math.max(0, fetchedArtifact.attempts - 1);
      let content = fetchedArtifact.content;
      if (gitBlobSha(content) !== artifact.git_blob_sha || content.length !== artifact.byte_size) {
        const remainingAttempts = SOURCE_FETCH_MAX_ATTEMPTS - fetchedArtifact.attempts;
        if (remainingAttempts < 1) {
          items.push({ issue_number: item.issue_number, source_note_id: item.source_note_id, source_revision_id: item.source_revision_id, source_repository_ref: item.source_repository_ref, body_sha256: item.body_sha256, status: 'blocked', block_reason: 'source artifact integrity mismatch after exhausting controlled GET attempts', artifact: { ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size }, verification: { method: 'controlled-get', attempts: fetchedArtifact.attempts, transient: false, transient_retries: Math.max(0, fetchedArtifact.attempts - 1) } });
          continue;
        }
        const retried = await fetchSourceArtifactAsync(artifact.ref, SOURCE_REPOSITORY, SOURCE_REF, artifact.git_blob_sha, remainingAttempts);
        transientRetries += Math.max(0, retried.attempts - 1);
        if (!retried.ok) {
          items.push({ issue_number: item.issue_number, source_note_id: item.source_note_id, source_revision_id: item.source_revision_id, source_repository_ref: item.source_repository_ref, body_sha256: item.body_sha256, status: 'blocked', block_reason: `source artifact retry failed after integrity mismatch: ${retried.error}`, artifact: { ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size }, verification: { method: 'controlled-get', attempts: fetchedArtifact.attempts + retried.attempts, transient: retried.transient, transient_retries: Math.max(0, fetchedArtifact.attempts - 1) + Math.max(0, retried.attempts - 1) } });
          continue;
        }
        content = retried.content;
        fetchedArtifact.attempts += retried.attempts;
      }
      if (gitBlobSha(content) !== artifact.git_blob_sha || content.length !== artifact.byte_size) {
        items.push({ issue_number: item.issue_number, source_note_id: item.source_note_id, source_revision_id: item.source_revision_id, source_repository_ref: item.source_repository_ref, body_sha256: item.body_sha256, status: 'blocked', block_reason: 'source artifact Git blob SHA or byte length mismatch after deterministic retry', artifact: { ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size }, verification: { method: 'controlled-get', attempts: fetchedArtifact.attempts, transient: false, transient_retries: Math.max(0, fetchedArtifact.attempts - 1) } });
        continue;
      }
      const text = content.toString('utf8');
      const lines = text.split(/\r?\n/);
      items.push({
        issue_number: item.issue_number,
        source_note_id: item.source_note_id,
        source_revision_id: item.source_revision_id,
        source_repository_ref: item.source_repository_ref,
        body_sha256: item.body_sha256,
        status: 'verified',
        artifact: { ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size },
        verification: { method: 'controlled-get', attempts: fetchedArtifact.attempts, transient: false, transient_retries: Math.max(0, fetchedArtifact.attempts - 1) },
        line_count: lines.length,
        lines: lines.map((line, lineIndex) => ({ line: lineIndex + 1, text: line })),
      });
    }
  }
  /* Keep all selected items in deterministic issue-number order after parallel fetches. */
  items.sort((left, right) => left.issue_number - right.issue_number);
  /* Validate the source inventory itself before writing it. */
  for (const item of items) {
    if (!Number.isInteger(item.issue_number) || item.issue_number < MIN_ISSUE || item.issue_number > MAX_ISSUE) throw new Error(`source inventory contains out-of-range issue #${item.issue_number}`);
  }
  const inventory = {
    schema_version: 'issue-1606-source-inventory.v1',
    repository: REPOSITORY,
    source_repository: SOURCE_REPOSITORY,
    source_repository_ref: SOURCE_REF,
    transport_policy: {
      method: 'GET',
      endpoint: 'raw.githubusercontent.com',
      source_projection_only: true,
      single_object_get: true,
      concurrency: SOURCE_FETCH_CONCURRENCY,
      max_attempts_per_item: SOURCE_FETCH_MAX_ATTEMPTS,
      timeout_seconds: SOURCE_FETCH_TIMEOUT_SECONDS,
      transient_errors: ['TLS', 'EOF', 'connection reset', 'timeout'],
      clone: false,
      http_range_header: false,
      cache: { path: path.relative(process.cwd(), path.resolve(outputPath)), hits: cacheHits, network_fetches: networkFetches, transient_retries: transientRetries },
    },
    selection_sha256: selection.selection_sha256,
    item_count: items.length,
    verified_count: items.filter((item) => item.status === 'verified').length,
    blocked_count: items.filter((item) => item.status === 'blocked').length,
    items,
  };
  inventory.inventory_sha256 = sha256(Buffer.from(canonicalJson(inventory), 'utf8'));
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(inventory, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ item_count: items.length, verified_count: inventory.verified_count, blocked_count: inventory.blocked_count, inventory_sha256: inventory.inventory_sha256 }, null, 2)}\n`);
  return inventory;
}

async function main() {
  const args = parseArgs();
  if (args.mode === 'freeze') await freeze(args.output, args.transport);
  else await sourceInventory(JSON.parse(fs.readFileSync(path.resolve(args.selection), 'utf8')), args.output);
}

if (require.main === module) {
  main().catch((error) => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
}

module.exports = { canonicalJson, gitBlobSha, parseArgs, parseIssueHtml, projectionArtifact, sha256 };
