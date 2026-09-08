'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  SOURCE_REF,
  BOUNDARY_BATCHES,
  canonicalDigest,
  upstreamDigest,
  validateUpstreamReport,
  sha256Text,
  planAggregate,
  validateBoundaryReports,
  validateAuthorization,
  applyPlan,
  EXISTING_SOURCE_READY_ISSUES,
} = require('../scripts/lib/aggregate-downstream-pipeline');
const { applyLive, acquireWriterLock } = require('../scripts/plan-aggregate-downstream-pipeline');
const { parseInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');

const repository = 'liqiangcc/interview-lab';
const body = fs.readFileSync('test/fixtures/interview-note-issue.valid.md', 'utf8');
const parsed = parseInterviewNoteIssue(body);
const interviewNoteId = parsed.marker.interview_note_id;
const sourceRevisionId = parsed.record.source_revision.id;
const sourceNoteId = `xhs-note:${parsed.record.source.external_id}`;
const issueNumber = 2000;
const sourceIssueNumber = 20;
const sourceBodySha = '1'.repeat(64);
const issue1609Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/aggregate-upstream/issue-1609-boundary-dry-run.json'), 'utf8'));

function boundaryReport(batch, includeCandidate = batch.issue_number === 1606) {
  const items = [];
  for (let index = 0; index < batch.expected_count; index += 1) {
    const number = batch.first + index;
    items.push({
      issue_number: number,
      status: 'already_applied',
      source_note_id: number === sourceIssueNumber ? sourceNoteId : `xhs-note:${number.toString(16).padStart(32, '0')}`,
      current_body_sha256: number === sourceIssueNumber ? sourceBodySha : '2'.repeat(64),
      interview_note_ids: number === sourceIssueNumber && includeCandidate ? [interviewNoteId] : [],
    });
  }
  const report = { schema_version: 'source-note-boundary-review-batch.v1', repository, total: items.length, counts: { ready: items.length, blocked: 0, already_applied: 0 }, items };
  return { ...report, dry_run_sha256: canonicalDigest(report) };
}

function materializationReport(extra = {}) {
  const report = {
    schema_version: 'source-note-interview-materialization-batch.v1',
    repository,
    results: [{
      source_note_issue_number: sourceIssueNumber,
      source_note_id: sourceNoteId,
      boundary_status: 'single-interview',
      case_key: null,
      action: 'already-materialized',
      request: {
        expected_source_note_body_sha256: sourceBodySha,
        expected_source_revision_id: sourceRevisionId,
        expected_source_repository_ref: SOURCE_REF,
        materialization_id: 'fixture-materialization-1',
      },
      materialization: {
        interview_note_id: interviewNoteId,
        existing_issue_number: issueNumber,
        source_note_body_sha256: sourceBodySha,
        projected_body_sha256: sha256Text(body),
      },
    }],
    ...extra,
  };
  return { ...report, dry_run_sha256: canonicalDigest(report) };
}

function contextProjection(id = interviewNoteId, revision = sourceRevisionId, number = issueNumber, bodyValue = body, action = undefined, existingSourceReady = false) {
  const context = {
    schema_version: 'interview-context.v1',
    context_id: `${id}:context-v1`,
    interview_note_id: id,
    source_revision_id: revision,
    review_status: 'reviewed',
    reviewed_at: '2026-09-08T00:00:00Z',
    company: { id: null, display_name: null, basis: 'unknown', evidence_refs: [] },
    role: { family: 'unknown', title: null, basis: 'unknown', evidence_refs: [] },
    recruitment_type: { value: 'unknown', basis: 'unknown', evidence_refs: [] },
    round: { value: 'unknown', basis: 'unknown', evidence_refs: [] },
    interview_occurred_at: { precision: 'unknown', value: null, basis: 'unknown', evidence_refs: [] },
    outcome_visibility: 'sealed-until-source-reveal',
  };
  return {
    issue_number: number,
    expected_body_sha256: sha256Text(bodyValue),
    context,
    title: id.split(':').pop().slice(0, 8),
    labels: ['source-year:2023', 'source:xhs', 'status:source-ready', 'type:interview-note'],
    live_issue: { number, state: 'open', title: id.split(':').pop().slice(0, 8), body: bodyValue, labels: ['source:xhs', 'status:source-ready', 'type:interview-note'] },
    ...(action ? { action } : {}),
    ...(existingSourceReady ? { existing_source_ready: true } : {}),
  };
}

function manifest() {
  return {
    schema_version: 'aggregate-downstream-pipeline.v1',
    aggregate_id: 'issue-1611-fixture',
    repository,
    source_repository: 'liqiangcc/xhs',
    source_ref: SOURCE_REF,
    parent_issue: 1605,
    issue_number: 1611,
    dependency_issues: [1606, 1607, 1608, 1609, 1610],
    boundary_batches: BOUNDARY_BATCHES.map((batch) => ({ ...batch, report: `boundary-${batch.issue_number}.json` })),
    recovery_report: 'recovery.json',
    materialization_reports: ['materialization.json'],
    source_review_receipts: 'source-review.json',
    context_reports: ['context.json'],
    existing_context_reports: ['existing-context.json'],
    existing_source_ready_issue_numbers: [...EXISTING_SOURCE_READY_ISSUES],
    live_issue_snapshot: 'live.json',
  };
}

function validInputs() {
  const reports = {};
  for (const batch of BOUNDARY_BATCHES) reports[batch.issue_number] = boundaryReport(batch);
  const recoveryWithoutDigest = { schema_version: 'issue-1610-source-recovery.v1', repository, items: [{ interview_issue_number: 1, final_status: 'blocked' }, { interview_issue_number: 2, final_status: 'blocked' }] };
  const recovery = { ...recoveryWithoutDigest, report_sha256: canonicalDigest(recoveryWithoutDigest) };
  const review = [{
    schema_version: 'interview-note-source-review-applied.v1',
    interview_note_id: interviewNoteId,
    source_note_body_sha256: sourceBodySha,
    interview_body_sha256: sha256Text(body),
    source_revision_id: sourceRevisionId,
    source_repository_ref: SOURCE_REF,
    final_status: 'source-ready',
    independent: true,
  }];
  const existingItems = EXISTING_SOURCE_READY_ISSUES.map((number, index) => {
    const suffix = (0x630e2e22000000001103c490n + BigInt(index + 1)).toString(16).padStart(32, '0');
    const id = `xhs:${suffix}`;
    const existingBody = body.replaceAll('630e2e22000000001103c490', suffix);
    return contextProjection(id, `${id}:r1`, number, existingBody, 'already_applied', true);
  });
  const liveIssues = new Map([[issueNumber, { number: issueNumber, state: 'open', body, labels: ['source:xhs', 'status:source-ready', 'type:interview-note'] }]]);
  for (const item of existingItems) liveIssues.set(item.issue_number, item.live_issue);
  return { manifest: manifest(), boundaryReports: reports, recoveryReport: recovery, materializationReports: [materializationReport()], sourceReviewReceipts: review, contextReports: [{ items: [contextProjection()] }], existingContextReports: [{ items: existingItems }], liveIssues };
}

test('aggregate fails closed when dependency receipts are absent', () => {
  const input = validInputs();
  input.boundaryReports[1606] = null;
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.equal(result.plan.mutation_performed, false);
  assert.equal(result.plan.summary.mutation_count, 0);
  assert.match(result.errors.join('\n'), /boundary #1606/);
});

test('real #1609 dry-run report shape validates with recursive canonical JSON', () => {
  const validation = validateUpstreamReport(issue1609Fixture, 'boundary #1609', 'issue-1609-boundary-dry-run.v1');
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(upstreamDigest(issue1609Fixture, 'issue-1609-boundary-dry-run.v1').expected, issue1609Fixture.dry_run_sha256);
  const { dry_run_sha256: ignored, ...input } = issue1609Fixture;
  assert.notEqual(sha256Text(JSON.stringify(input)), issue1609Fixture.dry_run_sha256, 'fixture must exercise canonical ordering rather than insertion-order JSON');
  const insertionOrderReport = { ...issue1609Fixture, dry_run_sha256: sha256Text(JSON.stringify(input)) };
  assert.equal(validateUpstreamReport(insertionOrderReport, 'boundary #1609', 'issue-1609-boundary-dry-run.v1').ok, false);
});

test('recovery dry-run uses its declared plan_sha256 digest input', () => {
  const digestInput = { schema_version: 'issue-1610-recovery-digest-input.v1', items: [{ issue_number: 1, status: 'blocked' }, { issue_number: 2, status: 'blocked' }] };
  const report = { schema_version: 'issue-1610-recovery-dry-run.v1', digest_input: digestInput, plan_sha256: canonicalDigest(digestInput) };
  const validation = upstreamDigest(report);
  assert.equal(validation.ok, true, validation.errors && validation.errors.join('\n'));
  assert.equal(validation.expected, report.plan_sha256);
});

test('aggregate requires the parent pending inventory and ownership dependency when pinned', () => {
  const input = validInputs();
  input.manifest.pending_inventory_snapshot = '../issue-1605/pending-inventory.snapshot.json';
  input.manifest.pending_inventory_ownership = '../issue-1605/pending-inventory.ownership.json';
  input.manifest.expected_pending_inventory_digest = '1'.repeat(64);
  input.manifest.expected_pending_ownership_digest = '2'.repeat(64);
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.equal(result.plan.summary.mutation_count, 0);
  assert.match(result.errors.join('\n'), /pending inventory snapshot and ownership index are required dependencies/);
});

test('aggregate freezes the four disjoint boundary ranges and source ref', () => {
  const input = validInputs();
  const result = planAggregate(input);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.plan.source_ref, SOURCE_REF);
  assert.equal(result.plan.selection.length, 51);
  assert.equal(result.plan.selection[0].source_note_body_sha256, sourceBodySha);
  assert.equal(result.plan.selection[0].raw_body_mutation, false);
  assert.match(result.plan.canonical_digest, /^[0-9a-f]{64}$/);
});

test('boundary validation requires the complete frozen per-batch issue set, union, disjointness, and explicit status', () => {
  const input = validInputs();
  const frozen = Object.values(input.boundaryReports).flatMap((report) => report.items.map((item) => item.issue_number));
  const valid = validateBoundaryReports(input.manifest, input.boundaryReports, frozen);
  assert.equal(valid.ok, true, valid.errors.join('\n'));
  assert.equal(valid.union_count, frozen.length);
  assert.equal(valid.union_disjoint, true);

  const missingStatus = validInputs();
  delete missingStatus.boundaryReports[1606].items[0].status;
  const statusResult = validateBoundaryReports(missingStatus.manifest, missingStatus.boundaryReports, frozen);
  assert.equal(statusResult.ok, false);
  assert.match(statusResult.errors.join('\n'), /no explicit status\/disposition/);

  const wrongSet = validInputs();
  wrongSet.boundaryReports[1609].items[0] = { ...wrongSet.boundaryReports[1609].items[0], issue_number: 20 };
  const setResult = validateBoundaryReports(wrongSet.manifest, wrongSet.boundaryReports, frozen);
  assert.equal(setResult.ok, false);
  assert.match(setResult.errors.join('\n'), /issue set does not equal the frozen selection|appears in more than one boundary batch/);
});

test('boundary validation adapts the current batch report field aliases without fabricating freeze facts', () => {
  const input = validInputs();
  const schemas = {
    1606: 'issue-1606-boundary-dry-run.v1',
    1607: 'issue-1607-boundary-dry-run.v1',
    1608: 'issue-1608-boundary-batch.v1',
    1609: 'issue-1609-boundary-dry-run.v1',
  };
  const adaptedReports = {};
  for (const batch of BOUNDARY_BATCHES) {
    const source = input.boundaryReports[batch.issue_number];
    const digestInput = {
      schema_version: schemas[batch.issue_number],
      repository,
      counts: { total: source.items.length },
      items: source.items.map((item) => ({
        issue_number: item.issue_number,
        body_sha256: item.current_body_sha256,
        source_identity: item.source_note_id,
        interview_note_ids_disposition: item.interview_note_ids,
        disposition: item.status,
      })),
    };
    adaptedReports[batch.issue_number] = { ...digestInput, dry_run_sha256: canonicalDigest(digestInput) };
  }
  const frozen = Object.values(input.boundaryReports).flatMap((report) => report.items.map((item) => item.issue_number));
  const validation = validateBoundaryReports(input.manifest, adaptedReports, frozen);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
  assert.equal(validation.union_count, 1397);
  assert.equal(validation.union_disjoint, true);
  assert.equal(validation.items[0].current_body_sha256, sourceBodySha);
  assert.equal(validation.items[0].source_note_id, sourceNoteId);
});

test('duplicate InterviewNote ownership and reused/non-independent evidence block the full plan', () => {
  const input = validInputs();
  input.materializationReports = [materializationReport({ results: [
    ...materializationReport().results,
    { ...materializationReport().results[0], source_note_issue_number: 21 },
  ] })];
  input.sourceReviewReceipts[0].independent = false;
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /duplicate materialization ownership|independent evidence/);
  assert.equal(result.plan.summary.mutation_count, 0);
});

