'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalDigest } = require('../scripts/lib/aggregate-downstream-pipeline');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { buildInterviewProjection, requestSha256, sha256Text } = require('../scripts/lib/source-note-interview-materialization');
const { buildMaterializationRequest, issueSourceRecord } = require('../scripts/lib/interview-note-materialization-batch');
const { parseArgs } = require('../scripts/issue-1658-bounded-materialization-runner');
const { initialJournal, initialIntent, applyOne, receiptObject, receiptBody, updateJournal, validateReceiptOwner } = require('../scripts/lib/issue-1658-materialization-runner');
const {
  AUTH_MARKER, ELIGIBLE_ROWS, BLOCKED_ROWS, AUTH_REQUIREMENTS, RUNNER_SCHEMA,
  validateBoundedInputPlan, validateBoundedAuthorizationComment,
  buildBoundedRunnerPlan, validateBoundedRunnerPlan,
} = require('../scripts/lib/issue-1658-bounded-materialization-runner');

const boundedFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/issue-1658-materialization-13-plan.fixture.json'), 'utf8'));
const sourceTemplate = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');

function fixtureSource(number) {
  const externalId = `xhs-${number}-bounded`;
  const sourceNoteId = `xhs-note:${externalId}`;
  const revisionId = `xhs:${externalId}:r1`;
  const initialBody = sourceTemplate.replaceAll('runtime-fixture-1', externalId);
  const parsed = parseSourceNoteIssue(initialBody);
  const record = JSON.parse(JSON.stringify(parsed.record));
  record.source_note_id = sourceNoteId;
  record.source.external_id = externalId;
  record.source.url = `https://www.xiaohongshu.com/explore/${externalId}`;
  record.source_revision.id = revisionId;
  record.source_revision.manifest_ref = `source-capture:xhs:${externalId}:r1#manifest.json`;
  record.source_revision.manifest_sha256 = sha256Text(`fixture-manifest-${number}`);
  record.source_revision.source_repository_ref = `fixture-ref-${number}`;
  record.boundary_review = { status: 'single-interview', reviewed_at: '2026-09-09T00:00:00Z', interview_note_ids: [`xhs:${externalId}`] };
  const body = initialBody.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(record, null, 2));
  return { number, state: 'open', body, labels: ['type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview'] };
}

const fixtureSources = boundedFixture.source_issue_numbers.map(fixtureSource);

function buildFixtureInputPlan() {
  const ownership_inventory = {
    ...boundedFixture.ownership_inventory,
    inventory_digest: canonicalDigest(boundedFixture.ownership_inventory),
  };
  const rows = fixtureSources.map((source) => {
    const sourceValidation = issueSourceRecord(source);
    const request = buildMaterializationRequest(source, boundedFixture.repository);
    const projection = buildInterviewProjection(source, sourceValidation.validation && sourceValidation.validation.ok ? sourceValidation.validation : sourceValidation, {});
    return {
      request,
      source_issue: { number: source.number, body_sha256: sha256Text(source.body) },
      plan: { action: 'create', interview_note_id: projection.interview_note_id, projection, ownership_count: 0 },
    };
  });
  const plan = {
    schema_version: 'issue-1656-materialization-13-plan.v1',
    repository: boundedFixture.repository,
    parent_issue: boundedFixture.parent_issue,
    source_boundary_plan_digest: 'b'.repeat(64),
    counts: { total: 13, create: 13, already: 0 },
    rows,
    input_plan_digest: canonicalDigest({ schema_version: boundedFixture.schema_version, source_issue_numbers: boundedFixture.source_issue_numbers }),
    ownership_inventory,
  };
  return { ...plan, plan_digest: canonicalDigest(plan) };
}

const inputPlan = buildFixtureInputPlan();

