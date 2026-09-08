#!/usr/bin/env node
'use strict';

/*
 * Issue #1609 is a plan/evidence producer.  It deliberately has no apply
 * mode: the existing guarded transition runner remains the only live
 * mutation path, and applying this batch requires an explicit controller
 * decision outside this command.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./lib/source-note-issue');
const { validateTransitionRequest } = require('./lib/source-note-boundary-review-transition');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const ISSUE = 1609;
const MIN_ISSUE = 1139;
const MAX_ISSUE = 1508;
const RANGE_COUNT = MAX_ISSUE - MIN_ISSUE + 1;
const EXPECTED_RANGE_COUNT = 366;
const REVIEWED_AT = '2026-09-08T00:00:00.000Z';
const PLACEHOLDER_COMMENT_BASE = 1609000000;
const DEFAULT_DESC_CACHE = '/tmp/xhs-note-desc-cache';
const REQUIRED_LABELS = ['type:source-note', 'status:captured', 'boundary:pending'];
const CHECKS = [
  ['source_identity', 'SourceNote identity matches the live machine record.'],
  ['source_revision_binding', 'SourceRevision and source repository ref match the frozen snapshot.'],
  ['source_content_coverage', 'The cited Raw or source_projection artifact is exact and hash-verified.'],
  ['event_boundary', 'The disposition is supported by the cited source evidence.'],
  ['no_cross_source_mixing', 'This item cites only evidence belonging to this SourceNote.'],
  ['no_fabrication', 'No Raw, Derived, or InterviewNote content is invented or overwritten.'],
];
const PROVENANCE = new Set(['raw_capture', 'raw_dom_snapshot', 'raw_context_capture', 'source_projection']);
const COMPANY_CASES = [
  ['阿里', 'alibaba'], ['字节', 'bytedance'], ['腾讯', 'tencent'], ['美团', 'meituan'],
  ['京东', 'jd'], ['小米', 'xiaomi'], ['百度', 'baidu'], ['快手', 'kuaishou'],
  ['滴滴', 'didi'], ['携程', 'ctrip'], ['华为', 'huawei'], ['网易', 'netease'],
  ['拼多多', 'pinduoduo'], ['得物', 'dewuu'], ['贝壳找房', 'ke-house'], ['OPPO', 'oppo'],
  ['虾皮', 'shopee'], ['小红书', 'xiaohongshu'], ['懂车帝', 'dongchedi'],
];

function sha256(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function sha1GitBlob(bytes) {
  return crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(value, null, 2)}\n`);
}
function clearGeneratedJsonFiles(directory) {
  fs.mkdirSync(path.resolve(directory), { recursive: true });
  for (const file of fs.readdirSync(path.resolve(directory)).filter((name) => name.endsWith('.json'))) {
    fs.unlinkSync(path.join(path.resolve(directory), file));
  }
}
function labelsOf(issue) {
  return (issue.labels || []).map((label) => typeof label === 'string' ? label : label && label.name).filter(Boolean).sort();
}
function parseArgs(argv = process.argv.slice(2)) {
  const out = { mode: null, output: null, selection: null, evidence: null, source: null, requests: null, receipts: null, journal: null, ambiguityAudit: null, sourceSnapshot: null, descCache: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') out.mode = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--selection') out.selection = argv[++i];
    else if (arg === '--evidence-dir') out.evidence = argv[++i];
    else if (arg === '--source-inventory') out.source = argv[++i];
    else if (arg === '--requests-dir') out.requests = argv[++i];
    else if (arg === '--receipts-dir') out.receipts = argv[++i];
    else if (arg === '--journal') out.journal = argv[++i];
    else if (arg === '--ambiguity-audit') out.ambiguityAudit = argv[++i];
    else if (arg === '--source-snapshot') out.sourceSnapshot = argv[++i];
    else if (arg === '--desc-cache') out.descCache = argv[++i];
    else if (arg === '--apply' || arg === '--confirm-dry-run' || arg === '--gate-proof') throw new Error('Issue #1609 producer is plan-only; live apply is controller-authorized and disabled here');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['freeze', 'evidence', 'plan', 'digest'].includes(out.mode)) throw new Error('--mode must be freeze, evidence, plan, or digest');
  if (!out.output) throw new Error('--output is required');
  if (out.mode !== 'freeze' && !out.selection) throw new Error('--selection is required');
  if (out.mode === 'evidence' && (!out.evidence || !out.requests || !out.receipts || !out.journal || !out.ambiguityAudit)) throw new Error('evidence mode requires --evidence-dir, --requests-dir, --receipts-dir, --journal, and --ambiguity-audit');
  if (out.mode === 'digest' && (!out.evidence || !out.requests || !out.receipts || !out.journal || !out.ambiguityAudit || !out.source)) throw new Error('digest mode requires --source-inventory, --evidence-dir, --requests-dir, --receipts-dir, --journal, and --ambiguity-audit');
  return out;
}
function ghJson(args) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const raw = execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 60000 });
      return JSON.parse(raw);
    } catch (error) {
      lastError = error;
      const message = String(error && error.message || error);
      const transient = /TLS handshake timeout|timed? ?out|EOF|temporarily unavailable|connection reset|connection refused|HTTP 429|HTTP 502|HTTP 503|HTTP 504/i.test(message);
      if (!transient || attempt === 5) throw error;
      const waitMs = attempt * 1000;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
    }
  }
  throw lastError;
}
function fetchExactIssueRange() {
  const issues = [];
  const chunkSize = 50;
  for (let start = MIN_ISSUE; start <= MAX_ISSUE; start += chunkSize) {
    const end = Math.min(MAX_ISSUE, start + chunkSize - 1);
    const fields = [];
    for (let n = start; n <= end; n += 1) fields.push(`i${n}: issue(number: ${n}) { number url title state body labels(first: 100) { nodes { name } } }`);
    const query = `query { repository(owner: "liqiangcc", name: "interview-lab") { ${fields.join(' ')} } }`;
    const response = ghJson(['graphql', '-f', `query=${query}`]);
    if (response.errors && response.errors.length) throw new Error(response.errors.map((error) => error.message).join('; '));
    const repo = response.data && response.data.repository;
    if (!repo) throw new Error('GraphQL response has no repository');
    for (let number = start; number <= end; number += 1) {
      const issue = repo[`i${number}`];
      if (!issue || Number(issue.number) !== number) throw new Error(`exact live Issue #${number} was not returned`);
      issues.push({ ...issue, html_url: issue.url, labels: (issue.labels && issue.labels.nodes || []).map((label) => label.name) });
    }
  }
  if (issues.length !== RANGE_COUNT) throw new Error(`exact live range count mismatch: expected ${RANGE_COUNT}, got ${issues.length}`);
  return issues;
}
function sourceArtifact(record) {
  const artifacts = (record.artifacts || []).filter((item) => PROVENANCE.has(item.provenance) && item.git_blob_sha && item.integrity === 'present');
  return artifacts.find((item) => item.provenance === 'source_projection' && item.kind === 'text_projection')
    || artifacts.find((item) => item.provenance === 'source_projection' && item.kind === 'json')
    || artifacts.find((item) => item.provenance === 'source_projection')
    || artifacts.find((item) => item.provenance === 'raw_capture' && item.kind === 'html')
    || null;
}
function freeze(output) {
  const liveIssues = fetchExactIssueRange();
  const items = [];
  const excluded = [];
  for (const issue of liveIssues) {
    const labels = labelsOf(issue);
    const missing = REQUIRED_LABELS.filter((label) => !labels.includes(label));
    if (missing.length) { excluded.push({ issue_number: issue.number, reason: missing.map((label) => `missing:${label}`), labels }); continue; }
    const body = String(issue.body || '');
    const parsed = parseSourceNoteIssue(body);
    if (!parsed.record || parsed.recordParseError) throw new Error(`#${issue.number}: SourceNote record invalid: ${parsed.recordParseError || 'missing'}`);
    const validation = validateSourceNoteIssue({ body, labels, state: String(issue.state || '').toLowerCase() });
    if (!validation.ok) throw new Error(`#${issue.number}: SourceNote validation failed: ${validation.errors.join('; ')}`);
    const record = parsed.record;
    if (record.boundary_review.status !== 'pending') throw new Error(`#${issue.number}: record/label boundary state drift`);
    if (record.source_revision.source_repository !== SOURCE_REPOSITORY || record.source_revision.source_repository_ref !== SOURCE_REF) throw new Error(`#${issue.number}: source revision is not the fixed snapshot`);
    items.push({
      issue_number: issue.number,
      live_url: issue.html_url,
      title: issue.title,
      state: issue.state,
      labels,
      body_sha256: sha256(body),
      source_note_id: record.source_note_id,
      source_id: `${record.source.system}:${record.source.external_id}`,
      source_revision_id: record.source_revision.id,
      source_repository: record.source_revision.source_repository,
      source_repository_ref: record.source_revision.source_repository_ref,
      source_published_at: record.source_published_at,
      artifacts: (record.artifacts || []).map((artifact) => ({
        kind: artifact.kind, ref: artifact.ref, git_blob_sha: artifact.git_blob_sha,
        sha256: artifact.sha256, provenance: artifact.provenance, byte_size: artifact.byte_size,
        integrity: artifact.integrity, sequence: artifact.sequence == null ? null : artifact.sequence,
      })),
    });
  }
  if (items.length === 0 || items.length > EXPECTED_RANGE_COUNT) throw new Error(`pending selection count is outside the frozen range: ${items.length}`);
  const manifest = {
    schema_version: 'issue-1609-boundary-selection.v1', repository: REPOSITORY, parent_issue: 1605, issue: ISSUE,
    selection_policy: 'exact live issue numbers 1139..1508 are read; only records currently carrying type:source-note + status:captured + boundary:pending enter this pending-only selection; no out-of-range reads are used',
    captured_at: new Date().toISOString(), source_repository: SOURCE_REPOSITORY, source_repository_ref: SOURCE_REF,
    range: { min_issue: MIN_ISSUE, max_issue: MAX_ISSUE, expected_count: EXPECTED_RANGE_COUNT },
    read_audit: { exact_issue_numbers: liveIssues.map((item) => item.number), count: liveIssues.length, out_of_range_issue_numbers: [] },
    selected_count: items.length, excluded_count: excluded.length, excluded, items,
  };
  manifest.selection_sha256 = sha256(canonicalJson(manifest));
  writeJson(output, manifest);
  process.stdout.write(`${JSON.stringify({ selected_count: items.length, excluded_count: excluded.length, selection_sha256: manifest.selection_sha256 }, null, 2)}\n`);
}
function semanticText(item, sourceText) {
  const cleanTags = (value) => String(value || '').replace(/#[^#\n]*?\[话题\]#/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (item.artifact.kind !== 'json') return cleanTags(sourceText);
  try {
    const object = JSON.parse(sourceText);
    let desc = null;
    const walk = (value) => {
      if (desc) return;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        if (value.noteId === item.source_note_id.replace(/^xhs-note:/, '') && typeof value.desc === 'string') desc = value.desc;
        else Object.values(value).forEach(walk);
      }
    };
    walk(object);
    return cleanTags(desc);
  } catch { return ''; }
}
function fetchRaw(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const result = execFileSync('curl', [
        '--fail', '--silent', '--show-error', '--location',
        '--retry', '4', '--retry-connrefused', '--retry-delay', '1', '--retry-max-time', '60',
        url,
      ], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024, timeout: 90000 });
      return Buffer.from(result);
    } catch (error) {
      lastError = error;
      const message = String(error && error.message || error);
      const transient = /TLS handshake timeout|timed? ?out|EOF|temporarily unavailable|connection reset|connection refused|HTTP 429|HTTP 502|HTTP 503|HTTP 504|curl: \(5|curl: \(6|curl: \(7|curl: \(18|curl: \(28\)/i.test(message);
      if (!transient || attempt === 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 1000);
    }
  }
  throw lastError;
}
function artifactPath(ref) {
  const colon = ref.indexOf(':');
  const at = ref.lastIndexOf('@');
  return ref.slice(colon + 1, at);
}
function readArtifact(item, snapshot = null, descCache = DEFAULT_DESC_CACHE) {
  let cacheStatus = 'not-applicable';
  if (item.artifact.kind === 'text_projection' && item.artifact.ref.includes(':note_desc/')) {
    const externalId = item.source_note_id.replace(/^xhs-note:/, '');
    const cacheFile = path.join(path.resolve(descCache), `${externalId}.txt`);
    if (fs.existsSync(cacheFile)) {
      const bytes = fs.readFileSync(cacheFile);
      const valid = bytes.length > 0
        && bytes.length === item.artifact.byte_size
        && sha1GitBlob(bytes) === item.artifact.git_blob_sha;
      if (valid) return { bytes, url: `cache:${cacheFile}`, cache_status: 'hit' };
      cacheStatus = 'invalid-fallback';
    } else {
      cacheStatus = 'miss';
    }
  }
  if (snapshot) {
    if (snapshot.root) {
      const snapshotPath = path.join(snapshot.root, artifactPath(item.artifact.ref));
      if (!fs.existsSync(snapshotPath)) throw new Error(`source snapshot directory does not contain exact artifact for ${item.artifact.ref}`);
      const bytes = fs.readFileSync(snapshotPath);
      if (sha1GitBlob(bytes) !== item.artifact.git_blob_sha) throw new Error(`cached Git blob SHA mismatch for ${item.artifact.ref}`);
      if (bytes.length !== item.artifact.byte_size) throw new Error(`cached byte length mismatch for ${item.artifact.ref}`);
      return { bytes, url: `snapshot-dir:${snapshotPath}`, cache_status: cacheStatus };
    }
    const cached = snapshot.get(item.issue_number);
    if (!cached || cached.artifact.ref !== item.artifact.ref || typeof cached.source_text !== 'string') throw new Error(`source snapshot does not contain exact artifact for #${item.issue_number}`);
    const bytes = Buffer.from(cached.source_text, 'utf8');
    if (sha1GitBlob(bytes) !== item.artifact.git_blob_sha) throw new Error(`cached Git blob SHA mismatch for ${item.artifact.ref}`);
    if (bytes.length !== item.artifact.byte_size) throw new Error(`cached byte length mismatch for ${item.artifact.ref}`);
    return { bytes, url: `snapshot:${item.artifact.ref}`, cache_status: cacheStatus };
  }
  const pathName = artifactPath(item.artifact.ref);
  const url = `https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/${SOURCE_REF}/${pathName}`;
  const bytes = fetchRaw(url);
  if (sha1GitBlob(bytes) !== item.artifact.git_blob_sha) throw new Error(`Git blob SHA mismatch for ${item.artifact.ref}`);
  if (bytes.length !== item.artifact.byte_size) throw new Error(`byte length mismatch for ${item.artifact.ref}`);
  return { bytes, url, cache_status: cacheStatus };
}
function artifactSemantic(artifact, rawText, sourceNoteId) {
  if (artifact.kind === 'text_projection') return rawText;
  if (artifact.kind === 'json') {
    try {
      const object = JSON.parse(rawText);
      let note = null;
      const walk = (value) => {
        if (note || !value || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach(walk);
        if (value.noteId === sourceNoteId.replace(/^xhs-note:/, '') && typeof value.desc === 'string') note = value;
        else Object.values(value).forEach(walk);
      };
      walk(object);
      if (note) return [note.title, note.desc].filter((value) => typeof value === 'string' && value.trim()).join('\n');
    } catch { /* the exact hash/length check still makes the artifact auditable */ }
    return '';
  }
  return '';
}
function htmlText(rawText) {
  return String(rawText || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function cleanSourceTags(value) {
  return String(value || '')
    .replace(/#[^#\n]*?\[话题\]#/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function readAllArtifacts(item, snapshot = null, descCache = DEFAULT_DESC_CACHE) {
  const artifacts = item.artifacts
    .filter((artifact) => PROVENANCE.has(artifact.provenance) && artifact.git_blob_sha && artifact.integrity === 'present')
    .filter((artifact) => ['html', 'json', 'text_projection'].includes(artifact.kind))
    .sort((left, right) => left.ref.localeCompare(right.ref));
  if (!artifacts.length) throw new Error(`#${item.issue_number}: no hash-addressed note_desc/html/json artifacts`);
  return artifacts.map((artifact) => {
    const result = readArtifact({ ...item, artifact }, snapshot, descCache);
    const rawText = result.bytes.toString('utf8');
    return { artifact, ...result, rawText, semantic: artifactSemantic(artifact, rawText, item.source_note_id) };
  });
}
function excerpt(item, rawText, semantic, artifact = null) {
  const lines = rawText.split(/\r?\n/);
  const candidates = String(semantic || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 4);
  let index = -1;
  let matchOffset = -1;
  for (const candidate of candidates) {
    const candidateIndex = lines.findIndex((line) => line.includes(candidate.slice(0, Math.min(80, candidate.length))));
    if (candidateIndex >= 0) { index = candidateIndex; matchOffset = lines[candidateIndex].indexOf(candidate.slice(0, Math.min(80, candidate.length))); break; }
  }
  if (index < 0) index = lines.findIndex((line) => line.trim() && !/^\s*[\[{]/.test(line));
  if (index < 0) index = 0;
  const original = lines[index];
  const offset = matchOffset >= 0 ? matchOffset : Math.max(0, original.search(/\S|$/));
  const excerptText = original.slice(offset, offset + 1000).trim();
  const suffix = artifact ? `;blob:${artifact.git_blob_sha}` : '';
  return { excerpt: excerptText, line: index + 1, locator: `artifact-line:${index + 1}#offset:${offset}-${offset + excerptText.length}${suffix}`, semantic_excerpt: semantic.slice(0, 1000) };
}
function questionCount(value) {
  return (String(value || '').match(/(?:^|\s)(?:\d{1,2}[.、)）]|[一二三四五六七八九十]+[、.）)])/g) || []).length;
}

const CJK_COMPATIBILITY_MAP = new Map([
  ['⼀', '一'],
  ['⾯', '面'],
]);

function normalizeBoundaryText(value) {
  return String(value || '').normalize('NFKC').replace(/[⼀⾯]/g, (character) => CJK_COMPATIBILITY_MAP.get(character) || character);
}

function firstPersonEvent(value) {
  if (/(?:避免.{0,12}回答|试试这样|参考答案|个人经验分享|面试前.{0,20}(?:问题|答案).{0,12}(?:练习|写下))/i.test(value)) return false;
  return /(?:(?<!自)我|本人|自己|亲身|主包).{0,24}(?:面试|面了|面完|参加|收到|投递|被问|回答|聊|介绍)|(?:面试|面完|面试官).{0,24}(?:我|本人|让我)/i.test(value);
}

function boundedEventSignal(value) {
  return /(?:面试官|让我|收到.{0,10}面试|参加.{0,10}面试|去面试|面试了|面完|面试时间|面试记录|面试过程|一面|二面|三面|hr面|技术面|手撕|自我介绍|项目拷打|投递.{0,12}面|面试.{0,8}(?:分钟|min)|总计\s*\d+\s*(?:分钟|min)|一次面试|这次面试|本次面试|最近结束.{0,8}面试)/i.test(value);
}

function detailedEventSignal(value) {
  return /(?:面试官|让我|收到.{0,10}面试|参加.{0,10}面试|去面试|面试了|面完|面试时间|面试记录|面试过程|面试.{0,8}(?:分钟|min)|总计\s*\d+\s*(?:分钟|min)|手撕|项目拷打|自我介绍|面试内容|面试问题|聊项目|问了|被问)/i.test(value);
}

function resourceSignal(value) {
  return /(?:题库|面试题合集|题合集|资料|教程|书籍|模拟面试|刷题|知识点|面试指南|面试准备|面试技巧|面试攻略|招聘|内推|岗位名称|岗位职责|岗位招聘|求职咨询|求捞|通关秘籍|宝典|笔试)/i.test(value);
}

function multiProcessSignal(value) {
  return /(?:从第一个面试|上面的公司|多家公司|多个公司|不同公司|几家公司|多家|多次面试|多场面试|三场面试|各家公司|秋招进度|公司校招|三家|四家|五家|两家公司)/i.test(value);
}

function caseSegments(value) {
  const lines = String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const found = [];
  for (const [anchor, key] of COMPANY_CASES) {
    const lineIndex = lines.findIndex((line) => line.toLowerCase().includes(anchor.toLowerCase()));
    if (lineIndex < 0) continue;
    const line = lines[lineIndex];
    const atStart = new RegExp(`^(?:\\d+[.、)）]\\s*)?${anchor}(?:$|[：:、，,\\s])`, 'i').test(line);
    const explicitProcess = (atStart && /(?:一面|二面|三面|四面|hr面|技术面|面试|流程|进度|offer|挂|通过|oc)/i.test(line))
      || new RegExp(`${anchor}.{0,24}(?:一面|二面|三面|四面|hr面|技术面|面试官|面试过程|流程|进度)|(?:一面|二面|三面|四面|hr面|技术面|面试官|面试过程|流程|进度).{0,24}${anchor}`, 'i').test(line);
    const nextCompany = lines.findIndex((candidate, index) => index > lineIndex && COMPANY_CASES.some(([candidateAnchor]) => new RegExp(`^(?:\\d+[.、)）]\\s*)?${candidateAnchor}(?:$|[：:、，,\\s])`, 'i').test(candidate)));
    const block = lines.slice(lineIndex, nextCompany < 0 ? lineIndex + 4 : nextCompany).join('\n');
    const heading = atStart && line.length <= 40;
    const localDetail = explicitProcess || (heading && /(?:一面|二面|三面|四面|hr面|技术面|面试官|面试过程|面试问题|问题|手撕|代码题|问|挂|offer|通过|oc)/i.test(block));
    if (!localDetail) continue;
    found.push({ case_key: `${key}-process`, anchor, line: lineIndex + 1, locator: `semantic-anchor:${anchor}`, local_detail: localDetail });
  }
  const unique = new Map(found.map((item) => [item.case_key, item]));
  return [...unique.values()];
}

function bindCaseArtifactLocators(cases, artifactReads) {
  const locators = new Set();
  return cases.map((item) => {
    const anchor = String(item.anchor || '');
    const anchorLower = anchor.toLowerCase();
    const read = artifactReads.find((candidate) => candidate.rawText.toLowerCase().includes(anchorLower));
    if (!read) throw new Error(`case anchor is absent from exact artifacts: ${anchor}`);
    const lines = read.rawText.split(/\r?\n/);
    const lineIndex = lines.findIndex((line) => line.toLowerCase().includes(anchorLower));
    const offset = lines[lineIndex].toLowerCase().indexOf(anchorLower);
    const locator = `artifact-line:${lineIndex + 1}#offset:${offset}-${offset + anchor.length};blob:${read.artifact.git_blob_sha}`;
    if (locators.has(locator)) throw new Error(`case artifact locator is not unique: ${locator}`);
    locators.add(locator);
    return { ...item, semantic_locator: item.locator, source_ref: read.artifact.ref, locator };
  });
}

function ambiguityAudit(semantic) {
  const value = cleanSourceTags(normalizeBoundaryText(semantic));
  const questions = questionCount(value);
  const firstQuestion = value.search(/(?:^|\s)(?:\d{1,2}[.、)）]|[一二三四五六七八九十]+[、.）)])/);
  const prefix = firstQuestion < 0 ? value : value.slice(0, firstQuestion);
  const hasFirstPersonEvent = firstPersonEvent(value);
  const hasBoundedEvent = boundedEventSignal(value);
  const hasDetailedEvent = detailedEventSignal(value);
  const explicitCandidateEvent = hasFirstPersonEvent || /(?:学员刚(?:面完|结束)|最近结束了?[^\n]{0,12}面试|前段时间面|两轮技术面|三轮技术面|面试官.{0,30}(?:让我|问)|时间线.{0,80}(?:一面|二面|三面)|收到面试邀请.{0,20}面试)/i.test(value);
  const multiSignal = multiProcessSignal(value);
  const segments = caseSegments(value);
  const outcomeSignal = /(?:offer|录用|入职|通过|挂了|挂掉|挂科|简历挂|拒绝|未通过|凉经|结果)/i.test(value);
  const resource = resourceSignal(value);
  const genericAdvice = /(?:避免.{0,12}回答|试试这样|参考答案|个人经验分享|可以这样回答|面试技巧)/i.test(value);
  const aggregatedText = /(?:粉丝投稿|综合粉丝投稿|当前市场环境|朋友.{0,12}(?:总结|复盘|记录)|收到一个朋友|特地分享|核心特点可总结|纯总结|无具体候选人)/i.test(value);
  const interviewerPerspective = /(?:面试官分享|面试官视角|作为面试官|我是面试官|招聘方分享|招聘方视角|面试官经验)/i.test(value);
  const algorithmQuestionOnly = questions >= 2
    && /(?:题目|描述|示例|输入|输出)/i.test(value)
    && !/(?:面试官|回答|追问|项目拷打|面试过程|面完|参加.{0,10}面试|我.{0,20}(?:面|参加)|反问)/i.test(value);
  const jobOrTitleOnly = /(?:岗位|职位|招聘)/i.test(value)
    && /(?:一面|二面|三面|四面|hr面|技术面|面试轮次|round|分钟|min|base)/i.test(value)
    && !explicitCandidateEvent
    && !/(?:面试官|让我|问了|被问|回答|追问|手撕|代码题|算法题|项目拷打|自我介绍|聊项目|面试过程|面试内容|面试问题)/i.test(value)
    && questions === 0;
  const nonInterviewFormat = /笔试/.test(value) && !/(?:面试官|面试时间|面试过程|面完|面了|面感|一面|二面|三面|hr面|技术面)/i.test(value);
  const genericResource = !explicitCandidateEvent
    && !/(?:面完|流程[:：]|涉及内容|详细面经|面试官先|面试官.{0,20}(?:问|追问|让我)|本次面试|这次面试|最近结束)/i.test(value)
    && (genericAdvice || (resource && (/(?:题库|题合集|书籍|招聘|内推|岗位名称|岗位职责|岗位招聘|急招|投递链接|面试攻略|集中面试即将|笔试题|下载|上传|收藏|核弹库|参考答案|高频题|200页)/i.test(value) || !hasDetailedEvent)));
  const onlyQuestionList = algorithmQuestionOnly || (questions >= 3 && !/(?:面试官|让我|面试时间|面试过程|面试内容|面试问题|面完|刚.{0,8}面|一面|二面|三面|hr面|总计\s*\d+\s*(?:分钟|min)|面试.{0,8}(?:分钟|min)|我.{0,20}(?:面|参加|去)|参加.{0,10}面试|收到.{0,10}面试)/i.test(prefix));
  const onlyOutcome = outcomeSignal && !hasDetailedEvent;
  const completedEventEvidence = /(?:面试官|面试过程|面试内容|面试问题|本次面试|这次面试|最近结束了?[^\n]{0,12}面试|面完|面试了|参加.{0,10}面试|去面试|面试结果|被问|问了|追问|回答|让我|聊项目|手撕|代码题|算法题|项目拷打|自我介绍|总计\s*\d+\s*(?:分钟|min)|面试.{0,8}(?:分钟|min))/i.test(value);
  const structuredCandidateEvent = hasDetailedEvent && !onlyQuestionList && completedEventEvidence && !aggregatedText;
  const scheduledOnly = /(?:预约|约面|面试通知|面试邀请|面试安排|明天面|后天面|即将面)/i.test(value) && !structuredCandidateEvent;
  const questionOnly = questions > 0 && !structuredCandidateEvent;
  const genericAdviceOrAggregated = genericAdvice || aggregatedText || genericResource;
  const noCandidateEventEvidence = !structuredCandidateEvent;
  const flags = [];
  if (multiSignal || segments.length > 1) flags.push('multi-company-or-process');
  if (onlyQuestionList) flags.push('question-list-only');
  if (onlyOutcome) flags.push('outcome-or-offer-only');
  if (!hasFirstPersonEvent) flags.push('no-first-person-event');
  if (genericResource) flags.push('generic-question-bank-or-job-ad');
  if (genericAdviceOrAggregated) flags.push('generic-advice-or-aggregated');
  if (scheduledOnly) flags.push('scheduled-only');
  if (questionOnly) flags.push('question-only');
  if (jobOrTitleOnly) flags.push('job-or-title-only');
  if (noCandidateEventEvidence) flags.push('no-candidate-event-evidence');
  if (nonInterviewFormat) flags.push('non-interview-format');
  if (interviewerPerspective) flags.push('interviewer-perspective');
  return { flags, questions, has_first_person_event: hasFirstPersonEvent, has_explicit_candidate_event: explicitCandidateEvent, has_bounded_event: hasBoundedEvent, has_detailed_event: hasDetailedEvent, has_completed_event_evidence: completedEventEvidence, has_structured_candidate_event: structuredCandidateEvent, generic_advice_or_aggregated: genericAdviceOrAggregated, scheduled_only: scheduledOnly, question_only: questionOnly, outcome_signal: outcomeSignal, resource_signal: resource, aggregated_text: aggregatedText, interviewer_perspective: interviewerPerspective, algorithm_question_only: algorithmQuestionOnly, job_or_title_only: jobOrTitleOnly, non_interview_format: nonInterviewFormat, only_question_list: onlyQuestionList, only_outcome: onlyOutcome, multi_signal: multiSignal, case_segments: segments };
}

function disposition(semantic) {
  const value = String(semantic || '').trim();
  const audit = ambiguityAudit(value);
  if (!value || value === 'null') return { disposition: 'blocked', reason: 'No non-empty readable Source/Source projection is available; title and hashtags cannot authorize a boundary.', audit };
  if (audit.interviewer_perspective) return { disposition: 'not-interview', reason: 'Exact Source is explicitly an interviewer/recruiter perspective rather than a candidate interview event.', audit };
  if (audit.flags.includes('non-interview-format')) return { disposition: 'not-interview', reason: 'Exact Source identifies a written-test/non-interview format rather than a candidate interview event.', audit };
  if (audit.flags.includes('job-or-title-only')) return { disposition: 'blocked', reason: 'Exact Source contains only a job/title, round, duration, or location descriptor and no candidate event; retain pending.', audit };
  if (!audit.has_structured_candidate_event && audit.flags.includes('generic-question-bank-or-job-ad')) {
    return { disposition: 'not-interview', reason: 'Exact Source is an explicit question bank or job advertisement rather than a candidate interview event.', audit };
  }
  if (audit.flags.includes('multi-company-or-process')) {
    if (audit.case_segments.length >= 2 && audit.has_structured_candidate_event && !audit.only_outcome) {
      return { disposition: 'multi-interview', reason: 'Exact Source separately identifies multiple independent interview processes, each with its own source anchor and bounded detail.', interview_cases: audit.case_segments, audit };
    }
    return { disposition: 'blocked', reason: 'Exact Source indicates multiple independent processes, but does not provide separately reviewable bounded event evidence for every process; retain pending.', audit };
  }
  if (audit.only_outcome) return { disposition: 'blocked', reason: 'Exact Source provides only an interview outcome, offer, rejection, or result without a bounded candidate event; retain pending.', audit };
  if (audit.flags.includes('generic-advice-or-aggregated')) return { disposition: 'blocked', reason: 'Exact Source is generic advice or aggregated/summarized material without a bounded candidate interview event; retain pending.', audit };
  if (audit.flags.includes('scheduled-only')) return { disposition: 'blocked', reason: 'Exact Source records only a scheduled, invited, or arranged interview and no completed candidate interview process; retain pending.', audit };
  if (audit.flags.includes('question-only') || audit.only_question_list) return { disposition: 'blocked', reason: 'Exact Source is only a question list without a sufficiently explicit completed candidate interview process; retain pending.', audit };
  if (audit.flags.includes('no-candidate-event-evidence')) return { disposition: 'blocked', reason: 'Exact Source has no explicit candidate interview event, actual interview questions, or process evidence; retain pending.', audit };
  if (!audit.has_bounded_event) return { disposition: 'blocked', reason: 'The available Source evidence does not establish a bounded candidate interview event; retain pending.', audit };
  return { disposition: 'single-interview', reason: 'Exact Source records one completed, bounded candidate interview process with structured event/question evidence; rounds within the same process remain one case.', audit };
}
function makeRequest(item, evidence, choice) {
  if (choice.disposition === 'blocked') return null;
  const transition = {
    schema_version: choice.disposition === 'multi-interview'
      ? 'source-note-boundary-review-transition.v2'
      : 'source-note-boundary-review-transition.v1',
    transition_id: `issue-1609-boundary-${String(item.issue_number).padStart(4, '0')}-review-1`,
    repository: REPOSITORY,
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    expected_body_sha256: item.body_sha256,
    expected_boundary_status: 'pending',
    expected_source_revision_id: item.source_revision_id,
    expected_manifest_sha256: null,
    expected_source_repository_ref: SOURCE_REF,
    decision: choice.disposition,
    reviewed_at: REVIEWED_AT,
    reviewer_kind: 'ai-assisted',
    review_evidence: {
      repository: REPOSITORY,
      issue_number: item.issue_number,
      comment_id: PLACEHOLDER_COMMENT_BASE + item.issue_number,
    },
    checks: evidence.checks,
    limitations: [
      choice.reason,
      'Candidate only: review_evidence.comment_id is a deterministic placeholder; no live evidence comment was created.',
      'No body PATCH, label write, or InterviewNote materialization was performed; controller authorization is required.',
    ],
  };
  if (choice.disposition === 'multi-interview') {
    transition.interview_cases = (choice.interview_cases || []).map((itemCase) => ({
      case_key: itemCase.case_key,
      evidence: [{ ref: itemCase.source_ref || evidence.source_evidence.ref, locator: itemCase.locator }],
    }));
  }
  return transition;
}
function evidence(selection, output, evidenceDir, requestsDir, receiptsDir, journalPath, ambiguityAuditPath, snapshot = null, descCache = DEFAULT_DESC_CACHE) {
  clearGeneratedJsonFiles(evidenceDir);
  clearGeneratedJsonFiles(requestsDir);
  clearGeneratedJsonFiles(receiptsDir);
  const sourceItems = [];
  const auditItems = [];
  for (const item of selection.items) {
    const artifactReads = readAllArtifacts(item, snapshot, descCache);
    const selected = artifactReads.find((read) => read.artifact.provenance === 'source_projection' && read.artifact.kind === 'text_projection')
      || artifactReads.find((read) => read.artifact.provenance === 'source_projection' && read.artifact.kind === 'json')
      || artifactReads.find((read) => read.artifact.provenance === 'source_projection')
      || artifactReads.find((read) => read.artifact.provenance === 'raw_capture' && read.artifact.kind === 'html');
    if (!selected) throw new Error(`#${item.issue_number}: no hash-addressed Raw/source projection artifact`);
    const jsonRead = artifactReads.find((read) => read.artifact.kind === 'json' && read.semantic);
    const descRead = artifactReads.find((read) => read.artifact.kind === 'text_projection' && read.semantic);
    const htmlRead = artifactReads.find((read) => read.artifact.kind === 'html');
    const semantic = cleanSourceTags((jsonRead && jsonRead.semantic) || (descRead && descRead.semantic) || (htmlRead && htmlText(htmlRead.rawText)) || '');
    const choice = disposition(semantic);
    if (choice.audit.case_segments.length) {
      const boundCases = bindCaseArtifactLocators(choice.audit.case_segments, artifactReads);
      choice.audit.case_segments = boundCases;
      if (choice.disposition === 'multi-interview') choice.interview_cases = boundCases;
    }
    const evidenceFile = path.join(evidenceDir, `${String(item.issue_number).padStart(4, '0')}.json`);
    const artifactEvidence = artifactReads.map((read) => ({
      ref: read.artifact.ref,
      git_blob_sha: read.artifact.git_blob_sha,
      kind: read.artifact.kind,
      provenance: read.artifact.provenance,
      byte_size: read.bytes.length,
      content_sha256: sha256(read.rawText),
      cache_status: read.cache_status,
      excerpt: excerpt(item, read.rawText, semantic, read.artifact),
    }));
    const selectedEvidence = artifactEvidence.find((evidenceItem) => evidenceItem.ref === selected.artifact.ref);
    const sourceEvidence = { ...selectedEvidence, artifact_evidence: artifactEvidence };
    const checks = CHECKS.map(([check_id, note]) => ({ check_id, result: check_id === 'event_boundary' && choice.disposition === 'blocked' ? 'fail' : 'pass', note: check_id === 'event_boundary' ? `${note} ${choice.reason}` : note }));
    const evidenceRecord = {
      schema_version: 'issue-1609-boundary-evidence.v1', issue_number: item.issue_number, live_url: item.live_url, source_note_id: item.source_note_id,
      source_revision_id: item.source_revision_id, source_repository: SOURCE_REPOSITORY, source_repository_ref: SOURCE_REF, body_sha256: item.body_sha256,
      disposition: choice.disposition, rationale: choice.reason, interview_cases: choice.interview_cases || [], ambiguity_audit: { ...choice.audit, reviewed_artifact_count: artifactReads.length, semantic_basis: jsonRead ? 'note_json.title+desc' : descRead ? 'note_desc' : 'note_detail.html' }, source_evidence: sourceEvidence, artifact_evidence: artifactEvidence, checks,
      limitations: [choice.reason, 'Complete note_desc/note_json/note_detail artifacts were read and independently hash-verified; excerpts are bounded views of those immutable artifacts.', 'Source projection/Raw evidence is kept separate from Derived data; this record authorizes no mutation.'], source_ready_claimed: false,
      live_evidence_comment_created: false, mutation_count: 0,
    };
    const evidenceDigest = sha256(canonicalJson(evidenceRecord));
    evidenceRecord.evidence_sha256 = evidenceDigest;
    writeJson(evidenceFile, evidenceRecord);
    const request = makeRequest(item, evidenceRecord, choice);
    const requestDigest = request ? sha256(canonicalJson(request)) : null;
    if (request) {
      const requestValidation = validateTransitionRequest(request);
      if (!requestValidation.ok) throw new Error(`#${item.issue_number}: staged transition request is not validator-compatible: ${requestValidation.errors.join('; ')}`);
      writeJson(path.join(requestsDir, `${String(item.issue_number).padStart(4, '0')}.json`), request);
    }
    const receipt = { schema_version: 'issue-1609-boundary-planned-receipt.v1', issue_number: item.issue_number, transition_id: request && request.transition_id || null, evidence_sha256: evidenceDigest, request_sha256: requestDigest, receipt_state: 'not-applied', possibly_performed: false, mutation_attempted: false, mutation_count: 0, reason: request ? 'Controller authorization for live apply is absent; review evidence comment placeholder was not created.' : 'Blocked disposition has no transition request; controller authorization and additional evidence are required.' };
    writeJson(path.join(receiptsDir, `${String(item.issue_number).padStart(4, '0')}.json`), receipt);
    auditItems.push({ issue_number: item.issue_number, disposition: choice.disposition, flags: choice.audit.flags, audit: { ...choice.audit, reviewed_artifact_count: artifactReads.length, semantic_basis: jsonRead ? 'note_json.title+desc' : descRead ? 'note_desc' : 'note_detail.html' }, artifact_evidence: artifactEvidence, source_cache_status: selected.cache_status, artifact_cache_statuses: artifactReads.map((read) => ({ ref: read.artifact.ref, status: read.cache_status })), evidence_file: `evidence/${String(item.issue_number).padStart(4, '0')}.json`, request_file: request ? `requests/${String(item.issue_number).padStart(4, '0')}.json` : null, transition_request_staged: Boolean(request), live_evidence_comment_created: false, mutation_count: 0, interview_cases: choice.interview_cases || [] });
    sourceItems.push({ issue_number: item.issue_number, disposition: choice.disposition, evidence_sha256: evidenceDigest, request_sha256: requestDigest, transition_id: request && request.transition_id || null, transition_request_staged: Boolean(request), receipt_state: receipt.receipt_state, live_evidence_comment_created: false, mutation_count: 0 });
  }
  const flagCounts = auditItems.flatMap((item) => item.flags).reduce((out, flag) => { out[flag] = (out[flag] || 0) + 1; return out; }, {});
  const flagIssueNumbers = {};
  for (const item of auditItems) for (const flag of item.flags) (flagIssueNumbers[flag] ||= []).push(item.issue_number);
  const sourceCacheCounts = auditItems.reduce((out, item) => { out[item.source_cache_status] = (out[item.source_cache_status] || 0) + 1; return out; }, {});
  writeJson(ambiguityAuditPath, { schema_version: 'issue-1609-boundary-ambiguity-audit.v1', repository: REPOSITORY, issue: ISSUE, selection_sha256: selection.selection_sha256, source_repository: SOURCE_REPOSITORY, source_repository_ref: SOURCE_REF, source_desc_cache: { directory: descCache, statuses: sourceCacheCounts }, total: auditItems.length, live_evidence_comment_created: false, mutation_count: 0, flag_counts: flagCounts, flag_issue_numbers: flagIssueNumbers, items: auditItems });
  const journal = { schema_version: 'issue-1609-boundary-apply-journal.v1', repository: REPOSITORY, issue: ISSUE, mode: 'plan-only', mutation_authorized: false, mutation_count: 0, entries: sourceItems.map((item) => ({ ...item, state: 'not-authorized', mutation_attempted: false, possibly_performed: false })) };
  journal.journal_sha256 = sha256(canonicalJson(journal)); writeJson(journalPath, journal);
  return sourceItems;
}
function plan(selection, sourceItems, output) {
  const counts = sourceItems.reduce((out, item) => { out[item.disposition] = (out[item.disposition] || 0) + 1; return out; }, {});
  const expectedCount = Number(selection.selected_count);
  if (!Number.isInteger(expectedCount) || expectedCount <= 0 || sourceItems.length !== expectedCount) throw new Error(`evidence count does not match current pending selection: expected ${expectedCount}, got ${sourceItems.length}`);
  const report = { schema_version: 'issue-1609-boundary-dry-run.v1', repository: REPOSITORY, parent_issue: 1605, issue: ISSUE, selection_sha256: selection.selection_sha256, source_repository: SOURCE_REPOSITORY, source_repository_ref: SOURCE_REF, range: { min_issue: MIN_ISSUE, max_issue: MAX_ISSUE, expected_count: EXPECTED_RANGE_COUNT, pending_expected_count: expectedCount }, total: sourceItems.length, counts: { 'single-interview': counts['single-interview'] || 0, 'multi-interview': counts['multi-interview'] || 0, 'not-interview': counts['not-interview'] || 0, blocked: counts.blocked || 0 }, mutation_authorized: false, mutation_count: 0, all_items_have_independent_evidence: sourceItems.length === expectedCount, items: sourceItems, fail_closed: (counts.blocked || 0) > 0 };
  report.dry_run_sha256 = sha256(canonicalJson(report)); writeJson(output, report); return report;
}
function collectionDigest(directory) {
  const files = fs.readdirSync(path.resolve(directory)).filter((file) => file.endsWith('.json')).sort();
  return { count: files.length, sha256: sha256(canonicalJson(files.map((file) => ({ file, value: JSON.parse(fs.readFileSync(path.join(path.resolve(directory), file), 'utf8')) })))) };
}
function digest(selection, report, evidenceDir, requestsDir, receiptsDir, journalPath, ambiguityAuditPath, output) {
  const journal = JSON.parse(fs.readFileSync(path.resolve(journalPath), 'utf8'));
  const ambiguity = JSON.parse(fs.readFileSync(path.resolve(ambiguityAuditPath), 'utf8'));
  const evidence = collectionDigest(evidenceDir);
  const requests = collectionDigest(requestsDir);
  const receipts = collectionDigest(receiptsDir);
  const value = { schema_version: 'issue-1609-boundary-canonical-digest.v2', repository: REPOSITORY, issue: ISSUE, selection_sha256: selection.selection_sha256, dry_run_sha256: report.dry_run_sha256, journal_sha256: journal.journal_sha256, ambiguity_audit_sha256: sha256(canonicalJson(ambiguity)), evidence_count: evidence.count, request_count: requests.count, receipt_count: receipts.count, ambiguity_audit_count: ambiguity.total, evidence_sha256: evidence.sha256, request_sha256: requests.sha256, receipt_sha256: receipts.sha256, mutation_count: 0 };
  value.canonical_digest_sha256 = sha256(canonicalJson(value));
  writeJson(output, value);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function main() {
  const args = parseArgs();
  if (args.mode === 'freeze') return freeze(args.output);
  const selection = JSON.parse(fs.readFileSync(path.resolve(args.selection), 'utf8'));
  const { selection_sha256: selectionDigest, ...selectionWithoutDigest } = selection;
  if (selectionDigest !== sha256(canonicalJson(selectionWithoutDigest))) throw new Error('selection manifest digest mismatch');
  if (args.mode === 'evidence') {
    let snapshot = null;
    if (args.sourceSnapshot) {
      const snapshotPath = path.resolve(args.sourceSnapshot);
      snapshot = fs.statSync(snapshotPath).isDirectory()
        ? { root: snapshotPath }
        : new Map(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).items.map((item) => [Number(item.issue_number), item]));
    }
    const items = evidence(selection, args.output, args.evidence, args.requests, args.receipts, args.journal, args.ambiguityAudit, snapshot, args.descCache || DEFAULT_DESC_CACHE);
    const report = plan(selection, items, args.output);
    process.stdout.write(`${JSON.stringify({ total: report.total, counts: report.counts, dry_run_sha256: report.dry_run_sha256, mutation_count: 0 }, null, 2)}\n`);
    return;
  }
  const report = JSON.parse(fs.readFileSync(path.resolve(args.source), 'utf8'));
  if (args.mode === 'digest') return digest(selection, report, args.evidence, args.requests, args.receipts, args.journal, args.ambiguityAudit, args.output);
  const result = plan(selection, report.items, args.output);
  process.stdout.write(`${JSON.stringify({ total: result.total, counts: result.counts, dry_run_sha256: result.dry_run_sha256, mutation_count: 0 }, null, 2)}\n`);
}
if (require.main === module) { try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; } }
module.exports = { ambiguityAudit, artifactSemantic, canonicalJson, caseSegments, disposition, normalizeBoundaryText, parseArgs, readAllArtifacts, readArtifact, sha256, sha1GitBlob };
