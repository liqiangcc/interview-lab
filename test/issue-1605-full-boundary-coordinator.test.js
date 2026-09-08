'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const completedManifest = require('../data/pilot/issue-1605/full-boundary-manifest.json');
const frozenSnapshot = require('../data/pilot/issue-1605/pending-inventory.snapshot.json');
const boundaryBEvidence = require('../data/issue-1607/evidence-ledger.json');
const {
  buildPlan, deriveBoundaryBCases, pendingInventory, remainingInventory, parseArgs, sha256,
  formalRequest, parseEvidenceComment, runEvidence, isAllowedBlockedAuditError,
  evidenceAuthorizationDigest, renderEvidenceAuthorizationMarker, validateEvidenceAuthorization,
  readWithRetry, readLiveIssue, readCommentsPage,
} = require('../scripts/issue-1605-full-boundary-coordinator');
const { validateTransitionRequest } = require('../scripts/lib/source-note-boundary-review-transition');

test('full boundary coordinator excludes the completed manifest and covers every remaining audit', () => {
  // CI intentionally has no live GitHub cache.  Use the frozen inventory's
  // already-verified body digests and labels as a read-only cache fixture;
  // production runs still read the full GitHub body cache.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-coordinator-'));
  const cacheFile = path.join(directory, 'source-notes.json');
  fs.writeFileSync(cacheFile, JSON.stringify(frozenSnapshot.items.map((item) => ({
    number: item.issue_number,
    body_sha256: item.body_sha256,
    labels: item.labels,
  }))));
  const plan = buildPlan({ cache: cacheFile });
  assert.equal(plan.frozen_inventory.digest, frozenSnapshot.canonical_digest);
  assert.notEqual(path.resolve(cacheFile), path.resolve('/tmp/interview-lab-cache/source-notes.json'));
  assert.equal(plan.frozen_inventory.count, 1397);
  assert.equal(plan.pending_inventory.count, 978);
  assert.equal(plan.completed_exclusion.count, 419);
  assert.equal(plan.scope.remaining_total, 978);
  assert.equal(plan.coverage.audited_total, 978);
  assert.equal(plan.coverage.actionable_total + plan.coverage.blocked_total, 978);
  assert.deepEqual(plan.coverage.uncovered_issue_numbers, []);
  assert.equal(plan.mutation_count, 0);
  assert.equal(plan.live_evidence_comments, 0);
  assert.equal(plan.live_transitions, 0);

  const completed = new Set(completedManifest.items.map((item) => item.issue_number));
  assert.equal(plan.items.some((item) => completed.has(item.issue_number)), false);
  for (const item of plan.items) {
    assert.equal(item.expected_source_repository_ref, '95b77bb261048059846273688e4b90a2e108b437');
    if (item.decision === 'multi-interview') assert.ok(item.cases.length >= 2, `#${item.issue_number} needs at least two case anchors`);
  }
  // #735 says that there were “many” interviews but does not enumerate them;
  // the controller must keep it blocked instead of inventing an N.
  assert.ok(plan.coverage.invalid_decision_issue_numbers.includes(735));
  assert.equal(plan.errors.length, 0);
  assert.deepEqual(plan.blocked_errors, ['#735 multi-interview has fewer than two cases']);
});

test('only the pinned #735 insufficient-case audit error is allowlisted; unexpected errors remain fail-closed', () => {
  assert.equal(isAllowedBlockedAuditError('#735 multi-interview has fewer than two cases'), true);
  assert.equal(isAllowedBlockedAuditError('#735 multi-interview has one case'), false);
  assert.equal(isAllowedBlockedAuditError('#951 comments read failed'), false);
});

