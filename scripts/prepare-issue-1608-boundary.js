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
const PARENT_DEPENDENCY = Object.freeze({
  schema_version: 'issue-1605-global-pending-inventory-dependency.v1',
  parent_issue: 1605,
  source_repository: SOURCE_REPOSITORY,
  source_ref: SOURCE_REF,
  snapshot_commit: '62aa7258d9931e6453329af2586b9a1390e8e3c5',
  snapshot_path: 'data/pilot/issue-1605/pending-inventory.snapshot.json',
  snapshot_canonical_digest: '5bbf8de3dc61ed382ee31e0d0286c3e7374efec243f60b245c76ee2e0b553dfd',
  ownership_path: 'data/pilot/issue-1605/pending-inventory.ownership.json',
  ownership_canonical_digest: '86550c7f11ed133be4d48873d47fe2118d8ade305acb40ff3040e904815f38fb',
  pending_count: 1397,
  partitions: [
    { child_issue: 1606, first_issue: 20, last_issue: 392, pending_count: 327 },
    { child_issue: 1607, first_issue: 393, last_issue: 765, pending_count: 367 },
    { child_issue: 1608, first_issue: 766, last_issue: 1138, pending_count: 337 },
    { child_issue: 1609, first_issue: 1139, last_issue: 1508, pending_count: 366 },
  ],
  union: { count: 1397, pairwise_disjoint: true, equals_parent_inventory: true },
  status: 'read-only-parent-controller-dependency',
});
const PARENT_LIVE_PROGRESS = Object.freeze({
  parent_issue: 1605,
  progress_comment_id: 5586456436,
  baseline_pending_count: 1397,
  completed_boundary_rows: 419,
  remaining_boundary_pending: 978,
  authorization: {
    manifest_digest: '40fd63cccea624a567778f5c679a9e0e77b0784181de4d54cacad9873ae6c97a',
    plan_digest: '75af8bc59053022d884a845b98f12229705e03daefdcaaaa7793b36a21cf4906',
    authorization_comment_id: 5584795249,
    candidate_count: 419,
    max_mutations: 840,
    live_github_allowed: true,
    applies_to_issue_1608_remainder: false,
  },
});

const MULTI_CASE_RULES = [
  {
    match: (text) => /京东科技/.test(text) && /物流/.test(text) && /4月1日一面/.test(text),
    cases: [{ key: 'jd-logistics', anchor: '物流' }, { key: 'jd-tech', anchor: '京东科技' }],
  },
  {
    match: (text) => /上次腾讯面试/.test(text) && /字节跳动/.test(text),
    cases: [{ key: 'tencent', anchor: '腾讯' }, { key: 'bytedance', anchor: '字节跳动' }],
  },
  {
    match: (text) => /京东软件开发岗/.test(text) && /100-499小厂/.test(text) && /快手外包/.test(text),
    cases: [{ key: 'jd-software', anchor: '京东软件开发岗' }, { key: 'small-company', anchor: '100-499小厂' }, { key: 'kuaishou-outsourcing', anchor: '快手外包' }],
  },
  {
    match: (text) => /第一个是百度/.test(text) && /第二个是京东/.test(text) && /第三个是美团/.test(text) && /第四次?是今天晚上的蚂蚁/.test(text),
    cases: [{ key: 'baidu', anchor: '百度' }, { key: 'jd', anchor: '京东' }, { key: 'meituan', anchor: '美团' }, { key: 'ant', anchor: '蚂蚁' }],
  },
  {
    match: (text) => /华为面试/.test(text) && /字节二面/.test(text),
    cases: [{ key: 'huawei', anchor: '华为' }, { key: 'bytedance', anchor: '字节' }],
  },
  {
    match: (text) => /4 家共计5个 offer/.test(text) && /字节，美团，快手，滴滴/.test(text),
    cases: [{ key: 'didi', anchor: '滴滴' }, { key: 'bytedance', anchor: '字节' }, { key: 'meituan', anchor: '美团' }, { key: 'kuaishou', anchor: '快手' }],
  },
  {
    match: (text) => /上次腾讯面试完/.test(text) && /一次线上面试/.test(text),
    cases: [{ key: 'tencent', anchor: '腾讯面试完' }, { key: 'bytedance', anchor: '线上面试' }],
  },
];
const CASE_DETAIL_FROM_NEXT = new Set(['jd-software', 'small-company', 'kuaishou-outsourcing']);

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
  const labels = issue.labels && issue.labels.nodes ? issue.labels.nodes : issue.labels || [];
  return labels.map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean);
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

