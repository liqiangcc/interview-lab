'use strict';

const {
  BOUNDARY_TRANSITION_REPORT_SCHEMA,
  MATERIALIZATION_PLAN_SCHEMA,
  MATERIALIZATION_CANDIDATE_COUNT,
  SOURCE_REF,
  canonicalDigest,
  sha256Text,
  validateBoundaryTransitionReport,
  validateIssue1605MaterializationPlan,
} = require('./aggregate-downstream-pipeline');
const { validateInterviewContext, buildLearningDiscovery } = require('./interview-context');
const { parseInterviewNoteIssue, validateInterviewNoteIssue } = require('./interview-note-issue');

const SCHEMA_VERSION = 'issue-1611-context-learning-plan.v1';
const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REVIEW_RECEIPT_SCHEMA = 'interview-note-source-review-applied.v1';
const SOURCE_REVIEW_REQUEST_SCHEMA = 'aggregate-source-review-evidence-request.v1';
const CONTEXT_SCHEMA = 'interview-context.v1';
const DISCOVERY_PREFIXES = ['company:', 'role:', 'recruitment:', 'round:', 'source-year:', 'interview-year:'];
const LEARNING_LABEL_TEMPLATES = Object.freeze([
  'company:<normalized-id>',
  'role:<coarse-family>',
  'recruitment:<type>',
  'round:<round>',
  'source-year:<published-year>',
  'interview-year:<proven-year>',
]);
const ZERO_WRITES = Object.freeze({ patch: 0, post: 0, create: 0 });

const STAGE_CONTRACTS = Object.freeze([
  {
    stage: 'materialization',
    required_schema: MATERIALIZATION_PLAN_SCHEMA,
    status_when_ready: 'materialized',
    required_bindings: ['source_note_id', 'source_note_body_sha256', 'source_revision_id', 'source_ref', 'interview_note_id', 'unique_interview_note_issue_owner'],
  },
  {
    stage: 'source-review',
    request_schema: SOURCE_REVIEW_REQUEST_SCHEMA,
    receipt_schema: SOURCE_REVIEW_RECEIPT_SCHEMA,
    status_when_ready: 'source-ready',
    required_bindings: ['independent=true', 'source_note_body_sha256', 'source_revision_id', 'source_ref', 'interview_body_sha256'],
    forbidden_substitute: 'boundary review evidence or boundary digest',
  },
  {
    stage: 'context',
    required_schema: CONTEXT_SCHEMA,
    status_when_ready: 'reviewed-context',
    required_bindings: ['context.interview_note_id', 'context.source_revision_id', 'review_status=reviewed', 'body-pinned live Issue snapshot'],
    forbidden_fields: ['body', 'next_body', 'result', 'outcome'],
  },
  {
    stage: 'learning-discovery',
    producer: 'buildLearningDiscovery(context, source_published_at)',
    status_when_ready: 'projectable',
    required_bindings: ['reproducible non-spoiler title', 'reproducible discovery labels', 'Raw InterviewNote body SHA unchanged', 'Outcome sealed'],
    labels: LEARNING_LABEL_TEMPLATES,
  },
]);

function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }

function labelsOf(issue) {
  return [...new Set((issue && issue.labels || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(nonEmpty))].sort();
}

function withoutDiscoveryLabels(labels) {
  return labels.filter((label) => !DISCOVERY_PREFIXES.some((prefix) => label.startsWith(prefix)));
}

function readJson(file, fsImpl) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch (error) { return { __read_error: `cannot read ${file}: ${error.message}` }; }
}

function inputEvidence(file, value) {
  if (!file) return { path: null, sha256: null, present: value != null };
  if (value == null) return { path: file, sha256: null, present: false };
  if (value && value.__read_error) return { path: file, sha256: null, present: false, error: value.__read_error };
  return { path: file, sha256: sha256Text(JSON.stringify(value)), present: value != null };
}

function boundaryManifest(repository = REPOSITORY, sourceRepository = 'liqiangcc/xhs') {
  return { repository, source_repository: sourceRepository, source_ref: SOURCE_REF };
}

