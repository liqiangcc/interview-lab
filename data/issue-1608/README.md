# Issue #1608 boundary-review freeze

This directory is the scope-bounded, plan-only handoff for sub-issue #1608.

- Repository: `liqiangcc/interview-lab`
- Exact enumerated interval: issues `#766`–`#1138` (373 issue numbers read)
- Live selected set: 248 open issues carrying `type:source-note`, `status:captured`, and `boundary:pending`; 125 interval issues are no longer pending
- Pinned Source ref: `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`
- Second-round semantic review results: 94 `single-interview`, 0 `multi-interview`, 8 `not-interview`, and 146 blocked
- Live evidence comments created: 0
- GitHub body/label mutations: 0

`selection.json` binds every current selected issue to its live-read body SHA, SourceNote identity,
SourceRevision, exact `source_projection` blob SHA, and complete fixed-ref `html`, `json`, and
`note_desc` artifact metadata (byte length, content SHA, and Git blob SHA). Each item has one
independent evidence JSON file and one request-intent file. The request intents
are not transition comments: each explicitly records `comment_id: null` and is
`staged-awaiting-independent-live-evidence-comment` or blocked. The controller
must independently review and create any durable evidence comment before any
transition is considered executable.

`dry-run-plan.json`, `apply-journal.json`, and `audit.json` are digest-bound
records of the no-apply run. `boundary-batch.json` lists only the 94 decided intents
and has `mutation_allowed: false`; it is not an authorization to apply. Every decided single
evidence set contains a JSON title pointer plus independent `note_desc` event/Q&A line locators.
Multi-case candidates #782, #849, and #972 remain blocked because their cases cannot each be
independently located with substantive process detail.

The parent dependency is pinned to parent #1605's read-only inventory from
commit `62aa7258d9931e6453329af2586b9a1390e8e3c5`. It records the parent
canonical snapshot digest, ownership digest, count 1397, and the four
pairwise-disjoint batch partitions. The local validator fails if this
dependency metadata or the #1608 partition count drifts.

The parent live progress recorded for this run is 419 completed boundary rows
and 978 remaining pending rows. The existing authorization manifest/plan is
explicitly frozen to 419 rows and is not applicable to these 248 new rows;
this branch performs no live transition.

The live issue snapshot was captured for exactly #766-#1138 at
`2026-09-08T06:00:00.000Z`; its SHA is recorded in `selection.json` and the
capture helper is `scripts/capture-issue-1608-live-snapshot.js`.

Source text retrieval first reuses a non-empty `/tmp/xhs-note-desc-cache/<external_id>.txt`
when its byte length and Git blob SHA independently match the pinned artifact. Cache
misses use the frozen source snapshot; a cache mismatch or network error fails closed. The
read-only helper `scripts/capture-issue-1608-source-artifacts.js` independently reads all three
fixed-ref artifacts for the selected 248 rows; the resulting local capture is digest-bound in
the review run but is not a Raw/Derived rewrite.

Re-run the offline artifact check with:

```sh
npm run validate:issue-1608-boundary
```

To regenerate from a frozen read snapshot, pass the same fixed timestamp and
the exact issue/source snapshot files to `prepare-issue-1608-boundary.js`.
