# Issue #1608 boundary-review freeze

This directory is the scope-bounded, plan-only handoff for sub-issue #1608.

- Repository: `liqiangcc/interview-lab`
- Exact enumerated interval: issues `#766`–`#1138` (373 issue numbers read)
- Frozen selected set: 337 open issues carrying `type:source-note`, `status:captured`, and `boundary:pending`
- Pinned Source ref: `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`
- Results: 234 `single-interview`, 6 `multi-interview`, 54 `not-interview`, and 43 blocked
- Live evidence comments created: 0
- GitHub body/label mutations: 0

`selection.json` binds every selected issue to its body SHA, SourceNote identity,
SourceRevision, and exact `source_projection` blob SHA. Each item has one
independent evidence JSON file and one request-intent file. The request intents
are not transition comments: each explicitly records `comment_id: null` and is
`staged-awaiting-independent-live-evidence-comment` or blocked. The controller
must independently review and create any durable evidence comment before any
transition is considered executable.

`dry-run-plan.json`, `apply-journal.json`, and `audit.json` are digest-bound
records of the no-apply run. `boundary-batch.json` lists only the 294 decided
intents and has `mutation_allowed: false`; it is not an authorization to apply.

Re-run the offline artifact check with:

```sh
npm run validate:issue-1608-boundary
```

To regenerate from a frozen read snapshot, pass the same fixed timestamp and
the exact issue/source snapshot files to `prepare-issue-1608-boundary.js`.