function freshInputs() {
  const selected = new Set(inputPlan.rows.map((row) => Number(row.request.source_note_issue_number)));
  const freshRows = new Map(fixtureSources.filter((issue) => selected.has(Number(issue.number))).map((issue) => [Number(issue.number), { issue, comments: [] }]));
  const freshOwnershipIssues = inputPlan.ownership_inventory.owners.map((owner) => ({
    number: owner.issue_number,
    body: `<!-- interview-note: id=${owner.interview_note_id} schema=interview-note-issue.v2 -->`,
  }));
  return { freshRows, freshOwnershipIssues };
}

function authorizationBody(extra = {}) {
  const marker = {
    schema_version: 'issue-1656-materialization-only-authorization.v1',
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1611,
    controller_issue: 1658,
    upstream_issue: 1605,
    action: 'authorize-interview-note-materialization-only',
    allow_materialization: true,
    allow_boundary_patch: false,
    allow_evidence_post: false,
    allow_learning_labels: false,
    allow_source_note_label_write: false,
    plan_digest: inputPlan.plan_digest,
    input_plan_digest: inputPlan.input_plan_digest,
    ownership_inventory_digest: inputPlan.ownership_inventory.inventory_digest,
    max_create: 13,
    max_receipts: 13,
    comment_id: 5602915668,
    issued_at: '2026-09-09T13:46:13.445Z',
    scope: { eligible_rows: ELIGIBLE_ROWS, blocked_rows: BLOCKED_ROWS },
    requirements: AUTH_REQUIREMENTS,
    authorization_sha256: '2112f2527c59236905928ef4bb8549541349240aa556d70bcc79df7bc614c0da',
    ...extra,
  };
  const { authorization_sha256: ignored, ...authorizationFacts } = marker;
  marker.authorization_sha256 = canonicalDigest(authorizationFacts);
  return `<!-- ${AUTH_MARKER}\n${JSON.stringify(marker, null, 2)}\n-->`;
}

test('bounded input adapter accepts exactly the authorized 13 create rows', () => {
  const validation = validateBoundedInputPlan(inputPlan);
  assert.equal(validation.ok, true, validation.errors.join('; '));
  assert.deepEqual(inputPlan.rows.map((row) => row.request.source_note_issue_number).sort((a, b) => a - b), [...ELIGIBLE_ROWS]);
});

test('default bounded runner is plan-only and never needs the 1460-row replan', () => {
  assert.equal(parseArgs([]).apply, false);
  const plan = buildBoundedRunnerPlan({ inputPlan });
  assert.equal(plan.schema_version, RUNNER_SCHEMA);
  assert.equal(plan.mode, 'bounded-13-plan-only-adapter');
  assert.equal(plan.counts.total, 13);
  assert.equal(plan.counts.create, 13);
  assert.equal(plan.ready_for_apply, false, 'apply must require a fresh live CAS pass');
  assert.equal(plan.mutation_performed, false);
  assert.deepEqual(plan.write_operations, { patch: 0, post: 0, create: 0, label: 0, interview_note: 0 });
});

test('bounded fresh plan digest excludes generated_at so lock-held replan is stable', () => {
  const first = buildBoundedRunnerPlan({ inputPlan, generatedAt: '2026-09-09T00:00:00.000Z' });
  const second = buildBoundedRunnerPlan({ inputPlan, generatedAt: '2026-09-09T00:00:01.000Z' });
  assert.notEqual(first.generated_at, second.generated_at);
  assert.equal(first.plan_digest, second.plan_digest);
  assert.equal(validateBoundedRunnerPlan(first).ok, false, 'plan-only still cannot pass the fresh apply gate');
});

test('fresh bounded CAS validates all 13 SourceNotes against exact projection and full ownership', () => {
  const plan = buildBoundedRunnerPlan({ inputPlan, ...freshInputs() });
  assert.equal(plan.ok, true, plan.errors.join('; '));
  assert.equal(plan.ready_for_apply, true);
  assert.deepEqual(plan.counts, { total: 13, create: 13, already: 0, blocked: 0 });
  assert.equal(validateBoundedRunnerPlan(plan).ok, true);
});

