'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_VERSION,
  AUTH_SCHEMA_VERSION,
  buildPlan,
  validateAuthorization,
  validatePatchResponse,
  acquireExclusiveLock,
  applyPlan,
  canonicalDigest,
  sha256Text,
} = require('../scripts/lib/issue-1662-context-learning');

function context(id, revision, unknown = false) {
  return {
    schema_version: 'interview-context.v1', context_id: `${id}:context-v1`, interview_note_id: id,
    source_revision_id: revision, review_status: 'reviewed', reviewed_at: '2026-09-09T00:00:00Z',
    company: unknown ? { id: null, display_name: null, basis: 'unknown', evidence_refs: [] } : { id: 'alibaba', display_name: '阿里', basis: 'reviewed-inference', evidence_refs: ['fixture:company'] },
    role: unknown ? { family: 'unknown', title: null, basis: 'unknown', evidence_refs: [] } : { family: 'backend', title: '后端', basis: 'reviewed-inference', evidence_refs: ['fixture:role'] },
    recruitment_type: unknown ? { value: 'unknown', basis: 'unknown', evidence_refs: [] } : { value: 'campus', basis: 'reviewed-inference', evidence_refs: ['fixture:type'] },
    round: unknown ? { value: 'unknown', basis: 'unknown', evidence_refs: [] } : { value: 'unknown', basis: 'unknown', evidence_refs: [] },
    interview_occurred_at: { precision: unknown ? 'unknown' : 'year', value: unknown ? null : '2023', basis: unknown ? 'unknown' : 'reviewed-inference', evidence_refs: unknown ? [] : ['fixture:time'] },
    outcome_visibility: 'sealed-until-source-reveal',
  };
}

function body(id, revision, external) {
  const record = {
    schema_version: 'interview-note-issue.v2', interview_note_id: id,
    source: { system: 'xhs', external_id: external, url: null },
    source_revision: { id: revision, captured_at: '2026-09-01T00:00:00Z' },
    source_published_at: { precision: 'year', value: '2024' },
    source_edited_at: { precision: 'unknown', value: null },
    interview_occurred_at: { precision: 'year', value: '2023' },
    artifacts: [{ kind: 'html', ref: `${id}.html`, sha256: null, provenance: 'raw_capture' }],
    limitations: ['fixture'],
  };
  return `<!-- interview-note: id=${id} schema=interview-note-issue.v2 -->\n<!-- interview-note-record\n${JSON.stringify(record, null, 2)}\n-->\n\n## 来源身份\n\n## 原始标题\n\nFixture\n\n## 原始正文\n\nRaw fixture\n\n## 原始附件\n\n- raw\n\n## 来源限制\n\n- fixture\n\n## 派生链接\n`;
}

