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
const HEX40_RE = /^[0-9a-f]{40}$/;
const DEPENDENCY_GATE_SCHEMA_VERSION = 'interview-context-learning-discovery-dependency-gate.v1';
const DEPENDENCY_ACCEPTANCE_SCHEMA_VERSION = 'issue-dependency-acceptance.v1';
const DEPENDENCY_MARKER_RE = /<!--\s*issue-dependency-acceptance\s*\n([\s\S]*?)\n-->/g;
const PROGRESS_SCHEMA_VERSION = 'interview-context-learning-discovery-apply-progress.v1';

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

function parseIssueCommentUrl(repository, dependencyNumber, value) {
  const match = String(value || '').match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)#issuecomment-(\d+)$/);
  if (!match || match[1] !== repository || Number(match[2]) !== Number(dependencyNumber)) return null;
  return { url: value, issue_number: Number(match[2]), comment_id: Number(match[3]) };
}

function parseDependencyAcceptance(body, repository, dependencyNumber, expectedAcceptanceEvidence) {
  const matches = [...String(body || '').matchAll(new RegExp(DEPENDENCY_MARKER_RE.source, DEPENDENCY_MARKER_RE.flags))];
  if (matches.length !== 1) return { ok: false, errors: [`dependency #${dependencyNumber} acceptance marker count must be exactly one`] };
  try {
    const value = JSON.parse(matches[0][1]);
    const allowed = new Set(['schema_version', 'issue_number', 'acceptance', 'accepted_by', 'acceptance_evidence']);
    const errors = [];
    for (const key of Object.keys(value || {})) if (!allowed.has(key)) errors.push(`dependency #${dependencyNumber} acceptance has unsupported field: ${key}`);
    if (value.schema_version !== DEPENDENCY_ACCEPTANCE_SCHEMA_VERSION) errors.push(`dependency #${dependencyNumber} acceptance schema must be ${DEPENDENCY_ACCEPTANCE_SCHEMA_VERSION}`);
    if (Number(value.issue_number) !== Number(dependencyNumber)) errors.push(`dependency #${dependencyNumber} acceptance issue_number mismatch`);
    if (value.acceptance !== 'pass') errors.push(`dependency #${dependencyNumber} acceptance must be pass`);
    if (!nonEmpty(value.accepted_by)) errors.push(`dependency #${dependencyNumber} accepted_by is required`);
    if (!parseIssueCommentUrl(repository, dependencyNumber, value.acceptance_evidence)) errors.push(`dependency #${dependencyNumber} acceptance_evidence must be an issue comment URL for the same Issue`);
    if (expectedAcceptanceEvidence && value.acceptance_evidence !== expectedAcceptanceEvidence) errors.push(`dependency #${dependencyNumber} acceptance_evidence does not match the gate artifact`);
    return { ok: errors.length === 0, errors, value };
  } catch (error) {
    return { ok: false, errors: [`dependency #${dependencyNumber} acceptance JSON is invalid: ${error.message}`] };
  }
}