function candidateBase(item, interviewNoteId) {
  const caseEntry = (item.interview_note_cases || []).find((entry) => entry.interview_note_id === interviewNoteId);
  return {
    source_note_issue_number: Number(item.issue_number),
    source_note_id: item.source_note_id,
    source_note_body_sha256: item.current_body_sha256,
    source_revision_id: item.source_revision_id,
    source_ref: SOURCE_REF,
    boundary_decision: item.decision,
    case_key: caseEntry ? caseEntry.case_key : null,
    interview_note_id: interviewNoteId,
  };
}

function sourceReviewRequest(candidate) {
  const subject = {
    schema_version: SOURCE_REVIEW_REQUEST_SCHEMA,
    interview_note_id: candidate.interview_note_id,
    source_note_issue_number: candidate.source_note_issue_number,
    source_note_id: candidate.source_note_id,
    source_note_body_sha256: candidate.source_note_body_sha256,
    source_revision_id: candidate.source_revision_id,
    source_ref: candidate.source_ref,
    case_key: candidate.case_key,
  };
  return { ...subject, evidence_subject_sha256: canonicalDigest(subject), decision: 'pending-independent-source-review', boundary_evidence_reuse: false };
}

function emptyStage(stage, status, reason, extra = {}) {
  return { stage, status, reason, ...extra };
}

function receiptIndex(receipts, errors) {
  const byInterview = new Map();
  if (receipts == null) return byInterview;
  if (!Array.isArray(receipts)) { errors.push('source_review_receipts must be an array'); return byInterview; }
  for (const value of receipts) {
    const receipt = value && value.receipt || value;
    if (!receipt || typeof receipt !== 'object') { errors.push('source review receipt must be an object'); continue; }
    if (!nonEmpty(receipt.interview_note_id)) { errors.push('source review receipt is missing interview_note_id'); continue; }
    if (byInterview.has(receipt.interview_note_id)) errors.push(`duplicate Source Review receipt for ${receipt.interview_note_id}`);
    byInterview.set(receipt.interview_note_id, receipt);
  }
  return byInterview;
}

function contextIndex(report, errors) {
  const byIssue = new Map();
  if (report == null) return byIssue;
  const items = Array.isArray(report) ? report : report.items || report.results;
  if (!Array.isArray(items)) { errors.push('context report must contain an items array'); return byIssue; }
  for (const item of items) {
    const issueNumber = Number(item && item.issue_number);
    if (!Number.isInteger(issueNumber) || issueNumber < 1) { errors.push('Context projection has an invalid issue_number'); continue; }
    if (byIssue.has(issueNumber)) errors.push(`duplicate Context projection for InterviewNote #${issueNumber}`);
    byIssue.set(issueNumber, item);
  }
  return byIssue;
}

function liveIndex(snapshot, errors) {
  const byIssue = new Map();
  if (snapshot == null) return byIssue;
  const items = Array.isArray(snapshot) ? snapshot : snapshot.issues || snapshot.items;
  if (!Array.isArray(items)) { errors.push('live Issue snapshot must contain an items array'); return byIssue; }
  for (const issue of items) {
    const number = Number(issue && (issue.number || issue.issue_number));
    if (!Number.isInteger(number) || number < 1) { errors.push('live Issue snapshot has an invalid Issue number'); continue; }
    if (byIssue.has(number)) errors.push(`duplicate live Issue snapshot for #${number}`);
    byIssue.set(number, issue);
  }
  return byIssue;
}

function validateSourceReview(candidate, row, liveIssue, errors) {
  if (!row) return { stage: 'source-review', status: 'blocked', reason: 'materialization has no InterviewNote owner yet', request: sourceReviewRequest(candidate) };
  if (row.final_status !== 'source-ready' && row.final_status !== 'blocked') {
    errors.push(`Source Review ${candidate.interview_note_id} has no source-ready|blocked terminal status`);
    return { stage: 'source-review', status: 'invalid' };
  }
  if (row.schema_version !== SOURCE_REVIEW_RECEIPT_SCHEMA) errors.push(`Source Review ${candidate.interview_note_id} has wrong schema`);
  if (row.independent !== true && !(row.evidence && row.evidence.independent === true)) errors.push(`Source Review ${candidate.interview_note_id} is not independent`);
  if (row.source_note_body_sha256 !== candidate.source_note_body_sha256) errors.push(`Source Review ${candidate.interview_note_id} SourceNote body SHA drifted`);
  if (row.source_revision_id !== candidate.source_revision_id) errors.push(`Source Review ${candidate.interview_note_id} SourceRevision drifted`);
  if (row.source_repository_ref !== SOURCE_REF) errors.push(`Source Review ${candidate.interview_note_id} source ref drifted`);
  if (!/^[0-9a-f]{64}$/.test(row.interview_body_sha256 || '')) errors.push(`Source Review ${candidate.interview_note_id} has no InterviewNote body SHA`);
  if (!liveIssue) errors.push(`Source Review ${candidate.interview_note_id} lacks a body-pinned live Issue snapshot`);
  else if (sha256Text(liveIssue.body || '') !== row.interview_body_sha256) errors.push(`Source Review ${candidate.interview_note_id} InterviewNote body SHA drifted`);
  return row.final_status === 'source-ready'
    ? { stage: 'source-review', status: 'source-ready', receipt_schema: SOURCE_REVIEW_RECEIPT_SCHEMA, independent: true }
    : { stage: 'source-review', status: 'blocked', reason: 'independent Source Review ended blocked' };
}

