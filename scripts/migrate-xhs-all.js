#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { validateInterviewNoteIssue } = require('./lib/interview-note-issue');

const BULK_MIGRATION_LABEL = 'migration:xhs-bulk';
const DEFAULT_LABELS = ['type:interview-note', 'source:xhs', 'status:captured', BULK_MIGRATION_LABEL];
const MAX_DESC_CHARS = 8000;
const MAX_IMAGE_ARTIFACTS = 20;
const GRAPHQL_BATCH_SIZE = 8;
const GRAPHQL_BATCH_PAUSE_MS = 1600;

function parseArgs(argv = process.argv.slice(2)) {
  const out = { apply: false, sourceRoot: null, sourceRef: null, targetRepo: process.env.GITHUB_REPOSITORY || null, report: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--source-root') out.sourceRoot = argv[++i];
    else if (arg === '--source-ref') out.sourceRef = argv[++i];
    else if (arg === '--target-repo') out.targetRepo = argv[++i];
    else if (arg === '--report') out.report = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.sourceRoot) throw new Error('--source-root is required');
  if (!out.targetRepo) throw new Error('--target-repo is required');
  return out;
}

function findNoteObject(value, noteId) {
  if (!value || typeof value !== 'object') return null;
  if (!Array.isArray(value) && String(value.noteId || '') === noteId) return value;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    const found = findNoteObject(child, noteId);
    if (found) return found;
  }
  return null;
}

function normalizeEpochMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 1e12 ? number * 1000 : number;
}

