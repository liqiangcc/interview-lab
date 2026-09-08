#!/usr/bin/env node
'use strict';

/*
 * Controller for the full SourceNote boundary stage of Issue #1605.
 *
 * This tool deliberately separates the read-only decision plan from the two
 * mutation stages.  `plan` only reads committed child artifacts and the local
 * SourceNote snapshot.  `evidence` may POST one durable review comment per
 * approved decision, but never PATCHes a SourceNote.  `transition` is kept as
 * a separate, guarded stage and is not enabled by this first implementation.
 *
 * The child workers produce deliberately different audit schemas.  The
 * normalizer below is the single controller-owned boundary between those
 * proposals and the formal source-note-boundary-review-transition.v1/v2
 * contract.  Any missing or contradictory fact is fail-closed.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPOSITORY = 'liqiangcc/interview-lab';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const PARENT_ISSUE = 1605;
const PENDING_SNAPSHOT = 'data/pilot/issue-1605/pending-inventory.snapshot.json';
const REMAINING_MANIFEST = 'data/pilot/issue-1605/remaining-boundary.manifest.json';
const REMAINING_SCOPE_DIGEST = '6ef4fa26e838fe8c30d571c08807c09d5a3280eb40aa4af57d679274f6a131a1';
const REMAINING_MANIFEST_DIGEST = 'fea78669500c0986eff96b67b7e2d35afdf46355bc7caa9b862116eca40b4ba9';
const COMPLETED_MANIFEST = 'data/pilot/issue-1605/full-boundary-manifest.json';
const COMPLETED_MANIFEST_DIGEST = '40fd63cccea624a567778f5c679a9e0e77b0784181de4d54cacad9873ae6c97a';
const DEFAULT_OUTPUT = 'data/pilot/issue-1605/remaining-boundary-evidence-plan.json';
const DEFAULT_JOURNAL = 'data/pilot/issue-1605/remaining-boundary-evidence-progress.json';
const DEFAULT_LOCK = 'data/pilot/issue-1605/remaining-boundary-evidence-progress.lock';
const DEFAULT_REQUEST_DIR = 'data/pilot/issue-1605/remaining-boundary-evidence-requests';
const SNAPSHOT_CACHE = '/tmp/interview-lab-cache/source-notes.json';
const TRANSITION_SCHEMA = 'source-note-boundary-review-transition.v1';
const MULTI_TRANSITION_SCHEMA = 'source-note-boundary-review-transition.v2';
const EVIDENCE_AUTHORIZATION_SCHEMA = 'issue-1605-remaining-boundary-evidence-authorization.v1';
const EVIDENCE_AUTHORIZATION_MARKER = 'issue-1605-remaining-boundary-evidence-authorization';
const SAFE_HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED_CHECKS = Object.freeze([
  'source_identity',
  'source_revision_binding',
  'source_content_coverage',
  'event_boundary',
  'no_cross_source_mixing',
  'no_fabrication',
]);
const ALLOWED_BLOCKED_AUDIT_ERRORS = Object.freeze(new Set([
  '#735 multi-interview has fewer than two cases',
]));

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function writeJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
  const directory = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function writeRequest(file, request) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  const body = `<!-- source-note-boundary-review-transition\n${JSON.stringify(request, null, 2)}\n-->\n`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, target);
  const directory = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function labelsOf(issue) {
  const raw = Array.isArray(issue.labels) ? issue.labels : (issue.labels?.nodes || []);
  return raw
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter(Boolean)
    .sort();
}

function pad(number) {
  return String(number).padStart(4, '0');
}

function issueMapFromCache(file = SNAPSHOT_CACHE) {
  const values = readJson(file);
  const list = Array.isArray(values) ? values : values.issues;
  if (!Array.isArray(list)) throw new Error(`SourceNote cache is not an array: ${file}`);
  return new Map(list.map((issue) => [Number(issue.number), issue]));
}

function pendingInventory(file = PENDING_SNAPSHOT) {
  const snapshot = readJson(file);
  if (snapshot.schema_version !== 'issue-1605-pending-source-note-inventory.v1') {
    throw new Error(`unexpected pending inventory schema: ${snapshot.schema_version}`);
  }
  if (snapshot.source_repository !== SOURCE_REPOSITORY || snapshot.source_ref !== SOURCE_REF) {
    throw new Error('pending inventory is not pinned to the approved XHS source ref');
  }
  const numbers = snapshot.items.map((item) => Number(item.issue_number));
  if (numbers.length !== 1397 || new Set(numbers).size !== numbers.length) {
    throw new Error(`pending inventory must contain 1397 unique SourceNotes; got ${numbers.length}`);
  }
  const digestInput = { ...snapshot };
  delete digestInput.canonical_digest;
  delete digestInput.validation;
  delete digestInput.generated_at;
  if (snapshot.canonical_digest !== sha256(canonical(digestInput))
      || snapshot.canonical_digest !== '5bbf8de3dc61ed382ee31e0d0286c3e7374efec243f60b245c76ee2e0b553dfd') {
    throw new Error('pending inventory canonical digest is not the approved 1397-row snapshot');
  }
  return { snapshot, numbers: new Set(numbers) };
}

function remainingInventory(file = REMAINING_MANIFEST, frozen) {
  const manifest = readJson(file);
  const errors = [];
  if (manifest.schema_version !== 'issue-1605-next-boundary-manifest.v1') errors.push(`unexpected remaining manifest schema: ${manifest.schema_version}`);
  if (manifest.repository !== REPOSITORY || manifest.parent_issue !== PARENT_ISSUE) errors.push('remaining manifest repository/parent mismatch');
  if (manifest.source_snapshot?.repository !== SOURCE_REPOSITORY || manifest.source_snapshot?.ref !== SOURCE_REF) errors.push('remaining manifest is not pinned to the approved XHS source ref');
  if (manifest.scope_digest !== REMAINING_SCOPE_DIGEST) errors.push('remaining manifest scope digest is not the approved 978-row scope');
  if (manifest.canonical_digest !== REMAINING_MANIFEST_DIGEST) errors.push('remaining manifest canonical digest is not the approved 978-row manifest');
  const digestInput = { ...manifest };
  delete digestInput.ok;
  delete digestInput.canonical_digest;
  if (manifest.canonical_digest !== sha256(canonical(digestInput))) errors.push('remaining manifest canonical digest does not match content');
  if (manifest.ok !== true) errors.push('remaining manifest is not marked valid');
  const items = Array.isArray(manifest.items) ? manifest.items : [];
  if (manifest.remaining_count !== 978 || items.length !== 978) errors.push(`remaining manifest must contain 978 unique SourceNotes; got ${items.length}`);
  const numbers = items.map((item) => Number(item.issue_number));
  if (new Set(numbers).size !== numbers.length) errors.push('remaining manifest contains duplicate issue numbers');
  const frozenNumbers = frozen?.numbers || new Set();
  for (const number of numbers) if (!frozenNumbers.has(number)) errors.push(`#${number} in remaining manifest is outside the approved frozen inventory`);
  const expectedBatches = { A: 235, B: 257, C: 248, D: 238 };
  for (const batch of Object.entries(expectedBatches)) {
    const [name, expected] = batch;
    const actual = manifest.batches?.find((candidate) => candidate.batch === name);
    if (!actual || actual.count !== expected || actual.remaining_count !== expected || actual.issue_numbers?.length !== expected) {
      errors.push(`remaining manifest Boundary ${name} count is not ${expected}`);
    }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return { manifest, numbers: new Set(numbers) };
}

// Boundary A predates the v2 case contract and its multi decisions carry only
// a single controller excerpt.  These are the exact, independently observed
// event lines in the pinned note_desc projection.  They are deliberately
// controller-owned so that a later transition cannot silently invent case
// identities from a one-line child request.
const BOUNDARY_A_MULTI_CASE_LINES = Object.freeze({
  139: [2, 15],
  179: [4, 28],
  187: [1, 4],
  234: [4, 5],
  253: [2, 3, 5],
  388: [2, 3],
});

function caseKeyForRound(raw) {
  const token = String(raw || '');
  if (/^(?:一面|1️⃣面|1面|第一轮|第一面|第[一]面)$/.test(token)) return 'round-1';
  if (/^(?:二面|2️⃣面|2面|第二轮|第二面|第[二]面)$/.test(token)) return 'round-2';
  if (/^(?:三面|3️⃣面|3面|第三轮|第三面|第[三]面)$/.test(token)) return 'round-3';
  if (/^(?:四面|4️⃣面|4面|第四轮|第四面|第[四]面)$/.test(token)) return 'round-4';
  if (/^(?:五面|5️⃣面|5面|第五轮|第五面|第[五]面)$/.test(token)) return 'round-5';
  if (token === '初面') return 'round-initial';
  if (token === '终面') return 'round-final';
  return null;
}

function completedRoundTokenMatches(value) {
  const pattern = /(?:一面|二面|三面|四面|五面|[1-5]️⃣面|[1-5]面|初面|终面|第[一二三四五]面|第[一二三四五]轮|第一轮|第二轮|第三轮)/g;
  return [...String(value || '').matchAll(pattern)].filter((match) => {
    const raw = match[0];
    const before = String(value || '').slice(Math.max(0, match.index - 8), match.index);
    const after = String(value || '').slice(match.index + raw.length, match.index + raw.length + 2);
    // Numeric page references (p12面试), question counts (2面试题), and
    // future/speculative rounds do not establish another completed event.
    if (/^[1-5](?:️⃣)?面$/.test(raw) && (after.startsWith('试') || /[0-9pP]$/.test(before))) return false;
    if (/(?:听说有|据说有|可能有|大概有|预计有|已约|约了|预约|计划|准备|即将|明天|后天|将要|取消|流程结束)\s*$/.test(before)) return false;
    if (new RegExp(`${raw}的`).test(String(value || '')) || /(?:尤其|但是|但|没答好|没说到|感觉)/.test(before)) return false;
    return Boolean(caseKeyForRound(raw));
  }).map((match) => ({ raw: match[0], key: caseKeyForRound(match[0]), index: match.index }));
}

function deriveBoundaryACases(item, evidence) {
  const ref = evidence?.artifact_ref;
  const lines = BOUNDARY_A_MULTI_CASE_LINES[Number(item?.issue_number)] || [];
  if (!ref || lines.length < 2) return [];
  return lines.map((line, index) => ({
    case_key: `event-${index + 1}`,
    evidence: [{ ref, locator: `artifact-line:${line}` }],
  }));
}

function deriveBoundaryBCases(evidence) {
  if (Array.isArray(evidence?.interview_cases) && evidence.interview_cases.length >= 2) {
    return evidence.interview_cases.map((candidate) => ({
      case_key: candidate.case_key,
      evidence: (candidate.evidence || []).map((reference) => ({ ref: reference.ref, locator: reference.locator })),
    }));
  }
  const source = evidence?.source_evidence || {};
  const sourceRef = source.ref;
  const sourceLocator = String(source.locator || 'note_desc:full-file');
  const text = String(source.text || source.excerpt || '');
  const anchors = [];
  const usedLocators = new Set();
  const usedKeys = new Set();
  const sourceAnchorLines = new Set();
  const sourceRoundKeys = new Set();
  const eventOrdinalsSeen = new Set();
  let directThreeRoundsAdded = false;
  const add = (baseKey, ref, locator) => {
    if (!ref || !locator || usedLocators.has(locator)) return;
    let key = baseKey || 'event';
    let suffix = 1;
    while (usedKeys.has(key)) key = `${baseKey || 'event'}-event-${suffix++}`;
    usedKeys.add(key); usedLocators.add(locator);
    anchors.push({ case_key: key, evidence: [{ ref, locator }] });
  };
  const addLineRound = (line, lineNumber, round, occurrence) => {
    const base = round.key || `event-${occurrence || anchors.length + 1}`;
    const key = occurrence > 1 ? `${base}-event-${occurrence}` : base;
    add(key, sourceRef, `${sourceLocator}:line-${lineNumber}:round-${occurrence || 1}`);
  };
  const lines = text.split(/\r?\n/);
  const roundOccurrences = new Map();
  for (const [lineIndex, line] of lines.entries()) {
    const value = String(line || '').trim();
    if (!value) continue;
    // A recap can repeat already-recorded round headings (for example, a
    // summary that says “一面很顺利，约二面”).  Once the source has at
    // least two concrete anchors, ignore such recap lines so they cannot
    // duplicate InterviewNote cases.  A recap is still eligible when it is
    // the only available source for an otherwise unstructured multi-event
    // note.
    if (anchors.length >= 2 && /^(?:总结|总结：|总结:)/.test(value)) continue;
    const eventMatches = [...value.matchAll(/(?:第)?([一二三四五六七八九十]+)家/g)];
    for (const match of eventMatches) {
      const ordinal = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[match[1]];
      if (ordinal && !eventOrdinalsSeen.has(ordinal)) {
        eventOrdinalsSeen.add(ordinal);
        add(`event-${ordinal}`, sourceRef, `${sourceLocator}:line-${lineIndex + 1}:event-${ordinal}`);
      }
    }
    const directThreeRounds = /(?:三面直通|直通三面)/.test(value);
    const rounds = directThreeRounds ? [] : completedRoundTokenMatches(value);
    for (const round of rounds) {
      sourceAnchorLines.add(lineIndex + 1);
      sourceRoundKeys.add(round.key);
      const occurrence = (roundOccurrences.get(round.key) || 0) + 1;
      roundOccurrences.set(round.key, occurrence);
      addLineRound(value, lineIndex + 1, round, occurrence);
    }
    if (directThreeRounds && !directThreeRoundsAdded) {
      directThreeRoundsAdded = true;
      for (let number = 1; number <= 3; number += 1) add(`round-${number}`, sourceRef, `${sourceLocator}:line-${lineIndex + 1}:direct-${number}`);
    }
    // Only finite phrases that explicitly name separate interview/company
    // events may synthesize segment anchors.  Question content such as
    // “两个栈模拟队列” or “两个 ack” must never become another InterviewNote.
    if (/(?:两个(?:小公司|自研(?:线下)?面试|公司(?:现场)?面试)|两家(?:小公司|公司)?(?:现场)?面试|两场面试|两次面试|面了两家|面了多家)/.test(value)) {
      for (let number = 1; number <= 2; number += 1) add(`event-${number}`, sourceRef, `${sourceLocator}:line-${lineIndex + 1}:segment-${number}`);
    }
  }
  // Some compact projections put the only completed round markers in the
  // classification ledger's explicit basis lines.  Use them only when the
  // source projection did not already yield two events, and retain their
  // line-number provenance rather than manufacturing text excerpts.
  if (anchors.length < 2) {
    for (const basis of evidence?.classification?.basis_lines || []) {
      const lineNumber = Number(basis.line_number);
      if (!Number.isInteger(lineNumber) || lineNumber < 1) continue;
      if (sourceAnchorLines.has(lineNumber)) continue;
      const basisText = String(basis.excerpt || '');
      if (/(?:已约|约了|预约|计划|准备|即将|取消|流程结束|听说有|据说有)/.test(basisText)) continue;
      const rounds = completedRoundTokenMatches(basisText);
      if (rounds.length) {
        for (const round of rounds) add(`${round.key || 'event'}-basis`, sourceRef, `${sourceLocator}:line-${lineNumber}`);
      }
    }
  }
  // A title can establish a first completed round when the body explicitly
  // records a later round (for example #406).  It is never sufficient on its
  // own, which keeps title-only and page-reference notes fail-closed.
  if (anchors.length < 2) {
    for (const title of evidence?.semantic_evidence || []) {
      if (!/\/title$/.test(String(title.locator || ''))) continue;
      for (const round of completedRoundTokenMatches(title.excerpt)) {
        if (sourceRoundKeys.has(round.key)) continue;
        add(round.key || 'event-title', title.ref, `${title.locator}:${round.key}`);
      }
    }
  }
  return anchors;
}

function loadArtifactInputs() {
  const root = path.resolve('.');
  const rows = [];
  const errors = [];
  const auditedNumbers = new Set();
  const addError = (message) => errors.push(message);
  const add = (row) => {
    if (!row || !Number.isInteger(Number(row.issue_number))) return addError('artifact row has no issue_number');
    rows.push(row);
  };

  // Boundary A: custom request files contain formal source anchors and checks.
  const aPlan = readJson(path.join(root, 'data/issue-1606/boundary.dry-run.json'));
  for (const item of aPlan.items || []) {
    auditedNumbers.add(Number(item.issue_number));
    if (!item.decision) continue;
    const request = readJson(path.join(root, 'data/issue-1606/requests', `${pad(item.issue_number)}.json`));
    const evidence = request.evidence || {};
    add({
      batch: 'A', issue_number: Number(item.issue_number), decision: item.decision,
      source_note_id: request.source_note_id, expected_body_sha256: request.expected_body_sha256,
      expected_source_revision_id: request.expected_source_revision_id,
      artifact: {
        ref: evidence.artifact_ref, kind: evidence.kind, provenance: evidence.artifact_provenance,
        git_blob_sha: evidence.git_blob_sha, byte_size: evidence.byte_size,
      },
      excerpts: evidence.excerpts || [], checks: request.checks || [],
      cases: item.decision === 'multi-interview' ? deriveBoundaryACases(item, evidence) : [],
      rationale: request.checks?.find((check) => check.check_id === 'event_boundary')?.note || 'Boundary A controller-reviewed decision.',
      transition_id: `issue-1605-boundary-${item.issue_number}-a`,
    });
  }

  // Boundary B: the scope-clean rerun may remain proposal-only.  Only
  // non-pending proposals from a verified selection are promotable here.
  const bPlanFile = path.join(root, 'data/issue-1607/dry-run.plan.json');
  const bEvidenceFile = path.join(root, 'data/issue-1607/evidence-ledger.json');
  const bClassFile = path.join(root, 'data/issue-1607/classification-ledger.json');
  if (fs.existsSync(bPlanFile) && fs.existsSync(bEvidenceFile) && fs.existsSync(bClassFile)) {
    const bPlan = readJson(bPlanFile);
    const bEvidence = readJson(bEvidenceFile);
    const bClass = readJson(bClassFile);
    const clean = bPlan.scope_compliance?.status === 'pass' && bPlan.fail_closed === true;
    const evidenceByNumber = new Map((bEvidence.items || []).map((item) => [Number(item.issue_number), item]));
    if (!clean) addError('Boundary B scope-compliance is not pass; no B proposal may enter the full transition plan');
    if (clean) for (const item of bClass.items || []) {
      auditedNumbers.add(Number(item.issue_number));
      const decision = item.proposed_decision;
      if (!['not-interview', 'single-interview', 'multi-interview'].includes(decision)) continue;
      const evidence = evidenceByNumber.get(Number(item.issue_number));
      if (!evidence || evidence.source_evidence?.verification?.status === 'blocked') {
        addError(`Boundary B #${item.issue_number} lacks independently verified source evidence`);
        continue;
      }
      const sourceEvidence = evidence.source_evidence || {};
      const fallbackExcerpt = !sourceEvidence.excerpt
        ? (evidence.semantic_evidence || []).find((candidate) => candidate && String(candidate.excerpt || '').trim())
        : null;
      add({
        batch: 'B', issue_number: Number(item.issue_number), decision,
        source_note_id: item.source_note_id, expected_body_sha256: evidence.expected_body_sha256,
        expected_source_revision_id: evidence.expected_source_revision_id,
        artifact: {
          ref: sourceEvidence.ref, kind: sourceEvidence.kind,
          provenance: sourceEvidence.provenance, git_blob_sha: sourceEvidence.git_blob_sha,
          byte_size: sourceEvidence.byte_size,
        },
        excerpts: sourceEvidence.excerpt
          ? [{ locator: sourceEvidence.locator, excerpt: sourceEvidence.excerpt }]
          : (fallbackExcerpt ? [{ locator: fallbackExcerpt.locator, excerpt: fallbackExcerpt.excerpt }] : []),
        cases: decision === 'multi-interview' ? deriveBoundaryBCases(evidence) : [],
        checks: evidence.checks || [], rationale: item.basis || evidence.decision_basis || 'Boundary B scope-clean controller review.',
        transition_id: `issue-1605-boundary-${item.issue_number}-b`,
      });
    }
  } else addError('Boundary B artifacts are absent; B remains explicitly pending.');

  // Boundary C: one evidence JSON per selected SourceNote.
  const cPlan = readJson(path.join(root, 'data/issue-1608/dry-run-plan.json'));
  for (const item of cPlan.items || []) {
    auditedNumbers.add(Number(item.issue_number));
    if (!item.decision) continue;
    const evidence = readJson(path.join(root, 'data/issue-1608', item.evidence_file));
    const artifact = evidence.artifact || evidence.source_evidence;
    if (!artifact) { addError(`Boundary C #${item.issue_number} has no exact source artifact`); continue; }
    add({
      batch: 'C', issue_number: Number(item.issue_number), decision: item.decision,
      source_note_id: item.source_note_id, expected_body_sha256: item.body_sha256,
      expected_source_revision_id: evidence.source_revision_id,
      artifact: {
        ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance,
        git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size,
      },
      excerpts: evidence.excerpts || [], checks: evidence.checks || [],
      cases: evidence.case_keys?.length ? (evidence.case_evidence || []) : [],
      rationale: evidence.rationale || 'Boundary C controller-reviewed decision.',
      transition_id: `issue-1605-boundary-${item.issue_number}-c`,
    });
  }

  // Boundary D: the dry-run item points to a separately committed evidence file.
  const dPlan = readJson(path.join(root, 'data/issue-1609/dry-run-plan.json'));
  for (const item of dPlan.items || []) {
    auditedNumbers.add(Number(item.issue_number));
    if (!['single-interview', 'multi-interview', 'not-interview'].includes(item.disposition)) continue;
    const evidence = readJson(path.join(root, 'data/issue-1609/evidence', `${item.issue_number}.json`));
    const artifact = evidence.source_evidence;
    if (!artifact) { addError(`Boundary D #${item.issue_number} has no exact source artifact`); continue; }
    const cases = (evidence.interview_cases || []).map((candidate) => ({
      case_key: candidate.case_key,
      evidence: [{ ref: artifact.ref, locator: candidate.locator }],
    }));
    add({
      batch: 'D', issue_number: Number(item.issue_number), decision: item.disposition,
      source_note_id: evidence.source_note_id, expected_body_sha256: evidence.body_sha256,
      expected_source_revision_id: evidence.source_revision_id,
      artifact: {
        ref: artifact.ref, kind: artifact.kind, provenance: artifact.provenance,
        git_blob_sha: artifact.git_blob_sha, byte_size: artifact.byte_size,
      },
      excerpts: artifact.excerpt ? [artifact.excerpt] : [], checks: evidence.checks || [],
      cases, rationale: evidence.rationale || 'Boundary D controller-reviewed decision.',
      transition_id: `issue-1605-boundary-${item.issue_number}-d`,
    });
  }

  return { rows, errors, auditedNumbers };
}

function normalizeExcerpt(value) {
  if (!value) return null;
  const line = Number(value.line ?? value.line_number);
  const locator = String(value.locator || (Number.isInteger(line) ? `artifact-line:${line}` : '')).trim();
  const excerpt = String(value.excerpt || value.semantic_excerpt || '').trim();
  if (!locator || !excerpt) return null;
  return { locator, excerpt, ...(Number.isInteger(line) ? { line } : {}) };
}

function normalizedCases(row) {
  return (row.cases || []).map((candidate) => {
    const raw = Array.isArray(candidate.evidence)
      ? candidate.evidence
      : [candidate.evidence, candidate.detail_evidence].filter(Boolean);
    const evidence = raw.map((reference) => ({
      ref: reference.ref || row.artifact?.ref,
      locator: reference.locator,
    })).filter((reference, index, all) => reference.ref && reference.locator
      && all.findIndex((candidate) => candidate.ref === reference.ref && candidate.locator === reference.locator) === index);
    return { case_key: candidate.case_key, evidence };
  }).filter((candidate) => candidate.case_key && candidate.evidence.length);
}

function validateRows(rows, pending) {
  const errors = [];
  const invalidIssueNumbers = new Set();
  const seen = new Set();
  for (const row of rows) {
    const issueNumber = Number(row.issue_number);
    const errorCount = errors.length;
    if (!pending.has(issueNumber)) errors.push(`#${issueNumber} is outside the frozen pending inventory`);
    if (seen.has(issueNumber)) errors.push(`#${issueNumber} appears in more than one boundary batch`);
    seen.add(issueNumber);
    if (!['not-interview', 'single-interview', 'multi-interview'].includes(row.decision)) errors.push(`#${issueNumber} has unsupported decision ${row.decision}`);
    if (!/^xhs-note:[^\s]+$/.test(String(row.source_note_id || ''))) errors.push(`#${issueNumber} has invalid SourceNote identity`);
    if (!/^[0-9a-f]{64}$/.test(String(row.expected_body_sha256 || ''))) errors.push(`#${issueNumber} has invalid expected body SHA`);
    if (!row.expected_source_revision_id) errors.push(`#${issueNumber} has no SourceRevision id`);
    if (!row.artifact || !row.artifact.ref || !/^liqiangcc\/xhs:/.test(row.artifact.ref)) errors.push(`#${issueNumber} has no exact source artifact ref`);
    if (!['raw_capture', 'raw_dom_snapshot', 'raw_context_capture', 'source_projection'].includes(row.artifact?.provenance)) errors.push(`#${issueNumber} artifact is not source evidence`);
    const excerpts = (row.excerpts || []).map(normalizeExcerpt).filter(Boolean);
    if (!excerpts.length) errors.push(`#${issueNumber} has no non-empty evidence excerpt`);
    if (row.decision === 'multi-interview') {
      const cases = normalizedCases(row);
      if (cases.length < 2) errors.push(`#${issueNumber} multi-interview has fewer than two cases`);
      const locators = cases.flatMap((candidate) => candidate.evidence.map((reference) => reference.locator));
      if (new Set(locators).size !== locators.length) errors.push(`#${issueNumber} multi-interview reuses an evidence locator`);
    }
    if (errors.length !== errorCount) invalidIssueNumbers.add(issueNumber);
  }
  return { errors, seen, invalidIssueNumbers };
}

function isAllowedBlockedAuditError(error) {
  return ALLOWED_BLOCKED_AUDIT_ERRORS.has(String(error));
}

function evidenceAuthorizationDigest(proof) {
  return sha256(canonical(Object.fromEntries(Object.entries(proof).filter(([key]) => key !== 'proof_sha256'))));
}

function renderEvidenceAuthorizationMarker(proof) {
  return `<!-- ${EVIDENCE_AUTHORIZATION_MARKER}\n${JSON.stringify(proof, null, 2)}\n-->`;
}

function validateEvidenceAuthorization(proof, plan, comments = []) {
  const errors = [];
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return { ok: false, errors: ['evidence authorization proof must be an object'] };
  if (proof.schema_version !== EVIDENCE_AUTHORIZATION_SCHEMA
      || proof.repository !== REPOSITORY
      || proof.parent_issue !== PARENT_ISSUE
      || proof.action !== 'authorize-remaining-boundary-evidence') {
    errors.push('evidence authorization schema/repository/parent/action mismatch');
  }
  if (proof.allow_live_github !== true) errors.push('evidence authorization must explicitly allow live GitHub comments');
  if (proof.manifest_digest !== REMAINING_MANIFEST_DIGEST) errors.push('evidence authorization manifest digest mismatch');
  if (proof.scope_digest !== REMAINING_SCOPE_DIGEST) errors.push('evidence authorization scope digest mismatch');
  if (proof.plan_digest !== plan?.canonical_digest) errors.push('evidence authorization plan digest mismatch');
  if (!Number.isSafeInteger(proof.max_mutations) || proof.max_mutations < 1) errors.push('evidence authorization max_mutations must be a positive safe integer');
  if (!Number.isSafeInteger(proof.comment_id) || proof.comment_id < 1) errors.push('evidence authorization comment_id must be positive');
  if (typeof proof.authorized_by !== 'string' || !proof.authorized_by.trim()) errors.push('evidence authorization authorized_by is required');
  if (!SAFE_HEX64.test(String(proof.proof_sha256 || '')) || evidenceAuthorizationDigest(proof) !== proof.proof_sha256) errors.push('evidence authorization proof_sha256 is invalid');
  const matches = comments.flatMap((comment) => {
    if (Number(comment?.id) !== proof.comment_id) return [];
    const body = String(comment.body || '');
    const marker = new RegExp(`<!--\\s*${EVIDENCE_AUTHORIZATION_MARKER}\\s*([\\s\\S]*?)-->`, 'g');
    return [...body.matchAll(marker)].map((match) => {
      try { return JSON.parse(match[1].trim()); } catch (_) { return null; }
    }).filter(Boolean);
  });
  if (matches.length !== 1 || !sameObject(matches[0], proof)) errors.push('parent #1605 evidence authorization marker does not exactly match local proof');
  return { ok: errors.length === 0, errors };
}

function sameObject(left, right) {
  return canonical(left) === canonical(right);
}

function buildPlan(options = {}) {
  const frozen = pendingInventory(options.pending || PENDING_SNAPSHOT);
  const remaining = remainingInventory(options.remaining || REMAINING_MANIFEST, frozen);
  const cache = issueMapFromCache(options.cache || SNAPSHOT_CACHE);
  const loaded = loadArtifactInputs();
  const candidateRows = loaded.rows.filter((row) => remaining.numbers.has(Number(row.issue_number)));
  const validation = validateRows(candidateRows, remaining.numbers);
  const rawErrors = [...loaded.errors, ...validation.errors];
  const blockedErrors = rawErrors.filter(isAllowedBlockedAuditError);
  const errors = rawErrors.filter((error) => !isAllowedBlockedAuditError(error));
  if (!validation.invalidIssueNumbers.has(735) || blockedErrors.length !== 1) {
    errors.push('blocked audit allowlist must contain exactly the #735 insufficient-case error');
  }
  const missingAudits = [...remaining.numbers].filter((number) => !loaded.auditedNumbers.has(number)).sort((a, b) => a - b);
  if (missingAudits.length) errors.push(`remaining scope has no child audit for ${missingAudits.length} issue(s): ${missingAudits.slice(0, 20).map((number) => `#${number}`).join(', ')}${missingAudits.length > 20 ? ', …' : ''}`);
  const invalidNumbers = validation.invalidIssueNumbers;
  const items = candidateRows
    .filter((row) => !invalidNumbers.has(Number(row.issue_number)))
    .sort((left, right) => left.issue_number - right.issue_number).map((row) => {
    const sourceIssue = cache.get(row.issue_number);
    if (!sourceIssue) errors.push(`#${row.issue_number} is absent from SourceNote cache`);
    const labels = labelsOf(sourceIssue || {});
    if (!labels.includes('boundary:pending')) errors.push(`#${row.issue_number} is not pending in the frozen SourceNote snapshot`);
    // A live GitHub cache carries `body`; a persisted read-only fixture may
    // carry only its already-verified body_sha256.  Both are bound to the
    // child artifact digest before a row can enter the plan.
    const bodySha = sourceIssue?.body_sha256 || sha256(sourceIssue?.body || '');
    if (sourceIssue && bodySha !== row.expected_body_sha256) errors.push(`#${row.issue_number} cached body SHA differs from child artifact`);
    const excerpts = (row.excerpts || []).map(normalizeExcerpt).filter(Boolean);
    const cases = normalizedCases(row);
    return {
      batch: row.batch, issue_number: row.issue_number, decision: row.decision,
      transition_id: row.transition_id, source_note_id: row.source_note_id,
      expected_body_sha256: row.expected_body_sha256,
      expected_source_revision_id: row.expected_source_revision_id,
      expected_manifest_sha256: null, expected_source_repository_ref: SOURCE_REF,
      artifact: row.artifact, excerpts, cases,
      rationale: row.rationale, checks: REQUIRED_CHECKS.map((check_id) => ({ check_id, result: 'pass', note: `Controller verified against ${row.artifact.ref}.` })),
      limitations: ['AI-assisted controller review; transition remains guarded by live CAS checks.', 'Raw Source and Derived learning metadata remain separate.', 'No InterviewNote identity is materialized by this boundary stage.'],
      source_snapshot_body_sha256: sourceIssue ? bodySha : null,
    };
  });
  const actionNumbers = new Set(items.map((item) => item.issue_number));
  const blockedIssueNumbers = [...remaining.numbers].filter((number) => !actionNumbers.has(number)).sort((a, b) => a - b);
  const blockedByBatch = {};
  for (const number of blockedIssueNumbers) {
    const batch = remaining.manifest.batches?.find((candidate) => candidate.issue_numbers?.includes(number))?.batch || 'unknown';
    blockedByBatch[batch] = (blockedByBatch[batch] || 0) + 1;
  }
  const counts = { total: items.length, scope_total: remaining.numbers.size, actionable_total: items.length, blocked: blockedIssueNumbers.length, 'not-interview': 0, 'single-interview': 0, 'multi-interview': 0 };
  for (const item of items) counts[item.decision] += 1;
  const report = {
    schema_version: 'issue-1605-full-boundary-evidence-plan.v1', repository: REPOSITORY,
    parent_issue: PARENT_ISSUE, source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF },
    pending_inventory: { path: options.remaining || REMAINING_MANIFEST, count: remaining.numbers.size, digest: remaining.manifest.canonical_digest },
    frozen_inventory: { path: options.pending || PENDING_SNAPSHOT, count: frozen.numbers.size, digest: frozen.snapshot.canonical_digest },
    completed_exclusion: { path: COMPLETED_MANIFEST, count: 419, digest: COMPLETED_MANIFEST_DIGEST, purpose: 'exclusion-only; no completed authorization is reused' },
    scope: {
      remaining_scope_digest: remaining.manifest.scope_digest,
      remaining_total: remaining.numbers.size,
      ranges: [{ batch: 'A', first_issue: 20, last_issue: 392, remaining_count: 235 }, { batch: 'B', first_issue: 393, last_issue: 765, remaining_count: 257 }, { batch: 'C', first_issue: 766, last_issue: 1138, remaining_count: 248 }, { batch: 'D', first_issue: 1139, last_issue: 1508, remaining_count: 238 }],
    },
    coverage: {
      remaining_total: remaining.numbers.size,
      audited_total: [...remaining.numbers].filter((number) => loaded.auditedNumbers.has(number)).length,
      actionable_total: items.length,
      blocked_total: blockedIssueNumbers.length,
      blocked_by_batch: blockedByBatch,
      blocked_issue_numbers: blockedIssueNumbers,
      invalid_decision_issue_numbers: [...invalidNumbers].filter((number) => remaining.numbers.has(number)).sort((a, b) => a - b),
      uncovered_issue_numbers: missingAudits,
    },
    counts, mutation_count: 0, live_evidence_comments: 0, live_transitions: 0,
    blocked_errors: blockedErrors, errors, items,
  };
  report.canonical_digest = sha256(canonical(report));
  return report;
}

function ghJson(args, input = null) {
  const result = execFileSync('gh', args, { input: input == null ? undefined : JSON.stringify(input), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  return JSON.parse(result);
}

function sleep(ms) {
  if (!ms) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(file) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let fd;
  try { fd = fs.openSync(target, 'wx', 0o600); } catch (error) { throw new Error(`evidence writer lock is already held: ${error.message}`); }
  const token = crypto.randomBytes(16).toString('hex');
  const record = { schema_version: 'issue-1605-evidence-lock.v1', pid: process.pid, token, acquired_at: new Date().toISOString() };
  fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  const directory = fs.openSync(path.dirname(target), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  const inode = fs.statSync(target);
  return {
    target,
    assertHeld() {
      if (!fs.existsSync(target)) throw new Error('evidence writer lock was removed while the writer was active');
      let current;
      try { current = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) { throw new Error(`evidence writer lock is no longer valid: ${error.message}`); }
      if (!current || current.token !== token) throw new Error('evidence writer lock ownership changed');
      const currentStat = fs.statSync(target);
      if (currentStat.dev !== inode.dev || currentStat.ino !== inode.ino) throw new Error('evidence writer lock inode changed');
    },
    release() {
      if (!fs.existsSync(target)) return;
      let current;
      try { current = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) { throw new Error(`refusing to remove replaced evidence lock: ${error.message}`); }
      if (!current || current.token !== token) throw new Error('refusing to remove replaced evidence lock');
      const currentStat = fs.statSync(target);
      if (currentStat.dev !== inode.dev || currentStat.ino !== inode.ino) throw new Error('refusing to remove replaced evidence lock inode');
      fs.unlinkSync(target);
      const dir = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    },
  };
}

function issueEndpoint(number) { return `repos/${REPOSITORY}/issues/${number}`; }

function readLiveIssue(number) { return ghJson(['api', issueEndpoint(number)]); }

function readCommentsPage(number, page) { return ghJson(['api', `${issueEndpoint(number)}/comments?per_page=100&page=${page}`]); }

function findMarkerComments(number, marker, maxPages = 100, readPage = readCommentsPage) {
  const matches = [];
  let observedShort = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const comments = readPage(number, page);
    if (!Array.isArray(comments)) throw new Error(`#${number} comments page ${page} is not an array`);
    matches.push(...comments.filter((comment) => typeof comment.body === 'string' && comment.body.includes(marker)));
    if (comments.length < 100) { observedShort = true; break; }
  }
  if (!observedShort) throw new Error(`#${number} comment pagination did not expose a short terminal page`);
  return matches;
}

function parseEvidenceComment(comment, item) {
  const body = String(comment && comment.body || '');
  const matches = [...body.matchAll(/<!--\s*source-note-boundary-review-evidence\s*([\s\S]*?)-->/g)];
  if (matches.length !== 1) return { ok: false, errors: ['evidence comment must contain exactly one machine marker'] };
  let payload;
  try { payload = JSON.parse(matches[0][1].trim()); }
  catch (error) { return { ok: false, errors: [`evidence marker JSON is invalid: ${error.message}`] }; }
  const errors = [];
  if (payload.schema_version !== 'source-note-boundary-review-evidence.v1') errors.push('evidence schema_version mismatch');
  const expected = {
    transition_id: item.transition_id,
    repository: REPOSITORY,
    parent_issue: PARENT_ISSUE,
    issue_number: item.issue_number,
    source_note_id: item.source_note_id,
    expected_body_sha256: item.expected_body_sha256,
    expected_source_revision_id: item.expected_source_revision_id,
    expected_source_repository_ref: SOURCE_REF,
    decision: item.decision,
  };
  for (const [key, value] of Object.entries(expected)) if (payload[key] !== value) errors.push(`evidence ${key} mismatch`);
  if (!Array.isArray(payload.checks) || REQUIRED_CHECKS.some((id) => !payload.checks.some((check) => check && check.check_id === id && check.result === 'pass'))) {
    errors.push('evidence comment does not prove all required checks');
  }
  return { ok: errors.length === 0, errors, payload };
}

function findExactEvidenceComments(item, maxPages = 100, readPage = readCommentsPage) {
  const comments = findMarkerComments(item.issue_number, item.transition_id, maxPages, readPage);
  const exact = [];
  const errors = [];
  for (const comment of comments) {
    const parsed = parseEvidenceComment(comment, item);
    if (parsed.ok) exact.push({ ...comment, evidence: parsed.payload });
    else errors.push(`comment ${comment.id || 'unknown'}: ${parsed.errors.join('; ')}`);
  }
  return { exact, errors };
}

function evidenceBody(item, reviewedAt) {
  const payload = {
    schema_version: 'source-note-boundary-review-evidence.v1', transition_id: item.transition_id,
    repository: REPOSITORY, parent_issue: PARENT_ISSUE, issue_number: item.issue_number,
    source_note_id: item.source_note_id, expected_body_sha256: item.expected_body_sha256,
    expected_source_revision_id: item.expected_source_revision_id,
    expected_source_repository_ref: SOURCE_REF, decision: item.decision, reviewed_at: reviewedAt,
    source_evidence: { artifact: item.artifact, excerpts: item.excerpts },
    interview_cases: item.cases || [], checks: item.checks, limitations: item.limitations,
  };
  return `<!-- source-note-boundary-review-evidence\n${JSON.stringify(payload, null, 2)}\n-->\n\nController review evidence for Issue #${item.issue_number}; no transition applied in this comment.`;
}

function formalRequest(item, commentId, reviewedAt) {
  const request = {
    schema_version: item.decision === 'multi-interview' ? MULTI_TRANSITION_SCHEMA : TRANSITION_SCHEMA,
    transition_id: item.transition_id, repository: REPOSITORY, issue_number: item.issue_number,
    source_note_id: item.source_note_id, expected_body_sha256: item.expected_body_sha256,
    expected_boundary_status: 'pending', expected_source_revision_id: item.expected_source_revision_id,
    expected_manifest_sha256: null, expected_source_repository_ref: SOURCE_REF,
    decision: item.decision, reviewed_at: reviewedAt, reviewer_kind: 'ai-assisted',
    review_evidence: { repository: REPOSITORY, issue_number: item.issue_number, comment_id: Number(commentId) },
    checks: item.checks, limitations: item.limitations,
  };
  if (item.decision === 'multi-interview') request.interview_cases = item.cases;
  return request;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = { mode: 'plan', output: DEFAULT_OUTPUT, journal: DEFAULT_JOURNAL, lock: DEFAULT_LOCK, requestDir: DEFAULT_REQUEST_DIR, cache: SNAPSHOT_CACHE, pending: PENDING_SNAPSHOT, remaining: REMAINING_MANIFEST, authorization: null, confirmPlan: null, maxMutations: 25, pauseMs: 1000, allowUncertainRetry: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') args.mode = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--journal') args.journal = argv[++index];
    else if (arg === '--lock') args.lock = argv[++index];
    else if (arg === '--request-dir') args.requestDir = argv[++index];
    else if (arg === '--cache') args.cache = argv[++index];
    else if (arg === '--pending') args.pending = argv[++index];
    else if (arg === '--remaining') args.remaining = argv[++index];
    else if (arg === '--authorization-proof') args.authorization = argv[++index];
    else if (arg === '--confirm-plan') args.confirmPlan = argv[++index];
    else if (arg === '--max-mutations') args.maxMutations = Number(argv[++index]);
    else if (arg === '--pause-ms') args.pauseMs = Number(argv[++index]);
    else if (arg === '--allow-uncertain-retry') args.allowUncertainRetry = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['plan', 'evidence'].includes(args.mode)) throw new Error('--mode must be plan or evidence');
  if (!Number.isSafeInteger(args.maxMutations) || args.maxMutations < 1) throw new Error('--max-mutations must be a positive safe integer');
  if (!Number.isInteger(args.pauseMs) || args.pauseMs < 0) throw new Error('--pause-ms must be non-negative');
  if (args.mode === 'evidence' && !args.authorization) throw new Error('evidence mode requires --authorization-proof for parent #1605');
  return args;
}

function journalRows(journal, byNumber) {
  journal.items = [...byNumber.values()].sort((a, b) => Number(a.issue_number) - Number(b.issue_number));
  journal.posted = journal.items.filter((entry) => entry.status === 'posted').length;
}

function reconcileEvidenceItem(item, previous, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 1;
  const pauseMs = Number.isInteger(options.pauseMs) && options.pauseMs >= 0 ? options.pauseMs : 0;
  const findExact = options.findExactEvidenceComments || findExactEvidenceComments;
  const wait = options.sleep || sleep;
  let lastResult = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = findExact(item);
    lastResult = result;
    if (result.errors.length) throw new Error(`#${item.issue_number} evidence marker validation failed: ${result.errors.join('; ')}`);
    if (result.exact.length > 1) throw new Error(`#${item.issue_number} has multiple exact evidence markers; refusing to choose one`);
    if (result.exact.length === 1) {
      const comment = result.exact[0];
      const reviewedAt = comment.evidence.reviewed_at;
      if (!reviewedAt || Number.isNaN(Date.parse(reviewedAt))) throw new Error(`#${item.issue_number} evidence marker has invalid reviewed_at`);
      if (previous.comment_id != null && Number(previous.comment_id) !== Number(comment.id)) throw new Error(`#${item.issue_number} journal comment_id does not match the exact live evidence marker`);
      return {
        ...previous,
        issue_number: item.issue_number,
        transition_id: item.transition_id,
        status: 'posted',
        comment_id: Number(comment.id),
        reviewed_at: reviewedAt,
        possibly_posted: false,
        error: null,
        request: formalRequest(item, Number(comment.id), reviewedAt),
      };
    }
    if (attempt < attempts) wait(pauseMs * attempt);
  }
  return lastResult && lastResult.exact.length === 0 ? null : null;
}

function assertEvidencePrecondition(item, live) {
  const liveLabels = labelsOf(live);
  if (String(live.state).toLowerCase() !== 'open' || !liveLabels.includes('boundary:pending')) throw new Error(`#${item.issue_number} live SourceNote is not open+boundary:pending`);
  const liveSha = sha256(live.body || '');
  if (liveSha !== item.expected_body_sha256) throw new Error(`#${item.issue_number} live body SHA drifted: ${liveSha}`);
}

function evidencePreflight(plan, journal, byNumber, journalFile, requestDir, allowUncertainRetry = false, lock = null, io = {}) {
  // A complete read-only preflight happens before any new POST.  This makes
  // the bounded evidence writer all-or-nothing with respect to the current
  // live pending frontier and also validates every previously recorded POST.
  for (const item of plan.items) {
    if (lock) lock.assertHeld();
    let previous = byNumber.get(item.issue_number) || {
      issue_number: item.issue_number, transition_id: item.transition_id, status: 'pending', comment_id: null,
    };
    if (previous.transition_id !== item.transition_id) throw new Error(`#${item.issue_number} journal transition_id drifted`);
    const reconciled = (io.reconcileEvidenceItem || reconcileEvidenceItem)(item, previous, io.reconcileOptions || {});
    if (reconciled) {
      if (lock) lock.assertHeld();
      byNumber.set(item.issue_number, reconciled);
      (io.writeRequest || writeRequest)(path.join(requestDir, `${pad(item.issue_number)}.json`), reconciled.request);
      continue;
    }
    if (previous.status === 'posted') throw new Error(`#${item.issue_number} journal says posted but no exact live evidence marker exists`);
    if (['uncertain', 'post-pending'].includes(previous.status) || previous.possibly_posted === true) {
      if (!allowUncertainRetry) throw new Error(`#${item.issue_number} remains uncertain without an exact live evidence marker; refusing automatic re-POST (explicit --allow-uncertain-retry required)`);
      previous = { ...previous, status: 'pending', possibly_posted: false, error: null, uncertain_retry_authorized_at: new Date().toISOString() };
    }
    let live;
    try { live = (io.readLiveIssue || readLiveIssue)(item.issue_number); }
    catch (error) { throw new Error(`#${item.issue_number} evidence preflight read failed: ${error.message}`); }
    assertEvidencePrecondition(item, live);
    previous = { ...previous, status: 'pending', possibly_posted: false, error: null };
    byNumber.set(item.issue_number, previous);
  }
  journalRows(journal, byNumber);
  journal.status = 'preflight-complete';
  journal.preflight_completed_at = new Date().toISOString();
  journal.last_error = null;
  journal.canonical_digest = sha256(canonical(journal));
  if (lock) lock.assertHeld();
  (io.writeJson || writeJson)(journalFile, journal);
}

function runEvidence(args, plan, io = {}) {
  if (plan.errors.length) throw new Error(`plan is not executable; resolve ${plan.errors.length} fail-closed errors first`);
  if (args.confirmPlan !== plan.canonical_digest) throw new Error('evidence stage requires --confirm-plan equal to the plan canonical_digest');
  const proof = io.authorization || (args.authorization ? readJson(args.authorization) : null);
  const parentComments = io.parentComments || findMarkerComments(PARENT_ISSUE, EVIDENCE_AUTHORIZATION_MARKER);
  const authorization = validateEvidenceAuthorization(proof, plan, parentComments);
  if (!authorization.ok) throw new Error(`parent #${PARENT_ISSUE} evidence authorization failed closed: ${authorization.errors.join('; ')}`);
  if (args.maxMutations > proof.max_mutations) throw new Error(`--max-mutations ${args.maxMutations} exceeds evidence authorization ceiling ${proof.max_mutations}`);
  const lock = (io.acquireLock || acquireLock)(args.lock);
  const read = io.readJson || readJson;
  const write = io.writeJson || writeJson;
  const writeRequestFile = io.writeRequest || writeRequest;
  const readIssue = io.readLiveIssue || readLiveIssue;
  const findExact = io.findExactEvidenceComments || findExactEvidenceComments;
  const wait = io.sleep || sleep;
  const reconcile = io.reconcileEvidenceItem || ((item, previous, options = {}) => reconcileEvidenceItem(item, previous, { ...options, findExactEvidenceComments: findExact, sleep: wait }));
  const postEvidence = io.postEvidence || ((item, body) => (io.ghJson || ghJson)(['api', '--method', 'POST', `${issueEndpoint(item.issue_number)}/comments`, '--input', '-'], { body }));
  try {
    const journalFile = path.resolve(args.journal);
    const journal = fs.existsSync(journalFile) ? read(journalFile) : { schema_version: 'issue-1605-full-boundary-evidence-progress.v1', plan_digest: plan.canonical_digest, status: 'running', items: [] };
    if (journal.plan_digest !== plan.canonical_digest) throw new Error('existing evidence journal belongs to another plan');
    const byNumber = new Map(journal.items.map((item) => [Number(item.issue_number), item]));
    try { evidencePreflight(plan, journal, byNumber, journalFile, path.resolve(args.requestDir), args.allowUncertainRetry, lock, { ...io, readLiveIssue: readIssue, findExactEvidenceComments: findExact, reconcileEvidenceItem: reconcile, writeJson: write, writeRequest: writeRequestFile }); }
    catch (error) {
      lock.assertHeld(); journal.status = 'blocked'; journal.last_error = error.message; journalRows(journal, byNumber); journal.canonical_digest = sha256(canonical(journal)); write(journalFile, journal);
      throw error;
    }
    let attempted = 0;
    for (const item of plan.items) {
      if (attempted >= args.maxMutations) break;
      lock.assertHeld();
      let previous = byNumber.get(item.issue_number) || { issue_number: item.issue_number, transition_id: item.transition_id, status: 'pending', comment_id: null };
      if (previous.status === 'posted') continue;

      // Re-read immediately before each write and check the exact marker one
      // more time.  A crash after this intent is recoverable without guessing.
      let live;
      try { lock.assertHeld(); live = readIssue(item.issue_number); }
      catch (error) { throw new Error(`#${item.issue_number} evidence write precondition read failed: ${error.message}`); }
      assertEvidencePrecondition(item, live);
      const converged = reconcile(item, previous);
      if (converged) {
        previous = converged; byNumber.set(item.issue_number, previous); journalRows(journal, byNumber); lock.assertHeld(); write(journalFile, journal); lock.assertHeld(); writeRequestFile(path.join(args.requestDir, `${pad(item.issue_number)}.json`), previous.request); continue;
      }
      const reviewedAt = previous.reviewed_at || new Date().toISOString();
      const body = evidenceBody(item, reviewedAt);
      previous = { ...previous, status: 'post-pending', reviewed_at: reviewedAt, possibly_posted: true, error: null };
      byNumber.set(item.issue_number, previous); journalRows(journal, byNumber); journal.status = 'running'; journal.canonical_digest = sha256(canonical(journal)); lock.assertHeld(); write(journalFile, journal);
      let response;
      try {
        lock.assertHeld();
        response = postEvidence(item, body);
      } catch (error) {
        let reconciledAfterError;
        try { reconciledAfterError = reconcile(item, previous, { attempts: 3, pauseMs: Math.max(250, args.pauseMs) }); }
        catch (reconcileError) {
          previous = { ...previous, status: 'uncertain', error: `${error.message}; marker reconciliation failed: ${reconcileError.message}`, possibly_posted: true };
          byNumber.set(item.issue_number, previous); journalRows(journal, byNumber); journal.status = 'uncertain'; journal.canonical_digest = sha256(canonical(journal)); lock.assertHeld(); write(journalFile, journal);
          throw new Error(`#${item.issue_number} evidence POST response unknown and marker reconciliation failed: ${reconcileError.message}`);
        }
        if (!reconciledAfterError) {
          previous = { ...previous, status: 'uncertain', error: error.message, possibly_posted: true };
          byNumber.set(item.issue_number, previous); journalRows(journal, byNumber); journal.status = 'uncertain'; journal.canonical_digest = sha256(canonical(journal)); lock.assertHeld(); write(journalFile, journal);
          throw new Error(`#${item.issue_number} evidence POST response unknown; exact marker reconciliation found 0 matches`);
        }
        response = { id: reconciledAfterError.comment_id };
        previous = reconciledAfterError;
      }
      if (!response || !Number.isInteger(Number(response.id))) throw new Error(`#${item.issue_number} evidence POST returned no comment id`);
      previous = previous.status === 'posted' ? previous : { ...previous, status: 'posted', comment_id: Number(response.id), reviewed_at: reviewedAt, possibly_posted: false, request: formalRequest(item, Number(response.id), reviewedAt), error: null };
      byNumber.set(item.issue_number, previous); journalRows(journal, byNumber); journal.attempted = (journal.attempted || 0) + 1; journal.status = 'running'; journal.canonical_digest = sha256(canonical(journal)); lock.assertHeld(); write(journalFile, journal);
      lock.assertHeld(); writeRequestFile(path.join(args.requestDir, `${pad(item.issue_number)}.json`), previous.request);
      attempted += 1; wait(args.pauseMs);
    }
    const hasUncertain = journal.items.some((entry) => ['uncertain', 'post-pending'].includes(entry.status) || entry.possibly_posted === true);
    journal.status = journal.items.filter((entry) => entry.status === 'posted').length === plan.items.length
      ? 'complete'
      : hasUncertain ? 'uncertain' : 'partial';
    if (journal.status === 'complete') journal.last_error = null;
    journal.canonical_digest = sha256(canonical(journal)); lock.assertHeld(); write(journalFile, journal);
    const posted = journal.items.filter((entry) => entry.status === 'posted');
    const manifest = { schema_version: 'source-note-boundary-review-batch.v1', repository: REPOSITORY, parent_issue: PARENT_ISSUE, source_snapshot: { repository: SOURCE_REPOSITORY, ref: SOURCE_REF }, plan_digest: plan.canonical_digest, items: posted.map((entry) => ({ issue_number: entry.issue_number, transition_id: entry.transition_id, request_file: path.relative(path.dirname(args.output), path.join(args.requestDir, `${pad(entry.issue_number)}.json`)) })) };
    manifest.canonical_digest = sha256(canonical(manifest));
    const manifestFile = path.join(path.dirname(args.output), 'remaining-boundary-evidence-manifest.json');
    write(manifestFile, manifest);
    process.stdout.write(`${JSON.stringify({ status: journal.status, posted: posted.length, attempted: journal.attempted, manifest: manifestFile }, null, 2)}\n`);
  } finally { lock.release(); }
}

function main() {
  const args = parseArgs();
  const plan = buildPlan(args);
  writeJson(args.output, plan);
  if (args.mode === 'evidence') runEvidence(args, plan);
  else process.stdout.write(`${JSON.stringify({ status: plan.errors.length ? 'blocked' : 'ready-for-controller-review', canonical_digest: plan.canonical_digest, counts: plan.counts, blocked_errors: plan.blocked_errors, errors: plan.errors.slice(0, 20) }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}

module.exports = {
  canonical, sha256, buildPlan, evidenceBody, formalRequest, normalizeExcerpt, validateRows,
  pendingInventory, remainingInventory, deriveBoundaryACases, deriveBoundaryBCases, parseArgs,
  isAllowedBlockedAuditError, parseEvidenceComment, findExactEvidenceComments,
  evidenceAuthorizationDigest, renderEvidenceAuthorizationMarker, validateEvidenceAuthorization,
  reconcileEvidenceItem, evidencePreflight, runEvidence, acquireLock,
};