function validateContext(candidate, item, liveIssue, errors) {
  if (!item) return emptyStage('context', 'blocked', 'requires source-ready independent Source Review');
  if (Object.prototype.hasOwnProperty.call(item, 'body') || Object.prototype.hasOwnProperty.call(item, 'next_body')
    || (item.context && (Object.prototype.hasOwnProperty.call(item.context, 'body') || Object.prototype.hasOwnProperty.call(item.context, 'next_body')))) {
    errors.push(`Context #${candidate.interview_issue_number} attempts to mutate Raw InterviewNote body`);
  }
  const context = item.context;
  const errorCount = errors.length;
  const validation = validateInterviewContext(context);
  if (!validation.ok) errors.push(`Context #${candidate.interview_issue_number} failed validation: ${validation.errors.join('; ')}`);
  if (!liveIssue) errors.push(`Context #${candidate.interview_issue_number} lacks a body-pinned live Issue snapshot`);
  const bodySha = liveIssue && sha256Text(liveIssue.body || '');
  if (item.expected_body_sha256 && item.expected_body_sha256 !== bodySha) errors.push(`Context #${candidate.interview_issue_number} live body SHA drifted`);
  if (item.expected_body_sha256 && item.expected_body_sha256 !== candidate.interview_body_sha256) errors.push(`Context #${candidate.interview_issue_number} does not bind Source Review body SHA`);
  if (context && context.interview_note_id !== candidate.interview_note_id) errors.push(`Context #${candidate.interview_issue_number} identity mismatch`);
  if (context && context.source_revision_id !== candidate.source_revision_id) errors.push(`Context #${candidate.interview_issue_number} SourceRevision mismatch`);
  if (liveIssue) {
    const issueValidation = validateInterviewNoteIssue({ body: liveIssue.body, labels: labelsOf(liveIssue), state: String(liveIssue.state || 'open').toLowerCase() });
    if (!issueValidation.ok) errors.push(...issueValidation.errors.map((error) => `Context #${candidate.interview_issue_number}: ${error}`));
  }
  if (errors.length !== errorCount) return emptyStage('context', 'invalid', 'Context contract validation failed');
  return { stage: 'context', status: 'reviewed-context', schema_version: CONTEXT_SCHEMA, context_sha256: sha256Text(JSON.stringify(context)), expected_body_sha256: item.expected_body_sha256 };
}

function learningProjection(candidate, contextStage, contextItem, liveIssue, errors) {
  if (contextStage.status !== 'reviewed-context') return emptyStage('learning-discovery', 'blocked', 'requires reviewed Context');
  const parsed = parseInterviewNoteIssue(liveIssue.body || '');
  if (!parsed.record) {
    errors.push(`Context #${candidate.interview_issue_number} live InterviewNote record is not parseable`);
    return emptyStage('learning-discovery', 'invalid', 'live InterviewNote record is not parseable');
  }
  const discovery = buildLearningDiscovery(contextItem.context, parsed.record.source_published_at);
  if (!discovery.ok) {
    errors.push(...discovery.errors.map((error) => `Learning #${candidate.interview_issue_number}: ${error}`));
    return emptyStage('learning-discovery', 'invalid', 'learning discovery derivation failed');
  }
  const preserved = withoutDiscoveryLabels(labelsOf(liveIssue));
  const labels = [...new Set([...preserved, ...discovery.learning_labels])].sort();
  return {
    stage: 'learning-discovery', status: 'projectable', producer: 'buildLearningDiscovery',
    required_label_templates: LEARNING_LABEL_TEMPLATES,
    proposed_title: discovery.non_spoiler_title, proposed_labels: labels,
    raw_body_mutation: false, outcome_visibility: 'sealed-until-source-reveal', unknown_facts: [],
  };
}

