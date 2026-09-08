#!/usr/bin/env node
'use strict';

/* Capture only the exact #1608 issue interval for a reproducible live read. */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const FIRST_ISSUE = 766;
const LAST_ISSUE = 1138;
const REPOSITORY = 'liqiangcc/interview-lab';

function issueNumbers() {
  return Array.from({ length: LAST_ISSUE - FIRST_ISSUE + 1 }, (_, index) => FIRST_ISSUE + index);
}

function runGh(query) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', 'graphql', '-f', `query=${query}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}${stderr ? ` ${stderr.trim()}` : ''}`));
      try { return resolve(JSON.parse(stdout)); } catch (parseError) { return reject(parseError); }
    });
  });
}

async function readChunk(numbers) {
  const aliases = numbers.map((number) => `i${number}: issueOrPullRequest(number: ${number}) { __typename ... on Issue { number state title body url updatedAt labels(first: 30) { nodes { name } } } ... on PullRequest { number state title body url updatedAt labels(first: 30) { nodes { name } } } }`).join(' ');
  const query = `query { repository(owner: "liqiangcc", name: "${REPOSITORY.split('/')[1]}") { ${aliases} } }`;
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await runGh(query);
      return Object.values(response.data.repository).filter(Boolean);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

async function main() {
  const output = path.resolve(process.argv[2] || '/tmp/issue-1608-live-issues.json');
  const capturedAt = process.argv[3] || new Date().toISOString();
  const numbers = issueNumbers();
  const chunks = [];
  for (let index = 0; index < numbers.length; index += 40) chunks.push(numbers.slice(index, index + 40));
  const rows = [];
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= chunks.length) return;
      rows.push(...await readChunk(chunks[index]));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const byNumber = new Map(rows.map((row) => [Number(row.number), row]));
  if (byNumber.size !== numbers.length || numbers.some((number) => !byNumber.has(number))) throw new Error('live snapshot did not cover exact #766-#1138 interval');
  const issues = numbers.map((number) => {
    const row = byNumber.get(number);
    return {
      ...row,
      state: String(row.state || '').toLowerCase(),
      html_url: row.url,
      updated_at: row.updatedAt,
      labels: (row.labels && row.labels.nodes) || [],
    };
  });
  const snapshot = {
    schema_version: 'issue-1608-live-issue-snapshot.v2',
    repository: REPOSITORY,
    range: { first: FIRST_ISSUE, last: LAST_ISSUE },
    captured_at: capturedAt,
    numbers,
    issues,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(snapshot, null, 2)}\n`);
  const labels = (issue) => new Set(((issue.labels && issue.labels.nodes) || issue.labels || []).map((label) => label.name || label));
  const pending = issues.filter((issue) => issue.state === 'open' && ['boundary:pending', 'type:source-note', 'status:captured'].every((label) => labels(issue).has(label)));
  console.log(JSON.stringify({ output, captured_at: capturedAt, total: issues.length, pending: pending.length, nonpending: issues.length - pending.length }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
