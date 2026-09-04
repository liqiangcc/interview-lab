# Issue #1539 Source Review evidence batch

`scripts/apply-issue-1539-source-review-evidence-batch.js` publishes the independent
Source Review marker for the 30 blocked recovery packets and writes the formal
transition request only after the marker is confirmed. It never changes lifecycle
labels or status.

The command is plan-only unless `--apply` is explicitly supplied:

```sh
npm run plan:issue-1539-evidence-batch
node scripts/apply-issue-1539-source-review-evidence-batch.js \
  --packet-set data/pilot/issue-1539/source-review-packets.json \
  --manifest data/pilot/issue-1539/plan-manifest.json \
  --report data/pilot/issue-1539/recovery.dry-run.json \
  --pinned-artifact-manifest data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json \
  --output data/pilot/issue-1539/evidence-apply.result.json \
  --progress data/pilot/issue-1539/evidence-apply.progress.json \
  --request-dir data/pilot/issue-1539/requests \
  --apply
```

Before a future authorized apply, the runner validates the packet-set digest,
manifest/report/pinned-manifest anchors, exact live InterviewNote and SourceNote
body SHAs, `status:blocked`, and `task:source-recovery`. Each evidence marker
also records the packet-set digest, complete source/interview facts, pinned
artifact facts, machine checks, and the independent evidence subject digest.

Per-item intent is persisted before POST. An exact marker is idempotently reused;
conflicts and multiple markers fail closed. If a POST response is lost, the live
comment inventory is used for recovery and a missing exact marker becomes an
uncertain intent that forbids retry. Formal requests are generated only after the
production `planSourceReview` dry-run succeeds and include `reviewed_at`,
`reviewer_kind: ai-assisted`, and the repository/Issue/comment evidence locator.

`--apply` also takes an exclusive progress lock (by default
`<progress>.lock`) before rereading progress or live evidence and holds it until
the complete batch result is durably written. The lock records a random owner
ID, PID, hostname, acquisition time, and file device/inode. Only a same-host
lock whose recorded PID is explicitly confirmed absent (`ESRCH`) may be
atomically quarantined. Foreign-host locks, malformed locks, and unknown PID
states fail closed and require explicit operator recovery; they are never
reclaimed from age or expiry. Release also requires the owner token and
device/inode to match.