test('evidence mode authorization binds parent, plan, scope, manifest, marker, and mutation ceiling', () => {
  const plan = {
    canonical_digest: 'a'.repeat(64),
    frozen_inventory: { digest: '5bbf8de3dc61ed382ee31e0d0286c3e7374efec243f60b245c76ee2e0b553dfd' },
    errors: [],
  };
  const proofWithoutDigest = {
    schema_version: 'issue-1605-remaining-boundary-evidence-authorization.v1',
    repository: 'liqiangcc/interview-lab', parent_issue: 1605,
    action: 'authorize-remaining-boundary-evidence', allow_live_github: true,
    manifest_digest: 'fea78669500c0986eff96b67b7e2d35afdf46355bc7caa9b862116eca40b4ba9',
    scope_digest: '6ef4fa26e838fe8c30d571c08807c09d5a3280eb40aa4af57d679274f6a131a1',
    frozen_snapshot_digest: plan.frozen_inventory.digest,
    plan_digest: plan.canonical_digest, max_mutations: 557, comment_id: 1605001, authorized_by: 'test-reviewer',
  };
  const proof = { ...proofWithoutDigest, proof_sha256: evidenceAuthorizationDigest(proofWithoutDigest) };
  const comments = [{ id: proof.comment_id, body: renderEvidenceAuthorizationMarker(proof) }];
  assert.equal(validateEvidenceAuthorization(proof, plan, comments).ok, true);
  assert.equal(validateEvidenceAuthorization({ ...proof, max_mutations: 0 }, plan, comments).ok, false);
  assert.equal(validateEvidenceAuthorization({ ...proof, frozen_snapshot_digest: '0'.repeat(64) }, plan, comments).ok, false);
  assert.equal(validateEvidenceAuthorization({ ...proof, plan_digest: 'b'.repeat(64) }, plan, comments).ok, false);
  assert.equal(validateEvidenceAuthorization(proof, plan, [{ id: proof.comment_id, body: `${renderEvidenceAuthorizationMarker(proof)}\n${renderEvidenceAuthorizationMarker(proof)}` }]).ok, false);
  assert.throws(() => runEvidence({ confirmPlan: plan.canonical_digest, authorization: null, maxMutations: 1 }, plan, { parentComments: [] }), /authorization/);
  assert.throws(() => parseArgs(['--mode', 'evidence', '--confirm-plan', plan.canonical_digest]), /authorization-proof/);
});

test('read-only Issue and comments GETs retry transient TLS failures with bounded exponential backoff', () => {
  let issueAttempts = 0;
  const delays = [];
  const issue = readLiveIssue(735, {
    ghJson() {
      issueAttempts += 1;
      if (issueAttempts < 3) throw new Error('TLS handshake timeout');
      return { number: 735, state: 'open' };
    },
    baseDelayMs: 7,
    sleepFn: (delay) => delays.push(delay),
  });
  assert.equal(issue.number, 735);
  assert.equal(issueAttempts, 3);
  assert.deepEqual(delays, [7, 14]);

  let commentAttempts = 0;
  const comments = readCommentsPage(735, 1, {
    ghJson() {
      commentAttempts += 1;
      if (commentAttempts === 1) throw new Error('network connection reset');
      return [];
    },
    sleepFn() {},
  });
  assert.deepEqual(comments, []);
  assert.equal(commentAttempts, 2);
});

test('remaining and frozen inventory validators reject a digest or scope drift', () => {
  const frozen = pendingInventory();
  const remaining = remainingInventory(undefined, frozen);
  assert.equal(frozen.numbers.size, 1397);
  assert.equal(remaining.numbers.size, 978);
  assert.throws(() => remainingInventory('/tmp/does-not-exist.json', frozen), /ENOENT/);
});

test('boundary B case derivation keeps exact source refs and unique locators', () => {
  const evidence = {
    source_evidence: {
      ref: 'liqiangcc/xhs:note_desc/example.txt@95b77bb261048059846273688e4b90a2e108b437',
      locator: 'note_desc:1-2',
      text: '一面：项目深挖\n二面：系统设计',
    },
  };
  const cases = deriveBoundaryBCases(evidence);
  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map((item) => item.case_key), ['round-1', 'round-2']);
  assert.equal(new Set(cases.flatMap((item) => item.evidence.map((ref) => ref.locator))).size, 2);
  assert.ok(cases.every((item) => item.evidence[0].ref === evidence.source_evidence.ref));
});

test('boundary B ignores question-count wording and summary recaps', () => {
  for (const issueNumber of [504, 578]) {
    const evidence = boundaryBEvidence.items.find((item) => item.issue_number === issueNumber);
    assert.ok(evidence, `missing Boundary B evidence for #${issueNumber}`);
    const cases = deriveBoundaryBCases(evidence);
    assert.equal(cases.length, 2, `#${issueNumber} should have exactly two interview cases`);
    assert.equal(new Set(cases.map((item) => item.case_key)).size, 2);
    assert.equal(new Set(cases.flatMap((item) => item.evidence.map((ref) => ref.locator))).size, 2);
  }
});

