'use strict';

const crypto = require('crypto');
const { validateSourceNoteIssue } = require('./source-note-issue');

const SNAPSHOT_SCHEMA_VERSION = 'issue-1605-pending-source-note-inventory.v1';
const OWNERSHIP_SCHEMA_VERSION = 'issue-1605-pending-source-note-ownership.v1';
const SOURCE_REPOSITORY = 'liqiangcc/xhs';
const SOURCE_REF = '95b77bb261048059846273688e4b90a2e108b437';
const INVENTORY_TOTAL = 1397;
const PENDING_LABELS = Object.freeze(['boundary:pending', 'source:xhs', 'status:captured', 'type:source-note']);
const BOUNDARY_BATCHES = Object.freeze([
  { issue_number: 1606, first: 20, last: 392, expected_count: 327 },
  { issue_number: 1607, first: 393, last: 765, expected_count: 367 },
  { issue_number: 1608, first: 766, last: 1138, expected_count: 337 },
  { issue_number: 1609, first: 1139, last: 1508, expected_count: 366 },
]);
const HEX64 = /^[0-9a-f]{64}$/;

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(value) { return sha256Text(canonicalize(value)); }

function labelsOf(issue) {
  return [...new Set((issue && issue.labels || [])
    .map((label) => typeof label === 'string' ? label : label && label.name)
    .filter((label) => typeof label === 'string' && label.trim()))].sort();
}

function hasPendingSelectionLabels(labels) {
  const set = new Set(labels);
  return PENDING_LABELS.every((label) => set.has(label));
}

function bodySha256(body) { return sha256Text(body || ''); }

function buildInventoryItem(issue) {
  const errors = [];
  const number = Number(issue && (issue.number || issue.issue_number));
  const labels = labelsOf(issue);
  if (!Number.isInteger(number) || number < 1) errors.push('issue number must be a positive integer');
  if (issue && issue.pull_request) errors.push('pull requests are not SourceNote inventory items');
  if (!hasPendingSelectionLabels(labels)) errors.push('selected item is missing one or more pending inventory labels');
  const body = issue && typeof issue.body === 'string' ? issue.body : '';
  const validation = validateSourceNoteIssue({ body, labels, state: issue && issue.state || 'open' });
  if (!validation.ok) errors.push(...validation.errors);
  const record = validation.parsed && validation.parsed.record;
  const marker = validation.parsed && validation.parsed.marker;
  const sourceRevision = record && record.source_revision;
  if (!record || !marker || !sourceRevision) errors.push('SourceNote record/marker/revision is missing');
  if (record && record.source_note_id !== marker.source_note_id) errors.push('SourceNote marker and record identity differ');
  if (sourceRevision && sourceRevision.source_repository_ref !== SOURCE_REF) {
    errors.push(`source_revision.source_repository_ref must equal ${SOURCE_REF}`);
  }
  if (sourceRevision && sourceRevision.source_repository && sourceRevision.source_repository !== SOURCE_REPOSITORY) {
    errors.push(`source_revision.source_repository must equal ${SOURCE_REPOSITORY}`);
  }
  if (record && record.boundary_review && record.boundary_review.status !== 'pending') {
    errors.push('record boundary_review.status must be pending');
  }
  if (errors.length) return { ok: false, errors, number, labels, body_sha256: bodySha256(body) };
  return {
    ok: true,
    issue_number: number,
    issue_url: issue.html_url || `https://github.com/liqiangcc/interview-lab/issues/${number}`,
    state: issue.state || 'open',
    body_sha256: bodySha256(body),
    source_note_id: record.source_note_id,
    source_revision: {
      id: sourceRevision.id,
      source_repository: sourceRevision.source_repository || SOURCE_REPOSITORY,
      source_repository_ref: sourceRevision.source_repository_ref,
    },
    labels,
  };
}

function rangeForIssue(number) {
  return BOUNDARY_BATCHES.find((batch) => number >= batch.first && number <= batch.last) || null;
}

