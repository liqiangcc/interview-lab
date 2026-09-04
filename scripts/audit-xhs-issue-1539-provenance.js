#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const REPOSITORY = 'liqiangcc/xhs';
const PINNED_REF = '95b77bb261048059846273688e4b90a2e108b437';
const PATHS = [
  'note_detail/63f76452000000001303ca72.html',
  'note_desc/63f76452000000001303ca72.txt',
  'note_json/63f76452000000001303ca72.json',
  'note_images/63f76452000000001303ca72_urls.txt',
];
const ROOT_INIT = '6ac989f4dde363fe7b8ddb28fcc13852845cf409';

function ghJson(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function main(argv = process.argv.slice(2)) {
  const reportIndex = argv.indexOf('--report');
  const reportPath = reportIndex >= 0 ? argv[reportIndex + 1] : null;
  if (argv.some((arg, index) => arg === '--apply' || (arg === '--report' && !argv[index + 1]))) {
    throw new Error('this audit is read-only and accepts only optional --report PATH');
  }
  const commit = ghJson(['api', `repos/${REPOSITORY}/commits/${PINNED_REF}`]);
  const artifacts = PATHS.map((path) => {
    const content = ghJson(['api', `repos/${REPOSITORY}/contents/${path}?ref=${PINNED_REF}`]);
    const history = ghJson(['api', `repos/${REPOSITORY}/commits?path=${path}&per_page=100`]);
    return {
      path,
      pinned_blob_sha: content.sha,
      pinned_byte_size: content.size,
      path_history: history.map((item) => ({ sha: item.sha, date: item.commit.author.date, message: item.commit.message })),
    };
  });
  const reportWithoutDigest = {
    schema_version: 'issue-1539-source-provenance-audit.v1',
    repository: REPOSITORY,
    pinned_ref: PINNED_REF,
    pinned_commit: {
      sha: commit.sha,
      message: commit.commit.message,
      authored_at: commit.commit.author.date,
      parent: commit.parents && commit.parents[0] ? commit.parents[0].sha : null,
      changed_files: (commit.files || []).map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions })),
    },
    artifacts,
    lineage_assessment: {
      exact_paths_have_history: artifacts.every((item) => item.path_history.length > 0),
      exact_paths_share_only_root_init: artifacts.every((item) => item.path_history.length === 1 && item.path_history[0].sha === ROOT_INIT),
      one_to_one_derived_from_provable: false,
      status: 'pinned-source-artifact',
      raw_lineage_claim: 'not-claimed',
      reason: 'No producer manifest, explicit derived_from mapping, or causal commit is present in the repository evidence for these projection paths.',
      forbidden_inferences: ['same external id', 'same pinned commit', 'matching filename', 'history co-occurrence'],
    },
    mutation_performed: false,
  };
  const report = { ...reportWithoutDigest, audit_sha256: sha256(reportWithoutDigest) };
  if (reportPath) {
    const temporary = `${reportPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(temporary, reportPath);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 2; }
}

module.exports = { main, PATHS, PINNED_REF, ROOT_INIT };
