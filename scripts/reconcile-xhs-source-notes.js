#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseSourceNoteIssue, validateSourceNoteIssue, yearFromTimeFact } = require('./lib/source-note-issue');

const BULK_LABEL = 'migration:xhs-bulk';
const SOURCE_NOTE_LABELS = [
  'type:source-note',
  'source:xhs',
  'status:captured',
  'boundary:pending',
  'task:boundary-review',
  BULK_LABEL,
];
const MAX_DESC_CHARS = 8000;
const MAX_IMAGE_ARTIFACTS = 20;
const MUTATING_ACTIONS = new Set([
  'reconcile-source-note-labels',
  'reconcile-source-note-discovery-labels',
  'convert-bulk-interview-note-in-place',
  'create-source-note',
  'create-source-note-alongside-formal-interview-note',
]);

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    apply: false,
    sourceRoot: null,
    sourceRef: null,
    targetRepo: process.env.GITHUB_REPOSITORY || null,
    report: null,
    maxMutations: 100,
    pauseMs: 10000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') out.apply = true;
    else if (arg === '--source-root') out.sourceRoot = argv[++i];
    else if (arg === '--source-ref') out.sourceRef = argv[++i];
    else if (arg === '--target-repo') out.targetRepo = argv[++i];
    else if (arg === '--report') out.report = argv[++i];
    else if (arg === '--max-mutations') out.maxMutations = Number(argv[++i]);
    else if (arg === '--pause-ms') out.pauseMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.sourceRoot) throw new Error('--source-root is required');
  if (!out.targetRepo) throw new Error('--target-repo is required');
  if (!Number.isInteger(out.maxMutations) || out.maxMutations < 0) throw new Error('--max-mutations must be a non-negative integer');
  if (!Number.isInteger(out.pauseMs) || out.pauseMs < 0) throw new Error('--pause-ms must be a non-negative integer');
  return out;
}

