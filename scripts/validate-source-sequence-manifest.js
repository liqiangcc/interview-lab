'use strict';

const fs = require('fs');
const path = require('path');
const { validateSourceSequenceManifest } = require('./lib/source-sequence-manifest');

const filePath = process.argv[2];
if (!filePath) {
  console.error('usage: node scripts/validate-source-sequence-manifest.js <manifest.json>');
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
} catch (error) {
  console.error(`FAIL: cannot parse manifest: ${error.message}`);
  process.exit(1);
}

const result = validateSourceSequenceManifest(manifest);
for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
if (!result.ok) {
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`PASS: ${manifest.schema_version} ${manifest.manifest_id} units=${manifest.units.length}`);
