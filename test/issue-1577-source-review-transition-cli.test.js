'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  atomicWriteJson,
  collectOwnershipPages,
  httpStatusFromError,
  isTransientReadError,
  readReceipt,
  readWithRetry,
  receiptPath,
  main,
} = require('../scripts/apply-issue-1577-source-review-transition');
const { canonicalJson, sha256Text } = require('../scripts/lib/issue-1539-recovery-plan');
const {
  FIXED_ITEMS,
  TARGETS,
  initialProgress,
  validateFixedManifest,
  evidencePlanSha256,
} = require('../scripts/lib/issue-1577-source-review-transition-batch');
const {
  computeChecks,
  evidenceSubjectSha256,
  requestSha256,
} = require('../scripts/lib/interview-note-source-review-transition');
const { buildManifest } = require('../scripts/lib/issue-1539-pinned-artifact-manifest');

test('GET retry handles transient HTTP statuses and transport errors only', () => {
  let calls = 0;
  const sleeps = [];
  const transient = Object.assign(new Error('connection reset by peer'), { code: 'ECONNRESET' });
  assert.throws(() => readWithRetry(() => { calls += 1; throw transient; }, 3, 7, (ms) => sleeps.push(ms)), /connection reset/);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [7, 14]);
  for (const status of [429, 500, 502, 503, 504]) {
    calls = 0;
    const error = Object.assign(new Error(`HTTP ${status}`), { status });
    assert.equal(httpStatusFromError(error), status);
    assert.throws(() => readWithRetry(() => { calls += 1; throw error; }, 3, 7, () => {}), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 3, `HTTP ${status} should be retried`);
    assert.equal(isTransientReadError(error), true);
  }
  for (const error of [Object.assign(new Error('HTTP 400'), { status: 400 }), Object.assign(new Error('HTTP 404'), { status: 404 }), Object.assign(new Error('HTTP 408'), { status: 408, code: 'ETIMEDOUT' }), new SyntaxError('Unexpected token'), new Error('semantic validation failed'), new Error('semantic EOF')]) {
    calls = 0;
    assert.throws(() => readWithRetry(() => { calls += 1; throw error; }, 3, 7, () => {}));
    assert.equal(calls, 1);
    assert.equal(isTransientReadError(error), false);
  }
  assert.equal(isTransientReadError(Object.assign(new Error('unexpected EOF'), { code: 'EOF' })), true);
  assert.equal(isTransientReadError(Object.assign(new Error('EOF'), { code: 'EPIPE', transport: true })), true);
  assert.equal(isTransientReadError(new Error('EOF')), false, 'bare semantic EOF must not be retried');
});

test('ownership search reads every 100-item page through the terminal empty page', () => {
  const pages = [
    { incomplete_results: false, total_count: 101, items: Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })) },
    { incomplete_results: false, total_count: 101, items: [{ number: 101 }] },
    { incomplete_results: false, total_count: 101, items: [] },
  ];
  const seen = [];
  const result = collectOwnershipPages((page) => { seen.push(page); return pages[page - 1]; }, 'xhs:test');
  assert.equal(result.length, 101);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.throws(() => collectOwnershipPages(() => ({ incomplete_results: true, total_count: 0, items: [] }), 'xhs:bad'), /incomplete/);
  assert.throws(() => collectOwnershipPages((page) => ({ incomplete_results: false, total_count: page === 1 ? 1 : 2, items: page === 1 ? [{ number: 1 }] : [] }), 'xhs:drift'), /total_count changed/);
});

