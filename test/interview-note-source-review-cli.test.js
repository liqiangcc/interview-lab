'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArgs,
  loadPinnedArtifactManifest,
  ownershipSearchEndpoint,
  ownershipSearchItems,
} = require('../scripts/plan-interview-note-source-review-transition');
const { ownershipMatches } = require('../scripts/lib/interview-note-source-review-transition');

const INTERVIEW_NOTE_ID = 'xhs:6a8abe2d000000001602b26e';

test('ownership search is scoped to exact repository identity candidates', () => {
  const endpoint = ownershipSearchEndpoint('liqiangcc/interview-lab', INTERVIEW_NOTE_ID);
  assert.match(decodeURIComponent(endpoint), /^search\/issues\?q=repo:liqiangcc\/interview-lab is:issue in:body "xhs:6a8abe2d000000001602b26e"&per_page=100$/);
});

test('ownership search deduplicates paginated candidates and requires complete results', () => {
  const pages = [
    {
      total_count: 3,
      incomplete_results: false,
      items: [{ number: 910 }, { number: 915 }],
    },
    {
      total_count: 3,
      incomplete_results: false,
      items: [{ number: 915 }, { number: 917 }],
    },
  ];
  assert.deepEqual(ownershipSearchItems(pages), [910, 915, 917]);
});

test('incomplete or truncated ownership search fails closed', () => {
  assert.throws(
    () => ownershipSearchItems([{ total_count: 1, incomplete_results: true, items: [{ number: 915 }] }]),
    /incomplete results/,
  );
  assert.throws(
    () => ownershipSearchItems([{ total_count: 2, incomplete_results: false, items: [{ number: 915 }] }]),
    /pagination incomplete/,
  );
});

test('search references are not ownership without direct machine-marker verification', () => {
  const reference = { number: 917, body: `This mentions ${INTERVIEW_NOTE_ID}.` };
  const owner = { number: 915, body: `<!-- interview-note: id=${INTERVIEW_NOTE_ID} schema=interview-note-issue.v2 -->` };
  assert.deepEqual(ownershipMatches([reference], INTERVIEW_NOTE_ID), []);
  assert.deepEqual(ownershipMatches([owner], INTERVIEW_NOTE_ID), [owner]);
});

test('apply planner accepts and validates the pinned artifact manifest CLI input', () => {
  const args = parseArgs(['--request', 'request.json', '--pinned-artifact-manifest', 'manifest.json', '--apply']);
  assert.equal(args.pinnedArtifactManifest, 'manifest.json');
  assert.equal(args.apply, true);
  const manifest = loadPinnedArtifactManifest('data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json');
  assert.equal(manifest.verified, true);
  assert.equal(manifest.items.length, 30);
});