function fixture() {
  const owners = [
    { interview_note_id: 'xhs:1662-a', issue_number: 2001, source_revision_id: 'xhs:1662-a:r1', external: '1662-a', source_note_issue_number: 3001 },
    { interview_note_id: 'xhs:1662-b', issue_number: 2002, source_revision_id: 'xhs:1662-b:r1', external: '1662-b', source_note_issue_number: 3002 },
  ];
  const liveItems = owners.map((owner, index) => {
    const text = body(owner.interview_note_id, owner.source_revision_id, owner.external);
    return { number: owner.issue_number, title: `Old ${index}`, state: 'open', body: text, labels: ['type:interview-note', 'source:xhs', 'status:source-ready', 'quality:text-truncated'] };
  });
  const inventory = {
    schema_version: 'aggregate-interview-note-ownership-inventory.v1', repository: 'liqiangcc/interview-lab', coverage: 'all-repository-interview-note-issues', complete: true, fresh: true, captured_at: '2026-09-09T00:00:00Z', count: owners.length,
    entries: owners.map((owner, index) => ({ interview_note_id: owner.interview_note_id, issue_number: owner.issue_number, body_sha256: sha256Text(liveItems[index].body), source_revision_id: owner.source_revision_id, source_note_id: `xhs-note:${owner.external}`, source_note_issue_number: owner.source_note_issue_number })),
  };
  inventory.canonical_digest = canonicalDigest(inventory);
  const audit = { schema_version: 'issue-1658-materialization-post-audit.v1', issue_number: 1658, post_audit: true, post_audit_status: 'pass', mutation_performed: false, mutation_state: 'no-op', items: owners.map((owner, index) => ({ parent_issue: 1658, issue_number: owner.issue_number, interview_note_id: owner.interview_note_id, source_note_id: `xhs-note:${owner.external}`, body_sha256: sha256Text(liveItems[index].body), source_note_body_sha256: 'b'.repeat(64), source_revision_id: owner.source_revision_id, post_audit_status: 'pass', mutation_performed: false, materialization_state: 'already_materialized' })) };
  const receipts = owners.map((owner, index) => ({ schema_version: 'interview-note-source-review-applied.v1', repository: 'liqiangcc/interview-lab', interview_note_id: owner.interview_note_id, interview_issue_number: owner.issue_number, source_note_id: `xhs-note:${owner.external}`, source_note_body_sha256: 'b'.repeat(64), interview_body_sha256: sha256Text(liveItems[index].body), source_revision_id: owner.source_revision_id, source_repository_ref: '95b77bb261048059846273688e4b90a2e108b437', final_status: 'source-ready', independent: true, boundary_evidence_reuse: false, request: { request_id: `issue-1661:${owner.interview_note_id}`, repository: 'liqiangcc/interview-lab', interview_note_id: owner.interview_note_id, interview_issue_number: owner.issue_number, source_note_id: `xhs-note:${owner.external}`, source_note_body_sha256: 'b'.repeat(64), source_revision_id: owner.source_revision_id, source_ref: '95b77bb261048059846273688e4b90a2e108b437' } }));
  const contexts = owners.map((owner, index) => { const value = context(owner.interview_note_id, owner.source_revision_id, index === 1); return { issue_number: owner.issue_number, context: value, artifact: { repository: 'liqiangcc/interview-lab', path: `data/interview-contexts/${owner.external}.v1.json`, ref: 'refs/heads/main', commit: 'a'.repeat(40), sha256: canonicalDigest(value) } }; });
  const labelCatalog = ['type:interview-note', 'source:xhs', 'status:source-ready', 'quality:text-truncated', 'company:alibaba', 'role:backend', 'recruitment:campus', 'source-year:2024', 'interview-year:2023'];
  const values = { ownershipInventory: inventory, materializationPostAudit: audit, sourceReviewReceipts: receipts, contextArtifacts: contexts, liveIssueSnapshot: { items: liveItems }, labelCatalog };
  const binding = (value, file) => ({ path: file, sha256: canonicalDigest(value) });
  values.bindings = {
    ownership_inventory: binding(inventory, 'fresh-inventory.json'), materialization_post_audit: binding(audit, '1658-audit.json'), source_review_receipts: binding(receipts, '1661-receipts.json'), context_artifacts: binding(contexts, 'contexts.json'), live_issue_snapshot: binding(values.liveIssueSnapshot, 'live.json'),
  };
  return values;
}

function authorizationComment(auth, overrides = {}) {
  const comment = {
    id: auth.comment_id,
    issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/1662',
    issue_number: 1662,
    body: `<!-- issue-1662-authorization\n${JSON.stringify(auth, null, 2)}\n-->`,
    ...overrides,
  };
  return comment;
}

test('dynamic plan uses every fresh owner, not legacy 350 candidates, and keeps unknowns unlabelled', () => {
  const result = buildPlan(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.plan.schema_version, SCHEMA_VERSION);
  assert.equal(result.plan.candidate_count, 2);
  assert.equal(result.plan.legacy_1611_candidate_count_ignored, 350);
  assert.equal(result.plan.summary.projectable, 2);
  assert.equal(result.plan.write_operations.patch, 0);
  assert.equal(result.plan.candidates[1].unknown_facts.includes('company'), true);
  assert.equal(result.plan.candidates[1].proposed_labels.some((label) => label.startsWith('company:')), false);
  assert.equal(JSON.stringify(result.plan).includes('Raw fixture'), false);
  assert.equal(result.plan.candidates.every((item) => item.raw_body_mutation === false), true);
});

