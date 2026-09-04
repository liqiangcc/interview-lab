'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FIXED_SOURCE_REF,
  EXPECTED_SOURCE_TOTAL,
  MUTATING_ACTIONS,
  buildProjection,
  planActions,
  validateProjection,
  summarizeAnomalies,
  buildInventory,
  inventoryReconciliationSummary,
  inventoryPreflightErrors,
  finalAcceptanceErrors,
  inventoryGateErrors,
  sourceSnapshotGateErrors,
  paginatedGhApi,
  findSourceNoteIdentity,
  verifyCreatedSourceNote,
  verifyBatchInventory,
  applyMutationPlan,
  buildReconciliationReport,
} = require('../scripts/reconcile-xhs-source-notes');

const sourceRef = '95b77bb261048059846273688e4b90a2e108b437';

function candidate(overrides = {}) {
  return {
    note_id: '625564d70000000001025e46',
    original_title: '阿里蚂蚁金服Java中间件6轮面试题! 总结',
    readable_desc: '这些都是不断面试积累来的经验。',
    source_published_at: { precision: 'exact', value: '2022-04-12T19:39:03.000+08:00' },
    source_edited_at: { precision: 'exact', value: '2022-04-15T19:36:11.000+08:00' },
    artifacts: [{
      kind: 'image',
      ref: `liqiangcc/xhs:downloaded_images/625564d70000000001025e46/1.webp@${sourceRef}`,
      git_blob_sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
      sha256: null,
      provenance: 'raw_capture',
      byte_size: 0,
      integrity: 'zero-byte',
    }],
    anomalies: [{ code: 'zero-byte-artifacts', detail: '1 artifact(s) are zero-byte in the pinned source snapshot' }],
    limitations: ['SourceNote intake 不判断该帖子是否等于一次真实面试事件。'],
    ...overrides,
  };
}

function existingSourceNote(number, labels) {
  return { number, labels: labels.map((name) => ({ name })) };
}

function liveSourceNote(number, projection, overrides = {}) {
  return {
    number,
    state: 'open',
    body: projection.body,
    labels: projection.labels.map((name) => ({ name })),
    ...overrides,
  };
}

function validInterviewBody(interviewNoteId, schema = 'interview-note-issue.v2') {
  return fs.readFileSync('test/fixtures/interview-note-issue.valid.md', 'utf8')
    .replace(/630e2e22000000001103c490/g, interviewNoteId.slice('xhs:'.length))
    .replace(/interview-note-issue\.v2/g, schema);
}

test('XHS candidate projects to SourceNote, not InterviewNote', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  assert.equal(projection.source_note_id, 'xhs-note:625564d70000000001025e46');
  assert.match(projection.body, /<!-- source-note:/);
  assert.doesNotMatch(projection.body, /<!-- interview-note:/);
  assert.deepEqual(projection.labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk', 'source-year:2022',
  ]);
  const result = validateProjection(projection);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('unknown publication year does not invent source-year label', () => {
  const projection = buildProjection(candidate({
    source_published_at: { precision: 'unknown', value: null },
  }), sourceRef, '2026-09-03T13:00:00.000Z');
  assert.equal(projection.labels.some((label) => label.startsWith('source-year:')), false);
  const result = validateProjection(projection);
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('projection preserves zero-byte evidence without pretending it is healthy', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  assert.match(projection.body, /zero-byte/);
  assert.match(projection.body, /zero-byte-artifacts/);
});

test('legacy bulk InterviewNote is converted in place', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const actions = planActions([projection], {
    sourceNotes: new Map(),
    bulkLegacy: new Map([[projection.external_id, { number: 20 }]]),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'convert-bulk-interview-note-in-place');
  assert.equal(actions[0].issue_number, 20);
});

test('formal non-bulk InterviewNote is preserved while its SourceNote is still backfilled', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const actions = planActions([projection], {
    sourceNotes: new Map(),
    bulkLegacy: new Map(),
    protectedInterview: new Map([[projection.external_id, { number: 3 }]]),
  });
  assert.equal(actions[0].action, 'create-source-note-alongside-formal-interview-note');
  assert.equal(actions[0].issue_number, null);
  assert.equal(actions[0].protected_interview_issue_number, 3);
});