function sourceLine(text, anchor = null, allowFallback = true, allowHashtag = true) {
  const lines = String(text || '').split('\n');
  const usable = (line) => {
    const normalized = line.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim();
    return normalized && (allowHashtag || !normalized.startsWith('#'));
  };
  let index = anchor ? lines.findIndex((line) => line.includes(anchor) && usable(line)) : -1;
  if (index < 0 && allowFallback) index = lines.findIndex(usable);
  if (index < 0) return null;
  const value = lines[index].trim();
  return {
    line: index + 1,
    locator: `source-projection:artifact-line:${index + 1}`,
    excerpt: value.slice(0, 360),
  };
}

function nextSourceLine(text, lineNumber) {
  const lines = String(text || '').split('\n');
  for (let index = lineNumber; index < lines.length; index += 1) {
    const normalized = lines[index].replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim();
    if (normalized && !normalized.startsWith('#')) {
      return { line: index + 1, locator: `source-projection:artifact-line:${index + 1}`, excerpt: normalized.slice(0, 360) };
    }
  }
  return null;
}

function usableSourceLines(text) {
  const lines = String(text || '').split('\n');
  return lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => {
      const normalized = line.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim();
      return normalized && !normalized.startsWith('#');
    });
}

function sourceExcerpt(candidate) {
  const normalized = candidate.line.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim();
  return { line: candidate.index + 1, locator: `source-projection:artifact-line:${candidate.index + 1}`, excerpt: normalized.slice(0, 360) };
}

function titleHasInterviewExperience(title) {
  const value = String(title || '');
  if (!value || /(面试题|面试真题|题解|题型|攻略|技巧|准备|方法|三要素|岗位职责|招聘|求职|学习强度|资料|答案)/i.test(value)) return false;
  return /(一面|二面|三面|四面|终面|面经|凉经|面试记录|面试全程|面试体验|面试情况|面试结果|面试过|面试！)/i.test(value);
}

function actualEventLine(line) {
  const value = cleanText(line);
  const hasEvent = /(面试官.{0,24}(?:问|说|追问|人|好|很好|耐心|当我面)|面试完|面完|面试了|面试过|面试体验|面试过程|面试记录|面试结果|面试成功|面试通过|一面|二面|三面|四面|终面|HR面|技术面|手撕|拷打|反问|挂了|秒挂|offer|oc)/i.test(value);
  const genericOnly = /(面试官不再|面试官怎么|面试官会|一面问|二面必问|面试还是以|面试用的|面试场景题型|面试题|面试技巧|面试准备|面试方法|面试攻略)/i.test(value);
  return hasEvent && (!genericOnly || /面试完|面完|面试了|面试官.{0,24}当我面/i.test(value));
}

function substantiveQuestionLine(line) {
  const value = cleanText(line).trim();
  if (!value || /^(?:面试结果|面试情况|总结|面经|面试内容)\s*[:：]?$/u.test(value)) return false;
  if (/^\s*(?:[-*]\s*)?\d+[.、:：](?!\d)/.test(value)) {
    return !/(?:自我介绍|薪资|哪里人|期望薪资|离职原因|到岗时间|能实习多久)\s*[？?]?$/i.test(value);
  }
  if (/[？?]/.test(value)) return true;
  return /(手撕|算法题|编程题|项目拷打|项目深挖|八股|HashMap|ConcurrentHashMap|Redis|MySQL|JVM|Spring|线程池|消息队列|分布式|TCP|HTTP|RPC|SQL|Transformer|RAG|协程|限流器|链表|二叉树|滑动窗口)/i.test(value)
    && !/(整理|分享|建议|准备|复习|答案|题库|真题|教程|资料)/i.test(value);
}

function titleEvidence(title, item = null) {
  const jsonArtifact = item && (item.source_artifacts || []).find((artifact) => artifact.kind === 'json');
  return {
    line: null,
    locator: `json-pointer:/note/noteDetailMap/${item ? item.source_external_id : 'source-note'}/note/title`,
    artifact_ref: jsonArtifact ? jsonArtifact.ref : null,
    artifact_kind: 'json',
    excerpt: String(title || '').trim().slice(0, 360),
  };
}