test('missing Source Review receipt emits an independent evidence request but no mutation plan', () => {
  const input = validInputs();
  input.sourceReviewReceipts = [];
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.equal(result.plan.summary.mutation_count, 0);
  assert.equal(result.plan.independent_source_review_evidence_requests.length, 1);
  assert.equal(result.plan.independent_source_review_evidence_requests[0].boundary_evidence_reuse, false);
});

test('a raw body field in a derived Context report is rejected', () => {
  const input = validInputs();
  input.contextReports[0].items[0].body = 'must never be written';
  const result = planAggregate(input);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /mutate Raw InterviewNote body/);
});

test('applyPlan can only perform metadata/comment mutations and preserves Raw', () => {
  const input = validInputs();
  const result = planAggregate(input);
  assert.equal(result.ok, true, result.errors.join('\n'));
  const calls = [];
  const applied = applyPlan(result.plan, {
    patchIssueMetadata(number, projection) { calls.push(['patch', number, projection]); },
    postComment(number, comment) { calls.push(['comment', number, comment]); return 77; },
  });
  assert.equal(applied.mutation_performed, true);
  assert.deepEqual(calls.map((call) => call[0]), ['patch', 'comment']);
  assert.equal(calls[0][2].body, undefined);
  assert.match(calls[1][2], /raw_body_mutation.*false/);
});

