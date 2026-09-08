#!/usr/bin/env node
'use strict';

/*
 * Issue #1608 scope-bounded boundary preparation.
 *
 * This command is deliberately a plan/evidence generator.  It only performs
 * GETs for the exact SourceNote issue-number interval and the exact pinned
 * Source projection blobs declared by those issues.  It never calls PATCH or
 * POST.  Live evidence comments and the formal transition runner remain
 * controller-owned operations.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./lib/source-note-issue');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const ISSUE = 1608;
const FIRST_ISSUE = 766;
const LAST_ISSUE = 1138;
const EXPECTED_PENDING_COUNT = 337;
const OUTPUT_DIR = path.resolve(__dirname, '..', 'data', 'issue-1608');
const ALL_LABELS = ['type:source-note', 'status:captured', 'boundary:pending'];
const CHECKS = [
  'source_identity',
  'source_revision_binding',
  'source_content_coverage',
  'event_boundary',
  'no_cross_source_mixing',
  'no_fabrication',
];

const OVERRIDES = Object.freeze({
  blocked: [
    766, 779, 807, 829, 833, 838, 841, 842, 862, 868, 870, 885, 886, 956,
    985, 998, 1003, 1004, 1013, 1022, 1027, 1035, 1036, 1039, 1043, 1052,
    1066, 1076, 1080, 1092, 1101, 1115, 1122, 1132, 1135,
  ],
  notInterview: [
    768, 781, 790, 793, 797, 799, 809, 816, 824, 832, 834, 850, 855, 872,
    888, 940, 960, 967, 970, 973, 979, 982, 986, 990, 993, 996, 1006, 1018,
    1020, 1024, 1025, 1031, 1038, 1042, 1051, 1053, 1056, 1059, 1061, 1077,
    1087, 1089, 1093, 1099, 1112, 1113, 1120, 1127, 1130, 1136, 1138,
  ],
  multi: {
    782: ['jd-logistics', 'jd-tech'],
    849: ['tencent', 'bytedance'],
    853: ['jd-software', 'small-company', 'kuaishou-outsourcing'],
    865: ['baidu', 'jd', 'meituan', 'ant'],
    958: ['huawei', 'bytedance'],
    972: ['didi', 'bytedance', 'meituan', 'kuaishou'],
  },
});

const CASE_ANCHORS = Object.freeze({
  782: { 'jd-logistics': '物流', 'jd-tech': '京东科技' },
  849: { tencent: '腾讯', bytedance: '字节跳动' },
  853: { 'jd-software': '京东软件开发岗', 'small-company': '100-499小厂', 'kuaishou-outsourcing': '快手外包' },
  865: { baidu: '百度', jd: '京东', meituan: '美团', ant: '蚂蚁' },
  958: { huawei: '华为', bytedance: '字节' },
  972: { didi: '滴滴', bytedance: '字节', meituan: '美团', kuaishou: '快手' },
});

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function ghJson(args) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const run = () => {
      attempt += 1;
      execFile('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) {
          try { return resolve(JSON.parse(stdout)); } catch (parseError) { return reject(parseError); }
        }
        if (attempt < 4) return setTimeout(run, 500 * attempt);
        return reject(new Error(`${error.message}${stderr ? ` ${stderr.trim()}` : ''}`));
      });
    };
    run();
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function issueNumbers() {
  return Array.from({ length: LAST_ISSUE - FIRST_ISSUE + 1 }, (_, index) => FIRST_ISSUE + index);
}

function labelsOf(issue) {
  return (issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
}

function sourceProjection(record) {
  return (record.artifacts || []).find((artifact) => artifact.kind === 'text_projection' && artifact.provenance === 'source_projection') || null;
}

function titleOf(body) {
  return ((String(body || '').split('## 原始标题\n\n')[1] || '').split('\n\n## 原始正文')[0] || '')
    .replace(/^\s*[-*>]\s*/gm, '').trim().replace(/\n/g, ' / ');
}

