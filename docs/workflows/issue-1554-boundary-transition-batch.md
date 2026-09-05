# Issue #1554 Boundary Review transition batch

This runner consumes the fixed 17 Boundary Review requests and #1549 evidence receipts. It only transitions an eligible SourceNote from `boundary:pending` to `boundary:single-interview`; it never creates an InterviewNote, sets `source-ready`, or adds learning labels.

The command is plan-only unless `--apply` is explicitly supplied:

```text
node scripts/apply-issue-1539-boundary-transition-batch.js \
  --candidate-manifest data/pilot/issue-1539/boundary-expansion-candidates.json \
  --request-dir data/pilot/issue-1549/boundary-review-requests \
  --evidence-receipt-dir data/pilot/issue-1549/boundary-evidence-receipts \
  --transition-receipt-dir data/pilot/issue-1554/boundary-transition-receipts \
  --output data/pilot/issue-1554/boundary-transition.dry-run.json \
  --progress data/pilot/issue-1554/boundary-transition.progress.json \
  --progress-lock data/pilot/issue-1554/boundary-transition.progress.json.lock
```

Apply requires the exact `plan_sha256` from a fresh plan:

```text
... --apply --confirm-plan-digest <plan_sha256>
```

Before planning/applying, every item is checked against the fixed packet digest, #1549 receipt, fresh SourceNote body/labels/state/SourceRevision, pinned blob and unique InterviewNote ownership. Apply holds an exclusive progress lock, durably records progress intents and receipts with fsync/rename, performs one guarded PATCH and one receipt POST per item, and reconciles live comments after response loss. GET operations use at most the configured bounded retry count; PATCH and POST are never automatically retried. A drift or uncertain result fails closed and requires a new plan/review.

Use `--min-mutation-interval-ms <N>` to require at least `N` milliseconds between every actual PATCH or receipt POST (the default is 1000). The throttle is invoked immediately before each mutation, including after the durable pending intent. If a PATCH reports an error, the runner performs one fresh live reconcile: a converged target continues to the receipt gate without repeating PATCH; a non-converged or unreadable state is recorded as uncertain and stops. A pre-PATCH gate/CAS drift is different: no mutation was attempted, so it is durably recorded as a resumable failed/planned item with `possibly_performed=false`; a fresh plan must be reviewed before resuming.

The Boundary receipt carries the existing planner’s derived identity fields only; it does not assert that an InterviewNote already exists. Ownership must remain empty, and this workflow does not materialize InterviewNotes.
