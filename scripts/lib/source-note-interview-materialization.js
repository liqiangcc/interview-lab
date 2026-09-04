'use strict';

const crypto = require('crypto');
const { parseSourceNoteIssue, validateSourceNoteIssue } = require('./source-note-issue');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./interview-note-issue');

const SCHEMA_VERSION = 'source-note-interview-materialization.v1';
const MARKER_RE = /<!--\s*source-note-interview-materialization\s*([\s\S]*?)-->/g;
const RECEIPT_RE = /<!--\s*source-note-interview-materialized\s*([\s\S]*?)-->/g;
const INTERVIEW_ALLOWED_KINDS = new Set(['html', 'json', 'text_projection', 'image', 'image_reference', 'other']);

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestSha256(request) {
  return sha256Text(canonicalJson(request));
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseMaterializationRequest(body) {
  const matches = [...String(body || '').matchAll(MARKER_RE)];
  const errors = [];
  if (matches.length !== 1) {
    errors.push('request must contain exactly one source-note-interview-materialization marker');
    return { request: null, errors };
  }
  try {
    return { request: JSON.parse(matches[0][1].trim()), errors };
  } catch (error) {
    errors.push(`materialization marker must contain valid JSON: ${error.message}`);
    return { request: null, errors };
  }
}

function parseMaterializationReceipts(comments) {
  const receipts = [];
  for (const comment of comments || []) {
    const matches = [...String(comment.body || '').matchAll(RECEIPT_RE)];
    for (const match of matches) {
      try {
        receipts.push({ ...JSON.parse(match[1].trim()), comment_id: Number(comment.id) });
      } catch (_) {
        // Invalid receipts are ignored here; ownership validation is driven by live Issue state.
      }
    }
  }
  return receipts;
}

function validateRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, errors: ['materialization request must be an object'] };
  }
  const allowed = new Set([
    'schema_version', 'materialization_id', 'repository', 'source_note_issue_number', 'source_note_id',
    'expected_source_note_body_sha256', 'expected_boundary_status', 'expected_source_revision_id',
    'expected_manifest_sha256', 'expected_source_repository_ref',
  ]);
  for (const key of Object.keys(request)) if (!allowed.has(key)) errors.push(`unsupported request field: ${key}`);
  if (request.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isNonEmptyString(request.materialization_id)) errors.push('materialization_id must be a non-empty string');
  if (!/^[^/]+\/[^/]+$/.test(String(request.repository || ''))) errors.push('repository must be owner/repo');
  if (!Number.isInteger(request.source_note_issue_number) || request.source_note_issue_number < 1) errors.push('source_note_issue_number must be a positive integer');
  if (!isNonEmptyString(request.source_note_id)) errors.push('source_note_id must be a non-empty string');
  if (!/^[0-9a-f]{64}$/.test(String(request.expected_source_note_body_sha256 || ''))) errors.push('expected_source_note_body_sha256 must be lowercase sha256');
  if (request.expected_boundary_status !== 'single-interview') errors.push('expected_boundary_status must be single-interview');
  if (!isNonEmptyString(request.expected_source_revision_id)) errors.push('expected_source_revision_id must be a non-empty string');
  if (request.expected_manifest_sha256 != null && !/^[0-9a-f]{64}$/.test(String(request.expected_manifest_sha256))) errors.push('expected_manifest_sha256 must be null or lowercase sha256');
  if (request.expected_source_repository_ref != null && !isNonEmptyString(request.expected_source_repository_ref)) errors.push('expected_source_repository_ref must be null or non-empty');
  return { ok: errors.length === 0, errors };
}