test('atomic progress/receipt writes fsync the renamed file and parent directory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-transition-atomic-'));
  const file = path.join(directory, 'progress.json');
  const originalFsync = fs.fsyncSync;
  const fsyncKinds = [];
  fs.fsyncSync = (fd) => { fsyncKinds.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return originalFsync(fd); };
  try {
    atomicWriteJson(file, { durable: true });
    assert.deepEqual(fsyncKinds, ['file', 'directory']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { durable: true });
  } finally {
    fs.fsyncSync = originalFsync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('local transition receipt reader rejects malformed files and path escapes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-transition-receipt-'));
  const request = { issue_number: 1558 };
  try {
    assert.throws(() => receiptPath(directory, { issue_number: '../escape' }), /escapes/);
    const malformed = path.join(directory, 'issue-1558.json');
    fs.writeFileSync(malformed, '{not-json\n');
    assert.throws(() => readReceipt(directory, request), /Unexpected token|JSON/);
    fs.rmSync(malformed);
    atomicWriteJson(malformed, { schema_version: 'wrong' });
    assert.throws(() => readReceipt(directory, request), /malformed|not bound/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const productionFixtureRoot = path.resolve('data/pilot/issue-1577');
const hasProductionFixture = fs.existsSync(path.join(productionFixtureRoot, 'evidence-post-apply-plan.json')) && fs.existsSync(path.join(productionFixtureRoot, 'requests'));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeMarker(file, marker, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<!-- ${marker}\n${JSON.stringify(value, null, 2)}\n-->\n`);
}

function makeProductionApplyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-transition-apply-'));
  const requestDir = path.join(root, 'requests');
  const receiptDir = path.join(root, 'receipts');
  const progressDir = path.join(root, 'progress');
  fs.mkdirSync(requestDir, { recursive: true });
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.mkdirSync(progressDir, { recursive: true });
  const sourceRef = FIXED_ITEMS[0].text_projection_ref.match(/@([0-9a-f]{40})$/)[1];
  const sourceRepository = 'liqiangcc/xhs';
  const sourceStates = new Map();
  const interviewStates = new Map();
  const artifactsByIssue = new Map();
  const bodyFor = (kind, record, sections) => `<!-- ${kind === 'source' ? 'source-note' : 'interview-note'}: id=${record[kind === 'source' ? 'source_note_id' : 'interview_note_id']} schema=${record.schema_version} -->\n<!-- ${kind === 'source' ? 'source-note' : 'interview-note'}-record\n${JSON.stringify(record, null, 2)}\n-->\n\n${sections.join('\n\n')}`;

  for (const [index, fixed] of FIXED_ITEMS.entries()) {
    const externalId = fixed.source_note_id.slice('xhs-note:'.length);
    const interviewId = `xhs:${externalId}`;
    const rawRef = `${sourceRepository}:fixture/${externalId}/raw.txt@${sourceRef}`;
    const rawBlob = `${String(index + 1).padStart(2, '0')}${'a'.repeat(38)}`;
    const projection = { kind: 'text_projection', ref: fixed.text_projection_ref, git_blob_sha: fixed.text_projection_blob, sha256: null, provenance: 'source_projection', byte_size: 1, integrity: 'present' };
    const raw = { kind: 'html', ref: rawRef, git_blob_sha: rawBlob, sha256: null, provenance: 'raw_capture', byte_size: 1, integrity: 'present' };
    const artifacts = [raw, projection];
    artifactsByIssue.set(fixed.interview_issue_number, artifacts);
    const sourceRecord = {
      schema_version: 'source-note-issue.v1',
      source_note_id: fixed.source_note_id,
      source: { system: 'xhs', external_id: externalId, url: null },
      source_revision: { id: fixed.source_revision_id, captured_at: '2026-09-07T00:00:00Z', source_repository: sourceRepository, source_repository_ref: sourceRef, reason: 'deterministic production-path fixture' },
      source_published_at: { precision: 'unknown', value: null },
      source_edited_at: { precision: 'unknown', value: null },
      artifacts,
      anomalies: [],
      limitations: ['fixture limitation retained'],
      provenance_status: { status: 'pinned-source-artifact', raw_lineage_claim: 'not-claimed' },
      boundary_review: { status: 'single-interview', reviewed_at: '2026-09-07T00:00:00Z', interview_note_ids: [interviewId] },
    };
    const interviewRecord = {
      schema_version: 'interview-note-issue.v1',
      interview_note_id: interviewId,
      source: { system: 'xhs', external_id: externalId, url: null },
      source_revision: { id: fixed.source_revision_id, captured_at: '2026-09-07T00:00:00Z', source_repository: sourceRepository, source_repository_ref: sourceRef, reason: 'deterministic production-path fixture' },
      source_time: { precision: 'unknown', value: null },
      source_published_at: { precision: 'unknown', value: null },
      source_edited_at: { precision: 'unknown', value: null },
      interview_occurred_at: { precision: 'unknown', value: null },
      artifacts,
      limitations: [...sourceRecord.limitations],
    };
    const sourceBody = bodyFor('source', sourceRecord, ['## 来源身份', '## 原始标题', '## 原始正文', '## 原始附件', '## Intake 异常', '## 边界审核', '## 来源限制', '## 派生链接']);
    const interviewBody = bodyFor('interview', interviewRecord, ['## 来源身份', '## 原始标题', '## 原始正文', '## 原始附件', '## 来源限制', '## 派生链接']);
    sourceStates.set(fixed.source_note_issue_number, { number: fixed.source_note_issue_number, body: sourceBody, state: 'open', labels: ['type:source-note', 'source:xhs', 'boundary:single-interview'] });
    interviewStates.set(fixed.interview_issue_number, { number: fixed.interview_issue_number, body: interviewBody, state: 'open', labels: ['type:interview-note', 'source:xhs', 'learning:fixture', 'status:captured'], comments: [] });
  }

  const entries = FIXED_ITEMS.map((fixed) => ({
    interview_issue_number: fixed.interview_issue_number,
    source_note_issue_number: fixed.source_note_issue_number,
    source_note_id: fixed.source_note_id,
    source_revision_id: fixed.source_revision_id,
    artifacts: artifactsByIssue.get(fixed.interview_issue_number),
  }));
  const treeEntries = entries.flatMap((entry) => entry.artifacts.map((artifact) => ({ type: 'blob', path: artifact.ref.slice(`${sourceRepository}:`.length).replace(/@[0-9a-f]{40}$/, ''), sha: artifact.git_blob_sha })));
  const pinnedArtifactManifest = buildManifest({ repository: 'liqiangcc/interview-lab', sourceSnapshot: { repository: sourceRepository, ref: sourceRef }, entries, treeEntries, scope: 'issue-1577-fixed-17' });
  assert.equal(pinnedArtifactManifest.verified, true, pinnedArtifactManifest.errors.join('; '));
  const packetSetSha256 = sha256Text('deterministic-issue-1577-production-path-packet-set');
  const authorizationSha256 = sha256Text('deterministic-issue-1577-production-path-authorization');
  const requests = [];
  for (const [index, fixed] of FIXED_ITEMS.entries()) {
    const interviewIssue = interviewStates.get(fixed.interview_issue_number);
    const sourceIssue = sourceStates.get(fixed.source_note_issue_number);
    const interviewId = `xhs:${fixed.source_note_id.slice('xhs-note:'.length)}`;
    const request = {
      schema_version: 'interview-note-source-review-transition.v1',
      transition_id: `issue-1577-source-review-${fixed.interview_issue_number}`,
      repository: 'liqiangcc/interview-lab',
      issue_number: fixed.interview_issue_number,
      interview_note_id: interviewId,
      expected_interview_body_sha256: sha256Text(interviewIssue.body),
      expected_initial_status: 'captured',
      expected_source_revision_id: fixed.source_revision_id,
      source_note_issue_number: fixed.source_note_issue_number,
      expected_source_note_body_sha256: sha256Text(sourceIssue.body),
      expected_source_repository_ref: sourceRef,
      provenance_mode: 'pinned-source-artifact',
      provenance_statement: 'pinned-source-artifact; raw-lineage-unproven',
      pinned_artifact_manifest_sha256: pinnedArtifactManifest.digest,
      decision: 'source-ready',
      limitations: ['fixture limitation retained'],
      reviewed_at: '2026-09-07T00:00:00Z',
      reviewer_kind: 'ai-assisted',
      review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: fixed.interview_issue_number, comment_id: 900000 + index },
    };
    request.checks = computeChecks(request, interviewIssue, sourceIssue, [interviewIssue]);
    request.evidence_subject_sha256 = evidenceSubjectSha256(request, request.checks);
    requests.push(request);
    const marker = {
      schema_version: 'interview-note-source-review-evidence.v1',
      repository: request.repository,
      issue_number: request.issue_number,
      interview_note_id: request.interview_note_id,
      source_note_issue_number: request.source_note_issue_number,
      source_revision_id: request.expected_source_revision_id,
      transition_id: request.transition_id,
      evidence_subject_sha256: request.evidence_subject_sha256,
      expected_interview_body_sha256: request.expected_interview_body_sha256,
      expected_source_note_body_sha256: request.expected_source_note_body_sha256,
      provenance_mode: request.provenance_mode,
      provenance_statement: request.provenance_statement,
      pinned_artifact_manifest_sha256: request.pinned_artifact_manifest_sha256,
      decision: request.decision,
      packet_set_sha256: packetSetSha256,
      checks: request.checks,
    };
    const evidenceComment = { id: request.review_evidence.comment_id, issue_url: `https://api.github.com/repos/${request.repository}/issues/${request.issue_number}`, repository_url: `https://api.github.com/repos/${request.repository}`, body: `<!-- interview-note-source-review-evidence.v1\n${JSON.stringify(marker, null, 2)}\n-->` };
    interviewIssue.comments.push(evidenceComment);
    writeJson(path.join(requestDir, `issue-${request.issue_number}.json`), request);
    writeMarker(path.join(requestDir, `issue-${request.issue_number}.md`), 'interview-note-source-review-transition', request);
  }
  const evidencePlan = {
    schema_version: 'issue-1577-source-review-plan.v1',
    mode: 'plan',
    ok: true,
    preflight_ok: true,
    issue_number: 1577,
    fixed_item_count: 17,
    packet_set_sha256: packetSetSha256,
    authorization_sha256: authorizationSha256,
    pinned_artifact_manifest_sha256: pinnedArtifactManifest.digest,
    pinnedArtifactManifest,
    mutation_count: 0,
    mutation_attempted: false,
    mutation_performed: false,
    possibly_performed: false,
    items: requests.map((request) => ({ interview_issue_number: request.issue_number, action: 'already-present', evidence_marker_count: 1, evidence_gate: { ok: true, exact: true }, evidence_comment_id: request.review_evidence.comment_id })),
  };
  evidencePlan.plan_sha256 = evidencePlanSha256(evidencePlan);
  const progress = path.join(progressDir, 'apply.progress.json');
  const lock = path.join(progressDir, 'apply.lock');
  const evidencePlanFile = path.join(root, 'evidence-plan.json');
  writeJson(evidencePlanFile, evidencePlan);
  const apiCalls = [];
  let nextReceiptComment = 910000;
  const ghJson = (args, input = null) => {
    apiCalls.push({ args: [...args], input });
    const endpoint = args.find((value) => typeof value === 'string' && (value.startsWith('repos/') || value.startsWith('search/')));
    if (!endpoint) throw new Error(`fixture cannot identify endpoint: ${args.join(' ')}`);
    const mutation = args.includes('--method');
    const issueMatch = endpoint.match(/\/issues\/(\d+)/);
    const issue = issueMatch && Number(issueMatch[1]);
    if (mutation) {
      const state = interviewStates.get(issue);
      if (endpoint.endsWith('/labels')) {
        const labels = input && Array.isArray(input.labels) ? input.labels : [];
        state.labels = [...new Set([...state.labels, ...labels])];
        return { labels: state.labels };
      }
      if (endpoint.includes('/labels/')) {
        const label = decodeURIComponent(endpoint.slice(endpoint.indexOf('/labels/') + '/labels/'.length));
        state.labels = state.labels.filter((value) => value !== label);
        return { labels: state.labels };
      }
      if (endpoint.endsWith('/comments')) {
        const comment = { id: nextReceiptComment++, issue_url: `https://api.github.com/repos/liqiangcc/interview-lab/issues/${issue}`, repository_url: 'https://api.github.com/repos/liqiangcc/interview-lab', body: input.body };
        state.comments.push(comment);
        return comment;
      }
      throw new Error(`unexpected fixture mutation endpoint: ${endpoint}`);
    }
    if (endpoint.startsWith('search/issues?')) {
      const identity = decodeURIComponent(endpoint).match(/"([^"]+)"/)?.[1];
      const owner = [...interviewStates.values()].find((state) => state.body.includes(`id=${identity} `));
      if (!owner) throw new Error(`fixture ownership identity not found: ${identity}`);
      const page = Number(endpoint.match(/(?:^|&)page=(\d+)/)?.[1] || 1);
      return { incomplete_results: false, total_count: 1, items: page === 1 ? [{ number: owner.number }] : [] };
    }
    if (endpoint.includes('/comments?')) {
      const state = interviewStates.get(issue) || sourceStates.get(issue);
      return [...(state.comments || [])];
    }
    if (endpoint.startsWith('repos/')) return issue === 1577 ? {} : { ...(interviewStates.get(issue) || sourceStates.get(issue)), labels: [...(interviewStates.get(issue) || sourceStates.get(issue)).labels] };
    throw new Error(`unexpected fixture read endpoint: ${endpoint}`);
  };
  return { root, requestDir, receiptDir, progress, lock, evidencePlanFile, ghJson, apiCalls, evidencePlan, interviewStates, sourceStates };
}

