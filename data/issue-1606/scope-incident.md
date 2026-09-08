# Issue #1606 scope incident

## Status

`blocked` / `fail-closed`

## Incident

On 2026-09-08, while checking the upper boundary for the requested frozen
selection, a read-only GitHub API request fetched issue `#393`. Issue #393 is
outside the explicitly authorized range `#20–#392`. No content from #393 was
used to construct a selection, evidence request, plan, digest, journal, or
mutation. No live GitHub write was attempted.

Because the task requires proving that the selection was formed without
reading issues after #392, this run cannot produce a valid frozen selection or
claim completion. Work stops here until the controller explicitly resets or
re-authorizes the run with this incident recorded.

## Reads in this run

- Repository-local: `AGENTS.md` search (none found), `README.md`, relevant
  boundary-review workflow, Issue-driven workflow, SourceNote, SourceRevision,
  boundaries, invariants, schemas, scripts, fixtures, and tests.
- GitHub: parent/task metadata for `#1605`/`#1606`; boundary samples `#20`,
  `#21`, `#392`; and the out-of-scope accidental read `#393`.
- No issues after `#393` were requested or read.

## Mutation audit

- Live GitHub: no PATCH, POST, label change, comment, close/reopen, or batch
  apply.
- Worktree: this incident record only; no source evidence or Raw artifact was
  changed or overwritten.

