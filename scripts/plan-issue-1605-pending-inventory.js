#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildInventoryItem,
  buildOwnershipIndex,
  buildSnapshot,
  validateSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  SOURCE_REPOSITORY,
  SOURCE_REF,
  PENDING_LABELS,
} = require('./lib/issue-1605-pending-inventory');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    repository: 'liqiangcc/interview-lab',
    output: 'data/pilot/issue-1605/pending-inventory.snapshot.json',
    ownershipOutput: 'data/pilot/issue-1605/pending-inventory.ownership.json',
    pageSize: 100,
    maxPages: 100,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repository') args.repository = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--ownership-output') args.ownershipOutput = argv[++index];
    else if (arg === '--page-size') args.pageSize = Number(argv[++index]);
    else if (arg === '--max-pages') args.maxPages = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.pageSize !== 100) throw new Error('--page-size must remain 100 for the frozen inventory contract');
  if (!Number.isInteger(args.maxPages) || args.maxPages < 1) throw new Error('--max-pages must be a positive integer');
  return args;
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
}

function sleepMs(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readPage(repository, page, perPage) {
  const endpoint = `repos/${repository}/issues?state=all&labels=type%3Asource-note&per_page=${perPage}&page=${page}`;
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const issues = ghJson(['api', endpoint]);
      if (!Array.isArray(issues)) throw new Error(`GitHub returned a non-array page ${page}`);
      return { endpoint, issues };
    } catch (error) {
      lastError = error;
      if (attempt < 4) sleepMs(attempt * 1000);
    }
  }
  throw lastError;
}

function fetchInventory({ repository, pageSize = 100, maxPages = 100, read = readPage } = {}) {
  const pages = [];
  const selected = [];
  const selectedNumbers = new Set();
  for (let page = 1; page <= maxPages; page += 1) {
    const response = read(repository, page, pageSize);
    pages.push({ page, endpoint: response.endpoint, item_count: response.issues.length });
    for (const issue of response.issues) {
      if (issue.pull_request) throw new Error(`GitHub issue page contains pull request #${issue.number}; refusing ambiguous inventory`);
      const labels = (issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
      if (!PENDING_LABELS.every((label) => labels.includes(label))) continue;
      const item = buildInventoryItem(issue);
      if (!item.ok) throw new Error(`pending inventory item #${issue.number} failed closed: ${item.errors.join('; ')}`);
      if (selectedNumbers.has(item.issue_number)) throw new Error(`duplicate issue #${item.issue_number} across pages`);
      selectedNumbers.add(item.issue_number);
      selected.push(item);
    }
    if (response.issues.length < pageSize) return { pages, items: selected };
  }
  throw new Error(`pagination exceeded --max-pages=${maxPages}; refusing incomplete inventory`);
}

function writeAtomic(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const query = `repos/${args.repository}/issues?state=all&labels=type%3Asource-note&per_page=${args.pageSize}&page={page}`;
  const fetched = fetchInventory(args);
  const snapshot = buildSnapshot({ repository: args.repository, pages: fetched.pages, items: fetched.items, query });
  if (!snapshot.validation.ok) throw new Error(`pending inventory failed closed: ${snapshot.validation.errors.join('; ')}`);
  const ownership = buildOwnershipIndex(snapshot.items, snapshot.canonical_digest);
  const validated = validateSnapshot(snapshot, ownership);
  if (!validated.ok) throw new Error(`snapshot/ownership validation failed closed: ${validated.errors.join('; ')}`);
  writeAtomic(args.output, snapshot);
  writeAtomic(args.ownershipOutput, ownership);
  process.stdout.write(`${JSON.stringify({
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    snapshot: path.resolve(args.output),
    ownership_index: path.resolve(args.ownershipOutput),
    canonical_digest: snapshot.canonical_digest,
    ownership_digest: ownership.canonical_digest,
    pages: snapshot.selection.pages,
    count: snapshot.count,
    union_count: snapshot.union_count,
    union_disjoint: snapshot.union_disjoint,
    read_only: true,
    source_repository: SOURCE_REPOSITORY,
    source_ref: SOURCE_REF,
  }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { parseArgs, readPage, fetchInventory, writeAtomic, main };
