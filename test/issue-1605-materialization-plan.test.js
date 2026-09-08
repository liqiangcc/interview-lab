'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { buildInterviewProjection, findOwnershipMatches } = require('../scripts/lib/source-note-interview-materialization');
const { childInterviewNoteId } = require('../scripts/lib/interview-note-identity');
const {
  canonicalJson,
  sha256Text,
  planIssue1605Materialization,
} = require('../scripts/lib/issue-1605-materialization-plan');
const { parseArgs } = require('../scripts/plan-issue-1605-interview-note-materialization');

const template = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
const templateRecord = parseSourceNoteIssue(template).record;

function makeSourceIssue(number, status, externalId = `runtime-fixture-${number}`) {
  const record = JSON.parse(JSON.stringify(templateRecord));
  record.source_note_id = `xhs-note:${externalId}`;
  record.source.external_id = externalId;
  record.source.url = `https://www.xiaohongshu.com/explore/${externalId}`;
  record.source_revision.id = `xhs:${externalId}:r1`;
  record.source_revision.manifest_ref = `source-capture:xhs:${externalId}:r1#manifest.json`;
  for (const artifact of record.artifacts) artifact.ref = artifact.ref.replaceAll('runtime-fixture-1', externalId);
  record.boundary_review = { status, reviewed_at: '2026-09-08T00:00:00Z', interview_note_ids: [] };
  const labels = ['type:source-note', 'source:xhs', 'status:captured', `boundary:${status}`];
  if (status === 'pending') labels.push('task:boundary-review');
  if (status === 'single-interview') record.boundary_review.interview_note_ids = [`xhs:${externalId}`];
  if (status === 'multi-interview') {
    const cases = ['case-a', 'case-b'].map((caseKey) => ({
      case_key: caseKey,
      interview_note_id: childInterviewNoteId(record.source, caseKey),
      evidence: [{ ref: record.artifacts[0].ref, locator: `fixture-${caseKey}` }],
    }));
    record.boundary_review.interview_note_cases = cases;
    record.boundary_review.interview_note_ids = cases.map((item) => item.interview_note_id);
  }
  const marker = `<!-- source-note: id=${record.source_note_id} schema=source-note-issue.v2 -->`;
  const body = template
    .replace(/<!-- source-note:\s*id=[^\s]+\s+schema=[^\s]+\s*-->/, marker)
    .replace(/<!-- source-note-record\s*\n[\s\S]*?\n-->/, `<!-- source-note-record\n${JSON.stringify(record, null, 2)}\n-->`);
  const validation = validateSourceNoteIssue({ body, labels, state: 'open' });
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  return { number, state: 'open', body, labels };
}

function makeReport(items, schema = 'issue-1605-boundary-transition-report.v1') {
  const report = {
    schema_version: schema,
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    source_repository: 'liqiangcc/xhs',
    source_ref: '95b77bb261048059846273688e4b90a2e108b437',
    mode: 'plan-only',
    live_apply_authorized: false,
    items,
  };
  report.report_sha256 = sha256Text(canonicalJson(report));
  return report;
}

function item(source, decision, status = 'already_applied', ids = []) {
  const parsed = parseSourceNoteIssue(source.body).record;
  return {
    source_note_issue_number: source.number,
    source_note_id: parsed.source_note_id,
    source_note_body_sha256: sha256Text(source.body),
    source_revision_id: parsed.source_revision.id,
    decision,
    transition_id: `fixture-transition-${source.number}`,
    transition_status: status,
    interview_note_ids: ids,
  };
}

function plan(reports, sourceIssues, ownershipIssues = [], options = {}) {
  return planIssue1605Materialization({
    boundaryReports: reports,
    sourceIssues,
    ownershipIssues,
    ownershipErrors: options.ownershipErrors || new Map(),
    receiptsBySourceIssue: options.receiptsBySourceIssue || new Map(),
    sourceSnapshot: { mode: 'test', count: sourceIssues.length },
    ownershipSnapshot: { mode: 'test' },
  });
}

test('blocks every row when boundary transition is not live-applied', () => {
  const source = makeSourceIssue(910, 'pending', 'runtime-fixture-1');
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/issue-1605-materialization/boundary-transition-report.not-applied.json'), 'utf8'));
  const output = plan([report], [source]);
  assert.equal(output.ok, true);
  assert.equal(output.mutation_performed, false);
  assert.deepEqual(output.write_operations, { patch: 0, post: 0, create: 0 });
  assert.equal(output.counts.blocked, 1);
  assert.equal(output.blocked_reasons['boundary-transition-not-live-applied'], 1);
  assert.equal(output.results[0].derived_interview_note_id, undefined);
  assert.match(output.dry_run_sha256, /^[0-9a-f]{64}$/);
});

