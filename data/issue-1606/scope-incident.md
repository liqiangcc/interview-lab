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
- At that time, no issues after `#393` were requested or read; the only
  out-of-scope read then known was the single accidental request for `#393`
  described above. A later controller correction records an additional
  broad-list read incident below.

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

## 2026-09-09 controller correction

Two exploratory REST list requests were started while rebuilding the live
pending snapshot: an unbounded `state=all` list and a label-filtered list. The
first response was an incomplete concatenated page stream; the second returned
978 matching Issues, of which 235 were in `#20–#392` and 743 were outside the
authorized A range. No record from either list was used in the regenerated
selection, inventory, evidence, request, plan, journal, or digest. These reads
are retained here as an audit incident; the overall session therefore cannot
claim zero out-of-scope reads.

The authoritative replacement snapshot uses only 235 exact per-issue REST GETs
for the candidate numbers derived from the frozen A baseline minus the 92-row
intersection with the parent 419-row applied manifest. Its independent audit
records `out_of_scope_reads=0`; all subsequent artifacts are generated only
from those exact GET files and the pinned local Source projection cache.