test('remaining coordinator defaults never target the completed 419-row artifacts', () => {
  const args = parseArgs([]);
  assert.match(args.output, /remaining-boundary-evidence-plan\.json$/);
  assert.match(args.journal, /remaining-boundary-evidence-progress\.json$/);
  assert.match(args.requestDir, /remaining-boundary-evidence-requests$/);
  assert.notEqual(path.basename(args.output), 'full-boundary-transition.plan.json');
  assert.notEqual(path.basename(args.journal), 'full-boundary-transition.journal.json');
  assert.doesNotMatch(args.requestDir, /full-boundary-requests/);
});

test('not-interview remains actionable and multi-interview emits validator-compatible v2 requests', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-request-fixtures-'));
  const cacheFile = path.join(directory, 'source-notes.json');
  fs.writeFileSync(cacheFile, JSON.stringify(frozenSnapshot.items.map((item) => ({
    number: item.issue_number, body_sha256: item.body_sha256, labels: item.labels,
  }))));
  const plan = buildPlan({ cache: cacheFile });
  const notInterview = plan.items.find((item) => item.decision === 'not-interview');
  const multi = plan.items.find((item) => item.decision === 'multi-interview');
  assert.ok(notInterview);
  assert.ok(multi && multi.cases.length >= 2);
  const notRequest = formalRequest(notInterview, 1001, '2026-09-09T00:00:00Z');
  assert.equal(notRequest.schema_version, 'source-note-boundary-review-transition.v1');
  assert.equal(Object.hasOwn(notRequest, 'interview_cases'), false);
  assert.equal(validateTransitionRequest(notRequest).ok, true);
  const multiRequest = formalRequest(multi, 1002, '2026-09-09T00:00:00Z');
  assert.equal(multiRequest.schema_version, 'source-note-boundary-review-transition.v2');
  assert.ok(multiRequest.interview_cases.length >= 2);
  assert.equal(validateTransitionRequest(multiRequest).ok, true);
});

test('simulated evidence mode persists journal/request, reconciles exact marker, and never PATCHes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-evidence-simulation-'));
  const cacheFile = path.join(directory, 'source-notes.json');
  fs.writeFileSync(cacheFile, JSON.stringify(frozenSnapshot.items.map((item) => ({
    number: item.issue_number, body_sha256: item.body_sha256, labels: item.labels,
  }))));
  const sourcePlan = buildPlan({ cache: cacheFile });
  const sourceItem = sourcePlan.items.find((item) => item.decision === 'not-interview');
  const item = { ...sourceItem, expected_body_sha256: sha256('synthetic pending body') };
  const plan = { ...sourcePlan, items: [item], canonical_digest: sha256('simulated evidence plan') };
  const comments = [];
  const calls = { get: 0, post: 0, patch: 0 };
  const args = {
    mode: 'evidence', output: path.join(directory, 'remaining-plan.json'),
    journal: path.join(directory, 'remaining-journal.json'), lock: path.join(directory, 'remaining.lock'),
    requestDir: path.join(directory, 'requests'), confirmPlan: plan.canonical_digest,
    maxMutations: 1, pauseMs: 0, allowUncertainRetry: false,
  };
  const proofWithoutDigest = {
    schema_version: 'issue-1605-remaining-boundary-evidence-authorization.v1',
    repository: 'liqiangcc/interview-lab', parent_issue: 1605,
    action: 'authorize-remaining-boundary-evidence', allow_live_github: true,
    manifest_digest: sourcePlan.pending_inventory.digest, scope_digest: sourcePlan.scope.remaining_scope_digest,
    frozen_snapshot_digest: sourcePlan.frozen_inventory.digest,
    plan_digest: plan.canonical_digest, max_mutations: 1, comment_id: 1605002, authorized_by: 'simulation-reviewer',
  };
  const proof = { ...proofWithoutDigest, proof_sha256: evidenceAuthorizationDigest(proofWithoutDigest) };
  const fakeFindExact = (candidate) => ({
    exact: comments.filter((comment) => parseEvidenceComment(comment, candidate).ok).map((comment) => ({
      ...comment, evidence: JSON.parse(comment.body.match(/<!--\s*source-note-boundary-review-evidence\s*([\s\S]*?)-->/)[1].trim()),
    })),
    errors: [],
  });
  runEvidence(args, plan, {
    authorization: proof,
    parentComments: [{ id: proof.comment_id, body: renderEvidenceAuthorizationMarker(proof) }],
    readLiveIssue(number) {
      calls.get += 1;
      assert.equal(number, item.issue_number);
      return { state: 'open', body: 'synthetic pending body', labels: ['boundary:pending'] };
    },
    findExactEvidenceComments: fakeFindExact,
    postEvidence(candidate, body) {
      calls.post += 1;
      assert.equal(candidate.issue_number, item.issue_number);
      assert.match(body, /source-note-boundary-review-evidence/);
      comments.push({ id: 7001, body });
      throw new Error('simulated POST deadline after server accepted comment');
    },
    sleep() {},
  });
  assert.equal(calls.post, 1);
  assert.equal(calls.patch, 0);
  assert.ok(calls.get >= 2);
  const journal = JSON.parse(fs.readFileSync(args.journal, 'utf8'));
  assert.equal(journal.status, 'complete');
  assert.equal(journal.posted, 1);
  assert.equal(journal.items[0].status, 'posted');
  assert.equal(journal.items[0].possibly_posted, false);
  const request = JSON.parse(fs.readFileSync(path.join(args.requestDir, `${String(item.issue_number).padStart(4, '0')}.json`), 'utf8').match(/<!--[^\n]+\n([\s\S]*?)\n-->/)[1]);
  assert.equal(request.review_evidence.comment_id, 7001);
});

