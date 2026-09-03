#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { buildLearningDiscovery } = require('./lib/interview-context');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/validate-interview-context.js <interview-context.json>');
  process.exit(2);
}

let context;
try {
  context = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
} catch (error) {
  console.error(`failed to read InterviewContext: ${error.message}`);
  process.exit(2);
}

const result = buildLearningDiscovery(context);
for (const warning of result.warnings || []) console.warn(`WARN: ${warning}`);
if (!result.ok) {
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  context_id: context.context_id,
  learning_labels: result.learning_labels,
  non_spoiler_title: result.non_spoiler_title,
  pre_learning_display: result.pre_learning_display,
}, null, 2));