function makeCandidate(boundaryItem) {
  return (boundaryItem.interview_note_ids || []).map((interviewNoteId) => {
    const candidate = candidateBase(boundaryItem, interviewNoteId);
    if (!candidate.interview_note_id) throw new Error(`boundary SourceNote #${candidate.source_note_issue_number} has no InterviewNote identity`);
    return candidate;
  });
}

function groupBlockedLedger(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    for (const stage of candidate.blocked_stages || []) {
      const key = `${stage.stage}:${stage.reason}`;
      if (!groups.has(key)) groups.set(key, { stage: stage.stage, reason: stage.reason, count: 0, interview_note_ids: [] });
      const group = groups.get(key);
      group.count += 1;
      group.interview_note_ids.push(candidate.interview_note_id);
    }
  }
  return [...groups.values()].sort((left, right) => left.stage.localeCompare(right.stage) || left.reason.localeCompare(right.reason));
}

function hasForbiddenField(value, fields = new Set(['body', 'next_body'])) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasForbiddenField(item, fields));
  return Object.entries(value).some(([key, child]) => fields.has(key) || hasForbiddenField(child, fields));
}

function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { ok: false, errors: ['Context/learning plan must be an object'] };
  if (plan.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (plan.mode !== 'plan-only') errors.push('mode must be plan-only');
  if (plan.mutation_performed !== false) errors.push('mutation_performed must be false');
  if (JSON.stringify(plan.write_operations) !== JSON.stringify(ZERO_WRITES)) errors.push('write_operations must be patch=0, post=0, create=0');
  if (plan.candidate_count !== MATERIALIZATION_CANDIDATE_COUNT) errors.push(`candidate_count must be ${MATERIALIZATION_CANDIDATE_COUNT}`);
  if (!Array.isArray(plan.candidates) || plan.candidates.length !== MATERIALIZATION_CANDIDATE_COUNT) errors.push(`candidates must contain exactly ${MATERIALIZATION_CANDIDATE_COUNT} rows`);
  const seen = new Set();
  for (const candidate of plan.candidates || []) {
    if (!candidate || typeof candidate !== 'object') { errors.push('candidate must be an object'); continue; }
    if (!nonEmpty(candidate.interview_note_id) || seen.has(candidate.interview_note_id)) errors.push(`candidate InterviewNote identity is missing or duplicated: ${candidate.interview_note_id || 'unknown'}`);
    seen.add(candidate.interview_note_id);
    if (candidate.interview_issue_number !== null && (!Number.isInteger(candidate.interview_issue_number) || candidate.interview_issue_number < 1)) errors.push(`candidate ${candidate.interview_note_id} has an invalid InterviewNote Issue owner`);
    if (JSON.stringify(candidate.required_sequence) !== JSON.stringify(['materialization', 'source-review', 'context', 'learning-discovery'])) errors.push(`candidate ${candidate.interview_note_id} has an invalid required sequence`);
    if (hasForbiddenField(candidate)) errors.push(`candidate ${candidate.interview_note_id} contains a forbidden Raw body field`);
    if (!candidate.materialization || !candidate.source_review || !candidate.context || !candidate.learning) errors.push(`candidate ${candidate.interview_note_id} is missing a stage contract`);
  }
  if (hasForbiddenField(plan, new Set(['body', 'next_body']))) errors.push('plan contains a forbidden Raw body field');
  const { canonical_digest: ignoredDigest, ...digestInput } = plan;
  if (plan.canonical_digest !== canonicalDigest(digestInput)) errors.push('canonical_digest does not match the plan payload');
  return { ok: errors.length === 0, errors };
}

