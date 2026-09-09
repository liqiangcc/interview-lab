'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA = 'issue-1656-boundary-transition-plan.v1';
const SOURCE_SCHEMA = 'issue-1656-evidence-post-plan.v1';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digestPlan(plan) {
  const copy = JSON.parse(JSON.stringify(plan));
  delete copy.canonical_digest;
  return sha256(JSON.stringify(stable(copy)));
}

function arrayEqual(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function sortedLabels(labels) {
  return Array.isArray(labels) ? [...labels].sort() : labels;
}

function exactLabels(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && arrayEqual(sortedLabels(left), sortedLabels(right));
}

function bodySha(issue) {
  if (!issue || typeof issue.body !== 'string') return null;
  return sha256(issue.body);
}

function sourceOf(row) {
  const transition = row.transition_request || {};
  const cas = row.cas || transition.live_binding || {};
  return {
    source_note_id: cas.source_note_id || transition.source_note_id,
    source_revision_id: cas.expected_source_revision_id || transition.expected_source_revision_id,
    source_repository_ref: cas.expected_source_repository_ref || transition.expected_source_repository_ref,
    source_projection_ref: cas.source_projection_ref || transition.source_projection?.ref,
    source_projection_blob_sha: cas.source_projection_blob_sha || transition.source_projection?.blob_sha,
    source_projection_content_sha256: cas.source_projection_content_sha256 || transition.source_projection?.content_sha256,
  };
}

function normalizeRow(row) {
  if (!row || !Number.isInteger(row.issue_number)) throw new Error('boundary row issue_number required');
  const transition = row.transition_request || {};
  const cas = row.cas || transition.live_binding || {};
  const patch = row.patch || row.boundary_patch || {};
  return {
    ...row,
    issue_number: row.issue_number,
    cas: {
      issue_number: row.issue_number,
      expected_body_sha256: cas.expected_body_sha256 || transition.expected_body_sha256,
      expected_boundary_status: cas.expected_boundary_status || transition.expected_boundary_status,
      expected_source_revision_id: cas.expected_source_revision_id || transition.expected_source_revision_id,
      expected_source_repository_ref: cas.expected_source_repository_ref || transition.expected_source_repository_ref,
      source_note_id: cas.source_note_id || transition.source_note_id,
      source_projection_ref: cas.source_projection_ref || transition.source_projection?.ref,
      source_projection_blob_sha: cas.source_projection_blob_sha || transition.source_projection?.blob_sha,
      source_projection_content_sha256: cas.source_projection_content_sha256 || transition.source_projection?.content_sha256,
      expected_title: cas.expected_title ?? row.expected_title,
      expected_labels: cas.expected_labels ?? row.expected_labels,
    },
    patch: {
      ...patch,
      ...(patch.labels ? { labels: [...patch.labels] } : {}),
    },
    source: sourceOf(row),
  };
}

function normalizeBlocked(row) {
  if (!row || !Number.isInteger(row.issue_number)) throw new Error('blocked row issue_number required');
  return { ...row, issue_number: row.issue_number, status: row.status || 'blocked' };
}

function extractRows(plan) {
  const rows = plan.rows || plan.proposal_rows || [];
  const blocked = plan.blocked || plan.blocked_ledger || [];
  if (!Array.isArray(rows) || !Array.isArray(blocked)) throw new Error('rows and blocked must be arrays');
  if (plan.schema_version !== SCHEMA && plan.schema_version !== SOURCE_SCHEMA) {
    throw new Error(`unsupported boundary plan schema: ${plan.schema_version}`);
  }
  const normalizedRows = rows.length ? rows.map(normalizeRow) : (plan.proposal_issue_numbers || []).map((issue_number) => normalizeRow({ issue_number }));
  const normalizedBlocked = blocked.length ? blocked.map(normalizeBlocked) : (plan.blocked_issue_numbers || []).map((issue_number) => normalizeBlocked({ issue_number }));
  return { rows: normalizedRows, blocked: normalizedBlocked };
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('boundary plan must be an object');
  const { rows, blocked } = extractRows(plan);
  const ids = [...rows, ...blocked].map((row) => row.issue_number);
  if (new Set(ids).size !== ids.length) throw new Error('boundary plan has duplicate issue_number');
  for (const row of blocked) {
    if (row.status !== 'blocked') throw new Error(`blocked row ${row.issue_number} has non-blocked status`);
    if (row.mutation_count !== undefined && row.mutation_count !== 0) throw new Error(`blocked row ${row.issue_number} has mutation_count`);
  }
  if (plan.mutation_guard && (plan.mutation_guard.patch !== 0 || plan.mutation_guard.post !== 0
    || plan.mutation_guard.label !== 0 || plan.mutation_guard.mutation !== 0)) {
    throw new Error('boundary plan mutation guard is not zero');
  }
  if (plan.scope) {
    if (plan.scope.proposal_count !== undefined && plan.scope.proposal_count !== rows.length) throw new Error('proposal scope mismatch');
    if (plan.scope.blocked_count !== undefined && plan.scope.blocked_count !== blocked.length) throw new Error('blocked scope mismatch');
  }
  return { rows, blocked, digest: plan.canonical_digest || digestPlan(plan) };
}

function buildPlanOnly(plan) {
  const { rows, blocked, digest } = validatePlan(plan);
  return {
    schema_version: 'issue-1656-boundary-only-writer-plan-only.v1',
    repository: plan.repository || 'liqiangcc/interview-lab',
    issue: plan.issue || 1656,
    plan_digest: digest,
    plan_only: true,
    mutation: 0,
    proposal_count: rows.length,
    blocked_count: blocked.length,
    total_count: rows.length + blocked.length,
    blocked_issue_numbers: blocked.map((row) => row.issue_number),
    blocked_reads: 0,
    read_operations: 0,
    patch_operations: 0,
    receipt_operations: 0,
    note: 'Boundary-only local writer. Blocked rows are never read; apply requires a fake adapter and explicit authorization.',
  };
}

function lockMetadata(token, stat) {
  return {
    token,
    pid: process.pid,
    hostname: os.hostname(),
    dev: stat.dev,
    ino: stat.ino,
  };
}

function acquireExclusiveLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = crypto.randomUUID();
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, hostname: os.hostname() }));
  fs.closeSync(fd);
  const initial = fs.lstatSync(lockPath);
  if (initial.isSymbolicLink()) throw new Error('lock is symbolic link');
  const metadata = lockMetadata(token, initial);
  fs.writeFileSync(lockPath, JSON.stringify(metadata));
  const assertHeld = () => {
    let current;
    try { current = fs.lstatSync(lockPath); } catch { throw new Error('exclusive lock missing'); }
    if (current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino) {
      throw new Error('exclusive lock ownership drift');
    }
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { throw new Error('exclusive lock unreadable'); }
    if (parsed.token !== token || parsed.dev !== metadata.dev || parsed.ino !== metadata.ino) {
      throw new Error('exclusive lock token drift');
    }
  };
  assertHeld();
  return {
    token,
    assertHeld,
    release() {
      try {
        assertHeld();
        fs.unlinkSync(lockPath);
      } catch (error) {
        if (!/missing|drift|symbolic|unreadable/.test(error.message)) throw error;
      }
    },
  };
}

