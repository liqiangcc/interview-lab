#!/usr/bin/env node
'use strict';

/*
 * Read-only capture of the complete fixed-ref artifacts for the currently
 * selected issue-1608 remainder.  The caller supplies the already frozen
 * exact-interval issue snapshot and the current selection.  This helper is
 * deliberately limited to the selected issue numbers; it never enumerates
 * the xhs tree and never writes to GitHub.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const FIRST_ISSUE = 766;
const LAST_ISSUE = 1138;

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
function ghJson(args) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const run = () => {
      attempt += 1;
      execFile('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) {
          try { return resolve(JSON.parse(stdout)); } catch (parseError) { return reject(parseError); }
        }
        if (attempt < 5) return setTimeout(run, 600 * attempt);
        reject(new Error(`${error.message}${stderr ? ` ${stderr.trim()}` : ''}`));
      });
    };
    run();
  });
}
function rawBytes(item, expected) {
  const match = String(expected.ref).match(/^liqiangcc\/xhs:(.+)@([^@]+)$/);
  if (!match || match[2] !== SOURCE_REF) throw new Error(`#${item.issue_number} ${expected.kind} ref is not the fixed source ref`);
  const url = `https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/${SOURCE_REF}/${match[1]}`;
  return new Promise((resolve, reject) => {
    execFile('curl', ['-fsSL', '--retry', '3', '--retry-all-errors', '--connect-timeout', '10', '--max-time', '60', url], { encoding: null, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}${stderr ? ` ${stderr.toString('utf8').trim()}` : ''}`));
      resolve(Buffer.from(stdout));
    });
  });
}
async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}
function parseRecord(body) {
  const match = String(body || '').match(/<!-- source-note-record\n([\s\S]*?)\n-->/);
  if (!match) throw new Error('SourceNote record comment missing');
  return JSON.parse(match[1]);
}
function artifact(record, kind) {
  const item = (record.artifacts || []).find((candidate) => candidate.kind === kind);
  if (!item || !item.git_blob_sha || !item.ref || !item.byte_size) throw new Error(`missing complete ${kind} artifact`);
  return item;
}
async function readBlob(item, expected) {
  const response = await ghJson(['api', `repos/${SOURCE_REPOSITORY}/git/blobs/${expected.git_blob_sha}`]);
  if (response.sha !== expected.git_blob_sha || response.encoding !== 'base64' || typeof response.content !== 'string') {
    throw new Error(`#${item.issue_number} ${expected.kind} blob response mismatch`);
  }
  const bytes = Buffer.from(response.content.replace(/\s/g, ''), 'base64');
  if (bytes.length !== expected.byte_size || gitBlobSha(bytes) !== expected.git_blob_sha) {
    throw new Error(`#${item.issue_number} ${expected.kind} blob integrity mismatch`);
  }
  return bytes;
}

async function main(argv) {
  const [issuesFile, selectionFile, outputFile, cacheDir, sourceDir] = argv;
  if (!issuesFile || !selectionFile || !outputFile || !cacheDir) throw new Error('usage: capture ... issues.json selection.json output.json cache-dir [fixed-ref-source-dir]');
  const issues = readJson(issuesFile);
  const selection = readJson(selectionFile);
  if (issues.range?.first !== FIRST_ISSUE || issues.range?.last !== LAST_ISSUE) throw new Error('issue snapshot range drifted');
  const selected = selection.items.filter((item) => item.disposition === 'blocked');
  if (!selected.length || selected.some((item) => item.issue_number < FIRST_ISSUE || item.issue_number > LAST_ISSUE)) throw new Error('selection is not an exact in-range pending remainder');
  const liveByNumber = new Map(issues.issues.map((item) => [Number(item.number), item]));
  const rows = await mapWithConcurrency(selected, 8, async (item) => {
    const live = liveByNumber.get(item.issue_number);
    if (!live) throw new Error(`#${item.issue_number} missing from exact issue snapshot`);
    const record = parseRecord(live.body);
    if (record.source_revision?.source_repository !== SOURCE_REPOSITORY || record.source_revision?.source_repository_ref !== SOURCE_REF) throw new Error(`#${item.issue_number} source ref drifted`);
    if (record.source?.external_id !== item.source_external_id) throw new Error(`#${item.issue_number} external id drifted`);
    const expected = [artifact(record, 'html'), artifact(record, 'json'), artifact(record, 'text_projection')];
    const bytesByKind = {};
    for (const candidate of expected) {
      const cachePath = candidate.kind === 'text_projection' ? path.join(cacheDir, `${item.source_external_id}.txt`) : null;
      if (cachePath && fs.existsSync(cachePath)) {
        bytesByKind[candidate.kind] = fs.readFileSync(cachePath);
        if (bytesByKind[candidate.kind].length !== candidate.byte_size || gitBlobSha(bytesByKind[candidate.kind]) !== candidate.git_blob_sha) throw new Error(`#${item.issue_number} note_desc cache integrity mismatch`);
      } else {
        const pathMatch = String(candidate.ref).match(/^liqiangcc\/xhs:(.+)@([^@]+)$/);
        const localPath = sourceDir && pathMatch && pathMatch[2] === SOURCE_REF ? path.join(sourceDir, pathMatch[1]) : null;
        bytesByKind[candidate.kind] = localPath && fs.existsSync(localPath)
          ? fs.readFileSync(localPath)
          : candidate.kind === 'text_projection' ? await readBlob(item, candidate) : await rawBytes(item, candidate);
        if (bytesByKind[candidate.kind].length !== candidate.byte_size || gitBlobSha(bytesByKind[candidate.kind]) !== candidate.git_blob_sha) throw new Error(`#${item.issue_number} ${candidate.kind} raw content integrity mismatch`);
      }
    }
    try { JSON.parse(bytesByKind.json.toString('utf8')); } catch (error) { throw new Error(`#${item.issue_number} source json is not valid UTF-8 JSON: ${error.message}`); }
    const artifacts = expected.map((candidate) => ({
      kind: candidate.kind,
      ref: candidate.ref,
      git_blob_sha: candidate.git_blob_sha,
      byte_size: candidate.byte_size,
      content_sha256: sha256(bytesByKind[candidate.kind]),
      retrieval: candidate.kind === 'text_projection' && fs.existsSync(path.join(cacheDir, `${item.source_external_id}.txt`))
        ? { method: 'verified-note-desc-cache', path: path.join(cacheDir, `${item.source_external_id}.txt`) }
        : { method: candidate.kind === 'text_projection' ? 'github-git-blob' : (sourceDir ? 'fixed-ref-local-partial-clone' : 'raw-fixed-ref'), path: candidate.kind === 'text_projection' ? `repos/${SOURCE_REPOSITORY}/git/blobs/${candidate.git_blob_sha}` : (sourceDir ? path.join(sourceDir, candidate.ref.split(':')[1].split('@')[0]) : candidate.ref) },
      complete_content_read: true,
    }));
    return {
      issue_number: item.issue_number,
      source_note_id: record.source_note_id,
      source_external_id: record.source.external_id,
      source_revision_id: record.source_revision.id,
      artifacts,
      note_desc: {
        text: bytesByKind.text_projection.toString('utf8').replace(/\r\n/g, '\n'),
        blob_sha: gitBlobSha(bytesByKind.text_projection),
        byte_length: bytesByKind.text_projection.length,
      },
    };
  });
  rows.sort((left, right) => left.issue_number - right.issue_number);
  writeJson(outputFile, {
    schema_version: 'issue-1608-source-artifacts.v1',
    source_repository: SOURCE_REPOSITORY,
    source_ref: SOURCE_REF,
    issue_range: { first: FIRST_ISSUE, last: LAST_ISSUE },
    selection_sha256: selection.selection_sha256,
    captured_at: new Date().toISOString(),
    items: Object.fromEntries(rows.map((row) => [String(row.issue_number), {
      text: row.note_desc.text,
      blob_sha: row.note_desc.blob_sha,
      byte_length: row.note_desc.byte_length,
      artifacts: row.artifacts,
    }])),
  });
  console.log(JSON.stringify({ output: outputFile, total: rows.length, complete_artifacts_per_row: 3 }, null, 2));
}

main(process.argv.slice(2)).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