function extractSection(body, heading) {
  const source = String(body || '');
  const marker = `${heading}\n`;
  const index = source.indexOf(marker);
  if (index < 0) return '';
  const rest = source.slice(index + marker.length);
  const next = rest.search(/^##\s/m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

function normalizeArtifact(artifact) {
  return {
    kind: INTERVIEW_ALLOWED_KINDS.has(artifact.kind) ? artifact.kind : 'other',
    ref: artifact.ref,
    git_blob_sha: artifact.git_blob_sha == null ? null : artifact.git_blob_sha,
    sha256: artifact.sha256 == null ? null : artifact.sha256,
    provenance: artifact.provenance,
  };
}

function displaySourceTime(timeFact) {
  if (!timeFact || timeFact.precision === 'unknown' || timeFact.value == null) return 'unknown';
  return String(timeFact.value);
}

function buildInterviewProjection(sourceIssue, sourceValidation) {
  const record = sourceValidation.parsed.record;
  const interviewNoteId = `${record.source.system}:${record.source.external_id}`;
  const declared = record.boundary_review.interview_note_ids || [];
  const limitations = Array.isArray(record.limitations) ? [...record.limitations] : [];
  if ((record.artifacts || []).some((artifact) => !INTERVIEW_ALLOWED_KINDS.has(artifact.kind))) {
    limitations.push('InterviewNote v2 machine artifact schema uses kind=other for SourceNote artifact kinds it cannot represent directly; original kind/sequence/size/content-type remain authoritative in the SourceNote.');
  }
  const interviewRecord = {
    schema_version: 'interview-note-issue.v2',
    interview_note_id: interviewNoteId,
    source: {
      system: record.source.system,
      external_id: record.source.external_id,
      url: record.source.url == null ? null : record.source.url,
    },
    source_revision: {
      id: record.source_revision.id,
      captured_at: record.source_revision.captured_at == null ? null : record.source_revision.captured_at,
    },
    source_published_at: record.source_published_at,
    source_edited_at: record.source_edited_at,
    interview_occurred_at: { precision: 'unknown', value: null },
    artifacts: (record.artifacts || []).map(normalizeArtifact),
    limitations,
  };

  const titleSection = extractSection(sourceIssue.body, '## 原始标题') || '（来源标题为空）';
  const bodySection = extractSection(sourceIssue.body, '## 原始正文') || '（当前 SourceNote 没有可读正文；以 Source artifact 为准。）';
  const artifactLines = (record.artifacts || []).length
    ? record.artifacts.map((artifact) => {
      const extra = [];
      if (artifact.sequence != null) extra.push(`sequence=${artifact.sequence}`);
      if (artifact.byte_size != null) extra.push(`${artifact.byte_size} bytes`);
      if (artifact.integrity) extra.push(artifact.integrity);
      return `- \`${artifact.kind}\` — \`${artifact.provenance}\` — ${extra.length ? `${extra.join(' — ')} — ` : ''}\`${artifact.ref}\`${artifact.sha256 ? ` — sha256 \`${artifact.sha256}\`` : ''}`;
    }).join('\n')
    : '- 当前未登记 Source artifact。';
  const limitationLines = limitations.length ? limitations.map((item) => `- ${item}`).join('\n') : '- 无额外 limitation。';
  const manifestSha = record.source_revision && record.source_revision.manifest_sha256 ? record.source_revision.manifest_sha256 : null;
  const sourceRef = record.source_revision && record.source_revision.source_repository_ref ? record.source_revision.source_repository_ref : null;
  const provenanceLine = manifestSha
    ? `- SourceCapture manifest SHA-256：\`${manifestSha}\``
    : sourceRef
      ? `- 固定 Source snapshot：\`${record.source_revision.source_repository || 'source'}@${sourceRef}\``
      : '- Source binding：以 SourceRevision id 为准。';

  const body = `<!-- interview-note: id=${interviewNoteId} schema=interview-note-issue.v2 -->\n<!-- interview-note-record\n${JSON.stringify(interviewRecord, null, 2)}\n-->\n\n## 来源身份\n\n- 来源系统：${String(record.source.system).toUpperCase()}\n- External source id：\`${record.source.external_id}\`\n- InterviewNote id：\`${interviewNoteId}\`\n- SourceNote：#${sourceIssue.number} / \`${record.source_note_id}\`\n- SourceRevision：\`${record.source_revision.id}\`\n${provenanceLine}\n- 来源发布时间：\`${displaySourceTime(record.source_published_at)}\`\n- 来源更新时间：\`${displaySourceTime(record.source_edited_at)}\`\n- 实际面试发生时间：\`unknown\`（materialization 不提高 Source 时间精度）\n\n## 原始标题\n\n${titleSection}\n\n## 原始正文\n\n${bodySection}\n\n## 原始附件\n\n${artifactLines}\n\n## 来源限制\n\n${limitationLines}\n\n## 派生链接\n\n- 尚未生成 InterviewContext / SourceQuestion / CanonicalQuestion / Answer；当前 Issue 只物化已审核 Source case。\n- Source evidence 根：SourceNote #${sourceIssue.number}。\n`;

  return {
    interview_note_id: interviewNoteId,
    declared_interview_note_ids: declared,
    title: `[${String(record.source.system).toUpperCase()}] ${record.source.external_id.slice(0, 8)}`,
    body,
    labels: ['type:interview-note', `source:${record.source.system}`, 'status:captured'],
    record: interviewRecord,
  };
}

function validateExistingOwnership(issue, expectedProjection) {
  const errors = [];
  const labels = (issue.labels || []).map((label) => typeof label === 'string' ? label : label.name);
  const validation = validateInterviewNoteIssue({ body: issue.body, labels, state: String(issue.state || 'open').toLowerCase() });
  if (!validation.ok) errors.push(...validation.errors.map((error) => `existing InterviewNote invalid: ${error}`));
  const parsed = validation.parsed && validation.parsed.record;
  if (parsed) {
    if (parsed.interview_note_id !== expectedProjection.interview_note_id) errors.push('existing InterviewNote identity mismatch');
    if (parsed.source.system !== expectedProjection.record.source.system || parsed.source.external_id !== expectedProjection.record.source.external_id) errors.push('existing InterviewNote source identity mismatch');
    if (!parsed.source_revision || parsed.source_revision.id !== expectedProjection.record.source_revision.id) errors.push('existing InterviewNote SourceRevision mismatch');
  }
  return { ok: errors.length === 0, errors, validation };
}

function findOwnershipMatches(issues, interviewNoteId) {
  const matches = [];
  for (const issue of issues || []) {
    if (issue.pull_request) continue;
    const parsed = parseInterviewNoteIssue(issue.body || '');
    if (parsed.marker && parsed.marker.interview_note_id === interviewNoteId) matches.push(issue);
  }
  return matches;
}

function planMaterialization(request, options = {}) {
  const errors = [];
  const requestResult = validateRequest(request);
  errors.push(...requestResult.errors);
  if (errors.length) return { ok: false, errors, request };

  const sourceIssue = options.sourceIssue;
  if (!sourceIssue) return { ok: false, errors: ['sourceIssue is required'], request };
  if (request.repository !== options.repository) errors.push(`repository mismatch: request=${request.repository} live=${options.repository}`);
  if (Number(sourceIssue.number) !== request.source_note_issue_number) errors.push('source_note_issue_number does not match live Issue');
  if (String(sourceIssue.state || '').toLowerCase() !== 'open') errors.push('SourceNote Issue must be open for materialization');
  if (sha256Text(sourceIssue.body) !== request.expected_source_note_body_sha256) errors.push('stale SourceNote body digest');

  const sourceLabels = (sourceIssue.labels || []).map((label) => typeof label === 'string' ? label : label.name);
  const sourceValidation = validateSourceNoteIssue({ body: sourceIssue.body, labels: sourceLabels, state: String(sourceIssue.state || 'open').toLowerCase() });
  if (!sourceValidation.ok) errors.push(...sourceValidation.errors.map((error) => `SourceNote invalid: ${error}`));
  const record = sourceValidation.parsed && sourceValidation.parsed.record;
  if (!record) return { ok: false, errors, request };

  if (record.source_note_id !== request.source_note_id) errors.push('source_note_id mismatch');
  if (!record.boundary_review || record.boundary_review.status !== request.expected_boundary_status) errors.push(`boundary must remain ${request.expected_boundary_status}`);
  if (!sourceLabels.includes('boundary:single-interview')) errors.push('live SourceNote label must be boundary:single-interview');
  if (!Array.isArray(record.boundary_review.interview_note_ids) || record.boundary_review.interview_note_ids.length !== 1) errors.push('single-interview SourceNote must declare exactly one InterviewNote id');
  const derivedId = `${record.source.system}:${record.source.external_id}`;
  if (record.boundary_review.interview_note_ids[0] !== derivedId) errors.push('declared InterviewNote id must equal source-derived identity');
  if (!record.source_revision || record.source_revision.id !== request.expected_source_revision_id) errors.push('stale SourceRevision id');
  if (request.expected_manifest_sha256 != null) {
    if (!record.source_revision || record.source_revision.manifest_sha256 !== request.expected_manifest_sha256) errors.push('stale SourceCapture manifest SHA');
  }
  if (request.expected_source_repository_ref != null) {
    if (!record.source_revision || record.source_revision.source_repository_ref !== request.expected_source_repository_ref) errors.push('stale fixed source repository ref');
  }

  const projection = buildInterviewProjection(sourceIssue, sourceValidation);
  const projectionValidation = validateInterviewNoteIssue({ body: projection.body, labels: projection.labels, state: 'open' });
  if (!projectionValidation.ok) errors.push(...projectionValidation.errors.map((error) => `projected InterviewNote invalid: ${error}`));

  const ownership = findOwnershipMatches(options.issues || [], derivedId);
  let action = null;
  let existing_issue_number = null;
  if (ownership.length === 0) {
    action = 'create';
  } else if (ownership.length === 1) {
    const existing = validateExistingOwnership(ownership[0], projection);
    if (!existing.ok) errors.push(...existing.errors);
    else {
      action = 'existing';
      existing_issue_number = Number(ownership[0].number);
    }
  } else {
    errors.push(`duplicate ownership conflict: ${ownership.length} InterviewNote Issues claim ${derivedId}`);
  }

  const reqSha = requestSha256(request);
  const relevantReceipts = (options.receipts || []).filter((receipt) => receipt.materialization_id === request.materialization_id);
  if (relevantReceipts.length > 1) errors.push(`multiple materialization receipts found for ${request.materialization_id}`);
  let receipt = relevantReceipts.length === 1 ? relevantReceipts[0] : null;
  if (receipt) {
    if (receipt.schema_version !== 'source-note-interview-materialized.v1') errors.push('materialization receipt schema mismatch');
    if (receipt.request_sha256 !== reqSha) errors.push('materialization receipt request digest mismatch');
    if (receipt.source_note_id !== request.source_note_id) errors.push('materialization receipt SourceNote mismatch');
    if (receipt.interview_note_id !== derivedId) errors.push('materialization receipt InterviewNote identity mismatch');
    if (receipt.source_note_body_sha256 !== request.expected_source_note_body_sha256) errors.push('materialization receipt SourceNote body digest mismatch');
    if (receipt.source_revision_id !== request.expected_source_revision_id) errors.push('materialization receipt SourceRevision mismatch');
    if ((receipt.manifest_sha256 ?? null) !== (request.expected_manifest_sha256 ?? null)) errors.push('materialization receipt manifest mismatch');
    if ((receipt.source_repository_ref ?? null) !== (request.expected_source_repository_ref ?? null)) errors.push('materialization receipt source repository ref mismatch');
    if (action === 'create') errors.push('materialization receipt exists but no InterviewNote owner exists');
    if (action === 'existing' && Number(receipt.interview_issue_number) !== existing_issue_number) errors.push('materialization receipt points to a different InterviewNote Issue');
  }

  return {
    ok: errors.length === 0,
    errors,
    request,
    request_sha256: reqSha,
    source_note_body_sha256: sha256Text(sourceIssue.body),
    interview_note_id: derivedId,
    projection,
    action,
    existing_issue_number,
    ownership_count: ownership.length,
    receipt,
    already_materialized: action === 'existing' && Boolean(receipt),
    needs_receipt_repair: action === 'existing' && !receipt,
  };
}

module.exports = {
  SCHEMA_VERSION,
  sha256Text,
  requestSha256,
  parseMaterializationRequest,
  parseMaterializationReceipts,
  validateRequest,
  buildInterviewProjection,
  findOwnershipMatches,
  validateExistingOwnership,
  planMaterialization,
};