test('fresh ownership, materialization audit, receipt, Context and body CAS are all fail-closed', () => {
  const input = fixture();
  input.ownershipInventory.canonical_digest = '0'.repeat(64);
  const result = buildPlan(input);
  assert.equal(result.ok, false);
  assert.ok(result.plan.errors.some((error) => /canonical_digest/.test(error)));
  assert.equal(result.plan.summary.mutation_count, 0);

  const drifted = fixture();
  drifted.liveIssueSnapshot.items[0].body += '\nDRIFT';
  const driftResult = buildPlan(drifted);
  assert.equal(driftResult.ok, false);
  assert.ok(driftResult.plan.errors.some((error) => /body SHA/.test(error)));
});

test('authorization requires explicit #1662 marker/comment, live flag, exact digest and ceiling', () => {
  const input = fixture();
  const plan = buildPlan(input).plan;
  const auth = { schema_version: AUTH_SCHEMA_VERSION, issue_number: 1662, comment_id: 991662, marker: 'issue-1662-authorization', allow_live_github: true, plan_digest: plan.canonical_digest, mutation_ceiling: 1, authorized_by: 'fixture' };
  const fetchAuthorizationComment = () => authorizationComment(auth);
  assert.equal(validateAuthorization(auth, plan.canonical_digest, 1, { allowLiveGithub: true, fetchAuthorizationComment }).ok, true);
  assert.equal(validateAuthorization({ ...auth, comment_id: null }, plan.canonical_digest, 1, { allowLiveGithub: true, fetchAuthorizationComment }).ok, false);
  assert.equal(validateAuthorization(auth, plan.canonical_digest, 2, { allowLiveGithub: true, fetchAuthorizationComment }).ok, false);
  assert.equal(validateAuthorization(auth, plan.canonical_digest, 1, { allowLiveGithub: true }).ok, false);
  assert.equal(validateAuthorization(auth, plan.canonical_digest, 1, { allowLiveGithub: true, fetchAuthorizationComment: () => authorizationComment(auth, { id: 991663 }) }).ok, false);
  assert.equal(validateAuthorization(auth, plan.canonical_digest, 1, { allowLiveGithub: true, fetchAuthorizationComment: () => authorizationComment(auth, { issue_url: 'https://api.github.com/repos/liqiangcc/interview-lab/issues/1611', issue_number: 1611 }) }).ok, false);
  assert.equal(validateAuthorization(auth, plan.canonical_digest, 1, { allowLiveGithub: true, fetchAuthorizationComment: () => authorizationComment(auth, { issue_url: undefined, issue_number: 1662 }) }).ok, false);
  assert.equal(validateAuthorization(auth, plan.canonical_digest, 1, { allowLiveGithub: true, fetchAuthorizationComment: () => [authorizationComment(auth), authorizationComment(auth)] }).ok, false);
});

