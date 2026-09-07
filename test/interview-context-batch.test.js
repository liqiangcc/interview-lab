'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sha256Text, contextSha256, planItem, planBatch, receiptFor, receiptBody, parseReceipts, receiptMatches, auditReceiptMatches, intentId, progressFromPlan, validateProgressMapping, verifyContextArtifact, validateCompletionEvidence, ISSUE_1598_FIXED_INVENTORY, validateRequest } = require('../scripts/lib/interview-context-batch');
const { planReloadedItem, resumeProgressItem } = require('../scripts/plan-interview-context-learning-discovery');
const { parseInterviewNoteIssue } = require('../scripts/lib/interview-note-issue');

const body = fs.readFileSync(path.join(__dirname, 'fixtures/interview-note-issue.valid.md'), 'utf8');
const parsed = parseInterviewNoteIssue(body);
const dependencies = [917, 920, 921, 922].map((number) => ({ number, state: 'closed' }));
const dependencyGateArtifact = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/pilot/issue-923/dependency-gate.json'), 'utf8'));
const dependencyEvidence = new Map();
for (const entry of Object.values(dependencyGateArtifact.dependencies)) {
  const issueNumber = entry.issue_number;
  const issueUrl = `https://api.github.com/repos/liqiangcc/interview-lab/issues/${issueNumber}`;
  dependencyEvidence.set(entry.evidence, { id: Number(entry.evidence.match(/#issuecomment-(\d+)$/)[1]), issue_url: issueUrl, body: `<!-- issue-dependency-acceptance\n{"schema_version":"issue-dependency-acceptance.v1","issue_number":${issueNumber},"acceptance":"pass","accepted_by":"test","acceptance_evidence":"${entry.acceptance_evidence}"}\n-->` });
  dependencyEvidence.set(entry.acceptance_evidence, { id: Number(entry.acceptance_evidence.match(/#issuecomment-(\d+)$/)[1]), issue_url: issueUrl, body: 'final acceptance evidence' });
}

function context(overrides = {}) {
  return {
    schema_version: 'interview-context.v1',
    context_id: `${parsed.record.interview_note_id}:context-v1`,
    interview_note_id: parsed.record.interview_note_id,
    source_revision_id: parsed.record.source_revision.id,
    review_status: 'reviewed',
    reviewed_at: '2026-09-04T04:00:00Z',
    company: { id: 'kuaishou', display_name: '快手', basis: 'source-explicit', evidence_refs: ['raw-title:快手'] },
    role: { family: 'backend', title: '后端开发', basis: 'reviewed-inference', evidence_refs: ['raw:backend'] },
    recruitment_type: { value: 'unknown', basis: 'unknown', evidence_refs: [] },
    round: { value: '2', basis: 'source-explicit', evidence_refs: ['raw-title:二面'] },
    interview_occurred_at: { precision: 'unknown', value: null, basis: 'unknown', evidence_refs: [] },
    outcome_visibility: 'sealed-until-source-reveal',
    ...overrides,
  };
}

function request(itemContext = context()) {
  const contextArtifact = { repository: 'liqiangcc/interview-lab', path: `data/interview-contexts/${itemContext.interview_note_id.replace(/[^A-Za-z0-9_-]/g, '-')}.v1.json`, ref: 'refs/heads/codex/issue-923', commit: '0000000000000000000000000000000000000000', sha256: contextSha256(itemContext) };
  return {
    schema_version: 'interview-context-batch-review.v1',
    batch_id: 'issue-923-fixture-1',
    repository: 'liqiangcc/interview-lab',
    dependency_issues: [917, 920, 921, 922],
    dependency_gate_file: 'data/pilot/issue-923/dependency-gate.json',
    expected_dependency_gate_sha256: sha256Text(fs.readFileSync(path.join(__dirname, '../data/pilot/issue-923/dependency-gate.json'), 'utf8')),
    pilot_size: 1,
    items: [{ issue_number: 915, expected_body_sha256: sha256Text(body), context: itemContext, context_artifact: contextArtifact }],
  };
}

function issue(overrides = {}) {
  return {
    number: 915,
    state: 'open',
    title: '原始标题含结果：凉经',
    body,
    labels: ['type:interview-note', 'source:xhs', 'status:source-ready', 'task:question-review'],
    ...overrides,
  };
}

function plan(itemContext = context(), issueOverrides = {}, receiptMap = new Map()) {
  return planBatch(request(itemContext), { dependencies, issues: [issue(issueOverrides)], receiptsByIssue: receiptMap, dependencyGateArtifact, dependencyEvidence });
}

test('batch planner projects only reviewed source-ready InterviewNotes', () => {
  const result = plan();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(result.summary, {
    pilot_size: 1,
    ready_count: 1,
    unknown_count: 2,
    unknown_item_count: 1,
    needs_review_count: 0,
    already_applied_count: 0,
    proposed_mutation_count: 1,
    mutation_count: 1,
  });
  assert.deepEqual(result.items[0].projection.labels, [
    'company:kuaishou',
    'role:backend',
    'round:2',
    'source:xhs',
    'status:source-ready',
    'task:question-review',
    'type:interview-note',
    'source-year:2023',
  ].sort());
  assert.equal(result.items[0].projection.title, '[快手] 后端 · 二面 · 630e2e22');
});

test('unmet dependency gate blocks the batch before candidate planning', () => {
  const result = planBatch(request(), {
    dependencies: [{ number: 917, state: 'open' }],
    issues: [],
    dependencyGateArtifact,
    dependencyEvidence,
  });
  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.match(result.errors.join('\n'), /Issue #917 is not closed/);
  assert.equal(result.summary.mutation_count, 0);
});

test('SourceNote body is never accepted as an InterviewNote candidate', () => {
  const sourceBody = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
  const sourceIssue = issue({ body: sourceBody, title: 'SourceNote', labels: ['type:source-note', 'source:xhs', 'status:source-ready'] });
  const result = planBatch(request(), { dependencies, issues: [sourceIssue], dependencyGateArtifact, dependencyEvidence });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /SourceNote cannot be used as InterviewNote/);
});

test('stale body CAS fails closed without a proposed mutation', () => {
  const result = plan(context(), { body: `${body}\nchanged` });
  assert.equal(result.ok, false);
  assert.equal(result.items[0].action, 'needs_review');
  assert.match(result.errors.join('\n'), /stale InterviewNote body digest/);
});

test('source year and interview year remain independent', () => {
  const result = plan(context({
    interview_occurred_at: {
      precision: 'exact', value: '2022-08-02', basis: 'source-explicit', evidence_refs: ['raw:date'],
    },
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.items[0].projection.labels.includes('source-year:2023'));
  assert.ok(result.items[0].projection.labels.includes('interview-year:2022'));
});

test('outcome wording in derived title fails closed', () => {
  const result = plan(context({ company: { id: 'offer-company', display_name: 'offer', basis: 'source-explicit', evidence_refs: ['raw'] } }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /non-spoiler title contains forbidden outcome wording/);
});

test('matching projection receipt makes retry idempotent', () => {
  const first = plan();
  const receipt = receiptFor(request(), first.items[0], '2026-09-04T04:01:00Z');
  const second = plan(undefined, {
    title: first.items[0].projection.title,
    labels: first.items[0].projection.labels,
  }, new Map([[915, [{ ...receipt, comment_id: 123 }]]]));
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.equal(second.items[0].action, 'already_applied');
  assert.equal(second.summary.mutation_count, 0);
});

test('receipt matching is repository-bound for normal and audit receipts', () => {
  const first = plan();
  const baseRequest = request();
  const receipt = receiptFor(baseRequest, first.items[0], '2026-09-04T04:01:00Z');
  assert.equal(receiptMatches(receipt, baseRequest, baseRequest.items[0], first.items[0].projection), true);
  assert.equal(receiptMatches({ ...receipt, repository: 'attacker/other-repo' }, baseRequest, baseRequest.items[0], first.items[0].projection), false);
  const auditRequest = { ...baseRequest, batch_id: 'issue-1598-fixture-1' };
  const auditReceipt = { ...receipt, batch_id: 'issue-923-reviewed-contexts-3' };
  assert.equal(auditReceiptMatches(auditReceipt, auditRequest, auditRequest.items[0], first.items[0].projection), true);
  assert.equal(auditReceiptMatches({ ...auditReceipt, repository: 'attacker/other-repo' }, auditRequest, auditRequest.items[0], first.items[0].projection), false);
});

test('receiptFor round-trips through its marker and binds the original request item intent', () => {
  const first = plan();
  const receipt = receiptFor(request(), first.items[0], '2026-09-04T04:01:00Z');
  const parsed = parseReceipts([{ id: 123, body: receiptBody(receipt) }]);
  assert.equal(parsed.errors.length, 0);
  assert.equal(receipt.intent_id, intentId(request(), request().items[0]));
  const retried = plan(undefined, { title: first.items[0].projection.title, labels: first.items[0].projection.labels }, new Map([[915, parsed.receipts]]));
  assert.equal(retried.items[0].action, 'already_applied');
});

test('failed progress is auditable and resumable only after live convergence', () => {
  const first = plan();
  const progress = {
    schema_version: 'interview-context-learning-discovery-apply-progress.v1',
    batch_id: request().batch_id,
    repository: request().repository,
    dry_run_digest: 'a'.repeat(64),
    max_mutations: 1,
    items: [{
      issue_number: 915,
      expected_body_sha256: request().items[0].expected_body_sha256,
      context_sha256: first.items[0].projection.context_sha256,
      context_artifact: first.items[0].projection.context_artifact,
      intent_id: intentId(request(), request().items[0]),
      title: first.items[0].projection.title,
      labels: first.items[0].projection.labels,
      state: 'failed',
      error: 'receipt response was lost and live receipt was absent',
    }],
  };
  const mapping = validateProgressMapping(progress, request(), first, progress.dry_run_digest, progress.max_mutations);
  assert.equal(mapping.ok, true, mapping.errors.join('\n'));
});

test('new progress persists an exact receipt intent before its POST attempt', () => {
  const first = plan();
  const requestValue = request();
  const progress = progressFromPlan(requestValue, first, 'a'.repeat(64), 1, '2026-09-04T04:01:00Z');
  const item = progress.items[0];
  assert.equal(item.receipt_attempted, false);
  assert.equal(item.receipt_possibly_performed, false);
  const legacyPending = structuredClone(progress);
  legacyPending.items[0].state = 'receipt_pending';
  const legacyMapping = validateProgressMapping(legacyPending, requestValue, first, legacyPending.dry_run_digest, legacyPending.max_mutations);
  assert.equal(legacyMapping.ok, false);
  assert.match(legacyMapping.errors.join('\n'), /receipt_pending requires durable receipt intent state/);
  const intent = receiptFor(requestValue, first.items[0], '2026-09-04T04:02:00Z');
  Object.assign(item, {
    state: 'receipt_pending',
    receipt_intent: intent,
    receipt_body_sha256: sha256Text(receiptBody(intent)),
    receipt_attempted: false,
    receipt_possibly_performed: false,
  });
  const mapping = validateProgressMapping(progress, requestValue, first, progress.dry_run_digest, progress.max_mutations);
  assert.equal(mapping.ok, true, mapping.errors.join('\n'));
  assert.deepEqual(resumeProgressItem(item, { ok: true, action: 'repair_receipt' }), { ok: true, state: 'receipt_pending' });
});

test('attempted receipt progress fails closed when the marker is temporarily absent', () => {
  const first = plan();
  const requestValue = request();
  const intent = receiptFor(requestValue, first.items[0], '2026-09-04T04:02:00Z');
  const progress = progressFromPlan(requestValue, first, 'a'.repeat(64), 1);
  Object.assign(progress.items[0], {
    state: 'receipt_pending',
    receipt_intent: intent,
    receipt_body_sha256: sha256Text(receiptBody(intent)),
    receipt_attempted: true,
    receipt_possibly_performed: true,
  });
  const mapping = validateProgressMapping(progress, requestValue, first, progress.dry_run_digest, progress.max_mutations);
  assert.equal(mapping.ok, true, mapping.errors.join('\n'));
  const resume = resumeProgressItem(progress.items[0], { ok: true, action: 'repair_receipt' });
  assert.equal(resume.ok, false);
  assert.match(resume.error, /uncertain/);
});

test('matching receipt still reconciles externally drifted title or labels', () => {
  const first = plan();
  const receipt = receiptFor(request(), first.items[0], '2026-09-04T04:01:00Z');
  const second = plan(undefined, {
    title: '外部漂移标题',
    labels: first.items[0].projection.labels.filter((label) => label !== 'round:2'),
  }, new Map([[915, [{ ...receipt, comment_id: 123 }]]]));
  assert.equal(second.ok, true, second.errors.join('\n'));
  assert.equal(second.items[0].action, 'update');
  assert.equal(second.items[0].receipt.comment_id, 123);
  assert.equal(second.summary.mutation_count, 1);
});

test('audit-only items fail closed unless the exact receipt and projection already converge', () => {
  const auditRequest = { ...request(), batch_id: 'issue-1598-fixture-1', audit_only_issue_numbers: [915] };
  const blocked = planBatch(auditRequest, { dependencies, issues: [issue()], dependencyGateArtifact, dependencyEvidence });
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join('\n'), /audit-only item/);
  const projected = plan(auditRequest.items[0].context, { title: plan().items[0].projection.title, labels: plan().items[0].projection.labels });
  const receipt = receiptFor(auditRequest, projected.items[0], '2026-09-07T12:00:00Z');
  const converged = planBatch(auditRequest, { dependencies, issues: [issue({ title: projected.items[0].projection.title, labels: projected.items[0].projection.labels })], dependencyGateArtifact, dependencyEvidence, receiptsByIssue: new Map([[915, [receipt]]]) });
  assert.equal(converged.ok, true, converged.errors.join('\n'));
  assert.equal(converged.items[0].action, 'already_applied');
  assert.equal(converged.summary.mutation_count, 0);
});

test('recovery reload preserves historical audit receipts for #3, #4, and #915', () => {
  const auditRequest = { ...request(), batch_id: 'issue-1598-learning-contexts-50', audit_only_issue_numbers: [3, 4, 915] };
  const historicalRequest = { ...auditRequest, batch_id: 'issue-923-reviewed-contexts-3' };
  for (const issueNumber of [3, 4, 915]) {
    const requestItem = { ...auditRequest.items[0], issue_number: issueNumber };
    const liveIssue = issue({ number: issueNumber });
    const projected = planItem(auditRequest, requestItem, liveIssue);
    assert.equal(projected.ok, true, projected.errors.join('\n'));
    const historicalReceipt = { ...receiptFor(historicalRequest, projected, '2026-09-04T04:01:00Z'), comment_id: issueNumber };
    const convergedIssue = { ...liveIssue, title: projected.projection.title, labels: projected.projection.labels };
    const reloaded = planReloadedItem(auditRequest, requestItem, convergedIssue, [historicalReceipt]);
    assert.equal(reloaded.ok, true, reloaded.errors.join('\n'));
    assert.equal(reloaded.action, 'already_applied');
    assert.equal(reloaded.receipt.comment_id, issueNumber);
  }
});

test('completion evidence is live-comment-id bound and fail closed on a forged response', () => {
  const entry = { issue_number: 1539, evidence: 'https://github.com/liqiangcc/interview-lab/issues/1539#issuecomment-123' };
  const requestWithCompletion = { repository: 'liqiangcc/interview-lab', completion_dependencies: [entry] };
  const good = new Map([[entry.evidence, { id: 123, issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/1539', body: 'Expansion complete' }]]);
  assert.equal(validateCompletionEvidence(requestWithCompletion, [{ number: 1539, state: 'closed' }], good).ok, true);
  const forged = new Map([[entry.evidence, { id: 124, issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/1539', body: 'Expansion complete' }]]);
  assert.equal(validateCompletionEvidence(requestWithCompletion, [{ number: 1539, state: 'closed' }], forged).ok, false);
});

test('Issue #1598 fixed inventory and audit-only scope cannot be weakened', () => {
  const valid = { ...request(), batch_id: 'issue-1598-learning-contexts-50', fixed_inventory_issue_numbers: ISSUE_1598_FIXED_INVENTORY, audit_only_issue_numbers: [3, 4, 915] };
  assert.equal(validateRequest(valid).ok, false);
  assert.equal(validateRequest({ ...valid, fixed_inventory_issue_numbers: ISSUE_1598_FIXED_INVENTORY.slice(1) }).ok, false);
  assert.equal(validateRequest({ ...valid, audit_only_issue_numbers: [3, 4] }).ok, false);
});

test('Issue #1598 checked-in request is a complete 50-item audit with 47 new items', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../data/pilot/issue-1598/request-50-reviewed-contexts.md'), 'utf8');
  const parsed = raw.match(/<!-- interview-context-batch-review\n([\s\S]*?)\n-->/);
  assert.ok(parsed);
  const value = JSON.parse(parsed[1]);
  assert.equal(validateRequest(value).ok, true, validateRequest(value).errors.join('\n'));
  assert.equal(value.items.length, 50);
  assert.deepEqual(value.items.filter((item) => [3, 4, 915].includes(item.issue_number)).map((item) => item.issue_number), [3, 4, 915]);
  assert.equal(value.items.filter((item) => ![3, 4, 915].includes(item.issue_number)).length, 47);
  assert.equal(new Set(value.items.map((item) => item.context.interview_note_id)).size, 50);
});

test('closed dependency without structured acceptance evidence blocks fail-closed', () => {
  const evidence = new Map(dependencyEvidence);
  evidence.delete(dependencyGateArtifact.dependencies['922'].evidence);
  const result = planBatch(request(), { dependencies, issues: [], dependencyGateArtifact, dependencyEvidence: evidence });
  assert.equal(result.blocked, true);
  assert.match(result.errors.join('\n'), /#922 acceptance anchor could not be read/);
});

test('receipt present but durable Context missing fails closed for recovery', () => {
  const first = plan();
  const receipt = receiptFor(request(), first.items[0], '2026-09-04T04:01:00Z');
  const artifactResult = new Map([[915, { ok: false, errors: ['GitHub contents returned 404'] }]]);
  const blocked = planBatch(request(), { dependencies, issues: [issue({ title: first.items[0].projection.title, labels: first.items[0].projection.labels })], dependencyGateArtifact, dependencyEvidence, receiptsByIssue: new Map([[915, [receipt]]]), contextArtifactsByIssue: artifactResult });
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors.join('\n'), /durable Context artifact invalid/);
});

test('durable Context content conflict fails closed', () => {
  const itemContext = context();
  const artifact = request(itemContext).items[0].context_artifact;
  const conflict = verifyContextArtifact(itemContext, artifact, 'liqiangcc/interview-lab', {
    readRef: () => ({ object: { sha: artifact.commit } }),
    readCommit: () => ({ sha: artifact.commit }),
    readContent: () => JSON.stringify({ ...itemContext, context_id: `${itemContext.context_id}-conflict` }),
  });
  assert.equal(conflict.ok, false);
  assert.match(conflict.errors.join('\n'), /durable Context content conflicts/);
});

test('verifyContextArtifact without remote readers fails closed', () => {
  const item = request().items[0];
  const result = verifyContextArtifact(item.context, item.context_artifact, 'liqiangcc/interview-lab');
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /readers are required/);
});

test('pinned Context commit remains valid when its durable ref advances', () => {
  const item = request().items[0];
  const advanced = verifyContextArtifact(item.context, item.context_artifact, 'liqiangcc/interview-lab', {
    readRef: () => ({ object: { sha: '1111111111111111111111111111111111111111' } }),
    readCompare: () => ({ status: 'ahead', ahead_by: 2, behind_by: 0 }),
    readCommit: () => ({ sha: item.context_artifact.commit }),
    readContent: () => JSON.stringify(item.context),
  });
  assert.equal(advanced.ok, true, advanced.errors.join('\n'));
});

test('advanced Context ref with diverged ancestry or missing ref fails closed', () => {
  const item = request().items[0];
  const diverged = verifyContextArtifact(item.context, item.context_artifact, 'liqiangcc/interview-lab', {
    readRef: () => ({ object: { sha: '1111111111111111111111111111111111111111' } }),
    readCompare: () => ({ status: 'diverged', ahead_by: 2, behind_by: 1 }),
    readCommit: () => ({ sha: item.context_artifact.commit }),
    readContent: () => JSON.stringify(item.context),
  });
  assert.equal(diverged.ok, false);
  assert.match(diverged.errors.join('\n'), /does not contain the pinned commit/);
  const missing = verifyContextArtifact(item.context, item.context_artifact, 'liqiangcc/interview-lab', {
    readRef: () => { throw new Error('404 ref not found'); },
    readCompare: () => ({ status: 'ahead', ahead_by: 1, behind_by: 0 }),
    readCommit: () => ({ sha: item.context_artifact.commit }),
    readContent: () => JSON.stringify(item.context),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join('\n'), /could not be verified/);
});

test('receipt Context conflict fails closed instead of overwriting Derived data', () => {
  const first = plan();
  const receipt = receiptFor(request(), first.items[0], '2026-09-04T04:01:00Z');
  const conflict = planBatch(request(), { dependencies, issues: [issue({ title: first.items[0].projection.title, labels: first.items[0].projection.labels })], dependencyGateArtifact, dependencyEvidence, receiptsByIssue: new Map([[915, [{ ...receipt, context_artifact: { ...receipt.context_artifact, sha256: 'f'.repeat(64) }, comment_id: 123 }]]]) });
  assert.equal(conflict.ok, false);
  assert.match(conflict.errors.join('\n'), /conflicting receipt/);
});

test('Issue patch interruption recovers as receipt repair, and receipt response loss converges as already_applied', () => {
  const first = plan();
  const repaired = plan(undefined, { title: first.items[0].projection.title, labels: first.items[0].projection.labels });
  assert.equal(repaired.items[0].action, 'repair_receipt');
  const receipt = receiptFor(request(), first.items[0], '2026-09-04T04:01:00Z');
  const retried = plan(undefined, { title: first.items[0].projection.title, labels: first.items[0].projection.labels }, new Map([[915, [{ ...receipt, comment_id: 123 }]]]));
  assert.equal(retried.items[0].action, 'already_applied');
});
