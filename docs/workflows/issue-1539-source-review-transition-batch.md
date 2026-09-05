# Issue #1539 Source Review transition batch

`apply-issue-1539-source-review-transition-batch.js` is the narrowly scoped
transition runner for the 30 formal requests in
`data/pilot/issue-1539/source-review-requests/issue-1509.json` through
`issue-1538.json`. It is separate from the evidence publisher and does not
accept arbitrary request files.

The runner is plan-only by default. It requires the fixed packet-set digest
`347c4019ab07e455e0a164bd1216cb26876a80c30788916295b7c1dc1beb52d2` and the
verified 30-item pinned artifact manifest digest
`4f40de87cc5b65f2ef0c93f25ca19235f7a9386db8811a12530b77374fce9b45`.
Every JSON request must have its matching Markdown marker, exact Issue number,
repository, blocked recovery mode, evidence identity, and pinned manifest
digest. The existing `planSourceReview` remains the source of lifecycle,
provenance, evidence, receipt, and live CAS semantics.

## Plan-only

```text
npm run plan:issue-1539-source-review-transition-batch
```

The report contains a reproducible `plan_sha256`. Plan-only performs the full
live read for all 30 items and does not patch labels or post receipts. If the
progress file already exists, plan-only reads and validates it and includes its
pending phase, operation index, intent digest, and observed prefix in the digest.
After a crash, re-run plan-only
first and authorize apply with that newly emitted recovery digest; the pre-crash
digest must not be reused.

## Apply gate

Apply requires an explicit `--apply` and the reviewed plan digest:

```text
node scripts/apply-issue-1539-source-review-transition-batch.js \
  --request-dir data/pilot/issue-1539/source-review-requests \
  --pinned-artifact-manifest data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json \
  --output data/pilot/issue-1539/source-review-transition.result.json \
  --progress data/pilot/issue-1539/source-review-transition.progress.json \
  --progress-lock data/pilot/issue-1539/source-review-transition.progress.json.lock \
  --confirm-plan-sha256 <reviewed-plan-sha256> \
  --min-mutation-interval-ms 1000 \
  --apply
```

Before the first write, apply acquires an exclusive lock and repeats the full
preflight. Each begin/final label write is preceded by a live body/labels CAS
check and a durable pending intent. The write is accepted only after the
expected state and labels are live. Receipt POSTs use the same pending intent;
if the response is lost, a live receipt re-read may recover it, but a missing
receipt makes the item uncertain and stops the batch without retrying.

Completed items require a matching live receipt and final labels. Re-entry
therefore skips both lifecycle writes and receipt POSTs. A failed item may be
resumed only when its durable progress is not uncertain and a fresh full
preflight passes. Any uncertain progress, malformed progress, label drift,
body drift, evidence drift, ownership drift, receipt conflict, or manifest
drift fails closed.

GitHub Issues `PATCH` is not used as a conditional write here. The REST API
documents conditional requests for reads and says unsafe-method conditional
requests are unsupported unless an endpoint specifically documents otherwise.
The runner therefore changes only the controlled `status:*`,
`task:source-review`, and `task:source-recovery` labels through a deterministic,
sorted add-then-remove operation plan. Before every sub-operation it durably
records the operation index, original/desired controlled sets, the CAS snapshot,
and the preserved uncontrolled-label baseline. It re-reads and checks the
recorded CAS before each operation and verifies afterward that unrelated labels
were preserved; any controlled-label conflict fails closed.

If a process stops after a pending begin/final sub-intent is durable, re-entry
first compares raw labels with the recorded operation prefixes. The desired
prefix advances the journal without another PATCH; the original before-set (or
the current operation's before-prefix) permits a safe retry. Any non-prefix or
loss of an uncontrolled label is marked uncertain. A pending receipt is
recoverable only when its complete matching receipt is already live; absent
that receipt, the runner refuses a possibly duplicate POST.

The legacy single-item CLI remains plan-capable, but refuses `--apply` for every
fixed-batch Issue #1509--#1538 request, regardless of recovery mode or status;
the batch runner is the only apply path for this set.

The runner only changes the explicitly requested InterviewNote lifecycle
labels and writes the corresponding applied receipt. It does not modify
SourceNote/Raw content, create InterviewContext, or mutate unrelated Issues.

## Legacy uncertain recovery

The first apply attempt can leave a legacy progress file with #1509 marked
`uncertain` even though GitHub later exposes the first legal label prefix. Do
not reuse the old batch plan digest for this state. The explicit local recovery
entry point binds the original complete plan artifact and digest
`ed3770529310da7ebb20873d580011b076c1fc278b277bf22a360eec12c6bab9`, verifies
that only #1509 is uncertain, all other items remain planned, #1509 has no
receipt, and its raw lifecycle labels are an original plan prefix. It emits a
`live_prefix_sha256` confirmation value and proposes a reproducible
`begin-pending` intent; plan mode does not write progress.

```text
node scripts/recover-issue-1539-legacy-uncertain.js \
  --request-dir data/pilot/issue-1539/source-review-requests \
  --plan data/pilot/issue-1539/source-review-transition.dry-run.json \
  --plan-sha256 ed3770529310da7ebb20873d580011b076c1fc278b277bf22a360eec12c6bab9 \
  --pinned-artifact-manifest data/pilot/issue-1539/recovery.dry-run.json.pinned-artifact-manifest.json \
  --progress data/pilot/issue-1539/source-review-transition.progress.json \
  --progress-lock data/pilot/issue-1539/source-review-transition.progress.json.lock
```

Only after reviewing that output may the operator use the same command with
`--confirm-live-prefix-sha256 <emitted-value> --apply`. This mode writes only
the local progress file under the exclusive lock; it never calls a GitHub
mutation endpoint. A wrong plan digest, issue, lifecycle prefix, receipt,
uncontrolled-label baseline, or peer progress state fails closed. The regular
batch runner then requires a fresh plan digest derived from the recovered
pending journal.

Each lifecycle add/delete operation now performs bounded convergence polling
with exponential backoff after the adapter call. A delayed GitHub label read
therefore causes additional reads rather than a duplicate operation. Only
exhausting the configured attempt/deadline budget marks the item uncertain,
and the complete pending sub-intent is retained inside that uncertain record.