test('materialization rows cannot bypass #1658 scope, source CAS, revision, or actual state gates', () => {
  const input = fixture();
  input.materializationPostAudit.items = input.materializationPostAudit.items.map((row) => ({ issue_number: row.issue_number, interview_note_id: row.interview_note_id }));
  input.bindings.materialization_post_audit.sha256 = canonicalDigest(input.materializationPostAudit);
  const result = buildPlan(input);
  assert.equal(result.ok, false);
  assert.ok(result.plan.errors.some((error) => /explicitly bind #1658 scope/.test(error)));
  assert.ok(result.plan.errors.some((error) => /source_note_body_sha256|source_revision_id|actual passing post-audit state|actual mutation/.test(error)));
});

test('receipt terminal status conflicts and incomplete repository/SourceNote/request binding fail closed', () => {
  const input = fixture();
  input.sourceReviewReceipts[0] = { ...input.sourceReviewReceipts[0], status: 'blocked', repository: 'other/repository' };
  delete input.sourceReviewReceipts[0].source_note_id;
  delete input.sourceReviewReceipts[0].request;
  input.bindings.source_review_receipts.sha256 = canonicalDigest(input.sourceReviewReceipts);
  const result = buildPlan(input);
  assert.equal(result.ok, false);
  assert.ok(result.plan.errors.some((error) => /terminal status fields conflict/.test(error)));
  assert.ok(result.plan.errors.some((error) => /repository|SourceNote identity|complete marker\/request binding/.test(error)));
});

test('PATCH response must return the complete exact label projection', () => {
  const item = { issue_number: 2001, proposed_title: '[阿里] 后端 校招 · 2023 xhs:1662', proposed_labels: ['company:alibaba', 'role:backend'], current_body_sha256: 'a'.repeat(64) };
  assert.throws(() => validatePatchResponse({ number: 2001, title: item.proposed_title }, item), /omitted complete labels/);
  assert.throws(() => validatePatchResponse({ number: 2001, title: item.proposed_title, labels: ['role:backend'] }, item), /exactly match/);
  assert.equal(validatePatchResponse({ number: 2001, title: item.proposed_title, labels: [{ name: 'role:backend' }, { name: 'company:alibaba' }] }, item), true);
});

test('exclusive lock assertHeld rejects deletion, replacement, and symlink drift', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1662-assert-lock-'));
  const lockPath = path.join(temp, 'apply.lock');
  const replacementPath = path.join(temp, 'replacement');
  const lock = acquireExclusiveLock(lockPath);
  lock.assertHeld();
  fs.unlinkSync(lockPath);
  fs.writeFileSync(lockPath, JSON.stringify({ token: 'replacement', device: 0, inode: 0 }));
  assert.throws(() => lock.assertHeld(), /ownership or inode changed/);
  fs.unlinkSync(lockPath);
  fs.writeFileSync(replacementPath, 'replacement target');
  fs.symlinkSync(replacementPath, lockPath);
  assert.throws(() => lock.assertHeld(), /ownership or inode changed/);
  fs.unlinkSync(lockPath);
});

test('controlled apply uses exclusive lock/journal and only injected adapters', () => {
  const input = fixture();
  const result = buildPlan(input);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1662-'));
  const lockPath = path.join(temp, 'apply.lock');
  const journalPath = path.join(temp, 'apply.journal.jsonl');
  const auth = { schema_version: AUTH_SCHEMA_VERSION, issue_number: 1662, comment_id: 991662, marker: 'issue-1662-authorization', allow_live_github: true, plan_digest: result.plan.canonical_digest, mutation_ceiling: 2, authorized_by: 'fixture' };
  const patched = [];
  const applied = applyPlan(result.plan, { authorization: auth, fetchAuthorizationComment: () => authorizationComment(auth), allowLiveGithub: true, maxMutations: 2, lockPath, journalPath, readIssue: (number) => input.liveIssueSnapshot.items.find((issue) => issue.number === number), patchIssue: (number, projection) => { patched.push(number); const issue = input.liveIssueSnapshot.items.find((item) => item.number === number); issue.title = projection.title; issue.labels = projection.labels; return { number, title: projection.title, labels: projection.labels, body: issue.body }; }, postReceipt: () => ({ id: 1234 }) });
  assert.equal(applied.mutation_performed, true);
  assert.deepEqual(patched, [2001, 2002]);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.readFileSync(journalPath, 'utf8').includes('patch-converged'), true);
});