test('existing SourceNote with correct source-year is current and idempotent', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(600, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk', 'source-year:2022',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map([[projection.external_id, { number: 3 }]]),
  });
  assert.equal(actions[0].action, 'source-note-current');
  assert.equal(actions[0].issue_number, 600);
  assert.equal(MUTATING_ACTIONS.has(actions[0].action), false);
});

test('existing SourceNote missing source-year gets a labels-only discovery reconciliation action', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(20, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'reconcile-source-note-discovery-labels');
  assert.equal(actions[0].issue_number, 20);
  assert.deepEqual(actions[0].reconciled_labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'task:boundary-review', 'migration:xhs-bulk', 'source-year:2022',
  ]);
  assert.equal(MUTATING_ACTIONS.has(actions[0].action), true);
});

test('wrong source-year is replaced without changing unrelated labels or boundary state', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(601, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview', 'custom:keep-me', 'source-year:2023',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'reconcile-source-note-discovery-labels');
  assert.deepEqual(actions[0].reconciled_labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:single-interview', 'custom:keep-me', 'source-year:2022',
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(actions[0], 'body'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(actions[0], 'title'), false);
});

test('unknown publication time removes stale source-year while preserving other labels', () => {
  const projection = buildProjection(candidate({
    source_published_at: { precision: 'unknown', value: null },
  }), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(602, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:not-interview', 'source-year:2022', 'custom:keep-me',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'reconcile-source-note-discovery-labels');
  assert.deepEqual(actions[0].reconciled_labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:not-interview', 'custom:keep-me',
  ]);
});

test('duplicate stale source-year values collapse to the single authoritative source year', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = existingSourceNote(603, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'source-year:2022', 'source-year:2023',
  ]);
  const actions = planActions([projection], {
    sourceNotes: new Map([[projection.source_note_id, issue]]),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'reconcile-source-note-discovery-labels');
  assert.deepEqual(actions[0].reconciled_labels, [
    'type:source-note', 'source:xhs', 'status:captured', 'boundary:pending', 'source-year:2022',
  ]);
});

test('missing source identity becomes a new SourceNote, not an InterviewNote', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const actions = planActions([projection], {
    sourceNotes: new Map(),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
  });
  assert.equal(actions[0].action, 'create-source-note');
});

test('missing source identity is plannable in preflight but blocks final acceptance', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const inventory = {
    sourceNotes: new Map(),
    bulkLegacy: new Map(),
    protectedInterview: new Map(),
    duplicateSourceNotes: new Map(),
    invalidSourceNotes: [],
    repairableSourceNotes: [],
    interviewOwnershipConflicts: [],
  };
  const summary = inventoryReconciliationSummary([projection], inventory);
  const actions = planActions([projection], inventory);

  assert.equal(summary.unaccounted_source_id, 1);
  assert.deepEqual(inventoryPreflightErrors(summary), []);
  assert.deepEqual(inventoryGateErrors(summary), []);
  assert.equal(actions.filter((action) => MUTATING_ACTIONS.has(action.action)).length, 1);
  assert.deepEqual(finalAcceptanceErrors(summary, { mutationCandidates: 1, globalRemaining: 1 }), [
    'unaccounted_source_id=1',
    'mutation_candidates=1',
    'global_remaining_after_run=1',
  ]);
  assert.deepEqual(finalAcceptanceErrors(summary), ['unaccounted_source_id=1']);
  const report = buildReconciliationReport({
    sourceRef,
    candidates: [projection],
    inventory,
    inventorySummary: summary,
    actions,
    mutating: actions.filter((action) => MUTATING_ACTIONS.has(action.action)),
    applied: [],
  });
  assert.equal(report.preflight_gate, 'pass');
  assert.equal(report.final_gate, 'blocked');
  assert.equal(Object.prototype.hasOwnProperty.call(report, 'inventory_gate'), false);
});

