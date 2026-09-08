# Issue #1606 scope incident

## Status

`resolved by controller reset; incident retained`

## Incident

On 2026-09-08, while checking the upper boundary for the requested frozen
selection, a read-only GitHub API request fetched issue `#393`. Issue #393 is
outside the explicitly authorized range `#20–#392`. No content from #393 was
used to construct a selection, evidence request, plan, digest, journal, or
mutation. No live GitHub write was attempted.

The controller explicitly reset authorization on 2026-09-08 and confirmed
that the accidental read does not invalidate the A-batch selection. The
incident remains recorded, but the new selection/dry-run run starts from the
current live baseline and is still restricted to exact issue numbers
`#20–#392`; it does not use #393 content.

## Reads in this run

- Repository-local: `AGENTS.md` search (none found), `README.md`, relevant
  boundary-review workflow, Issue-driven workflow, SourceNote, SourceRevision,
  boundaries, invariants, schemas, scripts, fixtures, and tests.
- GitHub: parent/task metadata for `#1605`/`#1606`; boundary samples `#20`,
  `#21`, `#392`; and the out-of-scope accidental read `#393`.
- No issues after `#393` were requested or read; the only out-of-scope read was
  the single accidental request for `#393` described above.

## Mutation audit

- Live GitHub: no PATCH, POST, label change, comment, close/reopen, or batch
  apply.
- Worktree: the incident record is preserved; subsequent authorized work only
  added selection/evidence/dry-run artifacts and did not change or overwrite
  any Raw source artifact.

## Controller reset

The controller authorized continuation while retaining this audit record. The
continuation must not probe an upper-bound issue and must not read or modify
issues outside `#20–#392`.