function cleanText(text) {
  return String(text || '').replace(/#[^\s#]+\[话题\]#/g, '').replace(/\s+/g, ' ').trim();
}

function sourceLine(text, anchor = null, allowFallback = true) {
  const lines = String(text || '').split('\n');
  let index = anchor ? lines.findIndex((line) => line.includes(anchor)) : -1;
  if (index < 0 && allowFallback) index = lines.findIndex((line) => line.trim() && !line.trim().startsWith('#'));
  if (index < 0) return null;
  const value = lines[index].trim();
  return {
    line: index + 1,
    locator: `source-projection:artifact-line:${index + 1}`,
    excerpt: value.slice(0, 360),
  };
}

function caseEvidence(text, classification) {
  if (classification.decision !== 'multi-interview') return [];
  const anchors = CASE_ANCHORS[classification.issue_number] || {};
  return classification.case_keys.map((caseKey) => ({
    case_key: caseKey,
    anchor: anchors[caseKey] || null,
    evidence: sourceLine(text, anchors[caseKey] || null, false),
  }));
}

function classify(number, text) {
  if (OVERRIDES.blocked.includes(number)) {
    return { disposition: 'blocked', decision: null, stratum: 'insufficient-source-evidence', rationale: '当前 Source projection 无法独立证明一个可复核的 0/1/N 事件边界；保留 pending，不使用标题或 Derived 材料猜测。' };
  }
  if (OVERRIDES.notInterview.includes(number)) {
    return { disposition: 'decided', decision: 'not-interview', stratum: 'generic-or-non-event', rationale: '固定 Source projection 是题库、教程、招聘/内推、经验建议或其他非单场面试记录，未证明一个真实且有边界的候选人面试事件。' };
  }
  if (OVERRIDES.multi[number]) {
    return { disposition: 'decided', decision: 'multi-interview', stratum: 'multiple-independent-processes', case_keys: OVERRIDES.multi[number], rationale: '固定 Source projection 明确记录多个相互独立的公司/流程；按稳定 case key 分离，未把同一流程的多轮机械拆开。' };
  }

  const cleaned = cleanText(text);
  if (!cleaned) return { disposition: 'blocked', decision: null, stratum: 'empty-source-projection', rationale: '固定 Source projection 为空；标题、标签和图片存在性都不足以授权边界判定。' };
  const explicitEvent = /(面试官|面试时间|面试时长|面完|面试了|面试过|面了|约面|约的.{0,20}面试|收到.*(?:二面|三面|offer|意向)|一面\s*[:：]|二面\s*[:：]|三面\s*[:：]|四面\s*[:：]|一面\s*\d|二面\s*\d|三面\s*\d|一次面试|时间\s*[:：]|时间线|投递.*约面|手撕|自我介绍|项目拷打|拷打|反问|面试公司|面试岗位|一轮面试|技术面|HR面|线下面试|线上面试|面试感想|面试成功|面试通过|面经|凉经|凉凉|三面|二面)/i.test(cleaned);
  const generic = /(题库|真题|教程|整理|分享|建议|复习|准备|资料|面试技巧|内推|招聘|岗位职责|薪资|可分享|完整.*(?:答案|pdf)|统计出了|模拟面试|面试工具)/.test(cleaned);
  if (!explicitEvent && generic) {
    return { disposition: 'decided', decision: 'not-interview', stratum: 'generic-or-non-event', rationale: '固定 Source projection 只有通用题目/教程/招聘或建议内容，没有可定位的实际面试事件。' };
  }
  if (!explicitEvent || cleaned.length < 30) {
    return { disposition: 'blocked', decision: null, stratum: 'insufficient-source-evidence', rationale: '固定 Source projection 内容不足以独立证明一个可复核的面试事件边界；保留 pending，不以标题或标签补足。' };
  }
  return { disposition: 'decided', decision: 'single-interview', stratum: 'single-bounded-process', rationale: '固定 Source projection 含可定位的实际面试时间、流程、问答或面试官证据，且当前记录只支持一个面试流程；同流程多轮保留为一个 case。' };
}

function makeEvidence(item, classification, text) {
  classification.issue_number = item.issue_number;
  const line = sourceLine(text);
  const cases = caseEvidence(text, classification);
  const sufficient = classification.disposition === 'decided'
    && Boolean(line)
    && (classification.decision !== 'multi-interview' || cases.every((item) => item.evidence));
  return {
    schema_version: 'issue-1608-boundary-evidence.v1',
    issue_number: item.issue_number,
    issue_url: item.issue_url,
    source_note_id: item.source_note_id,
    source_revision_id: item.source_revision_id,
    source_repository: SOURCE_REPOSITORY,
    source_repository_ref: SOURCE_REF,
    evidence_status: sufficient ? 'sufficient-for-controller-review' : 'insufficient-blocked',
    decision: sufficient ? classification.decision : null,
    rationale: classification.rationale,
    artifact: {
      ref: item.artifact.ref,
      kind: item.artifact.kind,
      provenance: item.artifact.provenance,
      git_blob_sha: item.artifact.git_blob_sha,
      byte_size: item.artifact.byte_size,
      content_sha256: item.artifact.content_sha256,
    },
    excerpts: line ? [line] : [],
    case_keys: sufficient && classification.decision === 'multi-interview' ? classification.case_keys : [],
    case_evidence: sufficient && classification.decision === 'multi-interview' ? cases : [],
    checks: CHECKS.map((check_id) => ({
      check_id,
      result: sufficient || check_id !== 'event_boundary' ? 'pass' : 'fail',
      note: check_id === 'event_boundary' ? classification.rationale : 'Checked against the frozen SourceNote identity/revision and one exact Source projection artifact.',
    })),
    limitations: sufficient
      ? ['This local evidence is not a GitHub review comment; no live evidence comment was created by this run.', 'Boundary Review only determines 0/1/N and does not create InterviewNote Issues or source-ready/learning labels.']
      : ['Evidence is insufficient for a boundary transition; no body/label mutation is proposed.', 'Title, labels, OCR/Derived data, and image existence are not used to fill the missing boundary proof.'],
  };
}

function makeIntent(item, classification, evidence) {
  const transitionId = `issue-1608-boundary-${String(item.issue_number).padStart(4, '0')}-1`;
  return {
    schema_version: 'issue-1608-boundary-review-intent.v1',
    transition_id: transitionId,
    repository: REPOSITORY,
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    expected_body_sha256: item.body_sha256,
    expected_boundary_status: 'pending',
    expected_source_revision_id: item.source_revision_id,
    expected_manifest_sha256: null,
    expected_source_repository_ref: SOURCE_REF,
    decision: classification.decision,
    case_keys: classification.decision === 'multi-interview' ? classification.case_keys : [],
    evidence_file: `evidence/${String(item.issue_number).padStart(4, '0')}.json`,
    evidence_comment: { status: 'not-created', comment_id: null },
    transition_status: classification.disposition === 'decided'
      ? 'staged-awaiting-independent-live-evidence-comment'
      : 'blocked-insufficient-source-evidence',
    apply_authorization: 'controller-only; no live GitHub apply/PATCH/POST in this run',
    rationale: classification.rationale,
    evidence_locator: (evidence.excerpts[0] && evidence.excerpts[0].locator) || null,
    case_evidence: evidence.case_evidence || [],
    checks: CHECKS.map((check_id) => ({
      check_id,
      result: classification.disposition === 'decided' || check_id !== 'event_boundary' ? 'pass' : 'fail',
      note: classification.rationale,
    })),
    limitations: evidence.limitations,
  };
}

async function mapWithConcurrency(values, concurrency, worker) {
  const results = new Array(values.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results;
}

function parseArgs(argv) {
  const args = { capturedAt: null, issuesFile: null, sourceTextsFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--captured-at') args.capturedAt = argv[++index] || null;
    else if (argv[index] === '--issues-file') args.issuesFile = argv[++index] || null;
    else if (argv[index] === '--source-texts-file') args.sourceTextsFile = argv[++index] || null;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!args.capturedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(args.capturedAt)) {
    throw new Error('reproducibility requires --captured-at YYYY-MM-DDTHH:mm:ss.sssZ');
  }
  if (Number.isNaN(Date.parse(args.capturedAt))) throw new Error(`invalid --captured-at: ${args.capturedAt}`);
  if (Boolean(args.issuesFile) !== Boolean(args.sourceTextsFile)) throw new Error('--issues-file and --source-texts-file must be supplied together');
  return args;
}

async function prepare({ capturedAt, issuesFile, sourceTextsFile }) {
  const numbers = issueNumbers();
  const cachedIssues = issuesFile ? readJson(issuesFile) : null;
  if (cachedIssues) {
    if (cachedIssues.range?.first !== FIRST_ISSUE || cachedIssues.range?.last !== LAST_ISSUE) throw new Error('cached issue snapshot range drifted');
    if (JSON.stringify(cachedIssues.numbers) !== JSON.stringify(numbers)) throw new Error('cached issue snapshot enumeration drifted');
  }
  const liveIssues = cachedIssues
    ? cachedIssues.issues
    : await mapWithConcurrency(numbers, 12, async (number) => {
      const live = await ghJson(['api', `repos/${REPOSITORY}/issues/${number}`]);
      if (Number(live.number) !== number) throw new Error(`scope fail-closed: requested #${number}, received #${live.number}`);
      return live;
    });
  if (!Array.isArray(liveIssues) || liveIssues.length !== numbers.length) throw new Error('issue snapshot count mismatch');
  if (new Set(liveIssues.map((issue) => Number(issue.number))).size !== numbers.length
    || !numbers.every((number) => liveIssues.some((issue) => Number(issue.number) === number))) {
    throw new Error('issue snapshot contains a number outside or missing from the exact interval');
  }

  const selected = [];
  const rejected = [];
  for (const live of liveIssues) {
    const labels = labelsOf(live);
    const qualifies = live.state === 'open' && ALL_LABELS.every((label) => labels.includes(label));
    if (!qualifies) { rejected.push({ issue_number: live.number, state: live.state, labels }); continue; }
    const parsed = parseSourceNoteIssue(live.body || '');
    const validation = validateSourceNoteIssue({ body: live.body || '', labels, state: String(live.state).toLowerCase() });
    if (!validation.ok || !parsed.record) throw new Error(`#${live.number} SourceNote invalid: ${(validation.errors || []).join('; ')}`);
    const record = parsed.record;
    if (record.boundary_review.status !== 'pending') throw new Error(`#${live.number} is not pending in machine record`);
    if (record.source_revision.source_repository_ref !== SOURCE_REF) throw new Error(`#${live.number} source ref drifted`);
    const artifact = sourceProjection(record);
    if (!artifact || !artifact.git_blob_sha) throw new Error(`#${live.number} has no pinned source_projection text blob`);
    selected.push({
      issue_number: live.number,
      issue_url: live.html_url,
      source_note_id: record.source_note_id,
      source_id: `xhs:${record.source.external_id}`,
      source_revision_id: record.source_revision.id,
      source_repository: record.source_revision.source_repository,
      source_repository_ref: record.source_revision.source_repository_ref,
      body_sha256: sha256Text(live.body || ''),
      labels,
      title: titleOf(live.body || ''),
      artifact: { ...artifact },
      live_state: live.state,
      live_updated_at: live.updated_at,
    });
  }
  if (selected.length !== EXPECTED_PENDING_COUNT) throw new Error(`selection count mismatch: expected ${EXPECTED_PENDING_COUNT}, got ${selected.length}`);
  if (rejected.some((item) => item.issue_number >= FIRST_ISSUE && item.issue_number <= LAST_ISSUE && item.state === 'open' && item.labels.includes('boundary:pending'))) {
    throw new Error('scope selection rejected an in-range pending SourceNote unexpectedly');
  }

  const cachedSourceTexts = sourceTextsFile ? readJson(sourceTextsFile) : null;
  if (cachedSourceTexts) {
    if (cachedSourceTexts.source_repository !== SOURCE_REPOSITORY || cachedSourceTexts.source_ref !== SOURCE_REF) throw new Error('cached source snapshot ref drifted');
  }
  const sourceTexts = await mapWithConcurrency(selected, 12, async (item) => {
    const cached = cachedSourceTexts?.items?.[String(item.issue_number)];
    if (cached) {
      const bytes = Buffer.from(String(cached.text || ''), 'utf8');
      if (cached.blob_sha !== item.artifact.git_blob_sha || gitBlobSha(bytes) !== item.artifact.git_blob_sha) throw new Error(`#${item.issue_number} cached source blob verification failed`);
      return { issue_number: item.issue_number, content_sha256: sha256Text(bytes), byte_size: bytes.length, text: bytes.toString('utf8').replace(/\r\n/g, '\n') };
    }
    const blob = await ghJson(['api', `repos/${SOURCE_REPOSITORY}/git/blobs/${item.artifact.git_blob_sha}`]);
    if (blob.sha !== item.artifact.git_blob_sha || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`#${item.issue_number} source blob response mismatch`);
    const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
    if (gitBlobSha(bytes) !== item.artifact.git_blob_sha) throw new Error(`#${item.issue_number} source blob Git SHA verification failed`);
    return { issue_number: item.issue_number, content_sha256: sha256Text(bytes), byte_size: bytes.length, text: bytes.toString('utf8').replace(/\r\n/g, '\n') };
  });
  const textByIssue = new Map(sourceTexts.map((item) => [item.issue_number, item]));

  const items = [];
  const batchItems = [];
  for (const item of selected.sort((left, right) => left.issue_number - right.issue_number)) {
    const source = textByIssue.get(item.issue_number);
    item.artifact.content_sha256 = source.content_sha256;
    item.artifact.byte_size_verified = source.byte_size;
    const classification = classify(item.issue_number, source.text);
    const evidence = makeEvidence(item, classification, source.text);
    const intent = makeIntent(item, classification, evidence);
    const evidenceFile = `evidence/${String(item.issue_number).padStart(4, '0')}.json`;
    writeJson(path.join(OUTPUT_DIR, evidenceFile), evidence);
    const requestFile = `requests/${String(item.issue_number).padStart(4, '0')}.json.md`;
    writeText(path.join(OUTPUT_DIR, requestFile), `<!-- issue-1608-boundary-review-intent\n${JSON.stringify(intent, null, 2)}\n-->\n`);
    if (classification.disposition === 'decided') batchItems.push({ issue_number: item.issue_number, transition_id: intent.transition_id, request_file: requestFile });
    items.push({
      ...item,
      disposition: classification.disposition,
      decision: classification.decision,
      stratum: classification.stratum,
      rationale: classification.rationale,
      case_keys: classification.case_keys || [],
      evidence_file: evidenceFile,
      request_file: requestFile,
      evidence_status: evidence.evidence_status,
      evidence_locator: evidence.excerpts[0] ? evidence.excerpts[0].locator : null,
      evidence_excerpt_sha256: evidence.excerpts[0] ? sha256Text(evidence.excerpts[0].excerpt) : null,
    });
  }

  const counts = items.reduce((out, item) => {
    const key = item.disposition === 'blocked' ? 'blocked' : item.decision;
    out[key] = (out[key] || 0) + 1;
    return out;
  }, {});
  const selectionWithoutDigest = {
    schema_version: 'issue-1608-boundary-selection.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    scope: {
      first_issue: FIRST_ISSUE,
      last_issue: LAST_ISSUE,
      expected_pending_count: EXPECTED_PENDING_COUNT,
      membership_policy: 'open issues in the exact interval carrying type:source-note + status:captured + boundary:pending',
      no_out_of_scope_reads: true,
    },
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    captured_at: capturedAt,
    total: items.length,
    counts,
    rejected_in_range: rejected,
    items,
  };
  const selection = { ...selectionWithoutDigest, selection_sha256: sha256Text(canonicalJson(selectionWithoutDigest)) };
  writeJson(path.join(OUTPUT_DIR, 'selection.json'), selection);
  writeJson(path.join(OUTPUT_DIR, 'boundary-batch.json'), {
    schema_version: 'issue-1608-boundary-batch.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    scope: { first_issue: FIRST_ISSUE, last_issue: LAST_ISSUE, expected_count: EXPECTED_PENDING_COUNT },
    mutation_allowed: false,
    items: batchItems,
  });

  const planWithoutDigest = {
    schema_version: 'issue-1608-boundary-dry-run.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    selection_sha256: selection.selection_sha256,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    scope: { first_issue: FIRST_ISSUE, last_issue: LAST_ISSUE, total: items.length },
    mode: 'plan-only',
    mutation_allowed: false,
    live_evidence_comments_created: 0,
    mutation_count: 0,
    counts: {
      total: items.length,
      decided: items.filter((item) => item.disposition === 'decided').length,
      blocked: items.filter((item) => item.disposition === 'blocked').length,
      not_interview: items.filter((item) => item.decision === 'not-interview').length,
      single_interview: items.filter((item) => item.decision === 'single-interview').length,
      multi_interview: items.filter((item) => item.decision === 'multi-interview').length,
    },
    items: items.map((item) => ({
      issue_number: item.issue_number,
      source_note_id: item.source_note_id,
      body_sha256: item.body_sha256,
      decision: item.decision,
      status: item.disposition === 'blocked' ? 'blocked' : 'awaiting-live-evidence-comment',
      evidence_file: item.evidence_file,
      mutation: null,
      reason: item.rationale,
    })),
    fail_closed_conditions: ['selection drift', 'body/source revision drift', 'missing/duplicate/mismatched live evidence comment', 'any non-expected GitHub response', 'controller has not supplied explicit apply authorization'],
  };
  const plan = { ...planWithoutDigest, dry_run_sha256: sha256Text(canonicalJson(planWithoutDigest)) };
  writeJson(path.join(OUTPUT_DIR, 'dry-run-plan.json'), plan);

  const journalWithoutDigest = {
    schema_version: 'issue-1608-boundary-apply-journal.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    selection_sha256: selection.selection_sha256,
    dry_run_sha256: plan.dry_run_sha256,
    mode: 'not-authorized',
    mutation_allowed: false,
    entries: items.map((item) => ({ issue_number: item.issue_number, transition_id: item.disposition === 'decided' ? `issue-1608-boundary-${String(item.issue_number).padStart(4, '0')}-1` : null, status: 'not-started', mutation_performed: false, evidence_comment_id: null })),
  };
  writeJson(path.join(OUTPUT_DIR, 'apply-journal.json'), { ...journalWithoutDigest, journal_sha256: sha256Text(canonicalJson(journalWithoutDigest)) });

  const auditWithoutDigest = {
    schema_version: 'issue-1608-boundary-audit.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    selection_sha256: selection.selection_sha256,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    scope: { first_issue: FIRST_ISSUE, last_issue: LAST_ISSUE },
    checks: {
      exact_interval_enumerated: numbers.length === 373,
      pending_selection_count: items.length === EXPECTED_PENDING_COUNT,
      all_selected_labels_match: items.every((item) => ALL_LABELS.every((label) => item.labels.includes(label))),
      all_selected_source_refs_match: items.every((item) => item.source_repository_ref === SOURCE_REF),
      source_note_ids_unique: new Set(items.map((item) => item.source_note_id)).size === items.length,
      body_sha256_present: items.every((item) => /^[0-9a-f]{64}$/.test(item.body_sha256)),
      source_projection_sha_present: items.every((item) => /^[0-9a-f]{40}$/.test(item.artifact.git_blob_sha)),
      no_mutations: true,
      no_live_evidence_comments: true,
    },
    blocked_items: items.filter((item) => item.disposition === 'blocked').map((item) => ({ issue_number: item.issue_number, reason: item.rationale })),
    out_of_scope_issue_numbers_read: [],
    duplicate_ownership_check: 'deferred to controller-owned materialization phase; no InterviewNote identity is created here',
  };
  writeJson(path.join(OUTPUT_DIR, 'audit.json'), { ...auditWithoutDigest, audit_sha256: sha256Text(canonicalJson(auditWithoutDigest)) });
  console.log(JSON.stringify({ output_dir: OUTPUT_DIR, total: items.length, counts, selection_sha256: selection.selection_sha256, dry_run_sha256: plan.dry_run_sha256, mutation_count: 0 }, null, 2));
}

if (require.main === module) {
  try {
    prepare(parseArgs(process.argv.slice(2))).catch((error) => { console.error(error.stack || `ERROR: ${error.message}`); process.exitCode = 1; });
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { canonicalJson, classify, gitBlobSha, issueNumbers, sha256Text };