function epochToShanghaiTimeFact(value) {
  const ms = normalizeEpochMs(value);
  if (ms == null) return { precision: 'unknown', value: null };
  const shifted = new Date(ms + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
  return { precision: 'exact', value: shifted };
}

function publishedSortKey(timeFact) {
  if (!timeFact || timeFact.precision === 'unknown' || !timeFact.value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(timeFact.value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function sortByPublishedAt(candidates) {
  return [...candidates].sort((a, b) => {
    const aKey = publishedSortKey(a.source_published_at);
    const bKey = publishedSortKey(b.source_published_at);
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return a.note_id.localeCompare(b.note_id);
  });
}

function gitOutput(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function resolveSourceRef(sourceRoot, requestedRef) {
  return gitOutput(['-C', sourceRoot, 'rev-parse', requestedRef || 'HEAD']);
}

function gitObjectSha(sourceRoot, sourceRef, relativePath) {
  try {
    const output = gitOutput(['-C', sourceRoot, 'ls-tree', sourceRef, '--', relativePath]);
    if (!output) return null;
    const match = output.match(/^\d+\s+blob\s+([0-9a-f]{40})\t/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function fileExists(sourceRoot, relativePath) {
  return fs.existsSync(path.join(sourceRoot, relativePath));
}

function readUtf8(sourceRoot, relativePath) {
  const absolute = path.join(sourceRoot, relativePath);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
}

function listImagePaths(sourceRoot, noteId) {
  const relativeDir = path.join('downloaded_images', noteId);
  const absoluteDir = path.join(sourceRoot, relativeDir);
  if (!fs.existsSync(absoluteDir) || !fs.statSync(absoluteDir).isDirectory()) return [];
  return fs.readdirSync(absoluteDir)
    .filter((name) => fs.statSync(path.join(absoluteDir, name)).isFile())
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.posix.join('downloaded_images', noteId, name));
}

function artifact(sourceRoot, sourceRef, kind, relativePath, provenance) {
  if (!fileExists(sourceRoot, relativePath)) return null;
  const sha = gitObjectSha(sourceRoot, sourceRef, relativePath);
  if (!sha) return null;
  return {
    kind,
    ref: `liqiangcc/xhs:${relativePath}@${sourceRef}`,
    git_blob_sha: sha,
    sha256: null,
    provenance,
  };
}

function extractCandidate(sourceRoot, sourceRef, noteJsonPath) {
  const noteId = path.basename(noteJsonPath, '.json');
  const parsed = JSON.parse(fs.readFileSync(path.join(sourceRoot, noteJsonPath), 'utf8'));
  const note = findNoteObject(parsed, noteId);
  const descPath = `note_desc/${noteId}.txt`;
  const desc = readUtf8(sourceRoot, descPath);
  const title = note && typeof note.title === 'string' ? note.title : '';
  const sourcePublishedAt = epochToShanghaiTimeFact(note && note.time);
  const sourceEditedAt = epochToShanghaiTimeFact(note && note.lastUpdateTime);
  const limitations = [];

  if (!note) limitations.push('未在 note_json 中解析到与 external id 完全匹配的 note object；来源级 metadata 待后续 Source review。');
  if (sourcePublishedAt.precision === 'unknown') limitations.push('source_published_at 未能从来源 note.time 确认；全量创建排序时放入 unknown-time 尾部。');
  if (!desc) limitations.push('note_desc readable projection 缺失；Issue 仅登记现有 Source artifact。');

  const artifacts = [];
  const addArtifact = (value) => { if (value) artifacts.push(value); };
  addArtifact(artifact(sourceRoot, sourceRef, 'html', `note_detail/${noteId}.html`, 'raw_capture'));
  addArtifact(artifact(sourceRoot, sourceRef, 'image_reference', `note_images/${noteId}_urls.txt`, 'raw_capture'));

  const imagePaths = listImagePaths(sourceRoot, noteId);
  for (const imagePath of imagePaths.slice(0, MAX_IMAGE_ARTIFACTS)) {
    addArtifact(artifact(sourceRoot, sourceRef, 'image', imagePath, 'raw_capture'));
  }
  if (imagePaths.length > MAX_IMAGE_ARTIFACTS) {
    limitations.push(`Raw image 共 ${imagePaths.length} 个；intake Issue 初始只登记前 ${MAX_IMAGE_ARTIFACTS} 个 blob，完整图片目录留待 Source review。`);
  }

  addArtifact(artifact(sourceRoot, sourceRef, 'json', noteJsonPath, 'source_projection'));
  addArtifact(artifact(sourceRoot, sourceRef, 'text_projection', descPath, 'source_projection'));

  limitations.push('本记录属于全量 intake/captured 阶段；创建 Issue 不等于已经通过单次真实面试事件边界、Source fidelity 或 source-ready 审核。');
  limitations.push('interview_occurred_at 在 intake 阶段保持 unknown；不得从发布时间、标题、届次或 Derived 数据自动补写。');
  limitations.push('note_img_txt / note_structured / note_tagged 等历史数据继续属于 Derived，不得反向补写 Raw Source。');

  return {
    note_id: noteId,
    original_title: title,
    readable_desc: desc || '',
    source_published_at: sourcePublishedAt,
    source_edited_at: sourceEditedAt,
    interview_occurred_at: { precision: 'unknown', value: null },
    artifacts,
    limitations,
  };
}

function listCandidates(sourceRoot, sourceRef) {
  const noteJsonDir = path.join(sourceRoot, 'note_json');
  if (!fs.existsSync(noteJsonDir)) throw new Error(`missing source directory: ${noteJsonDir}`);
  const paths = fs.readdirSync(noteJsonDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.posix.join('note_json', name));
  return sortByPublishedAt(paths.map((noteJsonPath) => extractCandidate(sourceRoot, sourceRef, noteJsonPath)));
}

function displayPublishedDate(timeFact) {
  if (!timeFact || timeFact.precision === 'unknown' || !timeFact.value) return '发布时间未知';
  return String(timeFact.value).slice(0, 10);
}

function quoteMarkdown(value) {
  const normalized = String(value || '').replace(/\r\n/g, '\n');
  return normalized.split('\n').map((line) => `> ${line}`).join('\n');
}

function buildIssueProjection(candidate, sourceRef, capturedAt) {
  const interviewNoteId = `xhs:${candidate.note_id}`;
  const sourceRevisionId = `${interviewNoteId}:snapshot-${sourceRef.slice(0, 12)}`;
  const descWasTruncated = candidate.readable_desc.length > MAX_DESC_CHARS;
  const desc = candidate.readable_desc.slice(0, MAX_DESC_CHARS);
  const limitations = [...candidate.limitations];
  if (descWasTruncated) limitations.push(`Issue 中 readable projection 截断到 ${MAX_DESC_CHARS} 字符；完整内容仍以固定 Source snapshot 中 note_desc 文件为准。`);

  const record = {
    schema_version: 'interview-note-issue.v2',
    interview_note_id: interviewNoteId,
    source: { system: 'xhs', external_id: candidate.note_id, url: null },
    source_revision: {
      id: sourceRevisionId,
      captured_at: capturedAt,
      source_repository: 'liqiangcc/xhs',
      source_repository_ref: sourceRef,
      reason: 'full chronological XHS intake migration',
    },
    source_published_at: candidate.source_published_at,
    source_edited_at: candidate.source_edited_at,
    interview_occurred_at: candidate.interview_occurred_at,
    artifacts: candidate.artifacts,
    limitations,
  };

  const artifactLines = candidate.artifacts.length
    ? candidate.artifacts.map((item) => `- \`${item.kind}\` — \`${item.ref}\` — blob \`${item.git_blob_sha}\``).join('\n')
    : '- 当前未登记到可解析 artifact；等待 Source review。';
  const limitationLines = limitations.map((item) => `- ${item}`).join('\n');
  const derivedLines = [
    `- \`liqiangcc/xhs:note_img_txt/${candidate.note_id}.txt@${sourceRef}\`（如存在，Derived OCR）`,
    `- \`liqiangcc/xhs:note_structured/${candidate.note_id}.json@${sourceRef}\`（如存在，Derived）`,
    `- \`liqiangcc/xhs:note_tagged/${candidate.note_id}.json@${sourceRef}\`（如存在，Derived）`,
  ].join('\n');

  const body = `<!-- interview-note: id=${interviewNoteId} schema=interview-note-issue.v2 -->\n<!-- interview-note-record\n${JSON.stringify(record, null, 2)}\n-->\n\n## 来源身份\n\n- 来源系统：XHS\n- External source id：\`${candidate.note_id}\`\n- InterviewNote id：\`${interviewNoteId}\`\n- SourceRevision：\`${sourceRevisionId}\`\n- 固定 Source snapshot：\`liqiangcc/xhs@${sourceRef}\`\n- 来源发布时间：\`${candidate.source_published_at.value || 'unknown'}\`\n- 来源更新时间：\`${candidate.source_edited_at.value || 'unknown'}\`\n- 实际面试发生时间：\`unknown\`（intake 阶段不推断）\n\n## 原始标题\n\n${candidate.original_title || '（来源标题为空）'}\n\n## 原始正文\n\n### 可读 Source projection — \`note_desc\`\n\n${desc ? quoteMarkdown(desc) : '（当前缺失）'}\n\n## 原始附件\n\n${artifactLines}\n\n## 来源限制\n\n${limitationLines}\n\n## 派生链接\n\n${derivedLines}\n`;

  return {
    interview_note_id: interviewNoteId,
    title: `[XHS] ${displayPublishedDate(candidate.source_published_at)} · ${candidate.note_id.slice(0, 8)}`,
    body,
    labels: [...DEFAULT_LABELS],
    source_published_at: candidate.source_published_at,
  };
}

function extractInterviewNoteId(body) {
  const match = String(body || '').match(/<!--\s*interview-note:\s*id=([^\s]+)\s+schema=interview-note-issue\.v\d+\s*-->/);
  return match ? match[1] : null;
}

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  if (value.length && Array.isArray(value[0])) return value.flat();
  return value;
}

function ghJson(args, input = null) {
  const raw = execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function loadExistingInterviewNoteIds(targetRepo) {
  const issues = flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${targetRepo}/issues?state=all&per_page=100`]));
  const byId = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const id = extractInterviewNoteId(issue.body);
    if (id) byId.set(id, issue.number);
  }
  return byId;
}

function validateProjection(projection) {
  return validateInterviewNoteIssue({ body: projection.body, labels: projection.labels, state: 'open' });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function ensureBulkMigrationLabel(targetRepo) {
  const labels = flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${targetRepo}/labels?per_page=100`]));
  if (!labels.some((label) => label.name === BULK_MIGRATION_LABEL)) {
    ghJson(['api', '--method', 'POST', `repos/${targetRepo}/labels`, '--input', '-'], {
      name: BULK_MIGRATION_LABEL,
      color: 'ededed',
      description: 'XHS 全量 intake；已通过 batch preflight，进入 Source review 时移除',
    });
  }
}

function loadGraphqlTarget(targetRepo) {
  const repo = ghJson(['api', `repos/${targetRepo}`]);
  const labels = flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${targetRepo}/labels?per_page=100`]));
  const byName = new Map(labels.map((label) => [label.name, label.node_id]));
  const labelIds = DEFAULT_LABELS.map((name) => {
    const id = byName.get(name);
    if (!id) throw new Error(`required label does not exist: ${name}`);
    return id;
  });
  return { repositoryId: repo.node_id, labelIds };
}

function buildCreateIssueMutation(projections, repositoryId, labelIds) {
  const variableDefs = [];
  const fields = [];
  const variables = {};
  projections.forEach((projection, index) => {
    const variableName = `input${index}`;
    variableDefs.push(`$${variableName}: CreateIssueInput!`);
    fields.push(`i${index}: createIssue(input: $${variableName}) { issue { number } }`);
    variables[variableName] = {
      repositoryId,
      title: projection.title,
      body: projection.body,
      labelIds,
    };
  });
  return {
    query: `mutation(${variableDefs.join(', ')}) { ${fields.join(' ')} }`,
    variables,
  };
}

function createIssueBatch(projections, repositoryId, labelIds) {
  const request = buildCreateIssueMutation(projections, repositoryId, labelIds);
  const response = ghJson(['api', 'graphql', '--input', '-'], request);
  if (response.errors && response.errors.length) {
    throw new Error(`GraphQL createIssue failed: ${JSON.stringify(response.errors)}`);
  }
  return projections.map((projection, index) => {
    const item = response.data && response.data[`i${index}`];
    const number = item && item.issue && item.issue.number;
    if (!number) throw new Error(`GraphQL createIssue returned no issue number for ${projection.interview_note_id}`);
    return { projection, issue_number: number };
  });
}

function summarize(projections, existingById, sourceRef) {
  const known = projections.filter((item) => item.source_published_at.precision !== 'unknown');
  const unknown = projections.length - known.length;
  const toCreate = projections.filter((item) => !existingById.has(item.interview_note_id));
  return {
    schema_version: 'xhs-full-migration-report.v1',
    source_repository: 'liqiangcc/xhs',
    source_ref: sourceRef,
    creation_order: 'source_published_at ASC, note_id ASC tie-breaker, unknown-time last',
    total_candidates: projections.length,
    known_published_at: known.length,
    unknown_published_at: unknown,
    existing_preserved: projections.length - toCreate.length,
    to_create: toCreate.length,
    earliest_known_published_at: known.length ? known[0].source_published_at.value : null,
    latest_known_published_at: known.length ? known[known.length - 1].source_published_at.value : null,
  };
}

function writeReport(reportPath, report) {
  if (reportPath) fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
}

function chunk(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function main() {
  const args = parseArgs();
  const sourceRoot = path.resolve(args.sourceRoot);
  const sourceRef = resolveSourceRef(sourceRoot, args.sourceRef);
  const capturedAt = process.env.MIGRATION_CAPTURED_AT || new Date().toISOString();
  const candidates = listCandidates(sourceRoot, sourceRef);
  const projections = candidates.map((candidate) => buildIssueProjection(candidate, sourceRef, capturedAt));

  const invalid = [];
  for (const projection of projections) {
    const result = validateProjection(projection);
    if (!result.ok) invalid.push({ interview_note_id: projection.interview_note_id, errors: result.errors });
  }
  if (invalid.length) {
    const report = { preflight: 'failed', invalid };
    writeReport(args.report, report);
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    return 1;
  }

  const existingById = loadExistingInterviewNoteIds(args.targetRepo);
  const summary = summarize(projections, existingById, sourceRef);
  const operations = [];
  for (const projection of projections) {
    const existingIssue = existingById.get(projection.interview_note_id);
    if (existingIssue) operations.push({ interview_note_id: projection.interview_note_id, action: 'existing-preserved', issue_number: existingIssue });
  }

  const pending = projections.filter((projection) => !existingById.has(projection.interview_note_id));
  const report = {
    ...summary,
    apply: args.apply,
    batch_size: GRAPHQL_BATCH_SIZE,
    operations,
    created_this_run: 0,
    remaining_after_run: pending.length,
    failure: null,
  };

  if (!args.apply) {
    for (const projection of pending) {
      operations.push({
        interview_note_id: projection.interview_note_id,
        action: 'would-create',
        issue_number: null,
        source_published_at: projection.source_published_at,
      });
    }
    writeReport(args.report, report);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }

  ensureBulkMigrationLabel(args.targetRepo);
  const target = loadGraphqlTarget(args.targetRepo);
  const batches = chunk(pending, GRAPHQL_BATCH_SIZE);

  try {
    for (const batch of batches) {
      const created = createIssueBatch(batch, target.repositoryId, target.labelIds);
      for (const item of created) {
        operations.push({
          interview_note_id: item.projection.interview_note_id,
          action: 'created',
          issue_number: item.issue_number,
          source_published_at: item.projection.source_published_at,
        });
        existingById.set(item.projection.interview_note_id, item.issue_number);
        report.created_this_run += 1;
        report.remaining_after_run -= 1;
      }
      writeReport(args.report, report);
      sleepMs(GRAPHQL_BATCH_PAUSE_MS);
    }
  } catch (error) {
    report.failure = String(error.message || error);
    writeReport(args.report, report);
    process.stderr.write(`${JSON.stringify({ ...summary, created_this_run: report.created_this_run, remaining_after_run: report.remaining_after_run, failure: report.failure }, null, 2)}\n`);
    return 1;
  }

  writeReport(args.report, report);
  process.stdout.write(`${JSON.stringify({ ...summary, created_this_run: report.created_this_run, remaining_after_run: report.remaining_after_run }, null, 2)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  BULK_MIGRATION_LABEL,
  DEFAULT_LABELS,
  findNoteObject,
  epochToShanghaiTimeFact,
  sortByPublishedAt,
  buildIssueProjection,
  extractInterviewNoteId,
  buildCreateIssueMutation,
  summarize,
};