test('exhausted transient read retry blocks evidence preflight before any POST', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1605-evidence-read-blocked-'));
  const cacheFile = path.join(directory, 'source-notes.json');
  fs.writeFileSync(cacheFile, JSON.stringify(frozenSnapshot.items.map((item) => ({
    number: item.issue_number, body_sha256: item.body_sha256, labels: item.labels,
  }))));
  const sourcePlan = buildPlan({ cache: cacheFile });
  const sourceItem = sourcePlan.items.find((item) => item.decision === 'not-interview');
  const item = { ...sourceItem, expected_body_sha256: sha256('synthetic pending body') };
  const plan = { ...sourcePlan, items: [item], canonical_digest: sha256('exhausted read plan') };
  const proofWithoutDigest = {
    schema_version: 'issue-1605-remaining-boundary-evidence-authorization.v1',
    repository: 'liqiangcc/interview-lab', parent_issue: 1605,
    action: 'authorize-remaining-boundary-evidence', allow_live_github: true,
    manifest_digest: sourcePlan.pending_inventory.digest, scope_digest: sourcePlan.scope.remaining_scope_digest,
    frozen_snapshot_digest: sourcePlan.frozen_inventory.digest,
    plan_digest: plan.canonical_digest, max_mutations: 1, comment_id: 1605003, authorized_by: 'simulation-reviewer',
  };
  const proof = { ...proofWithoutDigest, proof_sha256: evidenceAuthorizationDigest(proofWithoutDigest) };
  let readAttempts = 0;
  let postAttempts = 0;
  const args = {
    mode: 'evidence', output: path.join(directory, 'remaining-plan.json'),
    journal: path.join(directory, 'remaining-journal.json'), lock: path.join(directory, 'remaining.lock'),
    requestDir: path.join(directory, 'requests'), confirmPlan: plan.canonical_digest,
    maxMutations: 1, pauseMs: 0, allowUncertainRetry: false,
  };
  assert.throws(() => runEvidence(args, plan, {
    authorization: proof,
    parentComments: [{ id: proof.comment_id, body: renderEvidenceAuthorizationMarker(proof) }],
    findExactEvidenceComments: () => ({ exact: [], errors: [] }),
    readLiveIssue() {
      return readWithRetry(() => {
        readAttempts += 1;
        throw new Error('TLS handshake timeout');
      }, { sleepFn() {} });
    },
    postEvidence() { postAttempts += 1; return { id: 1 }; },
  }), /evidence preflight read failed/);
  assert.equal(readAttempts, 5);
  assert.equal(postAttempts, 0);
  const journal = JSON.parse(fs.readFileSync(args.journal, 'utf8'));
  assert.equal(journal.status, 'blocked');
  assert.equal(journal.posted, 0);
});