function buildPlan({ boundaryReport, materializationPlan = null, sourceReviewReceipts = null, contextReport = null, liveIssueSnapshot = null, paths = {}, fsImpl = require('fs') } = {}) {
  const errors = [];
  const blockedPrerequisites = [];
  const manifest = boundaryManifest();
  const boundaryResult = validateBoundaryTransitionReport(boundaryReport, manifest, MATERIALIZATION_CANDIDATE_COUNT);
  errors.push(...boundaryResult.errors);
  const boundaryCandidates = boundaryResult.ok ? boundaryResult.items.flatMap((item) => makeCandidate(item)) : [];
  if (boundaryCandidates.length !== MATERIALIZATION_CANDIDATE_COUNT) blockedPrerequisites.push({ code: 'boundary-candidate-union-incomplete', count: boundaryCandidates.length, required: MATERIALIZATION_CANDIDATE_COUNT });

  let materializationRows = new Map();
  if (materializationPlan == null) {
    blockedPrerequisites.push({ code: 'materialization-plan-missing', required_schema: MATERIALIZATION_PLAN_SCHEMA, path: paths.materializationPlan || null });
  } else {
    const validated = validateIssue1605MaterializationPlan(materializationPlan, { ...manifest, parent_issue: 1605, expected_materialization_candidate_count: MATERIALIZATION_CANDIDATE_COUNT }, boundaryResult);
    errors.push(...validated.errors);
    for (const row of validated.rows) materializationRows.set(row.interview_note_id, row);
  }

  const receiptErrors = [];
  const receipts = receiptIndex(sourceReviewReceipts, receiptErrors);
  errors.push(...receiptErrors);
  const contextErrors = [];
  const contexts = contextIndex(contextReport, contextErrors);
  const liveIssues = liveIndex(liveIssueSnapshot, contextErrors);
  errors.push(...contextErrors);

  const candidates = boundaryCandidates.map((candidate) => {
    const materialization = materializationRows.get(candidate.interview_note_id);
    const base = { ...candidate, required_sequence: ['materialization', 'source-review', 'context', 'learning-discovery'], blocked_stages: [] };
    if (!materialization) {
      base.interview_issue_number = null;
      base.materialization = emptyStage('materialization', 'pending-materialization', 'Issue #1605 materialization plan is missing or candidate has no row', { required_schema: MATERIALIZATION_PLAN_SCHEMA });
      base.source_review = emptyStage('source-review', 'blocked', 'requires a unique materialized InterviewNote owner', { request: sourceReviewRequest(candidate) });
      base.context = emptyStage('context', 'blocked', 'requires source-ready independent Source Review');
      base.learning = emptyStage('learning-discovery', 'blocked', 'requires reviewed Context', { required_label_templates: LEARNING_LABEL_TEMPLATES });
      base.blocked_stages = [base.materialization, base.source_review, base.context, base.learning];
      return base;
    }
    base.interview_issue_number = materialization.interview_issue_number;
    if (materialization.kind === 'materialization-pending' || !Number.isInteger(materialization.interview_issue_number)) {
      base.materialization = emptyStage('materialization', 'pending-materialization', `materialization action=${materialization.materialization_status}`, { required_schema: MATERIALIZATION_PLAN_SCHEMA });
      base.source_review = emptyStage('source-review', 'blocked', 'requires a unique materialized InterviewNote owner', { request: sourceReviewRequest(candidate) });
      base.context = emptyStage('context', 'blocked', 'requires source-ready independent Source Review');
      base.learning = emptyStage('learning-discovery', 'blocked', 'requires reviewed Context', { required_label_templates: LEARNING_LABEL_TEMPLATES });
      base.blocked_stages = [base.materialization, base.source_review, base.context, base.learning];
      return base;
    }
    base.materialization = { stage: 'materialization', status: 'materialized', materialization_id: materialization.materialization_id, interview_issue_number: materialization.interview_issue_number };
    const liveIssue = liveIssues.get(materialization.interview_issue_number);
    base.interview_body_sha256 = liveIssue && sha256Text(liveIssue.body || '') || null;
    base.source_review = validateSourceReview(candidate, receipts.get(candidate.interview_note_id), liveIssue, errors);
    if (base.source_review.status !== 'source-ready') {
      base.context = emptyStage('context', 'blocked', 'requires source-ready independent Source Review');
      base.learning = emptyStage('learning-discovery', 'blocked', 'requires reviewed Context', { required_label_templates: LEARNING_LABEL_TEMPLATES });
      base.blocked_stages = [base.source_review, base.context, base.learning];
      return base;
    }
    const contextItem = contexts.get(materialization.interview_issue_number);
    base.context = validateContext({ ...candidate, interview_issue_number: materialization.interview_issue_number, interview_body_sha256: base.interview_body_sha256 }, contextItem, liveIssue, errors);
    base.learning = liveIssue ? learningProjection({ ...candidate, interview_issue_number: materialization.interview_issue_number }, base.context, contextItem, liveIssue, errors) : emptyStage('learning-discovery', 'blocked', 'requires body-pinned live Issue snapshot');
    if (base.context.status !== 'reviewed-context' || base.learning.status !== 'projectable') base.blocked_stages = [base.context, base.learning];
    return base;
  });

  for (const candidate of candidates) {
    candidate.blocked_stages = candidate.blocked_stages.filter((stage) => stage.status !== 'projectable' && stage.status !== 'materialized');
  }
  const sourceReady = candidates.filter((candidate) => candidate.source_review.status === 'source-ready').length;
  const contextReady = candidates.filter((candidate) => candidate.context.status === 'reviewed-context').length;
  const learningReady = candidates.filter((candidate) => candidate.learning.status === 'projectable').length;
  const planWithoutDigest = {
    schema_version: SCHEMA_VERSION,
    aggregate_id: 'issue-1611-full-downstream-v1',
    repository: REPOSITORY,
    source_repository: 'liqiangcc/xhs',
    source_ref: SOURCE_REF,
    parent_issue: 1605,
    aggregate_issue: 1611,
    mode: 'plan-only',
    mutation_performed: false,
    write_operations: ZERO_WRITES,
    candidate_count: MATERIALIZATION_CANDIDATE_COUNT,
    stage_contracts: STAGE_CONTRACTS,
    inputs: {
      boundary_transition_report: inputEvidence(paths.boundaryReport, boundaryReport),
      materialization_plan: inputEvidence(paths.materializationPlan, materializationPlan),
      source_review_receipts: inputEvidence(paths.sourceReviewReceipts, sourceReviewReceipts),
      context_report: inputEvidence(paths.contextReport, contextReport),
      live_issue_snapshot: inputEvidence(paths.liveIssueSnapshot, liveIssueSnapshot),
    },
    dependency_status: {
      boundary_transition: boundaryResult.ok ? 'satisfied' : 'blocked',
      materialization: materializationPlan ? 'provided-and-validated-if-no-errors' : 'blocked',
      source_review: sourceReady === MATERIALIZATION_CANDIDATE_COUNT ? 'satisfied' : 'blocked-until-independent-receipts',
      context: contextReady === MATERIALIZATION_CANDIDATE_COUNT ? 'satisfied' : 'blocked-until-reviewed-contexts',
      learning: learningReady === MATERIALIZATION_CANDIDATE_COUNT ? 'satisfied' : 'blocked-until-reviewed-contexts',
    },
    summary: {
      candidate_count: candidates.length,
      materialization_pending: candidates.filter((candidate) => candidate.materialization.status === 'pending-materialization').length,
      source_review_ready: sourceReady,
      context_ready: contextReady,
      learning_projectable: learningReady,
      blocked_candidate_count: candidates.filter((candidate) => candidate.blocked_stages.length > 0).length,
      blocked_prerequisite_count: blockedPrerequisites.length,
      mutation_count: 0,
    },
    blocked_prerequisites: blockedPrerequisites,
    blocked_ledger: groupBlockedLedger(candidates),
    errors,
    candidates,
    post_apply_audit: ['no pending mutation', 'unique InterviewNote owner', 'independent Source Review receipt per candidate', 'reviewed Context per source-ready candidate', 'discovery labels reproducible', 'Raw InterviewNote body SHA unchanged', 'Outcome remains sealed'],
  };
  const plan = { ...planWithoutDigest, canonical_digest: canonicalDigest(planWithoutDigest) };
  return { ok: errors.length === 0 && blockedPrerequisites.length === 0 && candidates.every((candidate) => candidate.blocked_stages.length === 0), plan };
}

module.exports = {
  SCHEMA_VERSION,
  MATERIALIZATION_CANDIDATE_COUNT,
  SOURCE_REVIEW_RECEIPT_SCHEMA,
  LEARNING_LABEL_TEMPLATES,
  STAGE_CONTRACTS,
  ZERO_WRITES,
  buildPlan,
  candidateBase,
  groupBlockedLedger,
  validatePlan,
};
