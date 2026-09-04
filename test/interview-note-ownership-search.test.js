'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ownershipSearchEndpoint,
  searchOwnershipCandidateNumbers,
  exactOwnershipCandidates,
  createSearchThrottle,
  forEachWithThrottle,
} = require('../scripts/lib/interview-note-ownership-search');
const { parseArgs, ghReadJson, loadOwnershipCandidates, ownershipIdentityCandidates, readOfflineInterviewIssues, main } = require('../scripts/plan-xhs-interview-note-materialization-batch');
const { parseSourceNoteIssue } = require('../scripts/lib/source-note-issue');
const { sha256Text } = require('../scripts/lib/source-note-interview-materialization');

test('exact identity search reads only returned candidate Issues at repository scale', () => {
  const pages = [{ total_count: 2, incomplete_results: false, items: [{ number: 17 }, { number: 42 }] }];
  const readIssues = [];
  const candidates = exactOwnershipCandidates({
    interviewNoteId: 'xhs:identity-42',
    readPage: (page) => pages[page - 1] || { total_count: 2, incomplete_results: false, items: [] },
    readIssue: (number) => {
      readIssues.push(number);
      return { number, body: number === 42 ? '<!-- interview-note: id=xhs:identity-42 schema=interview-note-issue.v2 -->' : 'reference only' };
    },
    matches: (issues, id) => issues.filter((issue) => issue.body.includes(`id=${id} `)),
  });
  assert.deepEqual(readIssues, [17, 42]);
  assert.deepEqual(candidates.map((issue) => issue.number), [42]);
  assert.match(ownershipSearchEndpoint('liqiangcc/interview-lab', 'xhs:identity-42'), /search%2Fissues|search\/issues/);
});

test('paginated exact search permits a large result count only with bounded complete pages', () => {
  const result = searchOwnershipCandidateNumbers((page) => ({
    total_count: 201,
    incomplete_results: false,
    items: page === 1
      ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }))
      : page === 2
        ? Array.from({ length: 100 }, (_, index) => ({ number: index + 101 }))
        : [{ number: 201 }],
  }), { maxPages: 3 });
  assert.equal(result.length, 201);
  assert.throws(() => searchOwnershipCandidateNumbers(() => ({ total_count: 1459, incomplete_results: false, items: Array.from({ length: 100 }, (_, index) => ({ number: index + 1 })) }), { maxPages: 10 }), /exceeded 10 pages|pagination incomplete/);
  assert.throws(() => searchOwnershipCandidateNumbers(() => ({ total_count: 1, incomplete_results: true, items: [{ number: 1 }] })), /incomplete results/);
});

test('paginated search invokes the shared throttle before every search page', () => {
  const pages = [];
  const result = searchOwnershipCandidateNumbers((page) => {
    pages.push(page);
    return { total_count: 101, incomplete_results: false, items: page === 1
      ? Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }))
      : [{ number: 101 }] };
  }, { beforePage: (page) => pages.push(`before:${page}`) });
  assert.equal(result.length, 101);
  assert.deepEqual(pages, ['before:1', 1, 'before:2', 2]);
});

test('batch CLI defaults to rate-safe search spacing and rejects unsafe overrides', () => {
  assert.equal(parseArgs(['--repository', 'liqiangcc/interview-lab']).searchPauseMs, 2200);
  assert.equal(parseArgs(['--repository', 'liqiangcc/interview-lab', '--search-pause-ms', '3000']).searchPauseMs, 3000);
  assert.throws(() => parseArgs(['--repository', 'liqiangcc/interview-lab', '--search-pause-ms', '2099']), />= 2100/);

  const calls = [];
  const pauses = [];
  forEachWithThrottle(Array.from({ length: 30 }, (_, index) => index), (item) => calls.push(item), 2100, (ms) => pauses.push(ms));
  assert.equal(calls.length, 30);
  assert.deepEqual(pauses, Array(29).fill(2100));
});

test('read-only GitHub JSON retries with bounded backoff', () => {
  let calls = 0;
  const waits = [];
  const value = ghReadJson(['api', 'read-only'], { attempts: 3, retryPauseMs: 25, sleep: (ms) => waits.push(ms), read: () => { calls += 1; if (calls < 3) throw new Error('transient'); return { ok: true }; } });
  assert.deepEqual(value, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 50]);
});

