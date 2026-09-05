'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../scripts/apply-issue-1556-materialization-batch');
const { buildPacketSet } = require('../scripts/lib/issue-1539-boundary-evidence-batch');
const { ISSUE_NUMBERS, renderMaterializationReceipt } = require('../scripts/lib/issue-1556-materialization-batch');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/issue-1556-authorized-batch.json'), 'utf8'));

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1556-cli-'));
  const sourceIssues = new Map(fixture.source_issues.map((issue) => [issue.number, clone(issue)]));
  const owners = new Map(ISSUE_NUMBERS.map((issue) => [issue, []]));
  const comments = new Map(ISSUE_NUMBERS.map((issue) => [issue, []]));
  const calls = { create: [], receipt: [] };
  const args = [
    '--manifest', 'fixture-manifest.json',
    '--request-dir', 'boundary-review-requests',
    '--evidence-receipt-dir', 'evidence-receipts',
    '--transition-receipt-dir', 'boundary-transition-receipts',
    '--output', path.join(root, 'materialization.plan.json'),
    '--progress', path.join(root, 'materialization.progress.json'),
    '--materialization-request-dir', path.join(root, 'materialization-requests'),
    '--materialization-receipt-dir', path.join(root, 'materialization-receipts'),
    '--get-max-attempts', '3',
    '--get-backoff-ms', '0',
    '--min-mutation-interval-ms', '0',
  ];
  const runtime = {
    manifest: fixture.manifest,
    packetSet: fixture.packet_set,
    transitionRequests: fixture.transition_requests,
    evidenceReceipts: fixture.evidence_receipts,
    transitionReceipts: fixture.transition_receipts,
    loadLive: (request) => ({
      sourceIssue: sourceIssues.get(request.source_note_issue_number),
      comments: comments.get(request.source_note_issue_number),
      allIssues: owners.get(request.source_note_issue_number),
    }),
    readBlob: (sha) => clone(fixture.blobs[sha]),
    createInterviewIssue: (request, projection) => {
      calls.create.push(request.source_note_issue_number);
      owners.set(request.source_note_issue_number, [{ number: 20000 + request.source_note_issue_number, state: 'open', body: projection.body, labels: projection.labels }]);
    },
    postReceipt: (request, receipt) => {
      calls.receipt.push(request.source_note_issue_number);
      comments.set(request.source_note_issue_number, [{ id: 30000 + request.source_note_issue_number, body: renderMaterializationReceipt(receipt), issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${request.source_note_issue_number}` }]);
    },
  };
  return { root, args, runtime, calls };
}

test('CLI defaults to plan-only and writes no progress or mutation', () => {
  const context = setup();
  try {
    const exitCode = cli.main(context.args, context.runtime);
    assert.equal(exitCode, 0);
    const output = JSON.parse(fs.readFileSync(context.args[context.args.indexOf('--output') + 1], 'utf8'));
    assert.equal(output.mode, 'plan');
    assert.equal(output.ok, true);
    assert.equal(output.packet_set_sha256, fixture.packet_set.packet_set_sha256);
    assert.equal(output.items.length, 17);
    assert.equal(output.create_mutation_count, 0);
    assert.equal(output.receipt_mutation_count, 0);
    assert.equal(output.mutation_count, 0);
    assert.equal(output.count_status, 'plan');
    assert.equal(fs.existsSync(context.args[context.args.indexOf('--progress') + 1]), false);
    assert.deepEqual(context.calls, { create: [], receipt: [] });
  } finally { fs.rmSync(context.root, { recursive: true, force: true }); }
});

test('CLI apply requires lock and both digest confirmations', () => {
  const base = [
    '--manifest', 'm', '--request-dir', 'r', '--evidence-receipt-dir', 'e', '--transition-receipt-dir', 't',
    '--output', 'o', '--progress', 'p', '--materialization-request-dir', 'rq', '--materialization-receipt-dir', 'rc', '--apply',
  ];
  assert.throws(() => cli.parseArgs(base), /--apply requires --progress-lock/);
  assert.throws(() => cli.parseArgs([...base, '--progress-lock', 'l']), /--apply requires --confirm-plan-sha256/);
  assert.throws(() => cli.parseArgs([...base, '--progress-lock', 'l', '--confirm-plan-sha256', 'a'.repeat(64)]), /--apply requires --confirm-authorization-sha256/);
});

test('CLI apply uses the real lock/core and durably writes 17 request and receipt files', () => {
  const context = setup();
  try {
    const planExit = cli.main(context.args, context.runtime);
    assert.equal(planExit, 0);
    const planOutput = JSON.parse(fs.readFileSync(context.args[context.args.indexOf('--output') + 1], 'utf8'));
    const lockPath = path.join(context.root, 'materialization.lock');
    const applyArgs = [...context.args, '--apply', '--progress-lock', lockPath, '--confirm-plan-sha256', planOutput.plan_sha256, '--confirm-authorization-sha256', planOutput.authorization_sha256];
    const applyExit = cli.main(applyArgs, context.runtime);
    assert.equal(applyExit, 0);
    const output = JSON.parse(fs.readFileSync(context.args[context.args.indexOf('--output') + 1], 'utf8'));
    assert.equal(output.mode, 'apply');
    assert.equal(output.ok, true);
    assert.equal(output.create_mutation_count, 17);
    assert.equal(output.receipt_mutation_count, 17);
    assert.equal(output.mutation_count, 34);
    assert.equal(output.count_status, 'valid');
    assert.equal(output.possibly_performed, false);
    assert.equal(context.calls.create.length, 17);
    assert.equal(context.calls.receipt.length, 17);
    assert.equal(fs.readdirSync(path.join(context.root, 'materialization-requests')).filter((file) => file.endsWith('.json')).length, 17);
    assert.equal(fs.readdirSync(path.join(context.root, 'materialization-receipts')).filter((file) => file.endsWith('.json')).length, 17);
    assert.equal(fs.existsSync(lockPath), false);
  } finally { fs.rmSync(context.root, { recursive: true, force: true }); }
});