test('CLI validates the fixed manifest anchors before any live API call', () => {
  const fixedManifest = JSON.parse(fs.readFileSync(path.resolve('data/issue-1577/source-review-manifest.json'), 'utf8'));
  assert.equal(validateFixedManifest(fixedManifest).ok, true);
  for (const mutate of [
    (manifest) => { manifest.repository = 'attacker/repository'; },
    (manifest) => { manifest.items[0].interview_issue_number = 9999; },
    (manifest) => { manifest.source_snapshot.ref = '0'.repeat(40); },
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-fixed-manifest-'));
    const manifestFile = path.join(directory, 'manifest.json');
    const altered = JSON.parse(JSON.stringify(fixedManifest));
    mutate(altered);
    writeJson(manifestFile, altered);
    let calls = 0;
    try {
      assert.throws(() => main(['--manifest', manifestFile, '--output', path.join(directory, 'output.json')], { ghJson: () => { calls += 1; throw new Error('live API must not be reached'); } }), /fixed manifest validation failed/);
      assert.equal(calls, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('real CLI main applies all 17 production-shaped requests through an injected GitHub fixture', () => {
  const fixture = makeProductionApplyFixture();
  const planOutput = path.join(fixture.root, 'transition-plan.json');
  const resultOutput = path.join(fixture.root, 'transition-result.json');
  try {
    const common = ['--manifest', path.resolve('data/issue-1577/source-review-manifest.json'), '--evidence-plan', fixture.evidencePlanFile, '--request-dir', fixture.requestDir, '--transition-receipt-dir', fixture.receiptDir, '--get-max-attempts', '1', '--get-backoff-ms', '0', '--min-mutation-interval-ms', '0', '--reviewed-at', '2026-09-07T00:00:00Z'];
    const planExit = main([...common, '--output', planOutput], { ghJson: fixture.ghJson });
    assert.equal(planExit, 0, fs.existsSync(planOutput) ? JSON.stringify(JSON.parse(fs.readFileSync(planOutput, 'utf8')).errors) : 'plan output was not written');
    const plan = JSON.parse(fs.readFileSync(planOutput, 'utf8'));
    assert.equal(plan.items.length, 17);
    assert.equal(plan.items.every((item) => item.action === 'would-transition'), true);
    assert.equal(fixture.apiCalls.some((call) => call.args.includes('--method')), false, 'plan-only must not issue mutation calls');
    writeJson(fixture.progress, initialProgress(plan));
    const applyArgs = [...common, '--output', resultOutput, '--progress', fixture.progress, '--progress-lock', fixture.lock, '--confirm-plan-sha256', plan.plan_sha256, '--confirm-authorization-sha256', plan.authorization_sha256, '--apply'];
    assert.equal(main(applyArgs, { ghJson: fixture.ghJson }), 0);
    const result = JSON.parse(fs.readFileSync(resultOutput, 'utf8'));
    assert.equal(result.ok, true, result.errors && result.errors.join('; '));
    assert.equal(result.items.length, 17);
    assert.equal(result.items.every((item) => item.action === 'applied'), true);
    assert.equal(result.progress.label_attempt_count, 102);
    assert.equal(result.progress.receipt_attempt_count, 17);
    assert.equal(result.progress.mutation_count, 119);
    assert.equal(result.progress.possibly_performed, false);
    assert.equal(fixture.apiCalls.filter((call) => call.args.includes('--method') && call.args.some((value) => value.includes('/labels'))).length, 102);
    assert.equal(fixture.apiCalls.filter((call) => call.args.includes('--method') && call.args.some((value) => value.endsWith('/comments'))).length, 17);
    assert.deepEqual(result.items.map((item) => item.issue_number), TARGETS);
    assert.equal(fs.readdirSync(fixture.receiptDir).filter((name) => name.endsWith('.json')).length, 17);
    for (const [issue, state] of fixture.interviewStates) assert.deepEqual(state.labels.sort(), ['learning:fixture', 'source:xhs', 'status:source-ready', 'type:interview-note']);
    assert.equal(fixture.apiCalls.every((call) => call.args[0] === 'api'), true, 'all calls remained inside the injected fixture');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('production evidence/request fixture uses the real read-only CLI loader contract', { skip: !hasProductionFixture }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1577-transition-production-cli-'));
  const output = path.join(directory, 'plan.json');
  const calls = [];
  const ghJson = (args) => {
    calls.push(args);
    const endpoint = args.find((value) => typeof value === 'string' && (value.startsWith('repos/') || value.startsWith('search/')));
    if (endpoint.startsWith('search/issues?')) return { incomplete_results: false, total_count: 0, items: [] };
    if (endpoint.includes('/comments?')) return [];
    if (endpoint.startsWith('repos/')) return {};
    throw new Error(`unexpected read-only fixture endpoint: ${endpoint}`);
  };
  try {
    const exitCode = main([
      '--manifest', path.resolve('data/issue-1577/source-review-manifest.json'),
      '--evidence-plan', path.join(productionFixtureRoot, 'evidence-post-apply-plan.json'),
      '--request-dir', path.join(productionFixtureRoot, 'requests'),
      '--output', output,
      '--get-max-attempts', '1',
      '--get-backoff-ms', '0',
    ], { ghJson });
    assert.equal(exitCode, 1, 'malformed live fixture must fail closed in plan-only mode');
    const plan = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(plan.mutation_count, 0);
    assert.equal(plan.possibly_performed, false);
    assert.ok(calls.length > 0);
    assert.equal(calls.some((args) => args.includes('--method')), false, 'read-only loader must not issue mutation requests');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
