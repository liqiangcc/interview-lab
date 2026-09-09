'use strict';

/*
 * Read-only boundary-review proposal builder for Issue #1656.
 *
 * This module intentionally stops at a reproducible proposal.  A proposal is
 * not a review receipt, an evidence comment, a transition request, or an
 * InterviewNote identity.  The only network primitive used by the CLI is
 * `gh api` GET of a frozen issue/source snapshot or Git blob.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');
const { canonicalize, sha256Text, PENDING_LABELS, SOURCE_REF } = require('./issue-1605-pending-inventory');
const { classify } = require('../prepare-issue-1608-boundary');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const ISSUE = 1656;
const PARENT_ISSUE = 1611;
const EXPECTED_PENDING_COUNT = 421;
const PER_PAGE = 100;
const MODEL = 'gpt-5.6-luna';
const REASONING_EFFORT = 'high';
const INVENTORY_FILE = 'data/pilot/issue-1656/pending-inventory.json';
const BUNDLE_SUMMARY_FILE = 'data/pilot/issue-1656/bundle-summary.json';
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const ZERO_MUTATIONS = Object.freeze({
  patch: 0,
  post: 0,
  label: 0,
  create: 0,
  mutation: 0,
});

function sha256(value) { return sha256Text(value); }

function gitBlobSha(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

function labelsOf(issue) {
  const labels = issue && issue.labels && issue.labels.nodes ? issue.labels.nodes : issue && issue.labels;
  return (Array.isArray(labels) ? labels : [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(Boolean)
    .sort();
}

function hasPendingLabels(labels) {
  const set = new Set(labels);
  return PENDING_LABELS.every((label) => set.has(label));
}

function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function sourceProjectionArtifact(record) {
  const artifacts = Array.isArray(record && record.artifacts) ? record.artifacts : [];
  return artifacts.find((artifact) => artifact.kind === 'text_projection' && artifact.provenance === 'source_projection')
    || artifacts.find((artifact) => artifact.kind === 'json' && artifact.provenance === 'source_projection')
    || null;
}

function sourceExternalId(item) {
  return String(item && (item.source_external_id || item.source_note_id || '')).replace(/^xhs-note:/, '');
}

function validateSourceProjectionArtifact(artifact, expectedExternalId = null) {
  if (!artifact || typeof artifact !== 'object') throw new Error('source projection artifact is missing');
  if (artifact.provenance !== 'source_projection') throw new Error('source projection provenance must be source_projection');
  if (artifact.kind !== 'text_projection' && artifact.kind !== 'json') throw new Error('source projection kind is invalid');
  if (artifact.repository != null && artifact.repository !== SOURCE_REPOSITORY) throw new Error('source projection repository drifted');
  if (typeof artifact.ref !== 'string') throw new Error('source projection artifact.ref is missing');
  const externalId = expectedExternalId == null ? null : String(expectedExternalId).replace(/^xhs-note:/, '');
  if (externalId === '') throw new Error('source projection external id is missing');
  const id = externalId || artifact.ref.match(/^liqiangcc\/xhs:note_(?:desc|json)\/([^/]+)\.(?:txt|json)@[0-9a-f]{40}$/)?.[1];
  if (!id) throw new Error('source projection artifact.ref path is invalid');
  const expectedPath = artifact.kind === 'text_projection' ? `liqiangcc/xhs:note_desc/${id}.txt@${SOURCE_REF}` : `liqiangcc/xhs:note_json/${id}.json@${SOURCE_REF}`;
  if (artifact.ref !== expectedPath) throw new Error(`source projection artifact.ref must be exactly ${expectedPath}`);
  return true;
}

function validateSourceProjectionArtifacts(record) {
  const artifacts = Array.isArray(record && record.artifacts) ? record.artifacts : [];
  const candidates = artifacts.filter((artifact) => artifact.provenance === 'source_projection'
    || (typeof artifact.ref === 'string' && /:note_(?:desc|json)\//.test(artifact.ref)));
  if (!candidates.length) throw new Error('no source_projection artifact');
  const externalId = record.source && record.source.external_id;
  for (const artifact of candidates) validateSourceProjectionArtifact(artifact, externalId);
  return candidates;
}

function jsonProjectionText(bytes, item) {
  let document;
  try {
    document = JSON.parse(normalizeSourceText(bytes));
  } catch (error) {
    return { text: null, title: null, error: `source projection JSON is invalid: ${error.message}` };
  }
  const externalId = sourceExternalId(item);
  const noteObject = document?.note?.noteDetailMap?.[externalId]?.note;
  if (!noteObject || typeof noteObject !== 'object') {
    return { text: null, title: null, error: `note object is missing at /note/noteDetailMap/${externalId}/note` };
  }
  if (typeof noteObject.desc !== 'string' || !noteObject.desc.trim()) {
    return { text: null, title: typeof noteObject.title === 'string' ? noteObject.title : null, error: `note.desc is missing at /note/noteDetailMap/${externalId}/note/desc` };
  }
  return {
    text: normalizeSourceText(Buffer.from(noteObject.desc, 'utf8')),
    title: typeof noteObject.title === 'string' ? noteObject.title : null,
    path: `/note/noteDetailMap/${externalId}/note/desc`,
    titlePath: `/note/noteDetailMap/${externalId}/note/title`,
  };
}

function sourceProjectionText(bytes, artifact, item) {
  if (!bytes) return { text: null, title: null, error: 'source projection content is unavailable' };
  if (artifact.kind === 'json') return jsonProjectionText(bytes, item);
  return { text: normalizeSourceText(bytes), title: null, path: null, titlePath: null };
}

function issueList(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (snapshot && Array.isArray(snapshot.issues)) return snapshot.issues;
  if (snapshot && Array.isArray(snapshot.items)) return snapshot.items;
  throw new Error('live issue snapshot must contain an issues/items array');
}

function validatePagination(snapshot, issues) {
  const errors = [];
  const pagination = snapshot && snapshot.pagination;
  if (!pagination || typeof pagination !== 'object') return ['live issue snapshot has no pagination audit'];
  const pages = Array.isArray(pagination.pages) ? pagination.pages : null;
  const pageCount = pages ? pages.length : Number(pagination.pages);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) errors.push('pagination.pages is invalid');
  if (pagination.terminal_page_short !== true) errors.push('pagination must prove a short terminal page');
  if (pages) {
    const counts = pages.map((page) => Number(page.item_count));
    if (counts.some((count) => !Number.isSafeInteger(count) || count < 0 || count > PER_PAGE)) errors.push('pagination page item_count is invalid');
    if (counts.reduce((sum, count) => sum + count, 0) !== issues.length) errors.push('pagination item counts do not equal issue snapshot count');
    if (counts.length && counts[counts.length - 1] >= PER_PAGE) errors.push('pagination terminal page is not short');
  }
  if (pageCount !== Math.ceil(issues.length / PER_PAGE)) errors.push(`pagination page count must be ${Math.ceil(issues.length / PER_PAGE)}`);
  return errors;
}

function validateIssueSnapshot(snapshot) {
  const issues = issueList(snapshot);
  const errors = [];
  if (snapshot && snapshot.repository && snapshot.repository !== REPOSITORY) errors.push('issue snapshot repository drifted');
  if (snapshot && snapshot.source_repository && snapshot.source_repository !== SOURCE_REPOSITORY) errors.push('issue snapshot source repository drifted');
  if (snapshot && snapshot.source_ref && snapshot.source_ref !== SOURCE_REF) errors.push('issue snapshot source ref drifted');
  if (snapshot && Number.isSafeInteger(snapshot.count) && snapshot.count !== issues.length) errors.push('issue snapshot count does not equal issue array length');
  errors.push(...validatePagination(snapshot, issues));
  const numbers = new Set();
  for (const issue of issues) {
    const number = Number(issue && issue.number);
    if (!Number.isSafeInteger(number) || number < 1) errors.push('issue snapshot contains an invalid issue number');
    else if (numbers.has(number)) errors.push(`issue snapshot duplicates #${number}`);
    else numbers.add(number);
  }
  return { ok: errors.length === 0, errors, issues };
}

function inventoryIndex(inventory) {
  if (!inventory || inventory.schema_version !== 'issue-1656-boundary-pending-inventory.v1') throw new Error('invalid #1656 pending inventory schema');
  if (inventory.repository !== REPOSITORY || inventory.issue !== ISSUE || inventory.parent_issue !== PARENT_ISSUE) throw new Error('#1656 inventory repository/issue/parent binding drifted');
  if (inventory.source_ref !== SOURCE_REF || inventory.source_repository !== SOURCE_REPOSITORY) throw new Error('#1656 inventory source binding drifted');
  if (inventory.scope?.total !== EXPECTED_PENDING_COUNT || inventory.items?.length !== EXPECTED_PENDING_COUNT) throw new Error('#1656 inventory must contain exactly 421 items');
  if (inventory.canonical_digest !== sha256(canonicalize(without(inventory, 'canonical_digest')))) throw new Error('#1656 inventory canonical digest mismatch');
  const byNumber = new Map();
  for (const item of inventory.items) {
    const number = Number(item.issue_number);
    if (byNumber.has(number)) throw new Error(`#${number} duplicated in #1656 inventory`);
    byNumber.set(number, item);
  }
  return { inventory, byNumber };
}

function validateBundleBinding(inventory, summary) {
  if (!summary || summary.schema_version !== 'issue-1656-boundary-plan-bundle.v1') throw new Error('missing #1656 bundle summary');
  if (summary.inventory_digest !== inventory.canonical_digest) throw new Error('#1656 bundle summary is not bound to inventory');
  for (const key of ['mutation_count', 'patch_count', 'post_count', 'label_write_count', 'interview_note_write_count']) {
    if (summary[key] !== 0) throw new Error(`#1656 bundle ${key} is not zero`);
  }
}

function selectedPendingIssues(snapshot) {
  const validation = validateIssueSnapshot(snapshot);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  const selected = validation.issues.filter((issue) => String(issue.state).toLowerCase() === 'open' && hasPendingLabels(labelsOf(issue)));
  if (selected.length !== EXPECTED_PENDING_COUNT) throw new Error(`current pending SourceNote selection must contain 421 items; got ${selected.length}`);
  return selected;
}

function parseSelectedIssue(issue, expected) {
  const labels = labelsOf(issue);
  const body = typeof issue.body === 'string' ? issue.body : '';
  const parsed = parseSourceNoteIssue(body);
  const validation = validateSourceNoteIssue({ body, labels, state: String(issue.state || '').toLowerCase() });
  if (!validation.ok || !parsed.record) throw new Error(`#${issue.number} SourceNote validation failed: ${validation.errors.join('; ')}`);
  const record = parsed.record;
  try { validateSourceProjectionArtifacts(record); }
  catch (error) { throw new Error(`#${issue.number} fail-closed: ${error.message}`); }
  const projection = sourceProjectionArtifact(record);
  const errors = [];
  if (record.boundary_review?.status !== 'pending') errors.push('boundary_review.status is not pending');
  if (record.source_revision?.source_repository_ref !== SOURCE_REF) errors.push('SourceRevision ref drifted');
  if (record.source_revision?.source_repository !== SOURCE_REPOSITORY) errors.push('SourceRevision repository drifted');
  if (!projection || !projection.git_blob_sha || !HEX40.test(projection.git_blob_sha)) errors.push('no hash-addressed source projection artifact');
  const bodySha = sha256(body);
  if (!expected) errors.push('issue is outside frozen #1656 inventory');
  else {
    if (bodySha !== expected.body_sha256) errors.push('live body SHA differs from #1656 inventory');
    if (record.source_note_id !== expected.source_note_id) errors.push('SourceNote identity differs from #1656 inventory');
    if (record.source_revision?.id !== expected.source_revision?.id) errors.push('SourceRevision differs from #1656 inventory');
  }
  if (errors.length) throw new Error(`#${issue.number} fail-closed: ${errors.join('; ')}`);
  return {
    issue_number: Number(issue.number),
    issue_url: issue.html_url || `https://github.com/${REPOSITORY}/issues/${issue.number}`,
    title: String(issue.title || ''),
    body_sha256: bodySha,
    source_note_id: record.source_note_id,
    source_revision_id: record.source_revision.id,
    source_revision: { ...record.source_revision },
    labels,
    source_projection: { ...projection },
    body,
  };
}

function sourceMap(sourceSnapshot) {
  if (!sourceSnapshot) return new Map();
  if (sourceSnapshot.source_repository && sourceSnapshot.source_repository !== SOURCE_REPOSITORY) throw new Error('source snapshot repository drifted');
  if (sourceSnapshot.source_ref && sourceSnapshot.source_ref !== SOURCE_REF) throw new Error('source snapshot ref drifted');
  const raw = Array.isArray(sourceSnapshot.items)
    ? sourceSnapshot.items
    : Object.entries(sourceSnapshot.items || {}).map(([issue_number, value]) => ({ issue_number: Number(issue_number), ...value }));
  const result = new Map();
  for (const item of raw) {
    const number = Number(item.issue_number ?? item.number);
    if (!Number.isSafeInteger(number) || result.has(number)) throw new Error('source snapshot contains invalid or duplicate issue number');
    result.set(number, item);
  }
  return result;
}

function sourceBytes(entry, artifact) {
  validateSourceProjectionArtifact(artifact);
  if (!entry) return null;
  let bytes;
  if (typeof entry.content_base64 === 'string') bytes = Buffer.from(entry.content_base64.replace(/\s/g, ''), 'base64');
  else if (typeof entry.text === 'string') bytes = Buffer.from(entry.text, 'utf8');
  else if (typeof entry.content === 'string') bytes = Buffer.from(entry.content, 'utf8');
  else return null;
  const blobSha = entry.git_blob_sha || entry.blob_sha || artifact.git_blob_sha;
  if (blobSha !== artifact.git_blob_sha || gitBlobSha(bytes) !== artifact.git_blob_sha) throw new Error('source snapshot Git blob SHA mismatch');
  if (Number.isInteger(artifact.byte_size) && bytes.length !== artifact.byte_size) throw new Error('source snapshot byte size mismatch');
  if (entry.byte_size != null && Number(entry.byte_size) !== bytes.length) throw new Error('source snapshot declared byte size mismatch');
  if (entry.content_sha256 && entry.content_sha256 !== sha256(bytes)) throw new Error('source snapshot content SHA mismatch');
  return bytes;
}

function normalizeSourceText(bytes) {
  return bytes.toString('utf8').replace(/\r\n/g, '\n');
}

function evidenceLine(blobSha, line, role) {
  const value = String(line.value || '').trim();
  if (!value) return null;
  return {
    role,
    line: line.number,
    locator: `source-projection:blob:${blobSha}:${line.path ? `${line.path}:` : ''}line-${line.number}`,
    excerpt: value.slice(0, 360),
    ...(line.path ? { projection_path: line.path } : {}),
  };
}

function linesOf(text) {
  return String(text || '').split('\n').map((value, index) => ({ number: index + 1, value }))
    .filter((line) => line.value.replace(/[\uFEFF\u200B-\u200D\u2060]/g, '').trim());
}

function cleanClassificationText(text) {
  return String(text || '').replace(/#[^\s#]+\[话题\]#/g, '').replace(/\s+/g, ' ').trim();
}

function actualEventLine(line) {
  const value = cleanClassificationText(line);
  const event = /(?:面试官.{0,24}(?:问|追问|说|当我面)|面试完|面完|面试了|面试过|面试体验|面试过程|面试记录|面试结果|面试成功|面试通过|一面|二面|三面|四面|终面|HR面|技术面|手撕|拷打|反问|挂了|秒挂|offer|oc)/i.test(value);
  const genericOnly = /(?:面试官不再|面试官怎么|面试官会|一面问|二面必问|面试还是以|面试用的|面试场景题型|面试题|面试技巧|面试准备|面试方法|面试攻略)/i.test(value);
  return event && (!genericOnly || /面试完|面完|面试了|面试官.{0,24}当我面/i.test(value));
}

function substantiveQuestionLine(line) {
  const value = cleanClassificationText(line).trim();
  if (!value || /^(?:面试结果|面试情况|总结|面经|面试内容)\s*[:：]?$/u.test(value)) return false;
  if (/^\s*(?:[-*]\s*)?\d+[.、:：](?!\d)/.test(value)) {
    return !/(?:自我介绍|薪资|哪里人|期望薪资|离职原因|到岗时间|能实习多久)\s*[？?]?$/i.test(value);
  }
  if (/[？?]/.test(value)) return true;
  return /(手撕|算法题|编程题|项目拷打|项目深挖|八股|HashMap|ConcurrentHashMap|Redis|MySQL|JVM|Spring|线程池|消息队列|分布式|TCP|HTTP|RPC|SQL|Transformer|RAG|协程|限流器|链表|二叉树|滑动窗口)/i.test(value)
    && !/(整理|分享|建议|准备|复习|答案|题库|真题|教程|资料)/i.test(value);
}

function titleHasInterviewExperience(title) {
  const value = String(title || '');
  return Boolean(value && !/(面试题|题解|题型|攻略|技巧|准备|方法|岗位职责|招聘|求职|学习强度|资料|答案)/i.test(value)
    && /(?:一面|二面|三面|四面|终面|面经|凉经|面试记录|面试全程|面试体验|面试情况|面试结果|面试过|面试！)/i.test(value));
}

function hasFirstPersonInterviewEvent(text, title) {
  const value = String(text || '');
  if (/(?:粉丝投稿|学员|综合.*投稿|高频真题|避坑指南|整理.*答案)/i.test(value)) return false;
  const event = linesOf(value).some((line) => actualEventLine(line.value));
  if (!event) return false;
  const personal = /(?:^|[\s，。！？：:、])(?:我|我的|本人|自己|我们)(?:[\s，。！？：:、]|$)|面试官.{0,24}(?:问|追问|当我面)/i.test(value);
  const datedRecord = /(?:时间线|面经|之前面的|本社招|找实习|投递)[\s\S]{0,120}(?:一面|二面|三面|四面|终面|面试)/i.test(value);
  const titleRecord = titleHasInterviewExperience(title) && /(?:一面|二面|三面|四面|终面|面经|面试)/i.test(String(title || ''));
  return personal || datedRecord || titleRecord;
}

function titleCompanyTokens(title) {
  const tokens = ['oppo', '得物', '贝壳', '字节', '腾讯', '阿里', '百度', '京东', '美团', '快手', '小红书', '华为', '滴滴', '拼多多', '抖音', '小米'];
  const value = String(title || '').toLowerCase();
  return tokens.filter((token) => value.includes(token.toLowerCase()));
}

function companyTokensIn(value) {
  const tokens = ['oppo', '得物', '贝壳', '字节', '腾讯', '阿里', '百度', '京东', '美团', '快手', '小红书', '华为', '滴滴', '拼多多', '抖音', '小米'];
  const textValue = String(value || '').toLowerCase();
  return tokens.filter((token) => textValue.includes(token.toLowerCase()));
}

function heuristicMultiClassification(text) {
  // Company names, multi-company summaries, and page metadata are candidates,
  // never evidence.  A fallback multi proposal must identify two independent
  // event/question blocks; otherwise the caller must keep the row blocked.
  const blocks = String(text || '').split(/\n\s*\n/).map((block) => linesOf(block)).filter((block) => block.length);
  const candidates = blocks.map((block, index) => {
    const event = block.find((line) => actualEventLine(line.value));
    const question = block.find((line) => substantiveQuestionLine(line.value));
    return event && question ? { key: `proposal-case-${index + 1}`, anchor: event.value.trim() } : null;
  }).filter(Boolean);
  if (candidates.length < 2) return null;
  return {
    decision: 'multi-interview', disposition: 'decided', stratum: 'independent-event-question-blocks',
    case_keys: candidates.map((candidate) => candidate.key),
    case_anchors: Object.fromEntries(candidates.map((candidate) => [candidate.key, candidate.anchor])),
    rationale: '仅在每个独立文本块同时包含已发生面试事件与 substantive question 时生成 multi proposal；公司名称本身不触发。',
  };
}

function explicitNonInterviewText(text) {
  return /(?:广告|推广|商业合作|教程|课程|教学视频|非面试|不是面试)/i.test(String(text || ''));
}

function strictMultiCases(text, classification, projectionPath = null) {
  if (classification.decision !== 'multi-interview') return [];
  const all = linesOf(text);
  const cases = (classification.case_keys || []).map((caseKey) => {
    const anchor = classification.case_anchors?.[caseKey];
    const anchorIndex = anchor ? all.findIndex((line) => line.value.includes(anchor)) : -1;
    if (anchorIndex < 0) return { case_key: caseKey, evidence: [] };
    const nextIndexes = (classification.case_keys || []).map((key) => {
      if (key === caseKey) return -1;
      const nextAnchor = classification.case_anchors?.[key];
      return nextAnchor ? all.findIndex((line, index) => index > anchorIndex && line.value.includes(nextAnchor)) : -1;
    }).filter((index) => index > anchorIndex);
    const end = nextIndexes.length ? Math.min(...nextIndexes) : all.length;
    const window = all.slice(anchorIndex, Math.min(end, anchorIndex + 10));
    const event = window.find((line) => actualEventLine(line.value));
    const question = window.find((line) => substantiveQuestionLine(line.value));
    return {
      case_key: caseKey,
      evidence: [event, question].filter(Boolean).map((line, index) => evidenceLine(null, projectionPath ? { ...line, path: projectionPath } : line, index === 0 ? 'case-event' : 'substantive-question')),
    };
  });
  const locators = cases.flatMap((candidate) => candidate.evidence.map((evidence) => `${evidence.line}:${evidence.excerpt}`));
  return cases.length >= 2 && cases.every((candidate) => candidate.evidence.length >= 2) && new Set(locators).size === locators.length ? cases : [];
}

function proposalFromClassification(item, text, issue735 = false, projectionError = null, projectionPath = null) {
  const allLines = linesOf(text);
  const usable = allLines.filter((line) => !line.value.trim().startsWith('#'));
  const withPath = (line) => line && projectionPath ? { ...line, path: projectionPath } : line;
  const evidence = (line, role) => evidenceLine(item.source_projection.git_blob_sha, withPath(line), role);
  if (issue735) {
    return {
      proposal: { decision: null, case_count: 0, cases: [], basis: 'issue-735-independent-review-required' },
      status: 'independent-review-required', rationale: '#735 独立标记：必须由人工/AI 复核确认至少两个各自可定位的合法 case；启发式候选不升级为 multi-interview。',
      lineEvidence: usable.slice(0, 4).map((line, index) => evidence(line, index === 0 ? 'context' : 'candidate')).filter(Boolean),
    };
  }
  if (projectionError) {
    return {
      proposal: { decision: null, case_count: 0, cases: [], basis: 'blocked-source-projection' },
      status: 'blocked-proposal', rationale: projectionError, lineEvidence: [],
    };
  }
  const sourceItem = { ...item, artifact: item.source_projection, source_artifacts: [item.source_projection] };
  const classificationTitle = item.source_title || item.title;
  let classification = text ? classify(item.issue_number, text, classificationTitle, sourceItem) : {
    disposition: 'blocked', decision: null, stratum: 'missing-source-snapshot', rationale: '固定 source projection 内容未提供或未能通过 blob 校验。',
  };
  const eventLineCount = linesOf(text).filter((line) => actualEventLine(line.value)).length;
  const processCompanies = [...new Set([...titleCompanyTokens(classificationTitle), ...companyTokensIn(text)])];
  const sameProcessRounds = /(?:[0-9一二三四五六七八九十两]+)\s*(?:面|轮)/i.test(String(classificationTitle || ''))
    || (eventLineCount >= 2 && processCompanies.length === 1);
  const heuristicMulti = text ? heuristicMultiClassification(text) : null;
  if (heuristicMulti && !sameProcessRounds) classification = heuristicMulti;
  if (classification.decision === 'multi-interview' && sameProcessRounds) {
    classification = {
      disposition: 'decided', decision: 'single-interview', stratum: 'single-process-multiple-rounds',
      rationale: '标题/正文记录的是同一 process 的多轮面试；多轮不拆分为 multi case，仍需单一流程的事件与 substantive Q&A。',
    };
  }
  const actualEvents = usable.filter((line) => actualEventLine(line.value));
  const substantiveQuestions = usable.filter((line) => substantiveQuestionLine(line.value));
  const explicitSingleEvent = actualEvents.length > 0 && hasFirstPersonInterviewEvent(text, classificationTitle);
  if (classification.decision === 'multi-interview') {
    const cases = strictMultiCases(text, classification, projectionPath);
    if (cases.length < 2) classification = { disposition: 'blocked', decision: null, stratum: 'multi-evidence-not-independent', rationale: '公司 token、营销/metadata 或同一流程多轮不足以形成 multi；每个 case 必须有独立已发生事件、substantive question 和不重复 locator。' };
    else classification._strictCases = cases;
  }
  if (classification.decision === 'single-interview' && (!explicitSingleEvent || substantiveQuestions.length < 1)) {
    classification = { disposition: 'blocked', decision: null, stratum: 'single-evidence-not-substantive', rationale: '未同时发现明确已完成/正在进行的个人面试事件与 substantive Q&A；建议、题库、招聘、总结和泛化描述保留 pending。' };
  }
  if (classification.decision === 'not-interview' && !explicitNonInterviewText(text)) {
    classification = { disposition: 'blocked', decision: null, stratum: 'generic-evidence-only', rationale: '通用问题、建议、题库、招聘或总结不是明确的非面试/广告/教程证据；保留 pending。' };
  }
  const base = {
    proposal: { decision: classification.decision, case_count: 0, cases: [], basis: classification.stratum || 'unclassified' },
    status: classification.decision ? 'proposal-only' : 'blocked-proposal',
    rationale: classification.rationale || 'insufficient source evidence',
    lineEvidence: [],
  };
  if (!classification.decision) {
    base.lineEvidence = usable.slice(0, 4).map((line, index) => evidence(line, index === 0 ? 'context' : 'candidate')).filter(Boolean);
    return base;
  }
  if (classification.decision === 'multi-interview') {
    const cases = classification._strictCases.map((candidate) => ({ ...candidate, evidence: candidate.evidence.map((line) => ({ ...line, locator: line.locator.replace('blob:null:', `blob:${item.source_projection.git_blob_sha}:`) })) }));
    base.proposal.case_count = cases.length;
    base.proposal.cases = cases;
    base.lineEvidence = cases.flatMap((candidate) => candidate.evidence);
    return base;
  }
  base.lineEvidence = usable.slice(0, classification.decision === 'not-interview' ? 2 : 4)
    .map((line, index) => evidence(line, index === 0 ? 'boundary' : 'supporting')).filter(Boolean);
  if (!base.lineEvidence.length) {
    base.proposal.decision = null;
    base.status = 'blocked-proposal';
    base.rationale = '启发式结果没有非空 source-projection line evidence；保留 pending。';
  }
  return base;
}

function buildItem(item, sourceEntry, issue735 = false) {
  const artifact = item.source_projection;
  const bytes = sourceBytes(sourceEntry, artifact);
  const projection = bytes ? sourceProjectionText(bytes, artifact, item) : { text: null, title: null, error: 'source projection content is unavailable' };
  const sourceText = projection.text;
  const sourceProjection = {
    ref: artifact.ref,
    kind: artifact.kind,
    provenance: artifact.provenance,
    blob_sha: artifact.git_blob_sha,
    source_projection_blob_sha: artifact.git_blob_sha,
    byte_size: artifact.byte_size,
    byte_size_verified: bytes ? bytes.length : null,
    content_sha256: bytes ? sha256(bytes) : null,
    line_count: sourceText ? sourceText.split('\n').length : null,
    retrieval: bytes ? (sourceEntry?.retrieval || 'provided-source-snapshot') : (sourceEntry?.status === 'blocked' ? 'blocked-source-read' : 'missing-source-snapshot'),
    ...(projection.path ? { content_path: projection.path } : {}),
    ...(projection.title != null ? { source_title: projection.title } : {}),
    ...(projection.error ? { content_error: projection.error } : {}),
    ...(sourceEntry?.error ? { source_error: sourceEntry.error } : {}),
  };
  const proposal = proposalFromClassification({ ...item, source_title: projection.title }, sourceText, issue735, projection.error, projection.path);
  const review = {
    status: proposal.status,
    durable_review: false,
    evidence_comment: { status: 'not-created', comment_id: null },
    transition_id: null,
    formal_evidence_post_allowed: false,
  };
  return {
    schema_version: 'issue-1656-boundary-review-proposal.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    parent_issue: PARENT_ISSUE,
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    body_sha256: item.body_sha256,
    source_revision_id: item.source_revision_id,
    source_revision: {
      id: item.source_revision_id,
      source_repository: SOURCE_REPOSITORY,
      source_repository_ref: SOURCE_REF,
    },
    source_repository_ref: SOURCE_REF,
    source_projection: sourceProjection,
    source_projection_blob_sha: sourceProjection.source_projection_blob_sha,
    line_evidence: proposal.lineEvidence,
    proposal: proposal.proposal,
    decision: proposal.proposal.decision,
    review,
    rationale: proposal.rationale,
    mutation_guard: { ...ZERO_MUTATIONS, read_only: true, live_mutation: false },
  };
}

function buildReviewPlan({ issueSnapshot, sourceSnapshot = null, inventory: suppliedInventory = null, bundleSummary: suppliedSummary = null, capturedAt = null }) {
  const snapshotValidation = validateIssueSnapshot(issueSnapshot);
  if (!snapshotValidation.ok) return blockedPlan(snapshotValidation.errors, capturedAt);
  let inventoryBinding;
  try {
    const inventory = suppliedInventory || readJson(INVENTORY_FILE);
    const summary = suppliedSummary || readJson(BUNDLE_SUMMARY_FILE);
    inventoryBinding = inventoryIndex(inventory);
    validateBundleBinding(inventory, summary);
  } catch (error) {
    return blockedPlan([error.message], capturedAt);
  }
  let selected;
  try { selected = selectedPendingIssues(issueSnapshot); }
  catch (error) { return blockedPlan([error.message], capturedAt); }
  const selectedByNumber = new Map();
  try {
    for (const issue of selected) {
      const number = Number(issue.number);
      selectedByNumber.set(number, parseSelectedIssue(issue, inventoryBinding.byNumber.get(number)));
    }
  } catch (error) {
    return blockedPlan([error.message], capturedAt);
  }
  const inventoryNumbers = [...inventoryBinding.byNumber.keys()].sort((a, b) => a - b);
  const selectedNumbers = [...selectedByNumber.keys()].sort((a, b) => a - b);
  if (canonicalize(inventoryNumbers) !== canonicalize(selectedNumbers)) return blockedPlan(['current pending issue set differs from #1656 frozen inventory'], capturedAt);
  const sources = sourceMap(sourceSnapshot);
  let items;
  try {
    items = inventoryNumbers.map((number) => buildItem(selectedByNumber.get(number), sources.get(number), number === 735));
  } catch (error) {
    return blockedPlan([`source snapshot tamper detected: ${error.message}`], capturedAt);
  }
  const proposalCounts = { single_interview: 0, multi_interview: 0, not_interview: 0, blocked: 0 };
  for (const item of items) {
    const decision = item.proposal.decision;
    if (decision === 'single-interview') proposalCounts.single_interview += 1;
    else if (decision === 'multi-interview') proposalCounts.multi_interview += 1;
    else if (decision === 'not-interview') proposalCounts.not_interview += 1;
    else proposalCounts.blocked += 1;
  }
  const sourceSnapshotDigest = sha256(canonicalize(items.map((item) => ({
    issue_number: item.issue_number,
    ref: item.source_projection.ref,
    blob_sha: item.source_projection.blob_sha,
    byte_size: item.source_projection.byte_size_verified,
    content_sha256: item.source_projection.content_sha256,
  }))));
  const sourceSnapshotComplete = items.every((item) => item.source_projection.byte_size_verified !== null
    && HEX64.test(String(item.source_projection.content_sha256 || '')));
  const sourceSnapshotErrors = items.filter((item) => item.source_projection.byte_size_verified === null || !item.source_projection.content_sha256)
    .map((item) => `#${item.issue_number} source projection content is missing or blocked`);
  const recordedSourceErrors = Array.isArray(sourceSnapshot?.errors)
    ? sourceSnapshot.errors.map((error) => `#${error.issue_number} source projection GET blocked: ${error.message || error.code || 'unknown error'}`)
    : [];
  const planWithoutDigest = {
    schema_version: 'issue-1656-dynamic-boundary-review-plan.v1',
    repository: REPOSITORY,
    issue: ISSUE,
    parent_issue: PARENT_ISSUE,
    upstream_issue: 1605,
    source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF, digest: sourceSnapshotDigest, complete: sourceSnapshotComplete },
    live_issue_snapshot: {
      schema_version: issueSnapshot.schema_version || null,
      count: issueSnapshot.count,
      issue_count: snapshotValidation.issues.length,
      pagination: issueSnapshot.pagination,
    },
    inventory_digest: inventoryBinding.inventory.canonical_digest,
    captured_at: capturedAt,
    reviewer_model: { model: MODEL, reasoning_effort: REASONING_EFFORT, fast_mode: false },
    mode: 'proposal-only',
    ok: sourceSnapshotComplete,
    ...((sourceSnapshotErrors.length || recordedSourceErrors.length) ? { errors: [...new Set([...sourceSnapshotErrors, ...recordedSourceErrors])] } : {}),
    authorization: {
      durable_review: false,
      evidence_post: false,
      boundary_transition: false,
      live_github_mutation: false,
    },
    mutation_guard: { ...ZERO_MUTATIONS, read_only: true, live_mutation: false },
    scope: { boundary_label: 'boundary:pending', total: items.length, complete: items.length === EXPECTED_PENDING_COUNT },
    summary: { total: items.length, pending: items.length, ...proposalCounts, proposal_only: items.length, durable_reviews: 0 },
    items,
    fail_closed_conditions: [
      'issue snapshot count/pagination/selection drift',
      'issue body SHA, SourceNote identity, or SourceRevision drift',
      'source ref, source projection blob SHA, byte size, or content SHA drift',
      'missing line evidence for a proposed decision',
      '#735 lacks independent >=2-case evidence',
      'any attempt to treat this proposal as durable review or transition authorization',
    ],
  };
  return { ...planWithoutDigest, canonical_digest: sha256(canonicalize(planWithoutDigest)) };
}

function blockedPlan(errors, capturedAt = null) {
  const planWithoutDigest = {
    schema_version: 'issue-1656-dynamic-boundary-review-plan.v1',
    repository: REPOSITORY, issue: ISSUE, parent_issue: PARENT_ISSUE, upstream_issue: 1605,
    captured_at: capturedAt, mode: 'proposal-only', ok: false, errors,
    authorization: { durable_review: false, evidence_post: false, boundary_transition: false, live_github_mutation: false },
    mutation_guard: { ...ZERO_MUTATIONS, read_only: true, live_mutation: false },
    scope: { boundary_label: 'boundary:pending', total: 0, complete: false },
    summary: { total: 0, pending: 0, single_interview: 0, multi_interview: 0, not_interview: 0, blocked: 0, proposal_only: 0, durable_reviews: 0 },
    items: [],
  };
  return { ...planWithoutDigest, canonical_digest: sha256(canonicalize(planWithoutDigest)) };
}

function validateReviewPlan(plan, inventory = null) {
  const errors = [];
  if (!plan || plan.schema_version !== 'issue-1656-dynamic-boundary-review-plan.v1') errors.push('plan schema mismatch');
  if (plan?.repository !== REPOSITORY || plan?.issue !== ISSUE || plan?.parent_issue !== PARENT_ISSUE) errors.push('plan repository/issue/parent binding drifted');
  if (plan?.mode !== 'proposal-only') errors.push('plan mode is not proposal-only');
  if (plan?.ok === false) errors.push('plan is fail-closed and cannot be accepted as complete');
  if (plan?.reviewer_model?.model !== MODEL || plan?.reviewer_model?.reasoning_effort !== REASONING_EFFORT || plan?.reviewer_model?.fast_mode !== false) errors.push('plan reviewer model is not gpt-5.6-luna high non-fast');
  if (plan && plan.canonical_digest !== sha256(canonicalize(without(plan, 'canonical_digest')))) errors.push('plan canonical_digest does not match content');
  for (const key of Object.keys(ZERO_MUTATIONS)) if (plan?.mutation_guard?.[key] !== 0) errors.push(`plan mutation_guard.${key} must be zero`);
  if (plan?.mutation_guard?.read_only !== true || plan?.mutation_guard?.live_mutation !== false) errors.push('plan mutation guard is not read-only');
  if (plan?.authorization?.durable_review !== false || plan?.authorization?.evidence_post !== false || plan?.authorization?.boundary_transition !== false || plan?.authorization?.live_github_mutation !== false) errors.push('plan authorization is not proposal-only');
  const items = Array.isArray(plan?.items) ? plan.items : [];
  if (items.length !== EXPECTED_PENDING_COUNT || plan?.scope?.total !== EXPECTED_PENDING_COUNT || plan?.scope?.complete !== true) errors.push('plan does not contain the complete 421-item scope');
  const numbers = new Set();
  for (const item of items) {
    const number = Number(item.issue_number);
    if (numbers.has(number)) errors.push(`plan duplicates #${number}`);
    numbers.add(number);
    if (item.source_repository_ref !== SOURCE_REF || item.source_revision?.source_repository_ref !== SOURCE_REF) errors.push(`#${number} source ref drifted`);
    if (!HEX64.test(String(item.body_sha256 || '')) || !item.source_revision_id) errors.push(`#${number} body/SourceRevision binding missing`);
    try { validateSourceProjectionArtifact(item.source_projection, item.source_note_id); }
    catch (error) { errors.push(`#${number} source projection artifact binding invalid: ${error.message}`); }
    if (!HEX40.test(String(item.source_projection_blob_sha || ''))) errors.push(`#${number} source projection blob SHA missing`);
    if (!Number.isInteger(item.source_projection?.byte_size_verified) || !HEX64.test(String(item.source_projection?.content_sha256 || ''))) errors.push(`#${number} source projection content is not verified`);
    if (!Array.isArray(item.line_evidence)) errors.push(`#${number} line evidence is not an array`);
    if (item.review?.durable_review !== false || item.review?.evidence_comment?.comment_id !== null || item.review?.transition_id !== null) errors.push(`#${number} contains durable review state`);
    if (item.mutation_guard?.mutation !== 0 || item.mutation_guard?.read_only !== true) errors.push(`#${number} item mutation guard drifted`);
    if (item.proposal?.decision === 'multi-interview' && Number(item.proposal.case_count) < 2) errors.push(`#${number} multi proposal has fewer than two cases`);
  }
  const issue735 = items.find((item) => Number(item.issue_number) === 735);
  if (!issue735 || issue735.proposal?.decision !== null || issue735.review?.status !== 'independent-review-required') errors.push('#735 is not independently marked');
  if (inventory) {
    try {
      const expected = inventoryIndex(inventory).byNumber;
      if (expected.size !== numbers.size || [...expected.keys()].some((number) => !numbers.has(number))) errors.push('plan issue set differs from inventory');
    } catch (error) { errors.push(`inventory validation failed: ${error.message}`); }
  }
  return { ok: errors.length === 0, errors };
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
        if (attempt < 6) return setTimeout(run, 750 * attempt);
        return reject(new Error(`${error.message}${stderr ? ` ${stderr.trim()}` : ''}`));
      });
    };
    run();
  });
}

async function fetchSourceBlob(artifact) {
  const blob = await ghJson(['api', `repos/${SOURCE_REPOSITORY}/git/blobs/${artifact.git_blob_sha}`]);
  if (blob.sha !== artifact.git_blob_sha || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('source blob response mismatch');
  const bytes = Buffer.from(blob.content.replace(/\s/g, ''), 'base64');
  if (gitBlobSha(bytes) !== artifact.git_blob_sha) throw new Error('source blob Git SHA verification failed');
  return bytes;
}

function sourceSnapshotCanonicalDigest(snapshot) {
  const items = Object.values(snapshot?.items || {}).sort((left, right) => Number(left.issue_number) - Number(right.issue_number));
  return sha256(canonicalize({
    schema_version: snapshot?.schema_version || 'issue-1656-source-projection-snapshot.v1',
    source_repository: snapshot?.source_repository,
    source_ref: snapshot?.source_ref,
    items: items.map((item) => ({
      issue_number: item.issue_number,
      status: item.status || (item.content_base64 ? 'verified' : 'blocked'),
      git_blob_sha: item.git_blob_sha,
      byte_size: item.byte_size ?? null,
      content_sha256: item.content_sha256 || null,
      error: item.error || null,
    })),
    errors: snapshot?.errors || [],
  }));
}

function cacheCandidates(cacheDir, item) {
  if (!cacheDir) return [];
  const externalId = sourceExternalId(item);
  if (!externalId) return [];
  const kind = item.source_projection?.kind;
  const extensions = kind === 'json' ? ['.json', '.txt'] : ['.txt', '.json'];
  return extensions.map((extension) => path.join(cacheDir, `${externalId}${extension}`));
}

function verifiedCachedBytes(file, expectedSha, expectedSize) {
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expectedSize || gitBlobSha(bytes) !== expectedSha) return null;
    return bytes;
  } catch (error) {
    return null;
  }
}

async function retrySourceFetch(fetcher, artifact, maxAttempts, retryDelayMs) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await fetcher(artifact);
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (bytes.length !== artifact.byte_size || gitBlobSha(bytes) !== artifact.git_blob_sha) throw new Error('source blob byte size or Git SHA verification failed');
      return { bytes, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  const error = new Error(lastError ? lastError.message : 'source blob fetch failed');
  error.attempts = maxAttempts;
  throw error;
}

async function fetchSourceSnapshotForPlan(plan, fetcher = fetchSourceBlob, options = {}) {
  const maxAttempts = Number.isSafeInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 3;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0 ? options.retryDelayMs : 250;
  const cacheDir = options.cacheDir || null;
  const items = {};
  const errors = [];
  let cursor = 0;
  const work = async () => {
    while (cursor < plan.items.length) {
      const item = plan.items[cursor++];
      const gitBlob = item.source_projection.blob_sha || item.source_projection.git_blob_sha;
      const byteSize = item.source_projection.byte_size;
      let cacheStatus = cacheDir ? 'miss' : 'disabled';
      let cachedBytes = null;
      for (const candidate of cacheCandidates(cacheDir, item)) {
        if (!fs.existsSync(candidate)) continue;
        const candidateBytes = verifiedCachedBytes(candidate, gitBlob, byteSize);
        if (candidateBytes) {
          cachedBytes = candidateBytes;
          cacheStatus = 'hit';
          break;
        }
        cacheStatus = 'invalid';
      }
      if (cachedBytes) {
        items[String(item.issue_number)] = {
          issue_number: item.issue_number, status: 'verified', retrieval: 'local-cache',
          git_blob_sha: gitBlob, byte_size: cachedBytes.length, content_sha256: sha256(cachedBytes),
          content_base64: cachedBytes.toString('base64'), cache_status: cacheStatus,
        };
        continue;
      }
      try {
        const result = await retrySourceFetch(fetcher, { git_blob_sha: gitBlob, byte_size: byteSize }, maxAttempts, retryDelayMs);
        const bytes = result.bytes;
        items[String(item.issue_number)] = {
          issue_number: item.issue_number, status: 'verified', retrieval: 'github-git-blob',
          git_blob_sha: gitBlob, byte_size: bytes.length, content_sha256: sha256(bytes),
          content_base64: bytes.toString('base64'), attempts: result.attempts, cache_status: cacheStatus,
        };
      } catch (error) {
        const blocked = {
          issue_number: item.issue_number, status: 'blocked', retrieval: 'github-git-blob-blocked',
          git_blob_sha: gitBlob, byte_size: byteSize, content_sha256: null, content_base64: null,
          cache_status: cacheStatus,
          error: { code: 'source-blob-read-failed', message: error.message, attempts: error.attempts || maxAttempts },
        };
        items[String(item.issue_number)] = blocked;
        errors.push({ issue_number: item.issue_number, ...blocked.error, cache_status: cacheStatus });
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, work));
  const snapshot = { schema_version: 'issue-1656-source-projection-snapshot.v1', source_repository: SOURCE_REPOSITORY, source_ref: SOURCE_REF, retry_policy: { max_attempts: maxAttempts, retry_delay_ms: retryDelayMs }, cache_policy: { mode: cacheDir ? 'cache-first-read-only' : 'disabled', directory: cacheDir }, items, errors: errors.sort((left, right) => left.issue_number - right.issue_number) };
  return { ...snapshot, canonical_digest: sourceSnapshotCanonicalDigest(snapshot) };
}

module.exports = {
  REPOSITORY, SOURCE_REPOSITORY, SOURCE_REF, ISSUE, PARENT_ISSUE, EXPECTED_PENDING_COUNT, MODEL, REASONING_EFFORT,
  ZERO_MUTATIONS, canonicalize, sha256, gitBlobSha, sourceProjectionArtifact, validateSourceProjectionArtifact, validateSourceProjectionArtifacts, sourceProjectionText, sourceSnapshotCanonicalDigest, validateIssueSnapshot, inventoryIndex,
  selectedPendingIssues, parseSelectedIssue, sourceMap, sourceBytes, linesOf, proposalFromClassification, buildItem,
  heuristicMultiClassification, buildReviewPlan, blockedPlan, fetchSourceBlob, fetchSourceSnapshotForPlan,
  validateReviewPlan,
};
