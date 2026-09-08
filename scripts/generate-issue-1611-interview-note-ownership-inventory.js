#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./lib/interview-note-issue');
const { canonicalDigest, sha256Text } = require('./lib/aggregate-downstream-pipeline');

const REPOSITORY = 'liqiangcc/interview-lab';
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const SCHEMA_VERSION = 'aggregate-interview-note-ownership-inventory.v1';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { repository: REPOSITORY, output: null, maxPages: MAX_PAGES };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repository') args.repository = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--max-pages') args.maxPages = Number(argv[++index]);
    else if (['--apply', '--method', '--post', '--patch'].includes(arg)) throw new Error(`${arg} is forbidden: ownership inventory is GET-only`);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^[^/]+\/[^/]+$/.test(args.repository)) throw new Error('--repository must be owner/repo');
  if (!args.output) throw new Error('--output is required');
  if (!Number.isInteger(args.maxPages) || args.maxPages < 1) throw new Error('--max-pages must be a positive integer');
  return args;
}

function readPage(repository, page) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repository}/issues?state=all&labels=type%3Ainterview-note&per_page=${PAGE_SIZE}&page=${page}`], {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    timeout: 30_000,
  }));
}

function paginateInterviewNotes(repository, read = (page) => readPage(repository, page), maxPages = MAX_PAGES) {
  const issues = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = read(page);
    if (!Array.isArray(batch)) throw new Error(`InterviewNote inventory page ${page} is not an array; refusing incomplete inventory`);
    for (const issue of batch) {
      if (issue && issue.pull_request) continue;
      const labels = (issue && issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
      if (!labels.includes('type:interview-note')) throw new Error(`InterviewNote inventory page ${page} contains an object without type:interview-note; refusing incomplete inventory`);
      issues.push(issue);
    }
    if (batch.length < PAGE_SIZE) return issues;
  }
  throw new Error(`InterviewNote inventory reached maxPages=${maxPages} without observing a short terminal page; refusing incomplete inventory`);
}

function buildInventory(issues, repository = REPOSITORY) {
  const errors = [];
  const byIssue = new Set();
  const byInterview = new Set();
  const entries = [];
  for (const issue of issues) {
    const number = Number(issue && issue.number);
    if (!Number.isInteger(number) || number < 1 || byIssue.has(number)) { errors.push(`duplicate or invalid Issue #${issue && issue.number}`); continue; }
    byIssue.add(number);
    const validation = validateInterviewNoteIssue({ body: issue.body, labels: issue.labels, state: String(issue.state || 'open').toLowerCase() });
    if (!validation.ok) { errors.push(`InterviewNote Issue #${number}: ${validation.errors.join('; ')}`); continue; }
    const parsed = parseInterviewNoteIssue(issue.body || '');
    const interviewNoteId = parsed.marker && parsed.marker.interview_note_id;
    if (!interviewNoteId || byInterview.has(interviewNoteId)) { errors.push(`duplicate or missing InterviewNote identity on Issue #${number}`); continue; }
    byInterview.add(interviewNoteId);
    entries.push({
      interview_note_id: interviewNoteId,
      issue_number: number,
      body_sha256: sha256Text(issue.body || ''),
      source_note_id: parsed.record && parsed.record.source_note_id || null,
      source_revision_id: parsed.record && parsed.record.source_revision && parsed.record.source_revision.id || null,
      labels: (issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean).sort(),
    });
  }
  entries.sort((left, right) => left.issue_number - right.issue_number);
  if (errors.length) throw new Error(`cannot build complete InterviewNote ownership inventory: ${errors.join('; ')}`);
  const digestInput = {
    schema_version: SCHEMA_VERSION,
    repository,
    coverage: 'all-repository-interview-note-issues',
    complete: true,
    count: entries.length,
    entries,
  };
  return { ...digestInput, canonical_digest: canonicalDigest(digestInput) };
}

function atomicWrite(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, target);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const issues = paginateInterviewNotes(args.repository, (page) => readPage(args.repository, page), args.maxPages);
  const inventory = buildInventory(issues, args.repository);
  atomicWrite(args.output, inventory);
  process.stdout.write(`${JSON.stringify({ output: path.resolve(args.output), count: inventory.count, canonical_digest: inventory.canonical_digest, mutation_performed: false }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { SCHEMA_VERSION, PAGE_SIZE, parseArgs, paginateInterviewNotes, buildInventory };
