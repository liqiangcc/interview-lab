# Issue #1577 Source Review transition

This workflow is scoped only to InterviewNote Issues #1558, #1559, and
#1562--#1576. It is a separate lifecycle runner from the Issue #1539
30-item transition runner; it never imports or invokes that runner.

The evidence phase is a prerequisite, not a lifecycle mutation. The transition
runner consumes the successful #1577 evidence plan and its formal requests,
then performs a fresh read of every SourceNote and InterviewNote before any
label write. The independent evidence marker must occur exactly once and must
match the request's body SHAs, SourceRevision, pinned manifest, evidence
subject hash, packet-set digest, and review comment locator. Boundary Review
evidence is never accepted as Source Review evidence.

## Lifecycle

Each target follows two explicit controlled-label stages:

```text
status:captured
  -> status:source-review + task:source-review
  -> status:source-ready
```

Only `status:*`, `task:source-review`, and `task:source-recovery` are
controlled by the runner. The final projection removes all old status/task
labels and keeps every non-lifecycle label, including learning labels. Issue
body, SourceNote, Raw artifacts, and derived content are never written.

## Plan and apply

Plan-only is the default and performs read-only live GETs for all 17 targets:

```text
npm run plan:issue-1577-source-review-transition
```

The generated plan has a transition-specific `plan_sha256` and
`authorization_sha256`; neither is interchangeable with the evidence plan
digest. Apply requires a newly reviewed plan digest, the transition
authorization digest, an exclusive progress lock, and an explicit `--apply`.

Before every individual label operation, the runner persists a pending intent,
re-reads the target, and verifies the recorded body/label CAS prefix. Writes
use only deterministic add/remove operations for controlled labels. After each
write it re-reads and checks convergence and preservation of non-lifecycle
labels. A response loss is reconciled with bounded read-only GETs; it never
causes a blind retry.

The same protocol applies to the final transition receipt. A pending receipt
is recoverable only from an exact live receipt. Local progress and receipt files
are written atomically. Any missing or ambiguous receipt, lost lock, body or
SourceRevision drift, duplicate/missing evidence marker, ownership change, or
non-legal label prefix fails closed and leaves a resumable/uncertain intent.

## Completion audit

Completion requires all 17 targets to have `status:source-ready`, exactly one
matching independent evidence marker, exactly one matching transition receipt,
no `possibly_performed` or unresolved intent, and unchanged body/SourceNote/
artifact/non-lifecycle-label facts. A separate read-only repository inventory
must confirm the Issue #1577 acceptance count of 50 source-ready InterviewNotes.

No learning labels are generated here, and the runner does not close #1577
automatically.
