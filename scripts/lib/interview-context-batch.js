'use strict';

const crypto = require('crypto');
const {
  validateInterviewContext,
  buildLearningDiscovery,
} = require('./interview-context');
const {
  parseInterviewNoteIssue,
  validateInterviewNoteIssue,
} = require('./interview-note-issue');

const SCHEMA_VERSION = 'interview-context-batch-review.v1';
const RECEIPT_SCHEMA_VERSION = 'interview-context-learning-discovery-applied.v1';
const REQUIRED_DEPENDENCIES = [917, 920, 921, 922];
const MAX_BATCH_SIZE = 50;
const DISCOVERY_PREFIXES = [
  'company:',
  'role:',
  'recruitment:',
  'round:',
  'source-year:',
  'interview-year:',
];
const SPOILER_RE = /(凉经|挂科|挂了|拒绝|未通过|通过|失败|淘汰|录用|入职|offer|rejected|passed|failed|outcome|result)/i;
const HEX64_RE = /^[0-9a-f]{64}$/;

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalJson(value) {
  return JSON.stringify(value);
}

function contextSha256(context) {
  return sha256Text(canonicalJson(context));
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeLabels(labels = []) {
  return [...new Set(labels.map((label) => typeof label === 'string' ? label : label && label.name).filter(nonEmpty))].sort();
}

function parseMarker(body) {
  const matches = [...String(body || '').matchAll(/<!--\s*interview-context-batch-review\s*\n([\s\S]*?)\n-->/g)];
  if (matches.length !== 1) return { request: null, errors: [`expected exactly one batch review request marker, found ${matches.length}`] };
  try {
    return { request: JSON.parse(matches[0][1]), errors: [] };
  } catch (error) {
    return { request: null, errors: [`batch review request JSON is invalid: ${error.message}`] };
  }
}

function parseReceipts(comments = []) {
  const receipts = [];
  const errors = [];
  for (const comment of comments) {
    const matches = [...String(comment && comment.body || '').matchAll(/<!--\s*interview-context-learning-discovery-applied\s*\n([\s\S]*?)\n-->/g)];
    if (matches.length > 1) errors.push(`comment ${comment.id || 'unknown'} contains multiple context receipts`);
    for (const match of matches) {
      try {
        const receipt = JSON.parse(match[1]);
        if (receipt.schema_version !== RECEIPT_SCHEMA_VERSION) throw new Error(`schema_version must be ${RECEIPT_SCHEMA_VERSION}`);
        receipts.push({ ...receipt, comment_id: Number(comment.id) });
      } catch (error) {
        errors.push(`comment ${comment.id || 'unknown'} has invalid context receipt: ${error.message}`);
      }
    }
  }
  return { receipts, errors };
}

function validateRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, errors: ['request must be an object'] };
  const allowed = new Set(['schema_version', 'batch_id', 'repository', 'dependency_issues', 'pilot_size', 'items']);
  for (const key of Object.keys(request)) if (!allowed.has(key)) errors.push(`unsupported request field: ${key}`);
  if (request.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!nonEmpty(request.batch_id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.batch_id || '')) errors.push('batch_id must be a stable machine identifier');
  if (!nonEmpty(request.repository) || !/^[^/]+\/[^/]+$/.test(request.repository || '')) errors.push('repository must be owner/name');
  if (!Array.isArray(request.dependency_issues)) errors.push('dependency_issues must be an array');
  else {
    const deps = [...new Set(request.dependency_issues.map(Number))];
    if (deps.length !== request.dependency_issues.length || deps.some((number) => !Number.isInteger(number) || number <= 0)) errors.push('dependency_issues must contain unique positive Issue numbers');
    for (const required of REQUIRED_DEPENDENCIES) if (!deps.includes(required)) errors.push(`dependency gate must include Issue #${required}`);
  }
  if (!Number.isInteger(request.pilot_size) || request.pilot_size < 1 || request.pilot_size > MAX_BATCH_SIZE) errors.push(`pilot_size must be an integer between 1 and ${MAX_BATCH_SIZE}`);
  if (!Array.isArray(request.items)) errors.push('items must be an array');
  else {
    if (Number.isInteger(request.pilot_size) && request.items.length !== request.pilot_size) errors.push('items length must equal pilot_size');
    const issueNumbers = new Set();
    const contextIds = new Set();
    request.items.forEach((item, index) => {
      const prefix = `items[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      const itemAllowed = new Set(['issue_number', 'expected_body_sha256', 'context']);
      for (const key of Object.keys(item)) if (!itemAllowed.has(key)) errors.push(`${prefix} unsupported field: ${key}`);
      if (!Number.isInteger(item.issue_number) || item.issue_number <= 0) errors.push(`${prefix}.issue_number must be a positive integer`);
      else if (issueNumbers.has(item.issue_number)) errors.push(`${prefix}.issue_number is duplicated`);
      else issueNumbers.add(item.issue_number);
      if (!HEX64_RE.test(item.expected_body_sha256 || '')) errors.push(`${prefix}.expected_body_sha256 must be a lowercase 64-char SHA-256`);
      const validation = validateInterviewContext(item.context);
      if (!validation.ok) errors.push(...validation.errors.map((error) => `${prefix}.context: ${error}`));
      if (item.context && contextIds.has(item.context.context_id)) errors.push(`${prefix}.context.context_id is duplicated`);
      if (item.context && item.context.context_id) contextIds.add(item.context.context_id);
    });
  }
  return { ok: errors.length === 0, errors };
}

function dependencyGate(request, dependencies = []) {
  const errors = [];
  const byNumber = new Map(dependencies.map((issue) => [Number(issue.number), issue]));
  for (const number of REQUIRED_DEPENDENCIES) {
    const issue = byNumber.get(number);
    if (!issue) errors.push(`dependency Issue #${number} was not loaded`);
    else if (String(issue.state || '').toLowerCase() !== 'closed') errors.push(`dependency Issue #${number} is not closed (state=${issue.state})`);
  }
  return { ok: errors.length === 0, errors };
}

function isDiscoveryLabel(label) {
  return DISCOVERY_PREFIXES.some((prefix) => label.startsWith(prefix));
}

function projectLabels(currentLabels, learningLabels) {
  return normalizeLabels(currentLabels).filter((label) => !isDiscoveryLabel(label)).concat(learningLabels).sort();
}

function unknownFacts(context) {
  const facts = [
    ['company', context.company && context.company.id == null],
    ['role', context.role && context.role.family === 'unknown'],
    ['recruitment_type', context.recruitment_type && context.recruitment_type.value === 'unknown'],
    ['round', context.round && context.round.value === 'unknown'],
    ['interview_occurred_at', context.interview_occurred_at && context.interview_occurred_at.precision === 'unknown'],
  ];
  return facts.filter(([, unknown]) => unknown).map(([name]) => name);
}

function receiptMatches(receipt, request, item, projection) {
  return receipt && receipt.schema_version === RECEIPT_SCHEMA_VERSION
    && receipt.batch_id === request.batch_id
    && Number(receipt.issue_number) === Number(item.issue_number)
    && receipt.interview_note_id === projection.interview_note_id
    && receipt.expected_body_sha256 === item.expected_body_sha256
    && receipt.context_sha256 === contextSha256(item.context)
    && receipt.title === projection.title
    && JSON.stringify(receipt.labels || []) === JSON.stringify(projection.labels);
}

function planItem(request, item, issue, receipts = []) {
  const errors = [];
  const body = String(issue && issue.body || '');
  const labels = normalizeLabels(issue && issue.labels || []);
  const bodySha = sha256Text(body);
  if (bodySha !== item.expected_body_sha256) errors.push(`stale InterviewNote body digest: expected=${item.expected_body_sha256} live=${bodySha}`);

  const validation = validateInterviewNoteIssue({ body, labels, state: String(issue && issue.state || 'open').toLowerCase() });
  if (!validation.ok) errors.push(...validation.errors.map((error) => `live InterviewNote invalid: ${error}`));
  const parsed = parseInterviewNoteIssue(body);
  if (!parsed.marker || !parsed.record) errors.push('live object is not a parseable InterviewNote; SourceNote cannot be used as InterviewNote');
  if (parsed.record && parsed.record.schema_version !== 'interview-note-issue.v2') errors.push('batch requires InterviewNote Issue v2 with explicit source_published_at; legacy v1 is not eligible');
  if (parsed.marker && item.context && parsed.marker.interview_note_id !== item.context.interview_note_id) errors.push('context interview_note_id does not match live InterviewNote machine marker');
  if (parsed.record && item.context && parsed.record.interview_note_id !== item.context.interview_note_id) errors.push('context interview_note_id does not match live InterviewNote record');
  if (!labels.includes('status:source-ready')) errors.push('Learning Discovery requires live status:source-ready');
  if (parsed.record && item.context && parsed.record.source_revision && parsed.record.source_revision.id !== item.context.source_revision_id) errors.push('context source_revision_id does not match live InterviewNote SourceRevision');

  const discovery = parsed.record && item.context
    ? buildLearningDiscovery(item.context, parsed.record.source_published_at)
    : { ok: false, errors: ['cannot build discovery projection without a valid InterviewNote record'] };
  if (!discovery.ok) errors.push(...discovery.errors.map((error) => `context projection invalid: ${error}`));
  if (discovery.ok && SPOILER_RE.test(discovery.non_spoiler_title)) errors.push('non-spoiler title contains forbidden outcome wording');

  if (errors.length) return {
    ok: false,
    issue_number: item.issue_number,
    action: 'needs_review',
    errors,
    unknown_facts: unknownFacts(item.context),
  };

  const projection = {
    interview_note_id: item.context.interview_note_id,
    context: item.context,
    context_sha256: contextSha256(item.context),
    title: discovery.non_spoiler_title,
    labels: projectLabels(labels, discovery.learning_labels),
    unknown_facts: unknownFacts(item.context),
  };
  if (projection.labels.some((label) => SPOILER_RE.test(label))) errors.push('learning labels contain forbidden outcome wording');
  const projectedValidation = validateInterviewNoteIssue({
    body,
    labels: projection.labels,
    state: String(issue && issue.state || 'open').toLowerCase(),
  });
  if (!projectedValidation.ok) errors.push(...projectedValidation.errors.map((error) => `projected InterviewNote invalid: ${error}`));
  const relevantReceipts = receipts.filter((receipt) => receipt && receipt.batch_id === request.batch_id && Number(receipt.issue_number) === Number(item.issue_number));
  const matchingReceipt = relevantReceipts.find((receipt) => receiptMatches(receipt, request, item, projection));
  if (relevantReceipts.length > 1) errors.push('duplicate receipts exist for this batch item');
  if (relevantReceipts.length > 0 && !matchingReceipt) errors.push('conflicting receipt exists for this batch item');
  if (errors.length) return {
    ok: false,
    issue_number: item.issue_number,
    action: 'needs_review',
    errors,
    unknown_facts: projection.unknown_facts,
  };
  const currentTitle = String(issue.title || '');
  const currentLabels = normalizeLabels(issue.labels || []);
  const alreadyProjected = currentTitle === projection.title && JSON.stringify(currentLabels) === JSON.stringify(projection.labels);
  return {
    ok: true,
    issue_number: item.issue_number,
    action: matchingReceipt ? 'already_applied' : (alreadyProjected ? 'repair_receipt' : 'update'),
    errors: [],
    unknown_facts: projection.unknown_facts,
    current_body_sha256: bodySha,
    current_title: currentTitle,
    current_labels: currentLabels,
    projection,
    receipt: matchingReceipt || null,
  };
}

function planBatch(request, { dependencies = [], issues = [], receiptsByIssue = new Map() } = {}) {
  const requestValidation = validateRequest(request);
  if (!requestValidation.ok) return { ok: false, blocked: false, errors: requestValidation.errors, items: [], summary: null };
  const gate = dependencyGate(request, dependencies);
  if (!gate.ok) {
    return {
      ok: false,
      blocked: true,
      errors: gate.errors,
      items: [],
      summary: { pilot_size: request.pilot_size, ready_count: 0, unknown_count: 0, unknown_item_count: 0, needs_review_count: 0, already_applied_count: 0, proposed_mutation_count: 0, mutation_count: 0 },
    };
  }
  const byNumber = new Map(issues.map((issue) => [Number(issue.number), issue]));
  const plannedItems = request.items.map((item) => {
    const issue = byNumber.get(Number(item.issue_number));
    if (!issue) return { ok: false, issue_number: item.issue_number, action: 'needs_review', errors: ['InterviewNote Issue was not loaded'], unknown_facts: unknownFacts(item.context) };
    const receipts = receiptsByIssue instanceof Map ? (receiptsByIssue.get(Number(item.issue_number)) || []) : [];
    return planItem(request, item, issue, receipts);
  });
  const needsReview = plannedItems.filter((item) => !item.ok);
  const applied = plannedItems.filter((item) => item.ok && item.action === 'already_applied');
  const mutations = plannedItems.filter((item) => item.ok && item.action !== 'already_applied');
  const unknownItemCount = plannedItems.filter((item) => item.unknown_facts && item.unknown_facts.length > 0).length;
  const unknownCount = plannedItems.reduce((sum, item) => sum + (item.unknown_facts || []).length, 0);
  return {
    ok: needsReview.length === 0,
    blocked: false,
    errors: needsReview.flatMap((item) => item.errors.map((error) => `Issue #${item.issue_number}: ${error}`)),
    items: plannedItems,
    summary: {
      pilot_size: request.pilot_size,
      ready_count: plannedItems.filter((item) => item.ok).length,
      unknown_count: unknownCount,
      unknown_item_count: unknownItemCount,
      needs_review_count: needsReview.length,
      already_applied_count: applied.length,
      proposed_mutation_count: mutations.length,
      mutation_count: needsReview.length === 0 ? mutations.length : 0,
    },
  };
}

function receiptFor(request, item, appliedAt) {
  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    batch_id: request.batch_id,
    repository: request.repository,
    issue_number: item.issue_number,
    interview_note_id: item.projection.interview_note_id,
    expected_body_sha256: item.current_body_sha256,
    context_sha256: item.projection.context_sha256,
    title: item.projection.title,
    labels: item.projection.labels,
    applied_at: appliedAt,
  };
}

function receiptBody(receipt) {
  return `<!-- interview-context-learning-discovery-applied\n${JSON.stringify(receipt, null, 2)}\n-->\n\nReviewed InterviewContext learning discovery projection applied; Outcome remains sealed.`;
}

module.exports = {
  SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  REQUIRED_DEPENDENCIES,
  MAX_BATCH_SIZE,
  sha256Text,
  contextSha256,
  parseMarker,
  parseReceipts,
  validateRequest,
  dependencyGate,
  normalizeLabels,
  projectLabels,
  unknownFacts,
  planItem,
  planBatch,
  receiptFor,
  receiptBody,
};
