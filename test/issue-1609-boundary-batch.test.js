'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, disposition, normalizeBoundaryText, readArtifact, sha1GitBlob, sha256 } = require('../scripts/issue-1609-boundary-batch');
const { validateTransitionRequest, planSourceNoteBoundaryReviewTransition } = require('../scripts/lib/source-note-boundary-review-transition');

const ROOT = path.join(__dirname, '..', 'data', 'issue-1609');
const load = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
const files = (directory) => fs.readdirSync(path.join(ROOT, directory)).filter((name) => name.endsWith('.json')).sort();

test('Issue #1609 disposition is conservative and does not treat tags as evidence', () => {
  assert.equal(disposition('').disposition, 'blocked');
  assert.equal(disposition('#面经[话题]# #后端[话题]#').disposition, 'blocked');
  assert.equal(disposition('一面：自我介绍；面试官询问项目；手撕算法题').disposition, 'single-interview');
  assert.equal(disposition('Java 面试题库，整理常见知识点供刷题').disposition, 'blocked');
  assert.equal(disposition('三场面试：公司甲、公司乙、公司丙').disposition, 'blocked');
  assert.equal(disposition('从第一个面试到现在一个月，面完懂车帝挂了之后也不敢面字节了，面着面着感觉好累').disposition, 'blocked');
  assert.equal(disposition('oppo 模型加速\n代码题：合并有序链表\n\n得物\n聊项目\n代码题：合并有序链表\n\n贝壳找房\n场景题：介绍一个树模型').disposition, 'multi-interview');
  assert.equal(disposition('经典的Java必备书籍JavaGuide，内容涵盖自我介绍、面试、数据库，总共424页，直接下载').disposition, 'blocked');
});

test('Issue #1609 adversarial boundary audit recognizes CJK compatibility but stays fail-closed', () => {
  assert.equal(normalizeBoundaryText('开发工程师⼀⾯'), '开发工程师一面');
  const jobOnly = disposition('2026届字节跳动客户端-抖音岗位，开发工程师⼀⾯（60min，base北京）');
  assert.equal(jobOnly.disposition, 'blocked');
  assert.ok(jobOnly.audit.flags.includes('job-or-title-only'));
  assert.equal(disposition('岗位名称：Java开发；岗位职责：负责后端研发；欢迎投递').disposition, 'blocked');
  assert.equal(disposition('Q1：被问为什么加入百度。避免只说大公司，试试这样回答：技术创新与市场结合。个人经验分享：面试前练习问题和答案。').disposition, 'blocked');
  assert.equal(disposition('收到面试邀请，预约明天一面').disposition, 'blocked');
  assert.equal(disposition('1. Redis 2. JVM 3. MySQL').disposition, 'blocked');
  assert.equal(disposition('字节面试经验总结：综合粉丝投稿和市场环境，建议准备八股与项目。').disposition, 'blocked');
  assert.equal(disposition('仅记录岗位、面试轮次、60min 和 base 北京。').disposition, 'blocked');
  const structured = disposition('二面：面试官追问项目一致性，我回答了领域事件；随后手撕合并有序链表。');
  assert.equal(structured.disposition, 'single-interview');
  assert.equal(structured.audit.has_structured_candidate_event, true);
  const multiRoundup = disposition('秋招进度：1.字节三面挂；2.快手2+1到HR面；3.小红书2+1+1到主管面；4.美团一面挂');
  assert.equal(multiRoundup.disposition, 'blocked');
  assert.ok(multiRoundup.audit.flags.includes('multi-company-or-process'));
});

