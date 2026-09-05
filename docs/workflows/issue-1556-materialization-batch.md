# Issue #1556 InterviewNote materialization batch

This runner is fixed to the 17 Boundary-reviewed SourceNotes in Issue #1539. It only materializes the source-faithful `xhs:<external-id>` InterviewNote projection; it does not set `source-ready`, run Source Review, add learning labels, or create InterviewContext.

The default mode is read-only plan:

```text
node scripts/apply-issue-1556-materialization-batch.js \
  --manifest data/pilot/issue-1539/boundary-expansion-candidates.json \
  --request-dir data/pilot/issue-1549/boundary-review-requests \
  --evidence-receipt-dir data/pilot/issue-1549/boundary-evidence-receipts \
  --transition-receipt-dir data/pilot/issue-1554/boundary-transition-receipts \
  --output data/pilot/issue-1556/materialization.plan.json \
  --progress data/pilot/issue-1556/materialization.progress.json \
  --materialization-request-dir data/pilot/issue-1556/requests \
  --materialization-receipt-dir data/pilot/issue-1556/receipts \
  --get-max-attempts 3 --get-backoff-ms 250
```

Apply is a separate, explicit operation. It requires the plan SHA and stable authorization SHA from a fresh plan, a real progress lock, and durable output directories:

```text
node scripts/apply-issue-1556-materialization-batch.js ... \
  --apply --progress-lock data/pilot/issue-1556/materialization.lock \
  --confirm-plan-sha256 <plan_sha256> \
  --confirm-authorization-sha256 <authorization_sha256>
```

The CLI re-plans with live SourceNote body/labels/revision, pinned artifact, and exact ownership gates before the core batch can mutate. Progress, materialization requests, and receipts use the core durable writer. GitHub GETs use the existing bounded transient-error retry helper; InterviewNote creation and SourceNote receipt comment POSTs are each attempted once. A lost POST response is reconciled by fresh ownership/receipt reads; it is never retried blindly. Any unresolved or conflicting state remains fail-closed.