function appendJournal(journalPath, entry, lock) {
  lock.assertHeld();
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  let entries = [];
  if (fs.existsSync(journalPath)) {
    const raw = fs.readFileSync(journalPath, 'utf8');
    entries = raw.trim() ? JSON.parse(raw) : [];
    if (!Array.isArray(entries)) throw new Error('journal must be an array');
  }
  lock.assertHeld();
  entries.push({ ...entry, at: new Date().toISOString(), lock_token: lock.token });
  const temp = `${journalPath}.${process.pid}.${lock.token}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  lock.assertHeld();
  fs.renameSync(temp, journalPath);
  lock.assertHeld();
}

function bestEffortUncertain(journalPath, entry) {
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    let entries = [];
    if (fs.existsSync(journalPath)) {
      const raw = fs.readFileSync(journalPath, 'utf8').trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          entries = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          entries = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
        }
      }
    }
    entries.push({ ...entry, at: new Date().toISOString(), durable: true });
    fs.writeFileSync(journalPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  } catch (_) {
    // The original error remains the fail-closed result. Never retry a remote write.
  }
}

function assertIssueShape(issue, row, expectedLabels, expectedTitle) {
  if (!issue || issue.number !== row.issue_number) throw new Error(`issue ${row.issue_number} identity mismatch`);
  if (bodySha(issue) !== row.cas.expected_body_sha256) throw new Error(`issue ${row.issue_number} body CAS mismatch`);
  const source = row.source;
  for (const [key, expected] of Object.entries(source)) {
    if (expected !== undefined && expected !== null && issue[key] !== expected) throw new Error(`issue ${row.issue_number} ${key} mismatch`);
  }
  if (row.cas.expected_boundary_status !== undefined && issue.boundary_status !== row.cas.expected_boundary_status) {
    throw new Error(`issue ${row.issue_number} boundary status mismatch`);
  }
  if (expectedTitle !== undefined && issue.title !== expectedTitle) throw new Error(`issue ${row.issue_number} title mismatch`);
  if (expectedLabels !== undefined && !exactLabels(issue.labels, expectedLabels)) throw new Error(`issue ${row.issue_number} labels mismatch`);
}

function validatePatchPayload(row) {
  const keys = Object.keys(row.patch);
  if (keys.some((key) => !['title', 'labels'].includes(key))) throw new Error('boundary PATCH may only contain title/labels');
  if (Object.prototype.hasOwnProperty.call(row.patch, 'body')) throw new Error('boundary PATCH may not change body');
  if (Array.isArray(row.patch.labels) && row.patch.labels.some((label) => /^learning(?::|$)/i.test(label))) {
    throw new Error('boundary PATCH may not modify learning labels');
  }
  if (!keys.length) throw new Error(`issue ${row.issue_number} has no boundary patch`);
}

async function guarded(lock, action) {
  lock.assertHeld();
  const result = await action();
  lock.assertHeld();
  return result;
}

async function applyPlan({ plan, api, authorization, journalPath, lockPath, ceiling, digest }) {
  const checked = validatePlan(plan);
  if (!authorization || authorization.allow_live_github !== true) throw new Error('explicit authorization required');
  if (authorization.plan_digest !== (digest || checked.digest)) throw new Error('authorization digest mismatch');
  const expectedCeiling = checked.rows.length;
  const suppliedCeiling = ceiling ?? authorization.ceiling;
  if (suppliedCeiling !== expectedCeiling || authorization.ceiling !== expectedCeiling) throw new Error('authorization ceiling mismatch');
  if (!api || typeof api.readIssue !== 'function' || typeof api.patchIssue !== 'function' || typeof api.postReceipt !== 'function') {
    throw new Error('fake boundary adapter must provide readIssue, patchIssue, postReceipt');
  }
  const lock = acquireExclusiveLock(lockPath);
  const result = { plan_only: false, mutation: 0, patched: [], receipts: [], uncertain: [] };
  try {
    for (const row of checked.rows) {
      validatePatchPayload(row);
      let patchAttempted = false;
      let phase = 'precondition';
      try {
        const before = await guarded(lock, () => api.readIssue(row.issue_number));
        assertIssueShape(before, row, row.cas.expected_labels, row.cas.expected_title);
        appendJournal(journalPath, { event: 'patch-intent', issue_number: row.issue_number, payload: row.patch }, lock);
        patchAttempted = true;
        phase = 'patch';
        const patchResponse = await guarded(lock, () => api.patchIssue(row.issue_number, row.patch));
        assertIssueShape(patchResponse, row, row.patch.labels ?? before.labels, row.patch.title ?? before.title);
        appendJournal(journalPath, { event: 'patch-response-valid', issue_number: row.issue_number }, lock);
        phase = 'post-patch-get';
        const after = await guarded(lock, () => api.readIssue(row.issue_number));
        assertIssueShape(after, row, row.patch.labels ?? before.labels, row.patch.title ?? before.title);
        appendJournal(journalPath, { event: 'patch-converged', issue_number: row.issue_number }, lock);
        phase = 'receipt';
        const receipt = await guarded(lock, () => api.postReceipt(row.issue_number, {
          issue_number: row.issue_number,
          transition_id: row.transition_request?.transition_id || `issue-1656-boundary-${row.issue_number}`,
          source_note_id: row.cas.source_note_id,
          source_revision_id: row.cas.expected_source_revision_id,
          body_sha256: row.cas.expected_body_sha256,
          patch: row.patch,
        }));
        if (!receipt || (receipt.id === undefined && receipt.receipt_id === undefined)) throw new Error('receipt response missing id');
        appendJournal(journalPath, { event: 'receipt-posted', issue_number: row.issue_number, receipt_id: receipt.id ?? receipt.receipt_id }, lock);
        result.mutation += 1;
        result.patched.push(row.issue_number);
        result.receipts.push(receipt.id ?? receipt.receipt_id);
      } catch (error) {
        const event = phase === 'receipt'
          ? 'receipt-unknown'
          : (patchAttempted ? 'patch-unknown' : 'precondition-failed');
        const uncertain = { event, issue_number: row.issue_number, status: 'uncertain', error: error.message };
        bestEffortUncertain(journalPath, uncertain);
        result.uncertain.push(uncertain);
        throw error;
      }
    }
    return result;
  } finally {
    lock.release();
  }
}

function createFakeApi(initialIssues, options = {}) {
  const issues = new Map(Object.entries(initialIssues || {}).map(([key, issue]) => [Number(key), JSON.parse(JSON.stringify(issue))]));
  const calls = [];
  const api = {
    calls,
    issues,
    async readIssue(number) {
      calls.push({ method: 'readIssue', number });
      if (options.onRead) await options.onRead(number, calls.length);
      const issue = issues.get(number);
      if (!issue) throw new Error(`fake issue ${number} not found`);
      return JSON.parse(JSON.stringify(issue));
    },
    async patchIssue(number, patch) {
      calls.push({ method: 'patchIssue', number, patch: JSON.parse(JSON.stringify(patch)) });
      if (options.onPatch) await options.onPatch(number, patch, calls.length);
      const issue = issues.get(number);
      if (!issue) throw new Error(`fake issue ${number} not found`);
      Object.assign(issue, patch);
      return JSON.parse(JSON.stringify(issue));
    },
    async postReceipt(number, receipt) {
      calls.push({ method: 'postReceipt', number, receipt: JSON.parse(JSON.stringify(receipt)) });
      if (options.onReceipt) await options.onReceipt(number, receipt, calls.length);
      return { id: `fake-receipt-${number}-${calls.length}` };
    },
  };
  return api;
}

module.exports = {
  SCHEMA,
  SOURCE_SCHEMA,
  acquireExclusiveLock,
  applyPlan,
  bodySha,
  buildPlanOnly,
  createFakeApi,
  digestPlan,
  extractRows,
  sha256,
  validatePlan,
};
