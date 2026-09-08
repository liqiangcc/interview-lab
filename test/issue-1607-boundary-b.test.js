'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FIRST_ISSUE,
  LAST_ISSUE,
  EXPECTED_COUNT,
  SOURCE_REF,
  bodyProjectionEvidence,
  isSelected,
  parseArgs,
} = require('../scripts/prepare-issue-1607-boundary-batch');
const { evidenceFor, requestFor } = require('../scripts/generate-issue-1607-boundary-evidence');

function issue(number, labels = []) {
  return { number, state: 'OPEN', title: `[XHS Source] ${number}`, body: 'body', labels: { nodes: labels.map((name) => ({ name })) } };
}

const labels = ['type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review'];

test('Boundary B constants are frozen to the child issue scope', () => {
  assert.equal(FIRST_ISSUE, 393);
  assert.equal(LAST_ISSUE, 765);
  assert.equal(EXPECTED_COUNT, 367);
  assert.equal(SOURCE_REF, '95b77bb261048059846273688e4b90a2e108b437');
});

test('selection requires every live boundary label and excludes completed state', () => {
  assert.equal(isSelected(issue(393, labels)), true);
  assert.equal(isSelected(issue(392, labels)), true, 'range filtering is performed by the caller');
  assert.equal(isSelected(issue(393, labels.filter((label) => label !== 'task:boundary-review'))), false);
  assert.equal(isSelected(issue(393, [...labels.filter((label) => !label.startsWith('boundary:')), 'boundary:single-interview'])), false);
});

test('body-only evidence is explicitly non-authorizing and preserves the cited artifact', () => {
  const record = { artifacts: [{ ref: 'liqiangcc/xhs:note_desc/x.txt@95b77bb261048059846273688e4b90a2e108b437', git_blob_sha: 'a'.repeat(40) }] };
  const value = bodyProjectionEvidence({ body: 'x\n## 原始正文\n\n### 可读 Source projection — `note_desc`\n\n> one\n\n## 原始附件\n' }, record, record.artifacts[0].ref, 'network blocked');
  assert.equal(value.verification.status, 'blocked');
  assert.equal(value.artifact.git_blob_sha, 'a'.repeat(40));
  assert.match(value.locator, /^issue-body-copy:lines-/);
});

test('generated evidence and requests cannot authorize a transition', () => {
  const item = {
    issue_number: 393,
    issue_url: 'https://github.com/liqiangcc/interview-lab/issues/393',
    source_note_id: 'xhs-note:test',
    body_sha256: 'b'.repeat(64),
    source_revision_id: 'xhs-note:test:snapshot-95b77bb26104',
    source_projection: {
      artifact: { ref: 'liqiangcc/xhs:note_desc/test.txt@95b77bb261048059846273688e4b90a2e108b437', kind: 'text_projection', provenance: 'source_projection', git_blob_sha: 'c'.repeat(40) },
      locator: 'issue-body-copy:lines-1-2',
      excerpt: 'copy',
      verification: { status: 'blocked', reason: 'network blocked' },
    },
  };
  const evidence = evidenceFor(item);
  const request = requestFor(item, evidence);
  assert.equal(evidence.decision, 'pending');
  assert.equal(evidence.evidence_status, 'blocked');
  assert.equal(request.executable, false);
  assert.equal(request.review_evidence, null);
  assert.equal(request.reviewed_at, null);
});

test('body-only is an explicit preparation mode', () => {
  assert.equal(parseArgs(['--prepare', '--body-only']).bodyOnly, true);
  assert.equal(parseArgs(['--prepare', '--body-only']).allowUnverifiedSource, true);
});

test('checked-in audit outputs are complete and mutation-free', () => {
  const dir = path.join(__dirname, '..', 'data', 'issue-1607');
  const selection = JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8'));
  const plan = JSON.parse(fs.readFileSync(path.join(dir, 'dry-run.plan.json'), 'utf8'));
  const journal = JSON.parse(fs.readFileSync(path.join(dir, 'apply.journal.json'), 'utf8'));
  assert.equal(selection.items.length, EXPECTED_COUNT);
  assert.equal(selection.scope.first_issue, FIRST_ISSUE);
  assert.equal(selection.scope.last_issue, LAST_ISSUE);
  assert.equal(plan.counts.mutation_count, 0);
  assert.equal(journal.mutation_count, 0);
  assert.equal(journal.status, 'not-started');
  assert.equal(plan.fail_closed, true);
  assert.equal(plan.scope_compliance.status, 'blocked');
  assert.equal(plan.scope_compliance.out_of_scope_mutations, 0);
});
