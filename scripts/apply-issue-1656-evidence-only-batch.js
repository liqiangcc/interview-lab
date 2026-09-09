#!/usr/bin/env node
'use strict';

/*
 * Evidence-only batch CLI.  Without --apply it never calls GitHub.  The
 * apply path is intentionally explicit and has only a comment-create adapter;
 * boundary, label, and materialization adapters do not exist here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  buildPlanOnly,
  applyEvidenceBatch,
  SOURCE_REF,
  REPOSITORY,
} = require('./lib/issue-1656-evidence-only-batch');

const DEFAULT_PLAN = 'data/pilot/issue-1656/evidence-post-plan.json';
const DEFAULT_JOURNAL = 'data/pilot/issue-1656/evidence-only-batch.journal.json';
const DEFAULT_LOCK = 'data/pilot/issue-1656/evidence-only-batch.lock';

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
function ghJson(args, input = null) { return JSON.parse(execFileSync('gh', args, { input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 })); }
function readIssue(number) { return ghJson(['api', `repos/${REPOSITORY}/issues/${number}`]); }
function readComments(number) {
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const batch = ghJson(['api', `repos/${REPOSITORY}/issues/${number}/comments?per_page=100&page=${page}`]);
    if (!Array.isArray(batch)) throw new Error(`#${number} comments page ${page} is not an array`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error(`#${number} comments pagination exceeded bound`);
}
function postEvidenceComment(number, body) { return ghJson(['api', '--method', 'POST', `repos/${REPOSITORY}/issues/${number}/comments`, '--input', '-'], { body }); }

function parseArgs(argv = process.argv.slice(2)) {
  const args = { plan: DEFAULT_PLAN, journal: DEFAULT_JOURNAL, lock: DEFAULT_LOCK, apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--plan') args.plan = argv[++index];
    else if (argv[index] === '--journal') args.journal = argv[++index];
    else if (argv[index] === '--lock') args.lock = argv[++index];
    else if (argv[index] === '--apply') args.apply = true;
    else if (argv[index] === '--help') args.help = true;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write('Usage: node scripts/apply-issue-1656-evidence-only-batch.js [--plan FILE] [--journal FILE] [--lock FILE] [--apply]\n'); return 0; }
  const plan = readJson(args.plan);
  if (!args.apply) {
    const output = buildPlanOnly(plan);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }
  const required = ['AUTHORIZATION_COMMENT_ID', 'PLAN_DIGEST', 'CONFIRM_DIGEST', 'MAX_MUTATIONS', 'DRY_RUN_DIGEST'];
  const missing = required.filter((name) => !String(env[name] || '').trim());
  if (missing.length) throw new Error(`--apply requires ${missing.join(', ')}`);
  const authComment = readComments(1611).find((comment) => Number(comment.id) === Number(env.AUTHORIZATION_COMMENT_ID));
  if (!authComment) throw new Error('authorization comment was not found on parent #1611');
  const authorization = {
    authorization_comment_id: Number(env.AUTHORIZATION_COMMENT_ID),
    plan_digest: env.PLAN_DIGEST,
    confirm_digest: env.CONFIRM_DIGEST,
    max_mutations: Number(env.MAX_MUTATIONS),
  };
  const result = applyEvidenceBatch({ plan, authorizationComment: authComment, authorization, dryRunDigest: env.DRY_RUN_DIGEST, journalFile: args.journal, lockFile: args.lock, api: { readIssue, readComments, postEvidenceComment } });
  process.stdout.write(`${JSON.stringify({ ok: result.ok, mode: result.mode, plan_digest: result.plan_digest, counts: result.counts, write_operations: result.write_operations }, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) { try { process.exitCode = main(); } catch (error) { process.stderr.write(`ERROR: ${error.message}\n`); process.exitCode = 1; } }

module.exports = { parseArgs, main, readComments, postEvidenceComment, SOURCE_REF };