test('closed legacy bulk and closed pending SourceNote fail preflight closed', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const closedLegacy = {
    number: 30,
    state: 'closed',
    body: validInterviewBody('xhs:625564d70000000001025e46'),
    labels: [{ name: 'type:interview-note' }, { name: 'status:source-ready' }, { name: 'migration:xhs-bulk' }],
  };
  const closedPending = liveSourceNote(31, projection, { state: 'closed' });
  const inventory = buildInventory([closedLegacy, closedPending]);
  const summary = inventoryReconciliationSummary([projection], inventory);
  const errors = inventoryPreflightErrors(summary).join('\n');

  assert.equal(summary.closed_legacy_bulk, 1);
  assert.equal(summary.closed_pending_source_note, 1);
  assert.match(errors, /closed_legacy_bulk=1/);
  assert.match(errors, /closed_pending_source_note=1/);
  assert.equal(finalAcceptanceErrors(summary).length >= 2, true);
});

test('multiple and malformed InterviewNote markers are invalid inventory', () => {
  const inventory = buildInventory([
    {
      number: 40,
      state: 'open',
      body: '<!-- interview-note: id=xhs:a schema=interview-note-issue.v2 -->\n<!-- interview-note: id=xhs:b schema=interview-note-issue.v2 -->',
      labels: [{ name: 'type:interview-note' }],
    },
    {
      number: 41,
      state: 'open',
      body: '<!-- interview-note: id=xhs:c -->',
      labels: [{ name: 'type:interview-note' }],
    },
    {
      number: 42,
      state: 'open',
      body: validInterviewBody('xhs:630e2e22000000001103c490', 'interview-note-issue.v99'),
      labels: [{ name: 'type:interview-note' }],
    },
  ]);
  const summary = inventoryReconciliationSummary([], inventory);

  assert.equal(summary.invalid_interview_note_marker, 3);
  assert.match(inventoryPreflightErrors(summary).join('\n'), /invalid_interview_note_marker=3/);
  assert.match(finalAcceptanceErrors(summary).join('\n'), /invalid_interview_note_marker=3/);
  assert.match(inventory.invalidInterviewNotes[2].errors.join('\n'), /supported InterviewNote Issue schema/);
});

test('fixed source snapshot gate rejects wrong ref and candidate count', () => {
  assert.deepEqual(sourceSnapshotGateErrors(FIXED_SOURCE_REF, EXPECTED_SOURCE_TOTAL), []);
  assert.match(sourceSnapshotGateErrors('wrong-ref', EXPECTED_SOURCE_TOTAL).join('\n'), /source_ref=.*expected/);
  assert.match(sourceSnapshotGateErrors(FIXED_SOURCE_REF, EXPECTED_SOURCE_TOTAL - 1).join('\n'), /total_candidates=1458/);
});

test('explicit pagination collects multiple pages and stops on an empty page', () => {
  const calls = [];
  const values = paginatedGhApi('repos/example/issues', 2, (args) => {
    calls.push(args[1]);
    return calls.length === 1 ? [{ id: 1 }, { id: 2 }] : [];
  });

  assert.deepEqual(values, [{ id: 1 }, { id: 2 }]);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /per_page=2&page=1$/);
  assert.match(calls[1], /per_page=2&page=2$/);
});

test('explicit pagination rejects a non-array page', () => {
  assert.throws(
    () => paginatedGhApi('repos/example/issues', 2, () => ({ items: [] })),
    /expected paginated GitHub API response array/,
  );
});

test('missing POST response defers recovery to the batch inventory scan', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  let reads = 0;
  assert.throws(
    () => verifyCreatedSourceNote('liqiangcc/interview-lab', projection, null, {
      readIssue: () => {
        reads += 1;
        return null;
      },
    }),
    /batch inventory recovery/,
  );
  assert.equal(reads, 0);
});

test('normal POST response is verified by one direct GET without an issues scan', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const created = liveSourceNote(77, projection);
  let reads = 0;
  let scans = 0;
  const verified = verifyCreatedSourceNote('liqiangcc/interview-lab', projection, 77, {
    readIssue: () => {
      reads += 1;
      return created;
    },
    scanIssues: () => {
      scans += 1;
      return [created];
    },
  });

  assert.equal(verified, 77);
  assert.equal(reads, 1);
  assert.equal(scans, 0);
  assert.deepEqual(findSourceNoteIdentity([created], projection.source_note_id), [created]);
});