function singleInterviewEvidenceLines(text, title = '', item = null) {
  const usable = usableSourceLines(text);
  const eventCandidates = usable.filter((candidate) => actualEventLine(candidate.line));
  const questionCandidates = usable.filter((candidate) => substantiveQuestionLine(candidate.line));
  const explicitOneInterviewOutcome = usable.find(({ line }) => /一次面试.*(?:通知\s*oc|oc|offer)/i.test(line));
  const candidates = explicitOneInterviewOutcome
    ? [explicitOneInterviewOutcome]
    : [titleHasInterviewExperience(title) ? titleEvidence(title, item) : null, eventCandidates[0], ...questionCandidates.slice(0, 2)].filter(Boolean);
  const unique = [];
  for (const candidate of candidates) {
    const excerpt = candidate.locator ? candidate : sourceExcerpt(candidate);
    if (!unique.some((item) => item.locator === excerpt.locator)) unique.push(excerpt);
  }
  if (explicitOneInterviewOutcome) return unique;
  const hasEvent = Boolean(eventCandidates.length) || titleHasInterviewExperience(title);
  return hasEvent && questionCandidates.length >= 2 ? unique : [];
}

function detectMultiCandidate(text) {
  const rule = MULTI_CASE_RULES.find((candidate) => candidate.match(text));
  if (!rule) return null;
  return {
    case_keys: rule.cases.map((item) => item.key),
    case_anchors: Object.fromEntries(rule.cases.map((item) => [item.key, item.anchor])),
  };
}

