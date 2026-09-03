'use strict';

const fs = require('fs');
const { validateExplorationSessionCheckpoint } = require('./lib/exploration-session-checkpoint');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/validate-exploration-session-checkpoint.js <comment-markdown-file>');
  process.exit(2);
}

const body = fs.readFileSync(file, 'utf8');
const result = validateExplorationSessionCheckpoint(body);

for (const warning of result.warnings) {
  console.warn(`WARN: ${warning}`);
}

if (!result.ok) {
  for (const error of result.errors) {
    console.error(`ERROR: ${error}`);
  }
  process.exit(1);
}

console.log(`PASS: ${result.record.schema_version} ${result.record.session_id} position=${result.record.revealed_position} phase=${result.record.loop_phase}`);