test('one batch inventory scan recovers an uncertain POST response and rejects duplicates', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const issue = liveSourceNote(78, projection);
  let scans = 0;
  const recovered = verifyBatchInventory('liqiangcc/interview-lab', [projection], [{
    issue_number: null,
    projection,
  }], {
    scanIssues: () => {
      scans += 1;
      return [issue];
    },
  });
  assert.equal(scans, 1);
  assert.equal(recovered.created[0].issue_number, 78);

  assert.throws(
    () => verifyBatchInventory('liqiangcc/interview-lab', [projection], [{
      issue_number: null,
      projection,
    }], {
      scanIssues: () => [issue, { ...issue, number: 79 }],
    }),
    /duplicate audit failed closed: duplicate_source_note=1/,
  );
});

test('100 create actions use one batch inventory scan, not one scan per create', () => {
  const actions = Array.from({ length: 100 }, (_, index) => ({
    action: 'create-source-note',
    projection: { source_note_id: `xhs-note:test-${index}` },
  }));
  let scans = 0;
  const applied = applyMutationPlan(actions, {
    mutate: (action) => Number(action.projection.source_note_id.split('-').pop()),
    verifyBatch: () => {
      scans += 1;
      return { created: [] };
    },
    sleep: () => {},
    globalTotal: 1459,
  });

  assert.equal(applied.length, 100);
  assert.ok(scans <= 2);
  assert.equal(scans, 1);
});

test('POST exception permits one batch inventory recovery and stops safely', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const action = { action: 'create-source-note', projection };
  const reports = [];
  let scans = 0;
  assert.throws(
    () => applyMutationPlan([action], {
      mutate: () => {
        const error = new Error('response lost');
        error.postCreateUncertain = true;
        error.createdIssueNumber = null;
        error.projection = projection;
        throw error;
      },
      verifyBatch: (records) => {
        scans += 1;
        return verifyBatchInventory('liqiangcc/interview-lab', [projection], records, {
          scanIssues: () => [liveSourceNote(88, projection)],
        });
      },
      persist: (report) => reports.push({ ...report, applied: [...report.applied] }),
      sleep: () => {},
      globalTotal: 1,
    }),
    /response loss recovered/,
  );
  assert.equal(scans, 1);
  assert.equal(reports.at(-1).applied[0].issue_number, 88);
  assert.equal(reports.at(-1).failure.recovered, true);
});

test('batch-end duplicate audit blocks completion and persists failure', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const actions = [{ action: 'create-source-note', projection }];
  const reports = [];
  assert.throws(
    () => applyMutationPlan(actions, {
      mutate: () => 100,
      verifyBatch: (records) => verifyBatchInventory('liqiangcc/interview-lab', [projection], records, {
        scanIssues: () => [liveSourceNote(100, projection), liveSourceNote(101, projection)],
      }),
      persist: (report) => reports.push({ ...report, applied: [...report.applied] }),
      sleep: () => {},
      globalTotal: 1,
    }),
    /duplicate audit failed closed: duplicate_source_note=1/,
  );
  assert.equal(reports.at(-1).failure.phase, 'global-duplicate-audit');
  assert.equal(reports.at(-1).applied.length, 1);
  assert.equal(reports.at(-1).batch_remaining, 0);
});

test('batch duplicate audit retains the audited inventory in the failure report callback', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  let error;
  try {
    verifyBatchInventory('liqiangcc/interview-lab', [projection], [], {
      scanIssues: () => [liveSourceNote(100, projection), liveSourceNote(101, projection)],
    });
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /duplicate audit failed closed: duplicate_source_note=1/);
  assert.equal(error.inventorySummary.duplicate_source_note, 1);
});