test('live batch CLI has no repository-wide live Issue body scan', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scripts/plan-xhs-interview-note-materialization-batch.js'), 'utf8');
  assert.doesNotMatch(source, /function\s+loadAllIssues/);
  assert.doesNotMatch(source, /issues\?state=all&per_page=100/);
  assert.match(source, /exactOwnershipCandidates/);
});

test('live loader searches not-interview identities as ownership guards', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/source-note-issue-v2.valid.md'), 'utf8');
  const parsed = parseSourceNoteIssue(fixture);
  const makeIssue = (number, status, externalId) => {
    const record = JSON.parse(JSON.stringify(parsed.record));
    record.source.external_id = externalId;
    record.source_note_id = `xhs-note:${externalId}`;
    record.source.url = `https://www.xiaohongshu.com/explore/${externalId}`;
    record.source_revision.id = `xhs:${externalId}:r1`;
    record.boundary_review = { status, reviewed_at: '2026-09-04T04:00:00Z', interview_note_ids: [] };
    if (status === 'single-interview') record.boundary_review.interview_note_ids = [`xhs:${externalId}`];
    const body = fixture
      .replace(JSON.stringify(parsed.record, null, 2), JSON.stringify(record, null, 2))
      .replace('xhs-note:runtime-fixture-1', `xhs-note:${externalId}`)
      .replace('runtime-fixture-1', externalId);
    return { number, state: 'open', body, labels: ['type:source-note', 'source:xhs', 'status:captured', `boundary:${status}`] };
  };
  const sources = [makeIssue(1, 'not-interview', 'not-event'), makeIssue(2, 'single-interview', 'single-event')];
  assert.deepEqual(ownershipIdentityCandidates(sources).sort(), ['xhs:not-event', 'xhs:single-event']);
  const queried = [];
  loadOwnershipCandidates('liqiangcc/interview-lab', sources, {
    searchPauseMs: 2100,
    sleep: () => {},
    readPage: (id, page) => { queried.push([id, page]); return { total_count: 0, incomplete_results: false, items: [] }; },
    readIssue: () => { throw new Error('no candidate issue should be read'); },
  });
  assert.deepEqual([...new Set(queried.map(([id]) => id))].sort(), ['xhs:not-event', 'xhs:single-event']);
});

test('offline interview candidate input requires scope, completeness, and digest proof', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-922-offline-'));
  const file = path.join(directory, 'issues.json');
  const issues = [];
  const value = {
    schema_version: 'interview-note-ownership-offline-input.v1',
    repository: 'liqiangcc/interview-lab',
    scope: { kind: 'explicit-interview-note-candidate-set', source_issue_numbers: [1] },
    completeness: { complete: true, method: 'fixture-only-explicit-set' },
    issues,
    issues_sha256: require('../scripts/lib/source-note-interview-materialization').sha256Text(JSON.stringify(issues)),
  };
  fs.writeFileSync(file, JSON.stringify(value));
  assert.equal(readOfflineInterviewIssues(file, value.repository).proof.completeness.complete, true);
  fs.writeFileSync(file, JSON.stringify({ ...value, completeness: { complete: false, method: 'unknown' } }));
  assert.throws(() => readOfflineInterviewIssues(file, value.repository), /completeness proof/);
});

test('offline ownership report uses safeReport readiness for its exit code', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-922-offline-exit-'));
  const sourceFile = path.join(directory, 'sources.json');
  const interviewFile = path.join(directory, 'interviews.json');
  const reportFile = path.join(directory, 'report.json');
  const issues = [];
  const offline = {
    schema_version: 'interview-note-ownership-offline-input.v1',
    repository: 'liqiangcc/interview-lab',
    scope: { kind: 'explicit-interview-note-candidate-set', source_issue_numbers: [] },
    completeness: { complete: true, method: 'fixture-only-explicit-set' },
    issues,
    issues_sha256: sha256Text(JSON.stringify(issues)),
  };
  fs.writeFileSync(sourceFile, JSON.stringify([]));
  fs.writeFileSync(interviewFile, JSON.stringify(offline));
  const exitCode = main([
    '--repository', 'liqiangcc/interview-lab', '--source-issues-file', sourceFile,
    '--interview-issues-file', interviewFile, '--dependency-gate-file', path.join(__dirname, '../data/pilot/issue-922/dependency-gate.json'),
    '--report', reportFile,
  ]);
  const safeReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(safeReport.ready_for_apply, false);
  assert.equal(exitCode, 1);
});