test('apply fails closed immediately when the lock is replaced during a fresh read', () => {
  const input = fixture();
  const result = buildPlan(input);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1662-lock-drift-'));
  const lockPath = path.join(temp, 'apply.lock');
  const journalPath = path.join(temp, 'apply.journal.jsonl');
  const auth = { schema_version: AUTH_SCHEMA_VERSION, issue_number: 1662, comment_id: 991662, marker: 'issue-1662-authorization', allow_live_github: true, plan_digest: result.plan.canonical_digest, mutation_ceiling: 2, authorized_by: 'fixture' };
  let reads = 0;
  assert.throws(() => applyPlan(result.plan, {
    authorization: auth, fetchAuthorizationComment: () => authorizationComment(auth), allowLiveGithub: true, maxMutations: 2, lockPath, journalPath,
    readIssue: (number) => {
      reads += 1;
      if (reads === 1) { fs.unlinkSync(lockPath); fs.writeFileSync(lockPath, JSON.stringify({ token: 'replacement', device: 0, inode: 0 })); }
      return input.liveIssueSnapshot.items.find((issue) => issue.number === number);
    },
    patchIssue: () => { throw new Error('PATCH must not be reached after lock drift'); }, postReceipt: () => ({ id: 1234 }),
  }), /exclusive apply lock (ownership or inode changed|disappeared)/);
  assert.equal(reads, 1);
});

test('apply journals patch-unknown when post-PATCH GET drifts or throws', () => {
  for (const mode of ['drift', 'error']) {
    const input = fixture();
    const result = buildPlan(input);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `issue-1662-post-get-${mode}-`));
    const lockPath = path.join(temp, 'apply.lock');
    const journalPath = path.join(temp, 'apply.journal.jsonl');
    const auth = { schema_version: AUTH_SCHEMA_VERSION, issue_number: 1662, comment_id: 991662, marker: 'issue-1662-authorization', allow_live_github: true, plan_digest: result.plan.canonical_digest, mutation_ceiling: 2, authorized_by: 'fixture' };
    let reads = 0;
    assert.throws(() => applyPlan(result.plan, {
      authorization: auth, fetchAuthorizationComment: () => authorizationComment(auth), allowLiveGithub: true, maxMutations: 2, lockPath, journalPath,
      readIssue: (number) => {
        reads += 1;
        const issue = input.liveIssueSnapshot.items.find((item) => item.number === number);
        if (reads === 2 && mode === 'error') throw new Error('simulated post-PATCH GET failure');
        if (reads === 2) return { ...issue, title: 'concurrent title drift' };
        return issue;
      },
      patchIssue: (number, projection) => { const issue = input.liveIssueSnapshot.items.find((item) => item.number === number); return { number, title: projection.title, labels: projection.labels, body: issue.body }; },
      postReceipt: () => ({ id: 1234 }),
    }), /PATCH outcome is unknown/);
    const journal = fs.readFileSync(journalPath, 'utf8');
    assert.match(journal, /"state":"patch-unknown"/);
    assert.match(journal, /"phase":"post-patch-read-validation"|"phase":"patch-response-or-post-read"/);
    assert.match(journal, /"possibly_performed":true/);
    assert.doesNotMatch(journal, /"state":"patch-converged"/);
  }
});

test('controlled apply journals patch-unknown when PATCH returns but response validation fails', () => {
  const input = fixture();
  const result = buildPlan(input);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1662-unknown-'));
  const lockPath = path.join(temp, 'apply.lock');
  const journalPath = path.join(temp, 'apply.journal.jsonl');
  const auth = { schema_version: AUTH_SCHEMA_VERSION, issue_number: 1662, comment_id: 991662, marker: 'issue-1662-authorization', allow_live_github: true, plan_digest: result.plan.canonical_digest, mutation_ceiling: 2, authorized_by: 'fixture' };
  assert.throws(() => applyPlan(result.plan, { authorization: auth, fetchAuthorizationComment: () => authorizationComment(auth), allowLiveGithub: true, maxMutations: 2, lockPath, journalPath, readIssue: (number) => input.liveIssueSnapshot.items.find((issue) => issue.number === number), patchIssue: () => ({ number: 2001, title: result.plan.candidates[0].proposed_title }), postReceipt: () => ({ id: 1234 }) }), /PATCH outcome is unknown/);
  const journal = fs.readFileSync(journalPath, 'utf8');
  assert.match(journal, /"state":"patch-intent"/);
  assert.match(journal, /"state":"patch-unknown"/);
  assert.match(journal, /"uncertain":true/);
  assert.doesNotMatch(journal, /"state":"patch-converged"/);
  assert.equal(fs.existsSync(lockPath), false);
});