function gitOutput(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function ghJson(args, input = null) {
  const raw = execFileSync('gh', args, {
    input: input == null ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(raw);
}

function flattenPages(value) {
  if (!Array.isArray(value)) return [];
  if (value.length && Array.isArray(value[0])) return value.flat();
  return value;
}

function sleepMs(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  const absolute = path.join(sourceRoot, relativePath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  const gitBlobSha = gitObjectSha(sourceRoot, sourceRef, relativePath);
  if (!gitBlobSha) return null;
  const byteSize = fs.statSync(absolute).size;
  return {
    kind,
    ref: `liqiangcc/xhs:${relativePath}@${sourceRef}`,
    git_blob_sha: gitBlobSha,
    sha256: null,
    provenance,
    byte_size: byteSize,
    integrity: byteSize === 0 ? 'zero-byte' : 'present',
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
  const anomalies = [];

  if (!note) limitations.push('未在 note_json 中解析到与 external id 完全匹配的 note object；来源级 metadata 待人工复核。');
  if (sourcePublishedAt.precision === 'unknown') limitations.push('source_published_at 未能从来源 note.time 确认；排序时进入 unknown-time 尾部。');
  if (!desc) limitations.push('note_desc readable projection 缺失；SourceNote 只登记现有 Source artifact。');

  const artifacts = [];
  const add = (item) => { if (item) artifacts.push(item); };
  add(artifact(sourceRoot, sourceRef, 'html', `note_detail/${noteId}.html`, 'raw_capture'));
  add(artifact(sourceRoot, sourceRef, 'image_reference', `note_images/${noteId}_urls.txt`, 'raw_capture'));
  const imagePaths = listImagePaths(sourceRoot, noteId);
  for (const imagePath of imagePaths.slice(0, MAX_IMAGE_ARTIFACTS)) add(artifact(sourceRoot, sourceRef, 'image', imagePath, 'raw_capture'));
  if (imagePaths.length > MAX_IMAGE_ARTIFACTS) {
    limitations.push(`Raw image 共 ${imagePaths.length} 个；intake 只登记前 ${MAX_IMAGE_ARTIFACTS} 个，完整目录留待后续审核。`);
  }
  add(artifact(sourceRoot, sourceRef, 'json', noteJsonPath, 'source_projection'));
  add(artifact(sourceRoot, sourceRef, 'text_projection', descPath, 'source_projection'));

  const zeroByte = artifacts.filter((item) => item.byte_size === 0);
  if (zeroByte.length) {
    anomalies.push({
      code: 'zero-byte-artifacts',
      detail: `${zeroByte.length} artifact(s) are zero-byte in the pinned source snapshot`,
    });
  }
  const publishedMs = sourcePublishedAt.value ? Date.parse(sourcePublishedAt.value) : NaN;
  const editedMs = sourceEditedAt.value ? Date.parse(sourceEditedAt.value) : NaN;
  if (!Number.isNaN(publishedMs) && !Number.isNaN(editedMs) && editedMs < publishedMs) {
    anomalies.push({
      code: 'edited-before-published',
      detail: `source_edited_at ${sourceEditedAt.value} is earlier than source_published_at ${sourcePublishedAt.value}`,
    });
  }

  limitations.push('SourceNote intake 只证明一条 XHS Source 的采集身份，不判断它是否等于一次真实面试事件。');
  limitations.push('题库、经验总结、模拟面试、非目标岗位以及一帖多场面试都允许进入 SourceNote；必须经过 boundary review 才能产生 0..N InterviewNote。');
  limitations.push('note_img_txt / note_structured / note_tagged 等历史数据属于 Derived，不得反向补写 Raw Source。');

  return {
    note_id: noteId,
    original_title: title,
    readable_desc: desc || '',
    source_published_at: sourcePublishedAt,
    source_edited_at: sourceEditedAt,
    artifacts,
    anomalies,
    limitations,
  };
}

function listCandidates(sourceRoot, sourceRef) {
  const dir = path.join(sourceRoot, 'note_json');
  if (!fs.existsSync(dir)) throw new Error(`missing source directory: ${dir}`);
  const paths = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.posix.join('note_json', name));
  return sortByPublishedAt(paths.map((noteJsonPath) => extractCandidate(sourceRoot, sourceRef, noteJsonPath)));
}

function displayDate(timeFact) {
  if (!timeFact || timeFact.precision === 'unknown' || !timeFact.value) return '发布时间未知';
  return String(timeFact.value).slice(0, 10);
}

function quoteMarkdown(value) {
  return String(value || '').replace(/\r\n/g, '\n').split('\n').map((line) => `> ${line}`).join('\n');
}

function labelsForSourceNote(timeFact) {
  const labels = [...SOURCE_NOTE_LABELS];
  const year = yearFromTimeFact(timeFact);
  if (year) labels.push(`source-year:${year}`);
  return labels;
}

function buildProjection(candidate, sourceRef, capturedAt) {
  const sourceNoteId = `xhs-note:${candidate.note_id}`;
  const sourceRevisionId = `${sourceNoteId}:snapshot-${sourceRef.slice(0, 12)}`;
  const descWasTruncated = candidate.readable_desc.length > MAX_DESC_CHARS;
  const desc = candidate.readable_desc.slice(0, MAX_DESC_CHARS);
  const limitations = [...candidate.limitations];
  if (descWasTruncated) limitations.push(`Issue 中 readable projection 截断到 ${MAX_DESC_CHARS} 字符；完整内容以固定 Source snapshot 为准。`);

  const record = {
    schema_version: 'source-note-issue.v1',
    source_note_id: sourceNoteId,
    source: { system: 'xhs', external_id: candidate.note_id, url: null },
    source_revision: {
      id: sourceRevisionId,
      captured_at: capturedAt,
      source_repository: 'liqiangcc/xhs',
      source_repository_ref: sourceRef,
      reason: 'full chronological XHS SourceNote intake migration',
    },
    source_published_at: candidate.source_published_at,
    source_edited_at: candidate.source_edited_at,
    artifacts: candidate.artifacts,
    anomalies: candidate.anomalies,
    limitations,
    boundary_review: {
      status: 'pending',
      reviewed_at: null,
      interview_note_ids: [],
    },
  };

  const artifactLines = candidate.artifacts.length
    ? candidate.artifacts.map((item) => `- \`${item.kind}\` — \`${item.integrity}\` — ${item.byte_size} bytes — \`${item.ref}\` — blob \`${item.git_blob_sha}\``).join('\n')
    : '- 当前未登记到可解析 artifact；等待 Source review。';
  const anomalyLines = candidate.anomalies.length
    ? candidate.anomalies.map((item) => `- \`${item.code}\` — ${item.detail}`).join('\n')
    : '- 无 intake-level anomaly。';
  const limitationLines = limitations.map((item) => `- ${item}`).join('\n');
  const derivedLines = [
    `- \`liqiangcc/xhs:note_img_txt/${candidate.note_id}.txt@${sourceRef}\`（如存在，Derived OCR）`,
    `- \`liqiangcc/xhs:note_structured/${candidate.note_id}.json@${sourceRef}\`（如存在，Derived）`,
    `- \`liqiangcc/xhs:note_tagged/${candidate.note_id}.json@${sourceRef}\`（如存在，Derived）`,
  ].join('\n');

  const body = `<!-- source-note: id=${sourceNoteId} schema=source-note-issue.v1 -->\n<!-- source-note-record\n${JSON.stringify(record, null, 2)}\n-->\n\n## 来源身份\n\n- 来源系统：XHS\n- External source id：\`${candidate.note_id}\`\n- SourceNote id：\`${sourceNoteId}\`\n- SourceRevision：\`${sourceRevisionId}\`\n- 固定 Source snapshot：\`liqiangcc/xhs@${sourceRef}\`\n- 来源发布时间：\`${candidate.source_published_at.value || 'unknown'}\`\n- 来源更新时间：\`${candidate.source_edited_at.value || 'unknown'}\`\n\n## 原始标题\n\n${candidate.original_title || '（来源标题为空）'}\n\n## 原始正文\n\n### 可读 Source projection — \`note_desc\`\n\n${desc ? quoteMarkdown(desc) : '（当前缺失）'}\n\n## 原始附件\n\n${artifactLines}\n\n## Intake 异常\n\n${anomalyLines}\n\n## 边界审核\n\n- 状态：\`pending\`\n- 当前不判断该 Source 是 0、1 还是多个真实 InterviewNote。\n- 审核完成后才允许建立 InterviewNote identity。\n\n## 来源限制\n\n${limitationLines}\n\n## 派生链接\n\n${derivedLines}\n`;

  return {
    source_note_id: sourceNoteId,
    external_id: candidate.note_id,
    title: `[XHS Source] ${displayDate(candidate.source_published_at)} · ${candidate.note_id.slice(0, 8)}`,
    body,
    labels: labelsForSourceNote(candidate.source_published_at),
    source_published_at: candidate.source_published_at,
  };
}

function extractMarker(body, kind) {
  return extractMarkers(body, kind)[0] || null;
}

function extractMarkers(body, kind) {
  const markerName = kind === 'source-note' ? 'source-note' : 'interview-note';
  const pattern = new RegExp(`<!--\\s*${markerName}:\\s*id=([^\\s]+)\\s+schema=${markerName}-issue\\.v\\d+\\s*-->`, 'g');
  return [...String(body || '').matchAll(pattern)].map((match) => match[1]);
}

function normalizeIssueLabels(issue) {
  const rawLabels = issue && issue.labels
    ? (Array.isArray(issue.labels) ? issue.labels : issue.labels.nodes || [])
    : [];
  return rawLabels
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(Boolean);
}

function expectedSourceYearLabel(projection) {
  return projection.labels.find((label) => label.startsWith('source-year:')) || null;
}

function reconcileSourceYearLabels(issue, projection) {
  const current = normalizeIssueLabels(issue);
  const currentYearLabels = current.filter((label) => label.startsWith('source-year:'));
  const expected = expectedSourceYearLabel(projection);
  const isCurrent = expected == null
    ? currentYearLabels.length === 0
    : currentYearLabels.length === 1 && currentYearLabels[0] === expected;
  if (isCurrent) return null;

  const reconciled = current.filter((label) => !label.startsWith('source-year:'));
  if (expected) reconciled.push(expected);
  return reconciled;
}

function sourceNoteManagedLabel(label) {
  return label === 'type:source-note'
    || label === 'type:interview-note'
    || label === 'source:xhs'
    || label === 'status:captured'
    || label === 'task:boundary-review'
    || label === BULK_LABEL
    || label.startsWith('boundary:')
    || label.startsWith('source-year:');
}

function repairableSourceNoteLabels(issue, sourceNoteId) {
  const parsed = parseSourceNoteIssue(issue.body);
  if (parsed.markerMatches.length !== 1 || parsed.markerMatches[0][1] !== sourceNoteId || !parsed.record) return null;
  if (extractMarkers(issue.body, 'interview-note').length) return null;
  const boundaryStatus = parsed.record.boundary_review && parsed.record.boundary_review.status;
  if (!boundaryStatus) return null;
  const labels = normalizeIssueLabels(issue).filter((label) => !sourceNoteManagedLabel(label));
  labels.push('type:source-note', 'source:xhs', 'status:captured', `boundary:${boundaryStatus}`);
  if (boundaryStatus === 'pending') labels.push('task:boundary-review');
  if (normalizeIssueLabels(issue).includes(BULK_LABEL)) labels.push(BULK_LABEL);
  const sourceYear = yearFromTimeFact(parsed.record.source_published_at);
  if (sourceYear) labels.push(`source-year:${sourceYear}`);
  const validation = validateSourceNoteIssue({ body: issue.body, labels, state: issue.state });
  return validation.ok ? labels : null;
}

function buildInventory(issues) {
  const sourceNotes = new Map();
  const bulkLegacy = new Map();
  const protectedInterview = new Map();
  const invalidSourceNotes = [];
  const repairableSourceNotes = [];
  const sourceNoteOccurrences = new Map();
  const interviewOwnership = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    const labels = new Set(normalizeIssueLabels(issue));
    const sourceNoteIds = extractMarkers(issue.body, 'source-note');
    if (sourceNoteIds.length) {
      for (const sourceNoteId of sourceNoteIds) {
        const occurrences = sourceNoteOccurrences.get(sourceNoteId) || [];
        occurrences.push(issue.number);
        sourceNoteOccurrences.set(sourceNoteId, occurrences);
      }
      const validation = sourceNoteIds.length === 1
        ? validateSourceNoteIssue({ body: issue.body, labels: [...labels], state: issue.state })
        : { ok: false, errors: [`expected exactly one source-note machine marker, found ${sourceNoteIds.length}`] };
      if (extractMarkers(issue.body, 'interview-note').length) {
        validation.ok = false;
        validation.errors = [...(validation.errors || []), 'SourceNote must not also contain an InterviewNote machine marker'];
      }
      if (!validation.ok) {
        const sourceNoteId = sourceNoteIds.length === 1 ? sourceNoteIds[0] : null;
        const repairedLabels = sourceNoteId ? repairableSourceNoteLabels(issue, sourceNoteId) : null;
        if (repairedLabels) {
          const repairedIssue = { ...issue, reconciliation_labels: repairedLabels };
          sourceNotes.set(sourceNoteId, repairedIssue);
          repairableSourceNotes.push({ issue_number: issue.number, source_note_id: sourceNoteId, labels: repairedLabels });
          continue;
        }
        invalidSourceNotes.push({ issue_number: issue.number, source_note_ids: sourceNoteIds, errors: validation.errors });
        continue;
      }
      const sourceNoteId = sourceNoteIds[0];
      if (!sourceNotes.has(sourceNoteId)) sourceNotes.set(sourceNoteId, issue);
      continue;
    }
    const interviewNoteIds = extractMarkers(issue.body, 'interview-note');
    if (interviewNoteIds.length !== 1 || !interviewNoteIds[0].startsWith('xhs:')) continue;
    const interviewNoteId = interviewNoteIds[0];
    const externalId = interviewNoteId.slice('xhs:'.length);
    const ownership = interviewOwnership.get(externalId) || { bulk: [], formal: [] };
    if (labels.has(BULK_LABEL)) {
      ownership.bulk.push(issue);
      if (!bulkLegacy.has(externalId)) bulkLegacy.set(externalId, issue);
    } else {
      ownership.formal.push(issue);
      if (!protectedInterview.has(externalId)) protectedInterview.set(externalId, issue);
    }
    interviewOwnership.set(externalId, ownership);
  }
  const duplicateSourceNotes = new Map([...sourceNoteOccurrences.entries()]
    .filter(([, issueNumbers]) => issueNumbers.length > 1));
  const interviewOwnershipConflicts = [...interviewOwnership.entries()]
    .filter(([, owners]) => owners.bulk.length + owners.formal.length > 1)
    .map(([externalId, owners]) => ({
      external_id: externalId,
      bulk_issue_numbers: owners.bulk.map((issue) => issue.number),
      formal_issue_numbers: owners.formal.map((issue) => issue.number),
    }));
  return {
    sourceNotes,
    bulkLegacy,
    protectedInterview,
    invalidSourceNotes,
    repairableSourceNotes,
    duplicateSourceNotes,
    interviewOwnershipConflicts,
  };
}

function loadInventory(targetRepo) {
  const issues = flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${targetRepo}/issues?state=all&per_page=100`]));
  return buildInventory(issues);
}

function inventoryReconciliationSummary(projections, inventory) {
  const accounted = projections.filter((projection) => (
    inventory.sourceNotes.has(projection.source_note_id)
    || inventory.bulkLegacy.has(projection.external_id)
    || inventory.protectedInterview.has(projection.external_id)
  ));
  return {
    total_candidates: projections.length,
    accounted_source_id: accounted.length,
    unaccounted_source_id: projections.length - accounted.length,
    duplicate_source_note: inventory.duplicateSourceNotes.size,
    invalid_source_note: inventory.invalidSourceNotes.length + inventory.repairableSourceNotes.length,
    repairable_invalid_source_note: inventory.repairableSourceNotes.length,
    unrepairable_invalid_source_note: inventory.invalidSourceNotes.length,
    protected_formal_interview_note: projections.filter((projection) => inventory.protectedInterview.has(projection.external_id)).length,
    interview_ownership_conflict: inventory.interviewOwnershipConflicts.length,
  };
}

function inventoryGateErrors(summary) {
  const errors = [];
  if (summary.unaccounted_source_id) errors.push(`unaccounted_source_id=${summary.unaccounted_source_id}`);
  if (summary.duplicate_source_note) errors.push(`duplicate_source_note=${summary.duplicate_source_note}`);
  if (summary.unrepairable_invalid_source_note) errors.push(`invalid_source_note=${summary.unrepairable_invalid_source_note}`);
  if (summary.interview_ownership_conflict) errors.push(`interview_ownership_conflict=${summary.interview_ownership_conflict}`);
  return errors;
}

function planActions(projections, inventory) {
  return projections.map((projection) => {
    const existingSource = inventory.sourceNotes.get(projection.source_note_id);
    if (existingSource) {
      if (existingSource.reconciliation_labels) {
        return {
          action: 'reconcile-source-note-labels',
          issue_number: existingSource.number,
          reconciled_labels: existingSource.reconciliation_labels,
          projection,
        };
      }
      const reconciledLabels = reconcileSourceYearLabels(existingSource, projection);
      if (reconciledLabels) {
        return {
          action: 'reconcile-source-note-discovery-labels',
          issue_number: existingSource.number,
          reconciled_labels: reconciledLabels,
          projection,
        };
      }
      return { action: 'source-note-current', issue_number: existingSource.number, projection };
    }
    const legacy = inventory.bulkLegacy.get(projection.external_id);
    if (legacy) {
      return { action: 'convert-bulk-interview-note-in-place', issue_number: legacy.number, projection };
    }
    const formal = inventory.protectedInterview.get(projection.external_id);
    if (formal) {
      return {
        action: 'create-source-note-alongside-formal-interview-note',
        issue_number: null,
        protected_interview_issue_number: formal.number,
        projection,
      };
    }
    return { action: 'create-source-note', issue_number: null, projection };
  });
}

function validateProjection(projection) {
  return validateSourceNoteIssue({ body: projection.body, labels: projection.labels, state: 'open' });
}

function ensureProjectionLabels(targetRepo, projections) {
  const labels = flattenPages(ghJson(['api', '--paginate', '--slurp', `repos/${targetRepo}/labels?per_page=100`]));
  const existing = new Set(labels.map((label) => label.name));
  const required = new Set(projections.flatMap((projection) => projection.labels));
  for (const name of required) {
    if (existing.has(name)) continue;
    ghJson(['api', '--method', 'POST', `repos/${targetRepo}/labels`, '--input', '-'], {
      name,
      color: name.startsWith('source-year:') ? '1f883d' : 'ededed',
      description: name.startsWith('source-year:')
        ? '来源发布时间年份索引'
        : 'SourceNote intake / boundary workflow label',
    });
    existing.add(name);
  }
}

function createSourceNote(targetRepo, projection) {
  const created = ghJson(['api', '--method', 'POST', `repos/${targetRepo}/issues`, '--input', '-'], {
    title: projection.title,
    body: projection.body,
    labels: projection.labels,
  });
  return created.number;
}

function mutateAction(targetRepo, action) {
  if (action.action === 'reconcile-source-note-labels'
      || action.action === 'reconcile-source-note-discovery-labels') {
    ghJson(['api', '--method', 'PATCH', `repos/${targetRepo}/issues/${action.issue_number}`, '--input', '-'], {
      labels: action.reconciled_labels,
    });
    return action.issue_number;
  }
  if (action.action === 'convert-bulk-interview-note-in-place') {
    ghJson(['api', '--method', 'PATCH', `repos/${targetRepo}/issues/${action.issue_number}`, '--input', '-'], {
      title: action.projection.title,
      body: action.projection.body,
      labels: action.projection.labels,
    });
    return action.issue_number;
  }
  if (action.action === 'create-source-note'
      || action.action === 'create-source-note-alongside-formal-interview-note') {
    return createSourceNote(targetRepo, action.projection);
  }
  return action.issue_number;
}

function summarize(actions) {
  const counts = {};
  for (const action of actions) counts[action.action] = (counts[action.action] || 0) + 1;
  return counts;
}

function summarizeAnomalies(candidates) {
  const counts = {};
  for (const candidate of candidates) {
    for (const anomaly of candidate.anomalies || []) {
      counts[anomaly.code] = (counts[anomaly.code] || 0) + 1;
    }
  }
  return counts;
}

function writeReport(report, reportPath) {
  if (reportPath) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function main() {
  const args = parseArgs();
  const sourceRef = gitOutput(['-C', args.sourceRoot, 'rev-parse', args.sourceRef || 'HEAD']);
  const capturedAt = new Date().toISOString();
  const candidates = listCandidates(args.sourceRoot, sourceRef);
  const projections = candidates.map((candidate) => buildProjection(candidate, sourceRef, capturedAt));

  const validationErrors = [];
  for (const projection of projections) {
    const result = validateProjection(projection);
    if (!result.ok) validationErrors.push({ source_note_id: projection.source_note_id, errors: result.errors });
  }
  if (validationErrors.length) {
    const report = { source_ref: sourceRef, total: projections.length, validation_errors: validationErrors };
    writeReport(report, args.report);
    throw new Error(`SourceNote projection preflight failed for ${validationErrors.length} candidate(s)`);
  }

  const inventory = loadInventory(args.targetRepo);
  const inventorySummary = inventoryReconciliationSummary(projections, inventory);
  const gateErrors = inventoryGateErrors(inventorySummary);
  if (gateErrors.length) {
    const report = {
      schema_version: 'xhs-source-note-reconciliation-report.v1',
      generated_at: new Date().toISOString(),
      source_ref: sourceRef,
      ...inventorySummary,
      inventory_gate: 'blocked',
      gate_errors: gateErrors,
      invalid_source_notes: inventory.invalidSourceNotes,
      repairable_invalid_source_notes: inventory.repairableSourceNotes,
      duplicate_source_notes: Object.fromEntries(inventory.duplicateSourceNotes),
      interview_ownership_conflicts: inventory.interviewOwnershipConflicts,
    };
    writeReport(report, args.report);
    throw new Error(`SourceNote inventory preflight failed closed: ${gateErrors.join(', ')}`);
  }
  const actions = planActions(projections, inventory);
  const mutating = actions.filter((action) => MUTATING_ACTIONS.has(action.action));
  const selected = args.apply ? mutating.slice(0, args.maxMutations) : [];
  const applied = [];
  if (args.apply && selected.length) ensureProjectionLabels(args.targetRepo, selected.map((action) => action.projection));
  for (const action of selected) {
    const issueNumber = mutateAction(args.targetRepo, action);
    applied.push({
      action: action.action,
      issue_number: issueNumber,
      protected_interview_issue_number: action.protected_interview_issue_number || null,
      source_note_id: action.projection.source_note_id,
    });
    sleepMs(args.pauseMs);
  }

  const report = {
    schema_version: 'xhs-source-note-reconciliation-report.v1',
    generated_at: new Date().toISOString(),
    source_ref: sourceRef,
    ...inventorySummary,
    inventory_gate: 'pass',
    source_total: projections.length,
    source_note_target_total: projections.length,
    source_published_at_known: projections.filter((item) => item.source_published_at.precision !== 'unknown').length,
    source_published_at_unknown: projections.filter((item) => item.source_published_at.precision === 'unknown').length,
    anomaly_counts: summarizeAnomalies(candidates),
    action_counts: summarize(actions),
    mutation_candidates: mutating.length,
    applied_count: applied.length,
    remaining_mutations_after_run: Math.max(0, mutating.length - applied.length),
    final_dry_run_ready: mutating.length === 0,
    first_mutation: mutating[0] ? {
      action: mutating[0].action,
      source_note_id: mutating[0].projection.source_note_id,
      source_published_at: mutating[0].projection.source_published_at,
      protected_interview_issue_number: mutating[0].protected_interview_issue_number || null,
    } : null,
    applied,
  };
  writeReport(report, args.report);
}

if (require.main === module) main();

module.exports = {
  SOURCE_NOTE_LABELS,
  MUTATING_ACTIONS,
  extractCandidate,
  listCandidates,
  buildProjection,
  normalizeIssueLabels,
  extractMarker,
  extractMarkers,
  buildInventory,
  inventoryReconciliationSummary,
  inventoryGateErrors,
  reconcileSourceYearLabels,
  planActions,
  validateProjection,
  summarizeAnomalies,
};
