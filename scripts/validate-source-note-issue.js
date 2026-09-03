#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { validateSourceNoteIssue } = require('./lib/source-note-issue');

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/validate-source-note-issue.js <issue.md> [--state open|closed] [--label <label>]...');
  process.exit(2);
}
const file = args.shift();
let state = 'open';
const labels = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--state') state = args[++i];
  else if (args[i] === '--label') labels.push(args[++i]);
  else throw new Error(`unknown argument: ${args[i]}`);
}

const body = fs.readFileSync(file, 'utf8');
const result = validateSourceNoteIssue({ body, labels, state });
for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
if (!result.ok) {
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}
console.log('SourceNote Issue: PASS');
