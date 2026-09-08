#!/usr/bin/env node
'use strict';

/* Controlled two-worker prefetcher for the already-frozen Boundary B selection. */

const fs = require('fs');
const path = require('path');
const {
  FIRST_ISSUE,
  LAST_ISSUE,
  readPinnedArtifact,
  sourceArtifactRecord,
  validateAndFreezeIssue,
} = require('./prepare-issue-1607-boundary-batch');

const selectionFile = path.resolve(process.argv[2] || 'data/issue-1607/selection.json');
const liveFile = path.resolve(process.argv[3] || '/tmp/issue-1607-current-live.json');
const cacheDir = path.resolve(process.argv[4] || '/tmp/issue-1607-source-artifacts');
const worker = Number(process.argv[5] || 0);
const workerCount = Number(process.argv[6] || 2);
const selection = JSON.parse(fs.readFileSync(selectionFile, 'utf8'));
const live = JSON.parse(fs.readFileSync(liveFile, 'utf8'));
const liveByNumber = new Map(live.issues.map((issue) => [Number(issue.number), issue]));
const selected = selection.items.filter((item) => item.issue_number >= FIRST_ISSUE && item.issue_number <= LAST_ISSUE);
const failures = [];
let verified = 0;

for (let index = worker; index < selected.length; index += workerCount) {
  const item = selected[index];
  const issue = liveByNumber.get(item.issue_number);
  if (!issue) { failures.push({ issue_number: item.issue_number, reason: 'frozen live snapshot lacks selected issue' }); continue; }
  const checked = validateAndFreezeIssue(issue);
  if (!checked.ok || checked.record.source_note_id !== item.source_note_id) {
    failures.push({ issue_number: item.issue_number, reason: 'frozen body/source identity mismatch' });
    continue;
  }
  const artifacts = checked.record.artifacts.filter((artifact) => ['html', 'json', 'text_projection'].includes(artifact.kind));
  for (const artifact of artifacts.filter((value) => value.kind !== 'text_projection')) {
    try {
      const fetched = readPinnedArtifact(artifact, cacheDir);
      sourceArtifactRecord(artifact, fetched, checked.record.source.external_id);
      verified += 1;
    } catch (error) {
      failures.push({ issue_number: item.issue_number, kind: artifact.kind, reason: error.message });
    }
  }
}

process.stdout.write(`${JSON.stringify({ worker, worker_count: workerCount, processed_items: Math.ceil(Math.max(0, selected.length - worker) / workerCount), verified, failures }, null, 2)}\n`);
process.exitCode = failures.length ? 1 : 0;