function validateDependencyGateArtifact(gate, repository) {
  const errors = [];
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return { ok: false, errors: ['dependency gate artifact must be an object'] };
  const allowed = new Set(['schema_version', 'parent_issue', 'target_issue', 'dependencies']);
  for (const key of Object.keys(gate)) if (!allowed.has(key)) errors.push(`dependency gate has unsupported field: ${key}`);
  if (gate.schema_version !== DEPENDENCY_GATE_SCHEMA_VERSION) errors.push(`dependency gate schema_version must be ${DEPENDENCY_GATE_SCHEMA_VERSION}`);
  if (gate.parent_issue !== 919) errors.push('dependency gate parent_issue must be 919');
  if (gate.target_issue !== 923) errors.push('dependency gate target_issue must be 923');
  const deps = gate.dependencies;
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) errors.push('dependency gate dependencies must be an object');
  else {
    const keys = Object.keys(deps).sort((a, b) => Number(a) - Number(b));
    if (keys.length !== REQUIRED_DEPENDENCIES.length || keys.some((key, index) => Number(key) !== REQUIRED_DEPENDENCIES[index])) errors.push(`dependency gate must contain exactly #${REQUIRED_DEPENDENCIES.join(', #')}`);
    for (const dependencyNumber of REQUIRED_DEPENDENCIES) {
      const entry = deps[String(dependencyNumber)];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`dependency gate entry #${dependencyNumber} is missing`);
        continue;
      }
      const entryAllowed = new Set(['issue_number', 'state', 'acceptance', 'evidence_schema', 'evidence', 'acceptance_evidence']);
      for (const key of Object.keys(entry)) if (!entryAllowed.has(key)) errors.push(`dependency gate #${dependencyNumber} has unsupported field: ${key}`);
      if (Number(entry.issue_number) !== dependencyNumber) errors.push(`dependency gate #${dependencyNumber} issue_number mismatch`);
      if (String(entry.state).toLowerCase() !== 'closed') errors.push(`dependency gate #${dependencyNumber} state must be closed`);
      if (entry.acceptance !== 'pass') errors.push(`dependency gate #${dependencyNumber} acceptance must be pass`);
      if (entry.evidence_schema !== DEPENDENCY_ACCEPTANCE_SCHEMA_VERSION) errors.push(`dependency gate #${dependencyNumber} evidence_schema must be ${DEPENDENCY_ACCEPTANCE_SCHEMA_VERSION}`);
      if (!parseIssueCommentUrl(repository, dependencyNumber, entry.evidence)) errors.push(`dependency gate #${dependencyNumber} evidence must be an issue comment URL for the same Issue`);
      if (!parseIssueCommentUrl(repository, dependencyNumber, entry.acceptance_evidence)) errors.push(`dependency gate #${dependencyNumber} acceptance_evidence must be an issue comment URL for the same Issue`);
    }
  }
  return { ok: errors.length === 0, errors, gate };
}