function hasCompletedInterviewFact(text) {
  const value = String(text || '');
  const completed = /(面试官|面试完|面试了|面试过|一次面试|面试流程|线下面试|线上面试|总体感觉|面试结果|面试通过|面试成功|挂了|面完|发二面|二面.*(?:挂|过)|三面.*(?:挂|过)|offer|通知\s*oc|(?:^|[\s，。！？])oc(?:$|[\s，。！？#]))/i.test(value);
  const explicitlyMissing = /(?:没有|暂无|尚未|未有|还没|没(?:有)?)[^\n。！？]{0,16}(?:面试结果|面试情况|问答内容|实际面试)/i.test(value);
  return completed && !explicitlyMissing;
}

function hasScheduledOnlySignal(text) {
  return /(预约面试|预约|约面|面试安排|待面试|投递时间|投递.*面试|明天|后天)/i.test(String(text || ''));
}

function evidenceDecisionConsistent(decision, excerpt) {
  if (decision !== 'single-interview') return decision === 'multi-interview' || decision === 'not-interview';
  const values = (Array.isArray(excerpt) ? excerpt : [excerpt]).map((item) => (item && typeof item === 'object' ? item.excerpt : item))
    .map((item) => String(item || '').replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').replace(/#[^\s#]+\[话题\]#/g, '').trim());
  if (values.length === 1) return /(面试官|面试完|面试了|面试过|一次面试)/i.test(values[0]) && !hasScheduledOnlySignal(values[0]);
  const joined = values.join('\n');
  const hasEvent = /(面试官|面试完|面试了|面试过|一次面试|一面|二面|三面|线下面试|线上面试|面试流程|总体感觉|面试结果|结果\s*[:：]|收到.*(?:二面|三面|offer|意向)|发二面|发offer|通知\s*oc|(?:^|[\s，。！？])oc(?:$|[\s，。！？#]))/i.test(joined);
  const hasQuestion = /[？?]|手撕|场景\s*[:：]|八股|介绍一下|什么|如何|为什么|区别|原理|项目|算法|线程|缓存|索引|事务|redis|mysql|spring|java|怎么做|怎么解决/i.test(joined);
  return hasEvent && hasQuestion;
}

function multiProcessDetail(evidence, detail) {
  if (!evidence || !detail) return false;
  const section = evidence.excerpt.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim();
  const detailText = detail.excerpt.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim();
  return !section.startsWith('#')
    && !detailText.startsWith('#')
    && (evidence.locator !== detail.locator
      || /(面试|提问|手撕|问|拷打|聊了|分钟|offer|一面|二面|三面|技术面|HR面)/i.test(`${section} ${detailText}`));
}

function caseEvidence(text, classification) {
  if (classification.decision !== 'multi-interview') return [];
  const anchors = classification.case_anchors || {};
  return classification.case_keys.map((caseKey) => ({
    case_key: caseKey,
    anchor: anchors[caseKey] || null,
    evidence: sourceLine(text, anchors[caseKey] || null, false, false),
  })).map((item) => ({
    ...item,
    detail_evidence: item.evidence && !CASE_DETAIL_FROM_NEXT.has(item.case_key)
      && /(面试|提问|手撕|问|拷打|聊了|分钟|offer|一面|二面|三面|技术面|HR面)/i.test(item.evidence.excerpt)
      ? item.evidence
      : item.evidence ? nextSourceLine(text, item.evidence.line) : null,
  }));
}

function classify(number, text, title = '', item = null) {
  const cleaned = cleanText(text);
  if (!cleaned) return { disposition: 'blocked', decision: null, stratum: 'empty-source-projection', rationale: '固定 Source projection 为空；标题、标签和图片存在性都不足以授权边界判定。' };
  if (/^字节的效率真的很高\s*$/u.test(cleaned)) {
    return { disposition: 'blocked', decision: null, stratum: 'evidence-decision-mismatch', rationale: '固定 Source projection 仅有弱效率描述；拒绝用其他未绑定行包装为 single-interview。' };
  }
  if (/^字节的效率真的很高\s*$/u.test(String(text || '').split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#')) || '')) {
    return { disposition: 'blocked', decision: null, stratum: 'evidence-decision-mismatch', rationale: '固定 Source projection 的首个可读 artifact 行仅是弱效率描述；拒绝用其他未绑定行包装为 single-interview。' };
  }
  const multi = detectMultiCandidate(text);
  if (multi) {
    const candidate = { ...multi, issue_number: number, decision: 'multi-interview' };
    const cases = caseEvidence(text, candidate);
    const locators = cases.map((item) => item.evidence && item.evidence.locator).filter(Boolean);
    if (cases.length !== multi.case_keys.length || cases.some((item) => !multiProcessDetail(item.evidence, item.detail_evidence)) || new Set(locators).size !== locators.length) {
      return { disposition: 'blocked', decision: null, stratum: 'multi-evidence-not-independent', rationale: '固定 Source projection 提到多个流程，但每个 case 没有独立、非 hashtag 的 artifact locator 与流程细节；保留 pending，不 materialize。' };
    }
    return { disposition: 'decided', decision: 'multi-interview', stratum: 'multiple-independent-processes', case_keys: multi.case_keys, case_anchors: multi.case_anchors, rationale: '固定 Source projection 明确记录多个相互独立的公司/流程；每个 case 均有独立 artifact locator 与流程细节，未把同一流程多轮机械拆开。' };
  }
  const titleEvent = titleHasInterviewExperience(title);
  const bodyEvent = usableSourceLines(text).some((candidate) => actualEventLine(candidate.line));
  const generic = /(题库|真题|教程|整理|分享|建议|复习|准备|资料|面试技巧|内推|招聘|岗位职责|薪资|可分享|完整.*(?:答案|pdf)|统计出了|模拟面试|面试工具|题解|攻略|学习强度|三要素|方法)/.test(`${cleaned} ${title}`);
  const questionLines = usableSourceLines(text).filter((candidate) => substantiveQuestionLine(candidate.line));
  const appointmentOnly = hasScheduledOnlySignal(cleaned);
  const completedEvent = bodyEvent || (titleEvent && questionLines.length >= 2 && !appointmentOnly)
    || /(面试完|面完|面试了|问晕|答不上|答的还可以|面试体验|面试官.*(?:问|说|追问)|收到.*(?:offer|oc|二面|三面))/i.test(cleaned);
  if (hasScheduledOnlySignal(cleaned) && !completedEvent) {
    return { disposition: 'blocked', decision: null, stratum: 'scheduled-only-source-evidence', rationale: '固定 Source projection 只有预约/投递/面试时间或排期信号，没有候选人已完成面试事件事实；保留 pending，不 materialize。' };
  }
  if (generic && !titleEvent && !bodyEvent) {
    return { disposition: 'decided', decision: 'not-interview', stratum: 'generic-or-non-event', rationale: '固定 Source projection 只有通用题目/教程/招聘或建议内容，没有可定位的实际面试事件。' };
  }
  if (!titleEvent && !bodyEvent) {
    return { disposition: 'blocked', decision: null, stratum: 'insufficient-source-evidence', rationale: '固定 Source projection 内容不足以独立证明一个可复核的面试事件边界；保留 pending，不以标题或标签补足。' };
  }
  const evidenceLines = singleInterviewEvidenceLines(text, title, item);
  const explicitOneInterviewOutcome = /一次面试.*(?:通知\s*oc|oc|offer)/i.test(cleaned);
  if (!explicitOneInterviewOutcome && (questionLines.length < 2 || evidenceLines.length < 3 || !evidenceDecisionConsistent('single-interview', evidenceLines))) {
    return { disposition: 'blocked', decision: null, stratum: 'evidence-decision-mismatch', rationale: '固定 SourceNote 虽有面试标题或事件描述，但未同时提供已完成面试事件与至少两条 substantive Q&A；拒绝用预约、结果、题目列表或营销包装为 single-interview。' };
  }
  return { disposition: 'decided', decision: 'single-interview', stratum: 'single-bounded-process', rationale: '固定 Source projection 含可定位的实际面试时间、流程、问答或面试官证据，且当前记录只支持一个面试流程；同流程多轮保留为一个 case。' };
}

function makeEvidence(item, classification, text) {
  classification.issue_number = item.issue_number;
  const rawLines = classification.decision === 'single-interview' ? singleInterviewEvidenceLines(text, item.title, item) : [];
  const lines = rawLines.map((excerpt) => excerpt.artifact_ref ? excerpt : { ...excerpt, artifact_ref: item.artifact.ref, artifact_kind: item.artifact.kind });
  const line = classification.decision === 'single-interview' ? lines[0] : sourceLine(text, null, true, false);
  const cases = caseEvidence(text, classification);
  const caseLocators = cases.map((item) => item.evidence && item.evidence.locator).filter(Boolean);
  const sufficient = classification.disposition === 'decided'
    && Boolean(line)
    && (classification.decision === 'not-interview'
      || (classification.decision === 'single-interview' && evidenceDecisionConsistent(classification.decision, lines))
      || (classification.decision === 'multi-interview'
        && cases.length === classification.case_keys.length
        && cases.every((item) => item.evidence)
        && cases.every((item) => multiProcessDetail(item.evidence, item.detail_evidence))
        && new Set(caseLocators).size === caseLocators.length));
  return {
    schema_version: 'issue-1608-boundary-evidence.v1',
    issue_number: item.issue_number,
    issue_url: item.issue_url,
    source_note_id: item.source_note_id,
    source_revision_id: item.source_revision_id,
    source_repository: SOURCE_REPOSITORY,
    source_repository_ref: SOURCE_REF,
    source_retrieval: item.source_retrieval,
    source_artifacts: item.source_artifacts || [],
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
    excerpts: classification.decision === 'single-interview' ? lines : (line ? [{ ...line, artifact_ref: item.artifact.ref, artifact_kind: item.artifact.kind }] : []),
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
    source_retrieval: item.source_retrieval,
    source_artifacts: item.source_artifacts || [],
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
  const args = { capturedAt: null, issuesFile: null, sourceTextsFile: null, cacheDir: '/tmp/xhs-note-desc-cache' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--captured-at') args.capturedAt = argv[++index] || null;
    else if (argv[index] === '--issues-file') args.issuesFile = argv[++index] || null;
    else if (argv[index] === '--source-texts-file') args.sourceTextsFile = argv[++index] || null;
    else if (argv[index] === '--cache-dir') args.cacheDir = argv[++index] || null;
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!args.capturedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(args.capturedAt)) {
    throw new Error('reproducibility requires --captured-at YYYY-MM-DDTHH:mm:ss.sssZ');
  }
  if (Number.isNaN(Date.parse(args.capturedAt))) throw new Error(`invalid --captured-at: ${args.capturedAt}`);
  return args;
}

async function prepare({ capturedAt, issuesFile, sourceTextsFile, cacheDir }) {
  const numbers = issueNumbers();
  const cachedIssues = issuesFile ? readJson(issuesFile) : null;
  const liveIssueSnapshot = issuesFile
    ? { path: path.resolve(issuesFile), sha256: sha256Text(fs.readFileSync(issuesFile, 'utf8')) }
    : null;
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
      source_external_id: record.source.external_id,
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
  if (rejected.some((item) => item.issue_number >= FIRST_ISSUE && item.issue_number <= LAST_ISSUE && item.state === 'open' && item.labels.includes('boundary:pending'))) {
    throw new Error('scope selection rejected an in-range pending SourceNote unexpectedly');
  }

  const cachedSourceTexts = sourceTextsFile ? readJson(sourceTextsFile) : null;
  const sourceArtifactSnapshot = sourceTextsFile
    ? { path: path.resolve(sourceTextsFile), sha256: sha256Text(fs.readFileSync(sourceTextsFile, 'utf8')) }
    : null;
  if (cachedSourceTexts) {
    if (cachedSourceTexts.source_repository !== SOURCE_REPOSITORY || cachedSourceTexts.source_ref !== SOURCE_REF) throw new Error('cached source snapshot ref drifted');
  }
  const sourceTexts = await mapWithConcurrency(selected, 12, async (item) => {
    const cachePath = cacheDir ? path.join(cacheDir, `${item.source_external_id}.txt`) : null;
    if (cachePath && fs.existsSync(cachePath)) {
      const bytes = fs.readFileSync(cachePath);
      if (bytes.length === 0) throw new Error(`#${item.issue_number} note-desc cache is empty: ${cachePath}`);
      const verifiedSha = gitBlobSha(bytes);
      if (bytes.length !== item.artifact.byte_size || verifiedSha !== item.artifact.git_blob_sha) {
        throw new Error(`#${item.issue_number} note-desc cache verification failed: ${cachePath}`);
      }
      return {
        issue_number: item.issue_number,
        content_sha256: sha256Text(bytes),
        byte_size: bytes.length,
        text: bytes.toString('utf8').replace(/\r\n/g, '\n'),
        artifacts: cachedSourceTexts?.items?.[String(item.issue_number)]?.artifacts || [],
        retrieval: { method: 'note-desc-cache', path: cachePath, byte_size: bytes.length, git_blob_sha: verifiedSha },
      };
    }
    const cached = cachedSourceTexts?.items?.[String(item.issue_number)];
    if (cached) {
      const bytes = Buffer.from(String(cached.text || ''), 'utf8');
      const verifiedSha = gitBlobSha(bytes);
      if (bytes.length !== item.artifact.byte_size || cached.blob_sha !== item.artifact.git_blob_sha || cached.byte_length !== bytes.length || verifiedSha !== item.artifact.git_blob_sha) throw new Error(`#${item.issue_number} cached source blob verification failed`);
      return { issue_number: item.issue_number, content_sha256: sha256Text(bytes), byte_size: bytes.length, text: bytes.toString('utf8').replace(/\r\n/g, '\n'), artifacts: cached.artifacts || [], retrieval: { method: 'frozen-source-snapshot', path: sourceTextsFile, byte_size: bytes.length, git_blob_sha: verifiedSha } };
    }
    const blob = await ghJson(['api', `repos/${SOURCE_REPOSITORY}/git/blobs/${item.artifact.git_blob_sha}`]);
    if (blob.sha !== item.artifact.git_blob_sha || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error(`#${item.issue_number} source blob response mismatch`);
    const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
    if (gitBlobSha(bytes) !== item.artifact.git_blob_sha) throw new Error(`#${item.issue_number} source blob Git SHA verification failed`);
    const verifiedSha = gitBlobSha(bytes);
    return { issue_number: item.issue_number, content_sha256: sha256Text(bytes), byte_size: bytes.length, text: bytes.toString('utf8').replace(/\r\n/g, '\n'), retrieval: { method: 'github-git-blob', path: `repos/${SOURCE_REPOSITORY}/git/blobs/${item.artifact.git_blob_sha}`, byte_size: bytes.length, git_blob_sha: verifiedSha } };
  });
  const textByIssue = new Map(sourceTexts.map((item) => [item.issue_number, item]));

  const items = [];
  const batchItems = [];
  for (const item of selected.sort((left, right) => left.issue_number - right.issue_number)) {
    const source = textByIssue.get(item.issue_number);
    item.artifact.content_sha256 = source.content_sha256;
    item.artifact.byte_size_verified = source.byte_size;
    item.source_retrieval = source.retrieval;
    item.source_artifacts = source.artifacts || [];
    const classification = classify(item.issue_number, source.text, item.title, item);
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

  for (const [relativeDirectory, keepFiles] of [
    ['evidence', new Set(items.map((item) => item.evidence_file))],
    ['requests', new Set(items.map((item) => item.request_file))],
  ]) {
    const directory = path.join(OUTPUT_DIR, relativeDirectory);
    if (!fs.existsSync(directory)) continue;
    for (const file of fs.readdirSync(directory)) {
      if (/^\d{4}\.json(?:\.md)?$/.test(file) && !keepFiles.has(`${relativeDirectory}/${file}`)) fs.unlinkSync(path.join(directory, file));
    }
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
      expected_pending_count: selected.length,
      membership_policy: 'open issues in the exact interval carrying type:source-note + status:captured + boundary:pending',
      no_out_of_scope_reads: true,
    },
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    live_issue_snapshot: liveIssueSnapshot,
    source_artifact_snapshot: sourceArtifactSnapshot,
    parent_dependency: PARENT_DEPENDENCY,
    parent_live_progress: PARENT_LIVE_PROGRESS,
    captured_at: capturedAt,
    total: items.length,
    counts,
    rejected_in_range: rejected,
    items,
  };
  const selection = { ...selectionWithoutDigest, selection_sha256: sha256Text(canonicalJson(selectionWithoutDigest)) };
  writeJson(path.join(OUTPUT_DIR, 'selection.json'), selection);
  writeJson(path.join(OUTPUT_DIR, 'parent-dependency.json'), PARENT_DEPENDENCY);
  writeJson(path.join(OUTPUT_DIR, 'boundary-batch.json'), {
    schema_version: 'issue-1608-boundary-batch.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    live_issue_snapshot: liveIssueSnapshot,
    source_artifact_snapshot: sourceArtifactSnapshot,
    parent_dependency: PARENT_DEPENDENCY,
    parent_live_progress: PARENT_LIVE_PROGRESS,
    scope: { first_issue: FIRST_ISSUE, last_issue: LAST_ISSUE, expected_count: selected.length },
    mutation_allowed: false,
    items: batchItems,
  });

  const planWithoutDigest = {
    schema_version: 'issue-1608-boundary-dry-run.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    selection_sha256: selection.selection_sha256,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    live_issue_snapshot: liveIssueSnapshot,
    source_artifact_snapshot: sourceArtifactSnapshot,
    parent_dependency: PARENT_DEPENDENCY,
    parent_live_progress: PARENT_LIVE_PROGRESS,
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
    live_issue_snapshot: liveIssueSnapshot,
    source_artifact_snapshot: sourceArtifactSnapshot,
    parent_dependency: PARENT_DEPENDENCY,
    parent_live_progress: PARENT_LIVE_PROGRESS,
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
    live_issue_snapshot: liveIssueSnapshot,
    source_artifact_snapshot: sourceArtifactSnapshot,
    parent_dependency: PARENT_DEPENDENCY,
    parent_live_progress: PARENT_LIVE_PROGRESS,
    scope: { first_issue: FIRST_ISSUE, last_issue: LAST_ISSUE },
    checks: {
      exact_interval_enumerated: numbers.length === 373,
      pending_selection_count: items.length === selected.length,
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
  console.log(JSON.stringify({ output_dir: OUTPUT_DIR, total: items.length, counts, parent_live_pending: PARENT_LIVE_PROGRESS.remaining_boundary_pending, selection_sha256: selection.selection_sha256, dry_run_sha256: plan.dry_run_sha256, mutation_count: 0 }, null, 2));
}

if (require.main === module) {
  try {
    prepare(parseArgs(process.argv.slice(2))).catch((error) => { console.error(error.stack || `ERROR: ${error.message}`); process.exitCode = 1; });
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { actualEventLine, canonicalJson, classify, evidenceDecisionConsistent, gitBlobSha, issueNumbers, sha256Text, PARENT_DEPENDENCY, PARENT_LIVE_PROGRESS, substantiveQuestionLine, titleHasInterviewExperience };