function validateInventoryItems(items) {
  const errors = [];
  const normalized = Array.isArray(items) ? [...items].sort((a, b) => Number(a.issue_number) - Number(b.issue_number)) : [];
  if (!Array.isArray(items)) errors.push('inventory items must be an array');
  const numbers = new Set();
  const sourceIds = new Set();
  const ownership = new Map();
  for (const item of normalized) {
    const number = Number(item && item.issue_number);
    if (!Number.isInteger(number)) { errors.push('inventory item has a non-integer issue_number'); continue; }
    if (numbers.has(number)) errors.push(`duplicate pending issue #${number}`);
    numbers.add(number);
    if (!item.source_note_id) errors.push(`Issue #${number} has no source_note_id`);
    if (sourceIds.has(item.source_note_id)) errors.push(`duplicate SourceNote id ${item.source_note_id}`);
    sourceIds.add(item.source_note_id);
    if (!HEX64.test(item.body_sha256 || '')) errors.push(`Issue #${number} has no valid body_sha256`);
    if (!item.source_revision || !item.source_revision.id) errors.push(`Issue #${number} has no source revision id`);
    if (!item.source_revision || item.source_revision.source_repository_ref !== SOURCE_REF) errors.push(`Issue #${number} source ref drifted`);
    const labels = Array.isArray(item.labels) ? item.labels : [];
    if (JSON.stringify([...labels].sort()) !== JSON.stringify(labels)) errors.push(`Issue #${number} labels are not canonicalized`);
    if (!hasPendingSelectionLabels(labels)) errors.push(`Issue #${number} is not selected by the pending label predicate`);
    const batch = rangeForIssue(number);
    if (!batch) errors.push(`Issue #${number} is outside all fixed boundary ranges`);
    else ownership.set(number, batch.issue_number);
  }
  if (normalized.length !== INVENTORY_TOTAL) errors.push(`pending inventory count must be ${INVENTORY_TOTAL}, got ${normalized.length}`);
  const rangeCounts = BOUNDARY_BATCHES.map((batch) => {
    const numbersInRange = normalized.filter((item) => Number(item.issue_number) >= batch.first && Number(item.issue_number) <= batch.last).map((item) => Number(item.issue_number));
    const unique = new Set(numbersInRange);
    if (unique.size !== numbersInRange.length) errors.push(`boundary range #${batch.issue_number} contains duplicate ownership`);
    if (unique.size !== batch.expected_count) errors.push(`boundary range #${batch.issue_number} count must be ${batch.expected_count}, got ${unique.size}`);
    return { ...batch, count: unique.size, issue_numbers: [...unique].sort((a, b) => a - b) };
  });
  const rangeSets = rangeCounts.map((range) => new Set(range.issue_numbers));
  for (let left = 0; left < rangeSets.length; left += 1) {
    for (let right = left + 1; right < rangeSets.length; right += 1) {
      const overlap = [...rangeSets[left]].filter((number) => rangeSets[right].has(number));
      if (overlap.length) errors.push(`boundary ranges #${rangeCounts[left].issue_number} and #${rangeCounts[right].issue_number} overlap: ${overlap.join(',')}`);
    }
  }
  const union = new Set(rangeCounts.flatMap((range) => range.issue_numbers));
  if (union.size !== INVENTORY_TOTAL) errors.push(`boundary range union count must be ${INVENTORY_TOTAL}, got ${union.size}`);
  if (union.size !== numbers.size || [...numbers].some((number) => !union.has(number))) errors.push('boundary range union does not equal the pending inventory');
  return {
    ok: errors.length === 0,
    errors,
    total: normalized.length,
    union_count: union.size,
    range_counts: rangeCounts.map(({ issue_numbers, ...summary }) => summary),
    union_issue_numbers: [...union].sort((a, b) => a - b),
    ownership,
  };
}

function buildOwnershipIndex(items, snapshotDigest) {
  const entries = {};
  for (const item of [...items].sort((a, b) => Number(a.issue_number) - Number(b.issue_number))) {
    entries[item.source_note_id] = {
      issue_number: item.issue_number,
      issue_url: item.issue_url,
      body_sha256: item.body_sha256,
      source_revision_id: item.source_revision.id,
      source_repository_ref: item.source_revision.source_repository_ref,
      labels: item.labels,
    };
  }
  const content = {
    schema_version: OWNERSHIP_SCHEMA_VERSION,
    repository: 'liqiangcc/interview-lab',
    parent_issue: 1605,
    inventory_schema_version: SNAPSHOT_SCHEMA_VERSION,
    snapshot_canonical_digest: snapshotDigest,
    count: Object.keys(entries).length,
    entries,
  };
  return { ...content, canonical_digest: canonicalDigest(content) };
}

function snapshotDigestInput(snapshot) {
  const copy = { ...snapshot };
  delete copy.canonical_digest;
  delete copy.validation;
  delete copy.generated_at;
  return copy;
}

function buildSnapshot({ repository = 'liqiangcc/interview-lab', pages, items, query }) {
  const validation = validateInventoryItems(items);
  const sortedItems = [...items].sort((a, b) => Number(a.issue_number) - Number(b.issue_number));
  const content = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    repository,
    parent_issue: 1605,
    source_repository: SOURCE_REPOSITORY,
    source_ref: SOURCE_REF,
    selection: {
      state: 'all',
      label: 'type:source-note',
      local_predicate: PENDING_LABELS,
      per_page: 100,
      pages,
      query,
    },
    fixed_boundary_batches: validation.range_counts,
    count: sortedItems.length,
    union_count: validation.union_count,
    union_disjoint: validation.errors.filter((error) => error.includes('overlap')).length === 0,
    items: sortedItems,
  };
  return {
    ...content,
    validation: { ok: validation.ok, errors: validation.errors },
    canonical_digest: canonicalDigest(snapshotDigestInput(content)),
  };
}

function validateSnapshot(snapshot, ownership) {
  const errors = [];
  if (!snapshot || snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION) errors.push(`snapshot schema_version must be ${SNAPSHOT_SCHEMA_VERSION}`);
  const validation = validateInventoryItems(snapshot && snapshot.items);
  errors.push(...validation.errors);
  if (snapshot && snapshot.canonical_digest !== canonicalDigest(snapshotDigestInput(snapshot))) errors.push('snapshot canonical_digest does not match canonical content');
  if (!ownership || ownership.schema_version !== OWNERSHIP_SCHEMA_VERSION) errors.push(`ownership schema_version must be ${OWNERSHIP_SCHEMA_VERSION}`);
  else {
    if (ownership.snapshot_canonical_digest !== snapshot.canonical_digest) errors.push('ownership index is not pinned to snapshot canonical_digest');
    const expected = buildOwnershipIndex(snapshot.items, snapshot.canonical_digest);
    if (ownership.canonical_digest !== expected.canonical_digest) errors.push('ownership canonical_digest does not match entries');
  }
  return { ok: errors.length === 0, errors, validation };
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  OWNERSHIP_SCHEMA_VERSION,
  SOURCE_REPOSITORY,
  SOURCE_REF,
  INVENTORY_TOTAL,
  PENDING_LABELS,
  BOUNDARY_BATCHES,
  canonicalize,
  canonicalDigest,
  sha256Text,
  labelsOf,
  hasPendingSelectionLabels,
  buildInventoryItem,
  validateInventoryItems,
  buildOwnershipIndex,
  buildSnapshot,
  validateSnapshot,
};
