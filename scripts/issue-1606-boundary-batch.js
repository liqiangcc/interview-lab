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

function fetchSourceArtifactAsync(ref, sourceRepository, sourceRef, retryTag = null) {
  return new Promise((resolve) => {
    let url;
    try { url = sourceArtifactUrl(ref, sourceRepository, sourceRef); } catch (error) { resolve({ ok: false, error: error.message }); return; }
    const requestUrl = retryTag ? `${url}?source_blob_sha=${encodeURIComponent(retryTag)}` : url;
    const child = spawn('curl', [
      '-L', '-sS', '--fail', '--connect-timeout', '10', '--max-time', '20', '--retry', '1', '--retry-delay', '1', requestUrl,
    ]);
    const chunks = [];
    const errors = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => resolve({ ok: false, error: error.message }));
    child.on('close', (status) => {
      if (status !== 0) {
        resolve({ ok: false, error: (Buffer.concat(errors).toString('utf8') || `curl status ${status}`).trim() });
        return;
      }
      resolve({ ok: true, content: Buffer.concat(chunks) });
    });
  });
}

function projectionArtifact(item) {
  const candidates = item.artifacts.filter((artifact) => SOURCE_PROVENANCE.has(artifact.provenance) && artifact.git_blob_sha && artifact.integrity === 'present');
  return candidates.find((artifact) => artifact.kind === 'text_projection')
    || candidates.find((artifact) => artifact.kind === 'json')
    || candidates.find((artifact) => artifact.kind === 'html')
    || null;
}

async function sourceInventory(selection, outputPath) {
  if (selection.source_repository !== SOURCE_REPOSITORY || selection.source_repository_ref !== SOURCE_REF) throw new Error('selection source binding mismatch');
  const items = [];
  for (let start = 0; start < selection.items.length; start += 12) {
    const batch = selection.items.slice(start, start + 12);
    const fetched = await Promise.all(batch.map((item) => {
      const artifact = projectionArtifact(item);
      return artifact ? fetchSourceArtifactAsync(artifact.ref, SOURCE_REPOSITORY, SOURCE_REF) : Promise.resolve({ ok: false, error: 'no non-empty Raw/Source projection artifact with Git blob SHA' });
    }));
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const fetchedArtifact = fetched[index];
      const artifact = projectionArtifact(item);
      if (!artifact) {
        items.push({ issue_number: item.issue_number, source_note_id: item.source_note_id, status: 'blocked', block_reason: fetchedArtifact.error });
        continue;
      }
      if (!fetchedArtifact.ok) {
        items.push({ issue_number: item.issue_number, source_note_id: item.source_note_id, status: 'blocked', block_reason: `source artifact fetch failed: ${fetchedArtifact.error}`, artifact: { ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size } });
        continue;
      }
      let content = fetchedArtifact.content;
      if (gitBlobSha(content) !== artifact.git_blob_sha || content.length !== artifact.byte_size) {
        const retried = await fetchSourceArtifactAsync(artifact.ref, SOURCE_REPOSITORY, SOURCE_REF, artifact.git_blob_sha);
        if (!retried.ok) {
          items.push({ issue_number: item.issue_number, source_note_id: item.source_note_id, status: 'blocked', block_reason: `source artifact retry failed after integrity mismatch: ${retried.error}`, artifact: { ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size } });
          continue;
        }
        content = retried.content;
      }
      if (gitBlobSha(content) !== artifact.git_blob_sha || content.length !== artifact.byte_size) {
        items.push({ issue_number: item.issue_number, source_note_id: item.source_note_id, status: 'blocked', block_reason: 'source artifact Git blob SHA or byte length mismatch after deterministic retry', artifact: { ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size } });
        continue;
      }
      const text = content.toString('utf8');
      const lines = text.split(/\r?\n/);
      items.push({
        issue_number: item.issue_number,
        source_note_id: item.source_note_id,
        source_revision_id: item.source_revision_id,
        source_repository_ref: item.source_repository_ref,
        status: 'verified',
        artifact: { ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance, git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size },
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
