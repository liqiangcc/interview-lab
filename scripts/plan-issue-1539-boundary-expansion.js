#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseInterviewNoteIssue } = require('./lib/interview-note-issue');
const { ownershipSearchEndpoint } = require('./lib/interview-note-ownership-search');
const {
  REPOSITORY,
  SOURCE_REPOSITORY,
  planBoundaryExpansion,
} = require('./lib/issue-1539-boundary-expansion');

function parseArgs(argv = process.argv.slice(2)) {
  const args = { manifest: null, report: null, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--manifest') args.manifest = argv[++index];
    else if (arg === '--report') args.report = argv[++index];
    else if (arg === '--apply') args.apply = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.manifest) throw new Error('--manifest is required');
  if (args.apply) throw new Error('business mutation is disabled: this boundary expansion command is plan-only');
  return args;
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }));
}

function readIssue(issueNumber) { return ghJson(['api', `repos/${REPOSITORY}/issues/${issueNumber}`]); }

function readComments(issueNumber) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const current = ghJson(['api', `repos/${REPOSITORY}/issues/${issueNumber}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(current)) throw new Error(`comments response for #${issueNumber} is not an array`);
    comments.push(...current);
    if (current.length < 100) return comments;
  }
  throw new Error(`comments pagination exceeded for #${issueNumber}`);
}

function readBlob(blobSha) { return ghJson(['api', `repos/${SOURCE_REPOSITORY}/git/blobs/${blobSha}`]); }

function readOwnership(interviewNoteId) {
  const endpoint = ownershipSearchEndpoint(REPOSITORY, interviewNoteId);
  const issues = [];
  let expectedTotal = null;
  for (let page = 1; page <= 10; page += 1) {
    const result = ghJson(['api', `${endpoint}&page=${page}`]);
    if (!result || result.incomplete_results === true) throw new Error('ownership search is incomplete');
    if (expectedTotal == null) expectedTotal = Number.isInteger(result.total_count) ? result.total_count : null;
    if (expectedTotal != null && result.total_count !== expectedTotal) throw new Error('ownership search total_count changed during pagination');
    if (!Array.isArray(result.items)) throw new Error('ownership search items are unavailable');
    for (const item of result.items) {
      const number = Number(item.number);
      if (!Number.isInteger(number) || number < 1) throw new Error('ownership search returned an invalid Issue number');
      const issue = readIssue(number);
      if (!issue.pull_request && parseInterviewNoteIssue(issue.body || '').marker) issues.push(issue);
    }
    if (result.items.length === 0 || result.items.length < 100 || (expectedTotal != null && page * 100 >= expectedTotal)) break;
    if (page === 10) throw new Error('ownership search exceeded the bounded page limit');
  }
  return issues;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifestPath = path.resolve(args.manifest);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const planned = planBoundaryExpansion(manifest, { readIssue, readComments, readBlob, findOwnership: readOwnership });
  if (args.report) fs.writeFileSync(path.resolve(args.report), `${JSON.stringify(planned.report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(planned.report, null, 2)}\n`);
  return planned.ok ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}

module.exports = { parseArgs, readOwnership, main };