test('bounded fresh CAS fails closed on SourceNote body drift and owner drift', () => {
  const { freshRows, freshOwnershipIssues } = freshInputs();
  const source = freshRows.get(1309);
  freshRows.set(1309, { ...source, issue: { ...source.issue, body: `${source.issue.body}\nchanged` } });
  freshOwnershipIssues[0] = { ...freshOwnershipIssues[0], number: 9999 };
  const plan = buildBoundedRunnerPlan({ inputPlan, freshRows, freshOwnershipIssues });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /1309|ownership inventory/);
  assert.equal(plan.ready_for_apply, false);
});

test('bounded fresh CAS derives identity before owner lookup and rejects a mismatched bound identity', () => {
  const mismatchedInput = JSON.parse(JSON.stringify(inputPlan));
  const row = mismatchedInput.rows[0];
  row.plan.interview_note_id = 'fixture-owner-01';
  row.plan.projection.interview_note_id = 'fixture-owner-01';
  const { plan_digest: ignoredPlanDigest, ...mismatchedContent } = mismatchedInput;
  mismatchedInput.plan_digest = canonicalDigest(mismatchedContent);
  const plan = buildBoundedRunnerPlan({ inputPlan: mismatchedInput, ...freshInputs() });
  assert.equal(plan.ok, false);
  const result = plan.results.find((item) => item.source_note_issue_number === row.request.source_note_issue_number);
  assert.equal(result.action, 'blocked');
  assert.match(result.errors.join('\n'), /fresh SourceNote identity .* does not match bound row identity/);
});

test('authorization comment is bound to parent #1611, the bounded plan, exact scope, and 13 ceilings', () => {
  const comment = { id: 5602915668, issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/1611', issue_number: 1611, url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/comments/5602915668', body: authorizationBody() };
  const valid = validateBoundedAuthorizationComment(comment, inputPlan, { authorizationCommentId: 5602915668, maxCreate: 13, maxReceipts: 13 });
  assert.equal(valid.ok, true, valid.errors.join('; '));
  const bad = validateBoundedAuthorizationComment({ ...comment, body: authorizationBody({ max_create: 14 }) }, inputPlan, { authorizationCommentId: 5602915668, maxCreate: 13, maxReceipts: 13 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /ceilings/);
});

test('authorization cannot be repurposed for boundary/evidence/learning writes', () => {
  const comment = { id: 5602915668, issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/1611', issue_number: 1611, url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/comments/5602915668', body: authorizationBody({ allow_boundary_patch: true }) };
  const result = validateBoundedAuthorizationComment(comment, inputPlan, { authorizationCommentId: 5602915668, maxCreate: 13, maxReceipts: 13 });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /unsupported mutation/);
});

test('bounded apply CLI rejects mutation-shaped flags unless explicit gated apply is supplied', () => {
  assert.throws(() => parseArgs(['--post']), /forbidden/);
  assert.throws(() => parseArgs(['--apply', '--allow-live-github', '--max-create', '12', '--max-receipts', '13']), /requires.*13/);
  assert.equal(canonicalDigest({ ...inputPlan, plan_digest: undefined }) !== inputPlan.plan_digest, true, 'input plan digest and bounded plan digest are intentionally distinct bindings');
});