test('apply mutation failure persists prior successes and failure/remaining state', () => {
  const actions = [1, 2, 3].map((number) => ({
    action: 'create-source-note',
    projection: { source_note_id: `xhs-note:test-${number}` },
  }));
  const reports = [];

  assert.throws(
    () => applyMutationPlan(actions, {
      mutate: (action) => {
        if (action.projection.source_note_id.endsWith('2')) throw new Error('simulated POST failure');
        return 100 + reports.length;
      },
      persist: (report) => reports.push({ ...report, applied: [...report.applied] }),
      sleep: () => {},
      globalTotal: 3,
    }),
    /simulated POST failure/,
  );

  assert.equal(reports.length, 2);
  assert.equal(reports[0].applied.length, 1);
  assert.equal(reports[0].failure, null);
  assert.equal(reports[0].batch_remaining, 2);
  assert.equal(reports[0].global_remaining, 2);
  assert.equal(reports[1].applied.length, 1);
  assert.equal(reports[1].applied[0].source_note_id, 'xhs-note:test-1');
  assert.equal(reports[1].failure.index, 2);
  assert.equal(reports[1].failure.error, 'simulated POST failure');
  assert.equal(reports[1].batch_remaining, 2);
  assert.equal(reports[1].global_remaining, 2);

  const completedBatchReports = [];
  const completed = applyMutationPlan(actions.slice(0, 2), {
    mutate: (action) => Number(action.projection.source_note_id.slice(-1)),
    persist: (report) => completedBatchReports.push(report),
    sleep: () => {},
    globalTotal: actions.length,
  });
  assert.equal(completed.length, 2);
  assert.equal(completedBatchReports[1].batch_remaining, 0);
  assert.equal(completedBatchReports[1].global_remaining, 1);
});

test('anomaly summary counts affected SourceNotes by anomaly code', () => {
  const counts = summarizeAnomalies([
    candidate(),
    candidate({
      note_id: 'another',
      anomalies: [
        { code: 'zero-byte-artifacts', detail: '2 zero-byte artifacts' },
        { code: 'edited-before-published', detail: 'source order anomaly' },
      ],
    }),
  ]);
  assert.deepEqual(counts, {
    'zero-byte-artifacts': 2,
    'edited-before-published': 1,
  });
});

test('inventory reports duplicate SourceNote identities instead of silently choosing one', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const inventory = buildInventory([
    liveSourceNote(10, projection),
    liveSourceNote(11, projection),
  ]);
  const summary = inventoryReconciliationSummary([projection], inventory);
  assert.equal(summary.duplicate_source_note, 1);
  assert.deepEqual(inventory.duplicateSourceNotes.get(projection.source_note_id), [10, 11]);
  assert.match(inventoryGateErrors(summary).join('\n'), /duplicate_source_note=1/);
});

test('inventory repairs label-only SourceNote drift without rewriting its body', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const drifted = liveSourceNote(12, projection, {
    labels: [...projection.labels, { name: 'type:interview-note' }],
  });
  const inventory = buildInventory([drifted]);
  const summary = inventoryReconciliationSummary([projection], inventory);
  assert.equal(summary.invalid_source_note, 1);
  assert.equal(summary.repairable_invalid_source_note, 1);
  assert.equal(summary.unaccounted_source_id, 0);
  assert.equal(inventoryGateErrors(summary).length, 0);
  const action = planActions([projection], inventory)[0];
  assert.equal(action.action, 'reconcile-source-note-labels');
  assert.equal(action.issue_number, 12);
  assert.equal(action.reconciled_labels.includes('type:interview-note'), false);
});

test('inventory blocks SourceNotes whose body cannot be repaired by a label-only mutation', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const malformed = liveSourceNote(14, projection, { body: projection.body.replace('source-note-record', 'source-note-record-corrupt') });
  const inventory = buildInventory([malformed]);
  const summary = inventoryReconciliationSummary([projection], inventory);
  assert.equal(summary.invalid_source_note, 1);
  assert.equal(summary.unrepairable_invalid_source_note, 1);
  assert.equal(summary.unaccounted_source_id, 1);
  assert.match(inventoryGateErrors(summary).join('\n'), /invalid_source_note=1/);
});

test('inventory preserves formal InterviewNote ownership while accounting for SourceNote backfill', () => {
  const projection = buildProjection(candidate(), sourceRef, '2026-09-03T13:00:00.000Z');
  const inventory = buildInventory([{
    number: 13,
    state: 'open',
    body: validInterviewBody('xhs:625564d70000000001025e46'),
    labels: [{ name: 'type:interview-note' }, { name: 'status:source-ready' }],
  }]);
  const summary = inventoryReconciliationSummary([projection], inventory);
  assert.equal(summary.accounted_source_id, 1);
  assert.equal(summary.protected_formal_interview_note, 1);
  assert.equal(inventoryGateErrors(summary).length, 0);
  assert.equal(planActions([projection], inventory)[0].action, 'create-source-note-alongside-formal-interview-note');
});