test('derives a single InterviewNote identity only from the live SourceNote', () => {
  const source = makeSourceIssue(911, 'single-interview');
  const output = plan([makeReport([item(source, 'single-interview', 'already_applied', ['xhs:runtime-fixture-911'])])], [source]);
  assert.equal(output.ok, true, output.errors.join('\n'));
  assert.equal(output.counts['would-materialize'], 1);
  assert.equal(output.results[0].derived_interview_note_id, 'xhs:runtime-fixture-911');
  assert.equal(output.results[0].request.schema_version, 'source-note-interview-materialization.v1');
  assert.equal(output.results[0].projection.interview_note_id, 'xhs:runtime-fixture-911');
  assert.equal(output.results[0].mutation_performed, false);
});

test('derives stable v2 child identities for every approved multi-interview case', () => {
  const source = makeSourceIssue(912, 'multi-interview');
  const parsed = parseSourceNoteIssue(source.body).record;
  const ids = parsed.boundary_review.interview_note_ids;
  const output = plan([makeReport([item(source, 'multi-interview', 'applied', ids)])], [source]);
  assert.equal(output.ok, true, output.errors.join('\n'));
  assert.equal(output.counts['would-materialize'], 2);
  assert.deepEqual(output.results.map((result) => result.derived_interview_note_id).sort(), ids.sort());
  assert.deepEqual(output.results.map((result) => result.request.schema_version).sort(), ['source-note-interview-materialization.v2', 'source-note-interview-materialization.v2']);
  assert.equal(output.results.some((result) => Object.prototype.hasOwnProperty.call(result.request, 'interview_note_id')), false);
});

test('blocks duplicate SourceNote ownership and duplicate derived InterviewNote claims globally', () => {
  const first = makeSourceIssue(913, 'single-interview', 'runtime-duplicate');
  const second = makeSourceIssue(914, 'single-interview', 'runtime-duplicate');
  const reports = [
    makeReport([item(first, 'single-interview', 'already_applied', ['xhs:runtime-duplicate'])]),
    makeReport([item(second, 'single-interview', 'already_applied', ['xhs:runtime-duplicate'])]),
  ];
  const output = plan(reports, [first, second]);
  assert.equal(output.ok, false);
  assert.equal(output.counts.blocked, 2);
  assert.equal(output.blocked_reasons['duplicate-source-note-identity'], 2);
  assert.equal(output.counts['would-materialize'], undefined);
  assert.equal(output.write_operations.create, 0);
});

test('blocks multiple existing InterviewNote owners instead of choosing one', () => {
  const source = makeSourceIssue(915, 'single-interview');
  const validation = { ok: true, parsed: { record: parseSourceNoteIssue(source.body).record } };
  const projection = buildInterviewProjection(source, validation);
  const owners = [
    { number: 1201, state: 'open', body: projection.body, labels: projection.labels },
    { number: 1202, state: 'open', body: projection.body, labels: projection.labels },
  ];
  const output = plan([makeReport([item(source, 'single-interview', 'already_applied', ['xhs:runtime-fixture-915'])])], [source], owners);
  assert.equal(output.ok, true);
  assert.equal(output.counts.blocked, 1);
  assert.equal(output.blocked_reasons['materialization-preflight-failed'], 1);
  assert.match(output.results[0].errors.join('\n'), /duplicate ownership conflict/);
  assert.equal(findOwnershipMatches(owners, 'xhs:runtime-fixture-915').length, 2);
});

test('does not materialize not-interview SourceNotes and blocks an unexpected owner', () => {
  const source = makeSourceIssue(916, 'not-interview');
  const report = makeReport([item(source, 'not-interview', 'already_applied', [])]);
  const noOwner = plan([report], [source]);
  assert.equal(noOwner.ok, true, noOwner.errors.join('\n'));
  assert.equal(noOwner.counts['skip-not-interview'], 1);
  const validation = { ok: true, parsed: { record: parseSourceNoteIssue(source.body).record } };
  const projection = buildInterviewProjection({ ...source, body: source.body }, validation);
  const owner = { number: 1301, body: projection.body, labels: projection.labels, state: 'open' };
  const withOwner = plan([report], [source], [owner]);
  assert.equal(withOwner.counts.blocked, 1);
  assert.equal(withOwner.blocked_reasons['not-interview-has-interview-owner'], 1);
});

test('fails closed on a tampered boundary report digest and identity claim', () => {
  const source = makeSourceIssue(917, 'single-interview');
  const report = makeReport([item(source, 'single-interview', 'already_applied', ['xhs:injected'])]);
  report.items[0].interview_note_ids = ['xhs:injected'];
  report.report_sha256 = '0'.repeat(64);
  const output = plan([report], [source]);
  assert.equal(output.ok, false);
  assert.ok(output.errors.some((error) => /does not match/.test(error)));
  assert.equal(output.counts.blocked, 1);
  assert.equal(output.write_operations.create, 0);
});

test('CLI rejects apply-shaped arguments before any input read', () => {
  assert.throws(() => parseArgs(['--boundary-report', 'fixture.json', '--apply']), /plan-only and never PATCHes or POSTs/);
});
