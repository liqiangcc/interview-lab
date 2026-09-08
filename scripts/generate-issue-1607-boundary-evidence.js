#!/usr/bin/env node
'use strict';

/* Generate only local, non-executable Boundary B audit artifacts. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { canonicalJson } = require('./prepare-issue-1607-boundary-batch');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const EXPECTED_COUNT = 367;

function sha256Text(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex'); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function classifyProjection(projectionText) {
  const text = String(projectionText || '').replace(/\\n/g, '\n');
  const lines = text.split(/\r?\n/);
  const lineEvidence = (patterns) => lines.map((line, index) => ({ line, number: index + 1 })).filter(({ line }) => patterns.some((pattern) => pattern.test(line))).slice(0, 4).map(({ line, number }) => ({ line_number: number, excerpt: line }));
  const firstPerson = /(?:我|本人|自己|亲身)/.test(text);
  const processFact = /(?:参加过?面试|面试了|面完|被问|面试官问|面试流程|一面问|二面问|三面问|问了我|收到.*结果|拿到.*offer|面试挂|面试通过)/.test(text);
  const questionEvidence = /(?:问了|问题|面试题|题目|Q\s*\d+|怎么|为什么|如何|介绍一下)/.test(text);
  const declined = /(?:没面|未面|没有面|不面|放弃面试|拒绝面试)/.test(text);
  const appointmentOrAdvice = /(?:邀约|邀请|预约|约面|面试安排|据说|有没有.*情况|推荐去|准备面试|面试有所帮助|场景题|八股|资料|经验分享|求职招聘|岗位|职位|招聘|工作内容|薪资|base|外包|明天|后天|下周|几点|时间)/i.test(text);
  if (declined && !processFact) return { status: 'proposal-only', proposed_decision: 'not-interview', basis: 'explicit refusal/non-interview fact without an experienced interview process', basis_lines: lineEvidence([/(没面|未面|没有面|不面|放弃面试|拒绝面试)/]) };
  if (firstPerson && processFact && questionEvidence && !appointmentOrAdvice) return { status: 'proposal-only', proposed_decision: 'single-interview', basis: 'first-person experienced process fact plus question evidence; no appointment/advice marker', basis_lines: lineEvidence([/(参加过?面试|面试了|面完|被问|面试官问|面试流程|一面问|二面问|三面问|问了我)/, /(?:问了|问题|面试题|题目|Q\s*\d+|怎么|为什么|如何|介绍一下)/]) };
  return { status: 'review-required', proposed_decision: 'pending', basis: 'interview-like words are insufficient: no unambiguous first-person experienced process with questions, or the text is appointment/advice/question-bank content', basis_lines: lineEvidence([/(邀约|邀请|预约|据说|准备面试|场景题|八股|资料|经验分享|求职招聘|问题|面试题|题目)/]) };
}

function evidenceFor(item) {
  const transitionId = `issue-1607-boundary-${String(item.issue_number).padStart(4, '0')}-review-1`;
  const sourceVerified = item.status === 'verified' && item.source_verification?.status === 'verified';
  const classification = sourceVerified
    ? classifyProjection(item.source_projection.text || item.source_projection.excerpt)
    : { status: 'blocked', proposed_decision: 'pending', basis: 'pinned Source projection is blocked; no classification is proposed' };
  return {
    schema_version: 'issue-1607-boundary-evidence.v1',
    transition_id: transitionId,
    repository: REPOSITORY,
    child_issue: 1607,
    issue_number: item.issue_number,
    issue_url: item.issue_url,
    source_note_id: item.source_note_id,
    expected_body_sha256: item.body_sha256,
    expected_source_revision_id: item.source_revision_id,
    expected_source_repository_ref: SOURCE_REF,
    evidence_status: sourceVerified ? 'review-required' : 'blocked',
    decision: 'pending',
    decision_basis: sourceVerified
      ? 'Pinned Source bytes are independently verified; the deterministic classification below is proposal-only and requires controller review plus durable evidence before any transition.'
      : 'Boundary decision is withheld because the pinned Source projection bytes were not independently fetched and verified for this item.',
    classification,
    source_evidence: {
      ref: item.source_projection.artifact.ref,
      kind: item.source_projection.artifact.kind,
      provenance: item.source_projection.artifact.provenance,
      git_blob_sha: item.source_projection.artifact.git_blob_sha,
      byte_size: item.source_projection.artifact.byte_size,
      sha256: item.source_projection.artifact.sha256,
      locator: item.source_projection.locator,
      excerpt: item.source_projection.excerpt,
      text: item.source_projection.text,
      line_count: item.source_projection.line_count,
      verification: item.source_projection.verification || item.source_verification,
    },
    checks: [
      { check_id: 'source_identity', result: 'pass', note: 'Issue body machine record and SourceNote identity are frozen and internally consistent.' },
      { check_id: 'source_revision_binding', result: 'pass', note: `SourceRevision is bound to ${SOURCE_REF} in the frozen Issue body.` },
      { check_id: 'source_content_coverage', result: sourceVerified ? 'pass' : 'blocked', note: sourceVerified ? 'Raw bytes at the fixed ref matched the frozen Git blob SHA.' : 'Exact pinned Source projection bytes and Git blob content were not independently verified.' },
      { check_id: 'event_boundary', result: 'review-required', note: 'Classification is proposal-only; no 0/1/N decision is authorized by this artifact.' },
      { check_id: 'no_cross_source_mixing', result: 'pass', note: 'This ledger item references only its own SourceNote and its canonical note_desc artifact.' },
      { check_id: 'no_fabrication', result: 'pass', note: 'No InterviewNote identity, company, role, round, outcome, or derived content is created.' },
    ],
    limitations: [
      ...(sourceVerified ? [] : ['The excerpt is an Issue-body copy of the cited Source projection, not a substitute for independently verified pinned bytes.']),
      'The classification is deterministic proposal-only output from the cited projection excerpt, not durable human review evidence.',
      'Boundary remains pending; this item cannot authorize materialization or any GitHub mutation.',
      'Raw Source and Derived interpretations remain separate; no Raw artifact is modified.',
    ],
  };
}

function requestFor(item, evidence) {
  return {
    schema_version: 'issue-1607-boundary-request-template.v1',
    transition_id: evidence.transition_id,
    repository: REPOSITORY,
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    expected_body_sha256: item.body_sha256,
    expected_boundary_status: 'pending',
    expected_source_revision_id: item.source_revision_id,
    expected_source_repository_ref: SOURCE_REF,
    decision: 'pending',
    review_evidence: null,
    reviewed_at: null,
    evidence_file: `../evidence/${String(item.issue_number).padStart(4, '0')}.json`,
    executable: false,
    block_reason: `${item.status === 'verified' ? 'Durable review evidence and controller review are absent' : 'Pinned Source bytes are unverified'}; controller must independently review and bind a valid transition request before any apply authorization.`,
  };
}

function main(argv = process.argv.slice(2)) {
  const selectionFile = argv[argv.indexOf('--selection') + 1] || 'data/issue-1607/selection.json';
  const outputDir = path.resolve(argv[argv.indexOf('--output-dir') + 1] || 'data/issue-1607');
  const selection = JSON.parse(fs.readFileSync(path.resolve(selectionFile), 'utf8'));
  if (selection.schema_version !== 'issue-1607-boundary-b-selection.v1' || selection.repository !== REPOSITORY) throw new Error('selection is not bound to Boundary B');
  if (selection.items.length !== EXPECTED_COUNT) throw new Error(`selection must contain ${EXPECTED_COUNT} items`);
  if (selection.source_snapshot?.ref !== SOURCE_REF) throw new Error('selection source ref is not the fixed ref');
  const evidenceItems = selection.items.map(evidenceFor);
  const requestItems = selection.items.map((item, index) => requestFor(item, evidenceItems[index]));
  const classificationItems = evidenceItems.map((item) => ({
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    source_projection_ref: item.source_evidence.ref,
    locator: item.source_evidence.locator,
    excerpt: item.source_evidence.excerpt,
    full_projection_sha256: item.source_evidence.sha256,
    basis_lines: item.classification.basis_lines || [],
    status: item.classification.status,
    proposed_decision: item.classification.proposed_decision,
    basis: item.classification.basis,
  }));
  const classificationCounts = classificationItems.reduce((counts, item) => {
    counts[item.proposed_decision] = (counts[item.proposed_decision] || 0) + 1;
    return counts;
  }, {});
  const classificationLedger = {
    schema_version: 'issue-1607-boundary-classification-ledger.v1',
    repository: REPOSITORY,
    child_issue: 1607,
    source_ref: SOURCE_REF,
    status: 'proposal-only',
    counts: classificationCounts,
    total: classificationItems.length,
    items: classificationItems,
  };
  const sourceVerifiedCount = selection.items.filter((item) => item.status === 'verified').length;
  const sourceBlockedCount = selection.items.filter((item) => item.status === 'blocked').length;
  const evidenceLedger = {
    schema_version: 'issue-1607-boundary-evidence-ledger.v1',
    repository: REPOSITORY,
    child_issue: 1607,
    selection_sha256: sha256Text(canonicalJson(selection)),
    total: evidenceItems.length,
    counts: { pending: evidenceItems.length, blocked: sourceBlockedCount, review_required: sourceVerifiedCount, authorized: 0 },
    items: evidenceItems,
  };
  const requestSet = {
    schema_version: 'issue-1607-boundary-request-set.v1',
    repository: REPOSITORY,
    child_issue: 1607,
    selection_sha256: evidenceLedger.selection_sha256,
    evidence_ledger_sha256: sha256Text(canonicalJson(evidenceLedger)),
    classification_ledger_sha256: sha256Text(canonicalJson(classificationLedger)),
    total: requestItems.length,
    executable: false,
    items: requestItems,
  };
  const plan = {
    schema_version: 'issue-1607-boundary-dry-run-plan.v1',
    repository: REPOSITORY,
    parent_issue: 1605,
    child_issue: 1607,
    scope: selection.scope,
    source_snapshot: selection.source_snapshot,
    scope_compliance: {
      status: 'blocked',
      reason: 'This preparation run recorded an accidental read-only probe of #766 before the scoped inventory. No mutation occurred, but the run is not scope-clean and must not authorize apply.',
      out_of_scope_mutations: 0,
    },
    selection_sha256: evidenceLedger.selection_sha256,
    evidence_ledger_sha256: sha256Text(canonicalJson(evidenceLedger)),
    request_set_sha256: sha256Text(canonicalJson(requestSet)),
    mode: 'dry-run',
    fail_closed: true,
    counts: { total: EXPECTED_COUNT, pending: EXPECTED_COUNT, blocked: sourceBlockedCount, review_required: sourceVerifiedCount, ready: 0, already_applied: 0, mutation_count: 0 },
    blocked_reasons: [
      ...(sourceBlockedCount ? ['one or more pinned Source projection items remain independently unverified'] : []),
      'classification output is proposal-only and requires controller review',
      'durable review evidence comments have not been created or bound',
      'main controller has not granted live apply authorization',
    ],
    items: evidenceItems.map((item) => ({
      issue_number: item.issue_number,
      transition_id: item.transition_id,
      source_note_id: item.source_note_id,
      decision: item.decision,
      status: item.evidence_status === 'blocked' ? 'blocked' : 'review-required',
      expected_body_sha256: item.expected_body_sha256,
      expected_source_revision_id: item.expected_source_revision_id,
      source_projection_ref: item.source_evidence.ref,
      source_projection_blob: item.source_evidence.git_blob_sha,
      next_body_sha256: null,
      mutation: 'none',
    })),
  };
  plan.dry_run_sha256 = sha256Text(canonicalJson(plan));
  const journal = {
    schema_version: 'issue-1607-boundary-apply-journal.v1',
    repository: REPOSITORY,
    parent_issue: 1605,
    child_issue: 1607,
    selection_sha256: evidenceLedger.selection_sha256,
    dry_run_sha256: plan.dry_run_sha256,
    status: 'not-started',
    mutation_count: 0,
    entries: [],
    terminal_reason: 'No live GitHub apply is authorized by the child issue; each item remains blocked or review-required pending controller review, durable evidence, and remediation of the recorded out-of-scope read incident.',
  };
  const digest = {
    schema_version: 'issue-1607-boundary-canonical-digest.v1',
    repository: REPOSITORY,
    child_issue: 1607,
    selection_sha256: evidenceLedger.selection_sha256,
    evidence_ledger_sha256: sha256Text(canonicalJson(evidenceLedger)),
    request_set_sha256: sha256Text(canonicalJson(requestSet)),
    classification_ledger_sha256: sha256Text(canonicalJson(classificationLedger)),
    dry_run_sha256: plan.dry_run_sha256,
    journal_sha256: sha256Text(canonicalJson(journal)),
  };
  writeJson(path.join(outputDir, 'evidence-ledger.json'), evidenceLedger);
  writeJson(path.join(outputDir, 'request-set.json'), requestSet);
  writeJson(path.join(outputDir, 'classification-ledger.json'), classificationLedger);
  writeJson(path.join(outputDir, 'dry-run.plan.json'), plan);
  writeJson(path.join(outputDir, 'apply.journal.json'), journal);
  writeJson(path.join(outputDir, 'canonical-digest.json'), digest);
  fs.mkdirSync(path.join(outputDir, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(outputDir, 'requests'), { recursive: true });
  evidenceItems.forEach((item) => writeJson(path.join(outputDir, 'evidence', `${String(item.issue_number).padStart(4, '0')}.json`), item));
  requestItems.forEach((item) => writeJson(path.join(outputDir, 'requests', `${String(item.issue_number).padStart(4, '0')}.json`), item));
  process.stdout.write(`${JSON.stringify({ total: EXPECTED_COUNT, source_verified: sourceVerifiedCount, source_blocked: sourceBlockedCount, mutation_count: 0, dry_run_sha256: plan.dry_run_sha256 }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}

module.exports = { classifyProjection, evidenceFor, requestFor, sha256Text };
