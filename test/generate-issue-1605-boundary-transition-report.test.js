'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canonicalJson, sha256Text } = require('../scripts/lib/issue-1605-materialization-plan');
const { main } = require('../scripts/generate-issue-1605-boundary-transition-report');

const DATA_DIR = path.join(__dirname, '..', 'data', 'pilot', 'issue-1605');
const MANIFEST = path.join(DATA_DIR, 'full-boundary-manifest.json');
const PLAN = path.join(DATA_DIR, 'full-boundary-transition.plan.json');
const REQUEST_DIR = path.join(DATA_DIR, 'full-boundary-requests');

function withoutDigest(value) {
  const copy = { ...value };
  delete copy.canonical_digest;
  delete copy.report_sha256;
  return copy;
}

function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-boundary-report-'));
  const manifest = path.join(directory, 'full-boundary-manifest.json');
  const plan = path.join(directory, 'full-boundary-transition.plan.json');
  const journal = path.join(directory, 'full-boundary-transition.journal.json');
  const output = path.join(directory, 'boundary-transition-report.json');
  fs.copyFileSync(MANIFEST, manifest);
  fs.copyFileSync(PLAN, plan);
  fs.cpSync(REQUEST_DIR, path.join(directory, 'full-boundary-requests'), { recursive: true });
  const frozenPlan = JSON.parse(fs.readFileSync(plan, 'utf8'));
  const journalValue = {
    schema_version: 'issue-1605-full-boundary-transition-journal.v1',
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    manifest_digest: frozenPlan.manifest.digest,
    plan_digest: frozenPlan.canonical_digest,
    status: 'complete',
    mutation_count: 840,
    items: frozenPlan.items.map((item, index) => ({
      issue_number: item.issue_number,
      transition_id: item.transition_id,
      item_digest: item.item_digest,
      phase: 'complete',
      mutation_count: index === 0 ? 4 : 2,
      possibly_performed: false,
      receipt_comment_id: 7000000 + index,
      error: null,
    })),
  };
  journalValue.canonical_digest = sha256Text(canonicalJson(journalValue));
  fs.writeFileSync(journal, `${JSON.stringify(journalValue, null, 2)}\n`);
  return { directory, manifest, plan, journal, output };
}

function args(value) {
  return ['--manifest', value.manifest, '--transition-plan', value.plan, '--journal', value.journal, '--output', value.output];
}

test('generator emits a complete report only from an integrity-checked journal and frozen requests', () => {
  const value = harness();
  assert.equal(main(args(value)), 0);
  const report = JSON.parse(fs.readFileSync(value.output, 'utf8'));
  assert.equal(report.items.length, 419);
  assert.equal(report.transition_mutation_count, 840);
  assert.equal(report.report_sha256, sha256Text(canonicalJson(withoutDigest(report))));
});

test('generator rejects a journal whose canonical receipt ledger was changed', () => {
  const value = harness();
  const journal = JSON.parse(fs.readFileSync(value.journal, 'utf8'));
  journal.items[0].receipt_comment_id += 1;
  fs.writeFileSync(value.journal, `${JSON.stringify(journal, null, 2)}\n`);
  assert.throws(() => main(args(value)), /transition journal validation failed/);
});

test('generator rejects a request marker that drifts from the frozen plan row', () => {
  const value = harness();
  const requestFile = path.join(value.directory, 'full-boundary-requests', '0042.json');
  const body = fs.readFileSync(requestFile, 'utf8');
  assert.match(body, /"decision": "single-interview"/);
  fs.writeFileSync(requestFile, body.replace('"decision": "single-interview"', '"decision": "not-interview"'));
  assert.throws(() => main(args(value)), /plan\/journal\/request transition binding is inconsistent/);
});