function validateLiveDependencyGate(gate, repository, dependencies = [], readEvidence = null) {
  const structural = validateDependencyGateArtifact(gate, repository);
  if (!structural.ok) return structural;
  const errors = [];
  const liveByNumber = new Map(dependencies.map((issue) => [Number(issue.number), issue]));
  const getEvidence = (url) => {
    if (typeof readEvidence === 'function') return readEvidence(url);
    if (readEvidence instanceof Map) return readEvidence.get(url);
    if (readEvidence && typeof readEvidence === 'object') return readEvidence[url];
    return null;
  };
  for (const dependencyNumber of REQUIRED_DEPENDENCIES) {
    const entry = gate.dependencies[String(dependencyNumber)];
    const live = liveByNumber.get(dependencyNumber);
    if (!live) {
      errors.push(`dependency Issue #${dependencyNumber} was not loaded`);
      continue;
    }
    if (String(live.state || '').toLowerCase() !== 'closed') errors.push(`dependency Issue #${dependencyNumber} is not closed (state=${live.state})`);
    const anchor = getEvidence(entry.evidence);
    if (!anchor) {
      errors.push(`dependency #${dependencyNumber} acceptance anchor could not be read`);
      continue;
    }
    if (Number(anchor.id) !== Number(entry.evidence.match(/#issuecomment-(\d+)$/)?.[1])) errors.push(`dependency #${dependencyNumber} acceptance anchor comment id mismatch`);
    if (anchor.issue_url !== `https://api.github.com/repos/${repository}/issues/${dependencyNumber}`) errors.push(`dependency #${dependencyNumber} acceptance anchor issue_url mismatch`);
    const acceptance = parseDependencyAcceptance(anchor.body, repository, dependencyNumber, entry.acceptance_evidence);
    errors.push(...acceptance.errors);
    const finalEvidence = getEvidence(entry.acceptance_evidence);
    if (!finalEvidence) errors.push(`dependency #${dependencyNumber} final acceptance evidence could not be read`);
    else {
      if (Number(finalEvidence.id) !== Number(entry.acceptance_evidence.match(/#issuecomment-(\d+)$/)?.[1])) errors.push(`dependency #${dependencyNumber} final acceptance evidence comment id mismatch`);
      if (finalEvidence.issue_url !== `https://api.github.com/repos/${repository}/issues/${dependencyNumber}`) errors.push(`dependency #${dependencyNumber} final acceptance evidence issue_url mismatch`);
    }
  }
  return { ok: errors.length === 0, errors, gate };
}

function validateContextArtifact(artifact, context, repository) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return { ok: false, errors: ['context_artifact must be an object'] };
  const allowed = new Set(['repository', 'path', 'ref', 'commit', 'sha256']);
  for (const key of Object.keys(artifact)) if (!allowed.has(key)) errors.push(`context_artifact has unsupported field: ${key}`);
  if (artifact.repository !== repository) errors.push('context_artifact.repository must match request.repository');
  if (typeof artifact.path !== 'string' || !/^data\/interview-contexts\/[A-Za-z0-9_-]+\.v1\.json$/.test(artifact.path)) errors.push('context_artifact.path must be a safe data/interview-contexts/*.v1.json path');
  if (typeof artifact.ref !== 'string' || !/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/.test(artifact.ref)) errors.push('context_artifact.ref must be a fully-qualified heads/tags ref');
  if (!HEX40_RE.test(artifact.commit || '')) errors.push('context_artifact.commit must be a lowercase 40-char commit SHA');
  if (!HEX64_RE.test(artifact.sha256 || '')) errors.push('context_artifact.sha256 must be a lowercase 64-char SHA-256');
  if (context && artifact.sha256 !== contextSha256(context)) errors.push('context_artifact.sha256 must equal the reviewed Context canonical digest');
  return { ok: errors.length === 0, errors, artifact };
}

function verifyContextArtifact(context, artifact, repository, readers = {}) {
  const structural = validateContextArtifact(artifact, context, repository);
  if (!structural.ok) return structural;
  const errors = [];
  if (typeof readers.readRef !== 'function' || typeof readers.readCommit !== 'function' || typeof readers.readContent !== 'function') {
    return { ok: false, errors: ['durable Context readers are required; refusing to synthesize remote Git verification'], artifact };
  }
  try {
    const ref = readers.readRef(artifact.ref);
    const refSha = ref && (ref.sha || (ref.object && ref.object.sha));
    if (!ref || !refSha) errors.push('context_artifact ref could not be resolved');
    else if (refSha !== artifact.commit) {
      if (typeof readers.readCompare !== 'function') errors.push('context_artifact ref advanced; ancestry reader is required to verify the pinned commit');
      else {
        const comparison = readers.readCompare(artifact.commit, artifact.ref);
        if (!comparison || !['ahead', 'identical'].includes(comparison.status) || Number(comparison.behind_by || 0) !== 0) errors.push('context_artifact ref does not contain the pinned commit or has diverged');
      }
    }
    const commit = readers.readCommit(artifact.commit);
    if (!commit || (commit.sha && commit.sha !== artifact.commit)) errors.push('context_artifact commit cannot be verified');
    const content = readers.readContent(artifact.path, artifact.commit);
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    if (contextSha256(parsed) !== artifact.sha256) errors.push('durable Context content digest conflicts with context_artifact.sha256');
    if (contextSha256(parsed) !== contextSha256(context)) errors.push('durable Context content conflicts with requested reviewed Context');
  } catch (error) {
    errors.push(`durable Context artifact could not be verified: ${error.message}`);
  }
  return { ok: errors.length === 0, errors, artifact };
}

function validateRequest(request) {
  const errors = [];
  if (!request || typeof request !== 'object' || Array.isArray(request)) return { ok: false, errors: ['request must be an object'] };
  const allowed = new Set(['schema_version', 'batch_id', 'repository', 'dependency_issues', 'dependency_gate_file', 'expected_dependency_gate_sha256', 'pilot_size', 'items']);
  for (const key of Object.keys(request)) if (!allowed.has(key)) errors.push(`unsupported request field: ${key}`);
  if (request.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!nonEmpty(request.batch_id) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.batch_id || '')) errors.push('batch_id must be a stable machine identifier');
  if (!nonEmpty(request.repository) || !/^[^/]+\/[^/]+$/.test(request.repository || '')) errors.push('repository must be owner/name');
  if (request.dependency_gate_file !== 'data/pilot/issue-923/dependency-gate.json') errors.push('dependency_gate_file must be data/pilot/issue-923/dependency-gate.json');
  if (!HEX64_RE.test(request.expected_dependency_gate_sha256 || '')) errors.push('expected_dependency_gate_sha256 must be a lowercase 64-char SHA-256');
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
      const itemAllowed = new Set(['issue_number', 'expected_body_sha256', 'context', 'context_artifact']);
      for (const key of Object.keys(item)) if (!itemAllowed.has(key)) errors.push(`${prefix} unsupported field: ${key}`);
      if (!Number.isInteger(item.issue_number) || item.issue_number <= 0) errors.push(`${prefix}.issue_number must be a positive integer`);
      else if (issueNumbers.has(item.issue_number)) errors.push(`${prefix}.issue_number is duplicated`);
      else issueNumbers.add(item.issue_number);
      if (!HEX64_RE.test(item.expected_body_sha256 || '')) errors.push(`${prefix}.expected_body_sha256 must be a lowercase 64-char SHA-256`);
      const validation = validateInterviewContext(item.context);
      if (!validation.ok) errors.push(...validation.errors.map((error) => `${prefix}.context: ${error}`));
      const artifactValidation = validateContextArtifact(item.context_artifact, item.context, request.repository);
      if (!artifactValidation.ok) errors.push(...artifactValidation.errors.map((error) => `${prefix}.context_artifact: ${error}`));
      if (item.context && contextIds.has(item.context.context_id)) errors.push(`${prefix}.context.context_id is duplicated`);
      if (item.context && item.context.context_id) contextIds.add(item.context.context_id);
    });
  }
  return { ok: errors.length === 0, errors };
}

function dependencyGate(request, dependencies = [], gateArtifact = null, readEvidence = null) {
  const errors = [];
  if (!gateArtifact) return { ok: false, errors: ['structured dependency gate artifact is required'] };
  const result = validateLiveDependencyGate(gateArtifact, request.repository, dependencies, readEvidence);
  errors.push(...result.errors);
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
    && receipt.intent_id === intentId(request, item)
    && receipt.context_artifact && item.context_artifact
    && receipt.context_artifact.repository === item.context_artifact.repository
    && receipt.context_artifact.path === item.context_artifact.path
    && receipt.context_artifact.ref === item.context_artifact.ref
    && receipt.context_artifact.commit === item.context_artifact.commit
    && receipt.context_artifact.sha256 === item.context_artifact.sha256
    && receipt.title === projection.title
    && JSON.stringify(receipt.labels || []) === JSON.stringify(projection.labels);
}

function intentId(request, item) {
  const context = item.context || (item.projection && item.projection.context);
  const bodySha = item.expected_body_sha256 || item.current_body_sha256;
  return sha256Text(`${request.repository}:${request.batch_id}:${item.issue_number}:${bodySha}:${contextSha256(context)}`);
}

function progressFromPlan(request, plan, dryRunDigest, maxMutations, now = new Date().toISOString()) {
  return {
    schema_version: PROGRESS_SCHEMA_VERSION,
    batch_id: request.batch_id,
    repository: request.repository,
    dry_run_digest: dryRunDigest,
    max_mutations: maxMutations,
    created_at: now,
    updated_at: now,
    items: plan.items.map((item) => ({
      issue_number: item.issue_number,
      expected_body_sha256: request.items.find((candidate) => Number(candidate.issue_number) === Number(item.issue_number)).expected_body_sha256,
      context_sha256: item.projection && item.projection.context_sha256,
      context_artifact: item.projection && item.projection.context_artifact,
      title: item.projection && item.projection.title,
      labels: item.projection && item.projection.labels,
      intent_id: intentId(request, request.items.find((candidate) => Number(candidate.issue_number) === Number(item.issue_number))),
      planned_action: item.action,
      state: item.action === 'already_applied' ? 'complete' : 'pending',
      receipt_comment_id: item.receipt ? item.receipt.comment_id : null,
    })),
  };
}

function validateProgressMapping(progress, request, plan, dryRunDigest, maxMutations) {
  const errors = [];
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return { ok: false, errors: ['apply progress must be an object'] };
  if (progress.schema_version !== PROGRESS_SCHEMA_VERSION) errors.push(`apply progress schema_version must be ${PROGRESS_SCHEMA_VERSION}`);
  if (progress.batch_id !== request.batch_id || progress.repository !== request.repository) errors.push('apply progress batch/repository does not match request');
  if (progress.dry_run_digest !== dryRunDigest) errors.push('apply progress dry-run digest does not match the confirmed digest');
  if (progress.max_mutations !== maxMutations) errors.push('apply progress max_mutations does not match the confirmed mutation ceiling');
  if (!Array.isArray(progress.items) || progress.items.length !== plan.items.length) errors.push('apply progress item count does not match the planned batch');
  else {
    const byNumber = new Map(progress.items.map((item) => [Number(item.issue_number), item]));
    for (const planned of plan.items) {
      const requestItem = request.items.find((item) => Number(item.issue_number) === Number(planned.issue_number));
      const saved = byNumber.get(Number(planned.issue_number));
      if (!saved) { errors.push(`apply progress is missing Issue #${planned.issue_number}`); continue; }
      if (saved.expected_body_sha256 !== requestItem.expected_body_sha256) errors.push(`apply progress Issue #${planned.issue_number} body mapping differs`);
      if (!planned.projection || saved.context_sha256 !== planned.projection.context_sha256) errors.push(`apply progress Issue #${planned.issue_number} Context mapping differs`);
      if (!planned.projection || JSON.stringify(saved.context_artifact || null) !== JSON.stringify(planned.projection.context_artifact || null)) errors.push(`apply progress Issue #${planned.issue_number} durable artifact mapping differs`);
      if (saved.intent_id !== intentId(request, requestItem)) errors.push(`apply progress Issue #${planned.issue_number} intent mapping differs`);
      if (planned.projection && (saved.title !== planned.projection.title || JSON.stringify(saved.labels || []) !== JSON.stringify(planned.projection.labels || []))) errors.push(`apply progress Issue #${planned.issue_number} projection mapping differs`);
      if (!['pending', 'issue_mutation_pending', 'issue_converged', 'receipt_pending', 'complete', 'failed'].includes(saved.state)) errors.push(`apply progress Issue #${planned.issue_number} has unsupported state ${saved.state}`);
      if (saved.state === 'failed' && (typeof saved.error !== 'string' || saved.error.trim() === '')) errors.push(`apply progress Issue #${planned.issue_number} failed state requires a non-empty error`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function planItem(request, item, issue, receipts = [], contextArtifactResult = null) {
  const errors = [];
  if (contextArtifactResult && !contextArtifactResult.ok) errors.push(...contextArtifactResult.errors.map((error) => `durable Context artifact invalid: ${error}`));
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
    context_artifact: item.context_artifact,
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
    action: matchingReceipt && alreadyProjected ? 'already_applied' : (alreadyProjected ? 'repair_receipt' : 'update'),
    errors: [],
    unknown_facts: projection.unknown_facts,
    current_body_sha256: bodySha,
    current_title: currentTitle,
    current_labels: currentLabels,
    projection,
    receipt: matchingReceipt || null,
  };
}

function planBatch(request, { dependencies = [], issues = [], receiptsByIssue = new Map(), dependencyGateArtifact = null, dependencyEvidence = null, contextArtifactsByIssue = new Map() } = {}) {
  const requestValidation = validateRequest(request);
  if (!requestValidation.ok) return { ok: false, blocked: false, errors: requestValidation.errors, items: [], summary: null };
  const gate = dependencyGate(request, dependencies, dependencyGateArtifact, dependencyEvidence);
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
    const artifactResult = contextArtifactsByIssue instanceof Map ? contextArtifactsByIssue.get(Number(item.issue_number)) : null;
    return planItem(request, item, issue, receipts, artifactResult);
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

function planDigest(plan) {
  return sha256Text(canonicalJson({
    blocked: plan.blocked,
    errors: plan.errors,
    summary: plan.summary,
    items: plan.items.map((item) => ({
      issue_number: item.issue_number,
      action: item.action,
      errors: item.errors,
      current_body_sha256: item.current_body_sha256,
      projection: item.projection && {
        interview_note_id: item.projection.interview_note_id,
        context_sha256: item.projection.context_sha256,
        context_artifact: item.projection.context_artifact,
        title: item.projection.title,
        labels: item.projection.labels,
      },
    })),
  }));
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
    context_artifact: item.projection.context_artifact,
    intent_id: intentId(request, item),
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
  parseIssueCommentUrl,
  parseDependencyAcceptance,
  validateDependencyGateArtifact,
  validateLiveDependencyGate,
  validateContextArtifact,
  verifyContextArtifact,
  intentId,
  progressFromPlan,
  validateProgressMapping,
  validateRequest,
  dependencyGate,
  normalizeLabels,
  projectLabels,
  unknownFacts,
  planItem,
  planBatch,
  planDigest,
  receiptFor,
  receiptBody,
};