test('pinned note_desc cache is accepted only after independent SHA/length validation', () => {
  const sourceText = '一段固定的 candidate interview source projection';
  const sourceBytes = Buffer.from(sourceText, 'utf8');
  const artifact = { kind: 'text_projection', ref: 'liqiangcc/xhs:note_desc/test-cache.txt@95b77bb261048059846273688e4b90a2e108b437', git_blob_sha: sha1GitBlob(sourceBytes), byte_size: sourceBytes.length };
  const item = { issue_number: 1, source_note_id: 'xhs-note:test-cache', artifact };
  const snapshotMap = new Map([[1, { artifact, source_text: sourceText }]]);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1609-desc-cache-'));
  const cacheFile = path.join(cacheDir, `${item.source_note_id.replace(/^xhs-note:/, '')}.txt`);
  fs.writeFileSync(cacheFile, sourceText);
  const hit = readArtifact({ ...item, artifact }, snapshotMap, cacheDir);
  assert.equal(hit.cache_status, 'hit');
  fs.writeFileSync(cacheFile, 'null\n');
  const fallback = readArtifact({ ...item, artifact }, snapshotMap, cacheDir);
  assert.equal(fallback.cache_status, 'invalid-fallback');
  assert.match(fallback.url, /^snapshot:/);
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

test('Issue #1609 committed artifacts cover exactly the current pending subset of the frozen range', () => {
  const selection = load('selection-manifest.json');
  const plan = load('dry-run-plan.json');
  const journal = load('apply-journal.json');
  const digest = load('canonical-digest.json');
  const audit = load('post-apply-audit.json');
  assert.equal(selection.selected_count, 238);
  assert.equal(selection.excluded_count, 132);
  assert.deepEqual(selection.range, { min_issue: 1139, max_issue: 1508, expected_count: 366 });
  assert.equal(selection.source_repository_ref, '95b77bb261048059846273688e4b90a2e108b437');
  const { selection_sha256: selectionDigest, ...selectionWithoutDigest } = selection;
  assert.equal(selectionDigest, sha256(canonicalJson(selectionWithoutDigest)));
  const selectedNumbers = selection.items.map((item) => item.issue_number);
  assert.equal(new Set(selectedNumbers).size, 238);
  assert.ok(selection.items.every((item) => item.labels.includes('boundary:pending')));
  assert.ok(selectedNumbers.every((number) => number >= 1139 && number <= 1508));
  assert.deepEqual(selection.read_audit.exact_issue_numbers, Array.from({ length: 370 }, (_, i) => 1139 + i));
  assert.equal(plan.total, 238);
  assert.deepEqual(plan.range, { min_issue: 1139, max_issue: 1508, expected_count: 366, pending_expected_count: 238 });
  assert.deepEqual(plan.counts, { 'single-interview': 0, 'multi-interview': 0, 'not-interview': 0, blocked: 238 });
  assert.equal(plan.mutation_count, 0);
  assert.equal(journal.entries.length, 238);
  assert.equal(journal.mutation_count, 0);
  assert.equal(audit.audit_status, 'not-run');
  assert.equal(audit.mutation_count, 0);
  assert.equal(files('evidence').length, 238);
  assert.equal(files('requests').length, 0);
  assert.equal(files('receipts').length, 238);
  const ambiguity = load('ambiguity-audit.json');
  assert.equal(ambiguity.total, 238);
  assert.deepEqual(ambiguity.flag_issue_numbers['multi-company-or-process'], [1141, 1267, 1447]);
  assert.equal(ambiguity.items.find((item) => item.issue_number === 1141).disposition, 'blocked');
  assert.equal(ambiguity.items.find((item) => item.issue_number === 1267).disposition, 'blocked');
  assert.equal(ambiguity.items.find((item) => item.issue_number === 1200).disposition, 'blocked');
  assert.ok(ambiguity.items.find((item) => item.issue_number === 1200).flags.includes('job-or-title-only'));
  for (const issueNumber of [1175, 1182, 1455, 1460, 1457]) {
    const item = ambiguity.items.find((item) => item.issue_number === issueNumber);
    assert.equal(item.disposition, 'blocked', String(issueNumber));
    assert.ok(item.flags.includes('no-candidate-event-evidence'), String(issueNumber));
  }
  assert.equal(ambiguity.items.some((item) => item.issue_number === 1452), false);
  assert.ok(selection.excluded.some((item) => item.issue_number === 1452));
  assert.ok(ambiguity.flag_issue_numbers['question-list-only'].length > 0);
  assert.ok(ambiguity.flag_issue_numbers['outcome-or-offer-only'].length > 0);
  assert.ok(ambiguity.flag_issue_numbers['no-first-person-event'].length > 0);
  assert.ok(ambiguity.flag_issue_numbers['no-candidate-event-evidence'].length > 0);
  assert.ok(ambiguity.flag_issue_numbers['generic-advice-or-aggregated'].length > 0);
  assert.ok(ambiguity.flag_issue_numbers['scheduled-only'].length > 0);
  assert.ok(ambiguity.flag_issue_numbers['question-only'].length > 0);
  assert.deepEqual(ambiguity.flag_issue_numbers['generic-question-bank-or-job-ad'].filter((number) => number === 1176 || number === 1297), [1176, 1297]);
  assert.deepEqual(ambiguity.flag_issue_numbers['job-or-title-only'], [1200]);
  assert.equal(digest.evidence_count, 238);
  assert.equal(digest.request_count, 0);
  assert.equal(digest.receipt_count, 238);
});

test('staged terminal requests are exactly validator-compatible and blocked items have no transition request', () => {
  const selection = load('selection-manifest.json');
  const audit = load('ambiguity-audit.json');
  const auditByIssue = new Map(audit.items.map((item) => [item.issue_number, item]));
  for (const file of files('requests')) {
    const request = load(path.join('requests', file));
    const validation = validateTransitionRequest(request);
    assert.equal(validation.ok, true, `${file}: ${validation.errors.join('; ')}`);
    assert.equal(request.expected_manifest_sha256, null, file);
    assert.equal(request.expected_source_repository_ref, selection.source_repository_ref, file);
    assert.equal(request.reviewed_at, '2026-09-08T00:00:00.000Z', file);
    assert.equal(request.reviewer_kind, 'ai-assisted', file);
    assert.match(request.limitations.join('\n'), /no live evidence comment was created/);
    if (request.decision === 'multi-interview') {
      for (const item of request.interview_cases) {
        assert.deepEqual(Object.keys(item).sort(), ['case_key', 'evidence'], file);
        for (const evidence of item.evidence) assert.deepEqual(Object.keys(evidence).sort(), ['locator', 'ref'], file);
      }
    }
    assert.equal(auditByIssue.get(request.issue_number).transition_request_staged, true, file);
  }
  for (const item of audit.items.filter((item) => item.disposition === 'blocked')) {
    assert.equal(item.transition_request_staged, false, String(item.issue_number));
    assert.equal(item.request_file, null, String(item.issue_number));
  }
});

test('formal request contract remains validator-compatible and planner-gated without live evidence', () => {
  const request = {
    schema_version: 'source-note-boundary-review-transition.v1',
    transition_id: 'issue-1609-boundary-synthetic-review-1',
    repository: 'liqiangcc/interview-lab',
    issue_number: 1452,
    source_note_id: 'xhs-note:synthetic',
    expected_body_sha256: 'a'.repeat(64),
    expected_boundary_status: 'pending',
    expected_source_revision_id: 'xhs:synthetic:r1',
    expected_manifest_sha256: null,
    expected_source_repository_ref: '95b77bb261048059846273688e4b90a2e108b437',
    decision: 'single-interview',
    reviewed_at: '2026-09-08T00:00:00.000Z',
    reviewer_kind: 'ai-assisted',
    review_evidence: { repository: 'liqiangcc/interview-lab', issue_number: 1452, comment_id: 1609001452 },
    checks: [
      { check_id: 'source_identity', result: 'pass' },
      { check_id: 'source_revision_binding', result: 'pass' },
      { check_id: 'source_content_coverage', result: 'pass' },
      { check_id: 'event_boundary', result: 'pass' },
      { check_id: 'no_cross_source_mixing', result: 'pass' },
      { check_id: 'no_fabrication', result: 'pass' },
    ],
    limitations: ['synthetic contract fixture; no live evidence comment was created'],
  };
  assert.equal(validateTransitionRequest(request).ok, true);
  const planned = planSourceNoteBoundaryReviewTransition(request, null, {});
  assert.equal(planned.ok, false);
  assert.ok(planned.errors.includes('live SourceNote issue is required'));
});

test('each evidence record is bound to its frozen body and exact artifact', () => {
  const selection = load('selection-manifest.json');
  const byIssue = new Map(selection.items.map((item) => [item.issue_number, item]));
  for (const file of files('evidence')) {
    const evidence = load(path.join('evidence', file));
    const item = byIssue.get(evidence.issue_number);
    assert.ok(item, file);
    assert.equal(evidence.body_sha256, item.body_sha256, file);
    assert.equal(evidence.source_repository_ref, selection.source_repository_ref, file);
    assert.ok(item.artifacts.some((artifact) => artifact.ref === evidence.source_evidence.ref && artifact.git_blob_sha === evidence.source_evidence.git_blob_sha), file);
    const { evidence_sha256: ignored, ...withoutDigest } = evidence;
    assert.equal(evidence.evidence_sha256, sha256(canonicalJson(withoutDigest)), file);
    assert.ok(evidence.source_evidence.excerpt.locator.startsWith('artifact-line:'), file);
    assert.equal(evidence.source_ready_claimed, false, file);
    assert.ok(['single-interview', 'multi-interview', 'not-interview', 'blocked'].includes(evidence.disposition), file);
    if (evidence.disposition === 'blocked') assert.equal(evidence.checks.find((check) => check.check_id === 'event_boundary').result, 'fail', file);
    if (evidence.disposition === 'multi-interview') {
      assert.ok(evidence.interview_cases.length >= 2, file);
      assert.equal(new Set(evidence.interview_cases.map((item) => item.case_key)).size, evidence.interview_cases.length, file);
        assert.equal(new Set(evidence.interview_cases.map((item) => item.locator)).size, evidence.interview_cases.length, file);
        assert.ok(evidence.interview_cases.every((item) => item.locator.startsWith('artifact-line:')), file);
    }
  }
});

test('all planned receipts are explicitly non-live and no Raw mutation is claimed', () => {
  for (const file of files('receipts')) {
    const receipt = load(path.join('receipts', file));
    assert.equal(receipt.receipt_state, 'not-applied', file);
    assert.equal(receipt.mutation_attempted, false, file);
    assert.equal(receipt.possibly_performed, false, file);
  }
});