test('apply authorization is scoped to the aggregate plan and parent issue', () => {
  const input = validInputs();
  const result = planAggregate(input);
  const auth = { schema_version: 'aggregate-downstream-apply-authorization.v1', aggregate_id: input.manifest.aggregate_id, issue_number: 1611, parent_issue: 1605, plan_digest: result.plan.canonical_digest, allow_live_github: true, authorized_by: 'master-reviewer' };
  assert.equal(validateAuthorization(auth, result.plan.canonical_digest, input.manifest).ok, true);
  assert.equal(validateAuthorization({ ...auth, plan_digest: '0'.repeat(64) }, result.plan.canonical_digest, input.manifest).ok, false);
});

function applyFixture() {
  const input = validInputs();
  const planned = planAggregate(input);
  assert.equal(planned.ok, true, planned.errors.join('\n'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1611-aggregate-apply-'));
  const authorizationFile = path.join(directory, 'authorization.json');
  const journal = path.join(directory, 'apply-journal.json');
  const lock = path.join(directory, 'apply.lock');
  fs.writeFileSync(authorizationFile, JSON.stringify({
    schema_version: 'aggregate-downstream-apply-authorization.v1',
    aggregate_id: input.manifest.aggregate_id,
    issue_number: 1611,
    parent_issue: 1605,
    plan_digest: planned.plan.canonical_digest,
    allow_live_github: true,
    authorized_by: 'test-master-reviewer',
  }));
  const candidate = planned.plan.selection.find((item) => item.source_review && item.source_review.final_status === 'source-ready' && item.kind !== 'existing-source-ready-audit');
  const live = { ...candidate.context.live_issue };
  const args = { authorization: authorizationFile, confirmPlanDigest: planned.plan.canonical_digest, journal, lock, maxMutations: 1, pauseMs: 0, maxReceiptReconcile: 3, staleLockMs: 60_000 };
  return { input, plan: planned.plan, candidate, live, args, directory };
}

test('applyLive acquires one writer lock, fresh-replans, CASes, journals, and releases', () => {
  const fixture = applyFixture();
  const calls = [];
  const result = applyLive(fixture.plan, fixture.input.manifest, fixture.args, {
    replan() { calls.push('replan'); return { ok: true, plan: fixture.plan }; },
    readIssue() { calls.push('get'); return fixture.live; },
    patchIssueMetadata(issueNumber, projection) { calls.push(['patch', issueNumber]); fixture.live.title = projection.title; fixture.live.labels = projection.labels; },
    postComment(issueNumber) { calls.push(['post', issueNumber]); return { id: 901 }; },
  });
  assert.equal(result.mutation_performed, true);
  assert.deepEqual(calls, ['replan', 'get', ['patch', fixture.candidate.interview_issue_number], 'get', ['post', fixture.candidate.interview_issue_number]]);
  const journal = JSON.parse(fs.readFileSync(fixture.args.journal, 'utf8'));
  assert.equal(journal.status, 'complete');
  assert.equal(journal.mutation_ceiling, 1);
  assert.equal(journal.mutation_attempted, true);
  assert.equal(journal.mutation_performed, true);
  assert.equal(journal.possibly_performed, false);
  assert.equal(journal.receipt_attempted, true);
  assert.equal(journal.items[0].possibly_performed, false);
  assert.equal(fs.existsSync(fixture.args.lock), false);
});

test('applyLive rejects stale writer locks without re-plan or mutation', () => {
  const fixture = applyFixture();
  fs.writeFileSync(fixture.args.lock, JSON.stringify({ schema_version: 'aggregate-downstream-writer-lock.v1', lock_id: 'stale', owner: 'dead-owner', acquired_at: '2020-01-01T00:00:00.000Z' }));
  let replans = 0;
  let patches = 0;
  assert.throws(() => applyLive(fixture.plan, fixture.input.manifest, fixture.args, {
    replan() { replans += 1; return { ok: true, plan: fixture.plan }; },
    patchIssueMetadata() { patches += 1; },
  }), /stale; refusing to steal/);
  assert.equal(replans, 0);
  assert.equal(patches, 0);
});

test('applyLive requires fresh re-plan digest equality and CAS before PATCH', () => {
  const fixture = applyFixture();
  let patches = 0;
  assert.throws(() => applyLive(fixture.plan, fixture.input.manifest, fixture.args, {
    replan() { return { ok: true, plan: { ...fixture.plan, canonical_digest: 'f'.repeat(64) } }; },
    patchIssueMetadata() { patches += 1; },
  }), /fresh re-plan failed or canonical digest drifted/);
  assert.equal(patches, 0);
  const casFixture = applyFixture();
  casFixture.live.body = 'drifted Raw body';
  assert.throws(() => applyLive(casFixture.plan, casFixture.input.manifest, casFixture.args, {
    replan() { return { ok: true, plan: casFixture.plan }; },
    readIssue() { return casFixture.live; },
    patchIssueMetadata() { patches += 1; },
  }), /body SHA drifted/);
  assert.equal(patches, 0);
  const journal = JSON.parse(fs.readFileSync(casFixture.args.journal, 'utf8'));
  assert.equal(journal.mutation_attempted, false);
  assert.equal(journal.possibly_performed, false);

  const titleFixture = applyFixture();
  titleFixture.live.title = 'drifted title';
  assert.throws(() => applyLive(titleFixture.plan, titleFixture.input.manifest, titleFixture.args, {
    replan() { return { ok: true, plan: titleFixture.plan }; },
    readIssue() { return titleFixture.live; },
    patchIssueMetadata() { patches += 1; },
  }), /title drifted/);
  assert.equal(patches, 0);
});

test('applyLive reconciles a lost POST response with bounded marker GET and stops on unknown state', () => {
  const fixture = applyFixture();
  let postedBody = null;
  let reads = 0;
  const result = applyLive(fixture.plan, fixture.input.manifest, fixture.args, {
    replan() { return { ok: true, plan: fixture.plan }; },
    readIssue() { return fixture.live; },
    patchIssueMetadata(issueNumber, projection) { fixture.live.title = projection.title; fixture.live.labels = projection.labels; },
    postComment(issueNumber, body) { postedBody = body; throw new Error('simulated response loss'); },
    readComments() { reads += 1; return reads === 2 ? [{ id: 902, body: postedBody }] : []; },
  });
  assert.equal(result.mutation_performed, true);
  assert.equal(reads, 2);
  const journal = JSON.parse(fs.readFileSync(fixture.args.journal, 'utf8'));
  assert.equal(journal.status, 'complete');
  assert.equal(journal.possibly_performed, false);
  assert.equal(journal.items[0].receipt_reconciled, true);

  const unknown = applyFixture();
  let unknownReads = 0;
  assert.throws(() => applyLive(unknown.plan, unknown.input.manifest, unknown.args, {
    replan() { return { ok: true, plan: unknown.plan }; },
    readIssue() { return unknown.live; },
    patchIssueMetadata(issueNumber, projection) { unknown.live.title = projection.title; unknown.live.labels = projection.labels; },
    postComment() { throw new Error('simulated response loss'); },
    readComments() { unknownReads += 1; return []; },
  }), /receipt response unknown/);
  assert.equal(unknownReads, 3);
  const unknownJournal = JSON.parse(fs.readFileSync(unknown.args.journal, 'utf8'));
  assert.equal(unknownJournal.status, 'uncertain');
  assert.equal(unknownJournal.mutation_attempted, true);
  assert.equal(unknownJournal.mutation_performed, true);
  assert.equal(unknownJournal.possibly_performed, true);
});

test('applyLive enforces a positive mutation ceiling before any writer lock is acquired', () => {
  const fixture = applyFixture();
  fixture.args.maxMutations = 0;
  assert.throws(() => applyLive(fixture.plan, fixture.input.manifest, fixture.args), /positive mutation ceiling/);
  assert.equal(fs.existsSync(fixture.args.lock), false);
});

test('writer lock release refuses replacement and stale acquisition fails closed', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1611-lock-'));
  const lockPath = path.join(directory, 'writer.lock');
  const lock = acquireWriterLock(lockPath, { staleAfterMs: 60_000 });
  assert.throws(() => acquireWriterLock(lockPath, { staleAfterMs: 60_000 }), /lock is held/);
  lock.release();
  assert.equal(fs.existsSync(lockPath), false);
});
