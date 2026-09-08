# Issue #1605 remaining boundary transition

This runner covers only the remaining 978 rows after the approved 419-row
completion manifest. It binds the approved 1397-row pending snapshot
(`5bbf8de3dc61ed382ee31e0d0286c3e7374efec243f60b245c76ee2e0b553dfd`), the
fixed `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437` source ref, and
the remaining manifest (`fea78669500c0986eff96b67b7e2d35afdf46355bc7caa9b862116eca40b4ba9`, scope
`6ef4fa26e838fe8c30d571c08807c09d5a3280eb40aa4af57d679274f6a131a1`).

The audit plan is expected to contain exactly 557 actionable rows and 421
blocked rows. #735 remains blocked because its multi-interview evidence does
not contain enough independent cases. That row is recorded in
`blocked_errors` and does not make otherwise-ready actionable rows fail; the
557-row apply set remains independently gated. Missing or malformed
`remaining-boundary-evidence-plan` / formal transition request markers keep a
row out of the transition-ready set and keep the batch fail-closed.

Run the default plan-only command with:

```text
npm run plan:issue-1605-remaining-boundary-transition
```

The command writes a new transition plan and durable journal. The default
mode does not PATCH issues or POST comments. A missing evidence-plan file is
derived in memory from the read-only coordinator; it is never silently treated
as an authorization. The formal request directory is still an explicit input.

The apply path is separately guarded by `--apply`, `--confirm-plan`, a parent
authorization proof, and `--max-mutations` no greater than the proof ceiling.
It is intended for a future authorized invocation; this PR only exercises it
with injected simulated PATCH/POST writers in unit tests and performs no live
apply.

For a future separately authorized stage, every request must pass the existing
`parseSourceNoteBoundaryReviewTransition` and
`planSourceNoteBoundaryReviewTransition` paths. That stage must GET the issue
and all comments with a short terminal page, compare body/labels/SourceRevision
CAS, validate the post-write SourceNote, and reconcile an unknown PATCH/POST
response by reads only. PATCH and POST are never retried. The apply-shaped
guards require explicit apply/confirmation, parent authorization, a positive
max-mutation ceiling, an exclusive lock, and durable journal validation.
