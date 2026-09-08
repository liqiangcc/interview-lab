# Issue #1605 next boundary coordinator

This coordinator prepares the remaining boundary-review scope after the completed
419-row pilot. It is a read-only planning workflow: it performs GitHub GETs and
explicit comments pagination, writes local checkpoints and manifests, and has no
PATCH or POST path.

## Fixed scope

The input is the committed frozen pending inventory of 1,397 SourceNote issues at
the fixed XHS ref
`95b77bb261048059846273688e4b90a2e108b437`. The coordinator validates the
snapshot canonical digest
`5bbf8de3dc61ed382ee31e0d0286c3e7374efec243f60b245c76ee2e0b553dfd` and the
committed 419-row manifest against its exact approved digests, then excludes its
issue IDs. The resulting scope must be exactly 978 issues:

| batch | child | frozen | remaining |
| --- | ---: | ---: | ---: |
| A | #1606 | 327 | 235 |
| B | #1607 | 367 | 257 |
| C | #1608 | 337 | 248 |
| D | #1609 | 366 | 238 |

The old manifest is recorded as an exclusion reference only. Its plan digest is
not copied into the next scope, and its authorization cannot authorize any
remaining issue.

## Read and checkpoint protocol

For each remaining issue, the runner does a live GET and reads comments with
`per_page=100&page=N` until it receives a short terminal page. Transient GET and
comments failures are retried at most five times with short exponential delays;
PATCH/POST are not retried because this coordinator never calls them. A final
read failure creates a complete `blocked` observation and a top-level manifest
error, so the plan cannot be reported as ready.

The audit binds the live issue number, body SHA, complete normalized labels,
SourceNote ID, SourceRevision ID and fixed source ref. It parses applied receipts
from comments and blocks rather than reusing an existing receipt or the completed
419-row authorization. Missing, changed, malformed, or ambiguous state is
fail-closed.

The read journal stores one state per issue (`pending`, `reading`, `audited`, or
`blocked`), bounded attempts, and the observation. It is persisted before and
after every item read, under an exclusive lock. Resume reuses only durable
`audited` observations; a retry-bound `reading` record becomes blocked. Journal,
lock, manifest, and batch plans use atomic JSON writes with file and parent
directory fsync. Lock ownership and inode are asserted before durable writes and
on release.

## Outputs

Run:

```sh
npm run plan:issue-1605-next-boundary
```

The command writes `next-boundary.manifest.json` and, for each A-D batch,
`evidence.plan.json`, `request.plan.json`, and `transition.plan.json`. Every
batch envelope contains all of its rows. Evidence and decisions remain null;
request plans have `request_count: 0`, and transition plans have
`mutation_count: 0` with no authorization. Thus blocked/read-failed rows and
rows awaiting independent review are both visible and resumable without
performing a live mutation. Any later transition requires a separately created,
independently reviewed request and explicit controller authorization.