test('receipt-pending resume reconciles one exact SourceNote receipt and never posts a duplicate', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8').replaceAll('runtime-fixture-1', 'bounded-receipt-resume');
  const parsed = parseSourceNoteIssue(fixture);
  const record = JSON.parse(JSON.stringify(parsed.record));
  record.source.external_id = 'bounded-receipt-resume';
  record.source_note_id = 'xhs-note:bounded-receipt-resume';
  record.source_revision.id = 'xhs-note:bounded-receipt-resume:snapshot-test';
  record.boundary_review = { status: 'single-interview', reviewed_at: '2026-09-09T00:00:00Z', interview_note_ids: ['xhs:bounded-receipt-resume'] };
  const source = { number: 2600, state: 'open', body: fixture.replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(record, null, 2)), labels: ['type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview'] };
  const sourceValidation = issueSourceRecord(source);
  const projection = buildInterviewProjection(source, sourceValidation.validation && sourceValidation.validation.ok ? sourceValidation.validation : sourceValidation, {});
  const request = buildMaterializationRequest(source, 'liqiangcc/interview-lab');
  const result = { action: 'would-materialize', source_note_issue_number: source.number, request, request_sha256: requestSha256(request), derived_interview_note_id: projection.interview_note_id, projection: { ...projection, projected_body_sha256: sha256Text(projection.body), projected_title: projection.title, projected_labels: projection.labels } };
  const plan = { plan_digest: 'r'.repeat(64), results: [result] };
  const journal = initialJournal(plan, 1, 1);
  const owner = { number: 3600, state: 'open', title: projection.title, body: projection.body, labels: projection.labels };
  const receipt = receiptObject(request, { interview_note_id: projection.interview_note_id, projection }, owner.number, '2026-09-09T00:00:00Z');
  assert.throws(() => validateReceiptOwner({ ...receipt, repository: 'other/repository' }, request, projection, owner), /receipt repository/);
  assert.throws(() => validateReceiptOwner(receipt, request, projection, { ...owner, body: `${owner.body}\nchanged` }), /exact body\/label validation/);
  assert.throws(() => validateReceiptOwner(receipt, request, projection, { ...owner, labels: [...owner.labels, 'unexpected:label'] }), /exact body\/label validation/);
  journal.items[0].phase = 'receipt-pending';
  journal.items[0].mutation_attempted = true;
  journal.items[0].mutation_count = 2;
  journal.create_count = 1;
  journal.receipt_count = 1;
  journal.mutation_count = 2;
  journal.intents[request.materialization_id] = { ...initialIntent(request, { interview_note_id: projection.interview_note_id, projection }), phase: 'receipt-pending', interview_issue_number: owner.number };
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'issue-1658-receipt-resume-'));
  const journalFile = path.join(dir, 'journal.json');
  updateJournal(journal, journalFile, { assertHeld() {} }, plan, 1, 1);
  let posts = 0;
  const api = {
    plan,
    readIssue: (number) => Number(number) === source.number ? source : owner,
    readOwners: () => [owner],
    readComments: () => [{ id: 4600, body: receiptBody(receipt) }],
    addReceipt: () => { posts += 1; throw new Error('must not post on receipt resume'); },
  };
  const resumed = applyOne({ planResult: result, api, journalItem: journal.items[0], journal, journalFile, lock: { assertHeld() {} }, maxCreate: 1, maxReceipts: 1, allowReceiptResume: true });
  assert.equal(resumed.resumed, true);
  assert.equal(posts, 0);
  assert.equal(journal.items[0].phase, 'complete');
});

test('applyOne rejects fresh identity mismatch before consulting the owner inventory', () => {
  const source = fixtureSources[0];
  const sourceValidation = issueSourceRecord(source);
  const projection = buildInterviewProjection(source, sourceValidation.validation, {});
  const request = buildMaterializationRequest(source, boundedFixture.repository);
  const result = {
    action: 'would-materialize',
    source_note_issue_number: source.number,
    request,
    request_sha256: requestSha256(request),
    derived_interview_note_id: 'fixture-owner-01',
    projection: { ...projection, projected_body_sha256: sha256Text(projection.body), projected_title: projection.title, projected_labels: projection.labels },
  };
  const plan = { plan_digest: 'a'.repeat(64), results: [result] };
  const journal = initialJournal(plan, 1, 1);
  let ownerReads = 0;
  const api = {
    plan,
    readIssue: () => source,
    readOwners: () => { ownerReads += 1; return []; },
    readComments: () => [],
  };
  assert.throws(() => applyOne({ planResult: result, api, journalItem: journal.items[0], journal, journalFile: path.join(require('node:os').tmpdir(), `issue-1658-identity-${process.pid}.json`), lock: { assertHeld() {} }, maxCreate: 1, maxReceipts: 1 }), /fresh SourceNote identity mismatch/);
  assert.equal(ownerReads, 0, 'owner lookup must use only the fresh-derived identity after the bound identity check');
});
