#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { validateInterviewNoteIssue } = require('./lib/interview-note-issue');

function parseArgs(argv) {
  const file = argv[2];
  const labels = [];
  let state = 'open';
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === '--label' && argv[i + 1]) labels.push(argv[++i]);
    else if (argv[i] === '--state' && argv[i + 1]) state = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!file) throw new Error('Usage: node scripts/validate-interview-note-issue.js <issue-body.md> [--label <label>] [--state open|closed]');
  return { file, labels, state };
}

function main(argv = process.argv) {
  try {
    const { file, labels, state } = parseArgs(argv);
    const body = fs.readFileSync(path.resolve(file), 'utf8');
    const effectiveLabels = labels.length ? labels : ['type:interview-note', 'status:captured'];
    const result = validateInterviewNoteIssue({ body, labels: effectiveLabels, state });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs };
