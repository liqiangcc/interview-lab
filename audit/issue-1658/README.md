# Issue 1658 read-only reconciliation audit

Audit date: 2026-09-10 (Asia/Shanghai)

This directory records the read-only audit that preceded any proposed live
reconciliation. It contains only audit evidence and conclusions. It does not
change SourceNote data, historical receipts, labels, the runner, or Issues.

## Scope and provenance

The bounded scope is the 13 eligible rows authorized by [#1611 comment
5602915668](https://github.com/liqiangcc/interview-lab/issues/1611#issuecomment-5602915668):

`1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458`

The authorization records `max_create=13`, `max_receipts=13`,
`plan_digest=294349d6dd0575ba4e78e82607f509b067ee0476def5ff1ea9adcd70d41e99ab`,
and `input_plan_digest=458311b1571a959fa0b83083cdfeb093608ee35c165a41b0d3ab26a363716dd4`.
The exact original input plan and any durable execution journal were not found
in the workspace or audit temp directory. The tracked
`data/pilot/issue-1658/materialization.runner.plan.json` is an older full plan
and is not substituted for the authorized plan.

The 13-row facts are in [13-reconcile.json](./13-reconcile.json). This is the
corrected parser output. An earlier temporary file that reported zero receipts
was excluded because it contained the superseded escaped-marker parse.

## 13-row conclusions

`Owner fact` means a live unique owner exists and its identity, projected body
SHA, title, and labels match. `Receipt fact` means exactly one live
materialization marker was parsed and its recorded source/owner fields were
captured. These facts do not by themselves prove historical execution.

`History` is `UNKNOWN` for every row because the original authorized plan and
durable journal are absent. `Current runner` is `FAIL` because the current
consumer does not accept the observed boundary/materialization binding. This
does not assert that the historical execution was invalid.

| SourceNote | Owner | Receipt marker | Owner fact | Receipt fact | History | Current runner | Row conclusion |
|---:|---:|---:|---|---|---|---|---|
| [1309](https://github.com/liqiangcc/interview-lab/issues/1309) | [1674](https://github.com/liqiangcc/interview-lab/issues/1674) | [5613888065](https://github.com/liqiangcc/interview-lab/issues/1309#issuecomment-5613888065) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1325](https://github.com/liqiangcc/interview-lab/issues/1325) | [1675](https://github.com/liqiangcc/interview-lab/issues/1675) | [5613892926](https://github.com/liqiangcc/interview-lab/issues/1325#issuecomment-5613892926) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1333](https://github.com/liqiangcc/interview-lab/issues/1333) | [1676](https://github.com/liqiangcc/interview-lab/issues/1333) | [5613896228](https://github.com/liqiangcc/interview-lab/issues/1333#issuecomment-5613896228) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1363](https://github.com/liqiangcc/interview-lab/issues/1363) | [1677](https://github.com/liqiangcc/interview-lab/issues/1677) | [5613898735](https://github.com/liqiangcc/interview-lab/issues/1363#issuecomment-5613898735) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1375](https://github.com/liqiangcc/interview-lab/issues/1375) | [1678](https://github.com/liqiangcc/interview-lab/issues/1678) | [5613903360](https://github.com/liqiangcc/interview-lab/issues/1375#issuecomment-5613903360) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1376](https://github.com/liqiangcc/interview-lab/issues/1376) | [1679](https://github.com/liqiangcc/interview-lab/issues/1679) | [5613905233](https://github.com/liqiangcc/interview-lab/issues/1376#issuecomment-5613905233) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1380](https://github.com/liqiangcc/interview-lab/issues/1380) | [1680](https://github.com/liqiangcc/interview-lab/issues/1680) | [5613908279](https://github.com/liqiangcc/interview-lab/issues/1380#issuecomment-5613908279) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1401](https://github.com/liqiangcc/interview-lab/issues/1401) | [1681](https://github.com/liqiangcc/interview-lab/issues/1681) | [5613911802](https://github.com/liqiangcc/interview-lab/issues/1401#issuecomment-5613911802) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1406](https://github.com/liqiangcc/interview-lab/issues/1406) | [1682](https://github.com/liqiangcc/interview-lab/issues/1682) | [5613915850](https://github.com/liqiangcc/interview-lab/issues/1406#issuecomment-5613915850) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1418](https://github.com/liqiangcc/interview-lab/issues/1418) | [1683](https://github.com/liqiangcc/interview-lab/issues/1683) | [5613920895](https://github.com/liqiangcc/interview-lab/issues/1418#issuecomment-5613920895) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1428](https://github.com/liqiangcc/interview-lab/issues/1428) | [1684](https://github.com/liqiangcc/interview-lab/issues/1428) | [5613923886](https://github.com/liqiangcc/interview-lab/issues/1428#issuecomment-5613923886) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1447](https://github.com/liqiangcc/interview-lab/issues/1447) | [1686](https://github.com/liqiangcc/interview-lab/issues/1686) | [5614172867](https://github.com/liqiangcc/interview-lab/issues/1447#issuecomment-5614172867) | PASS | PASS | UNKNOWN | FAIL | FAIL |
| [1458](https://github.com/liqiangcc/interview-lab/issues/1458) | [1687](https://github.com/liqiangcc/interview-lab/issues/1687) | [5614208444](https://github.com/liqiangcc/interview-lab/issues/1458#issuecomment-5614208444) | PASS | PASS | UNKNOWN | FAIL | FAIL |

The boundary applied receipt for each row is present as one parsed marker, but
contains `interview_note_ids=[]`. The current planner therefore reports a
boundary-evidence mismatch. The materialization marker for each row uses the
older `issue-1656-materialization-<source>` identifier and an older request
SHA. The identifier/request difference alone is not evidence that the old
execution was invalid; it only makes the record incompatible with the current
runner's request binding until lineage is established.

## Full read-only plan

The final full fetch recovered from a transient page-14 EOF: the command
retried and completed. The resulting artifact records 27 boundary-evidence
pages and 15 source pages, both ending with a short terminal page;
`ownership_search_errors=[]`. Pagination recovery is therefore `PASS` for the
captured artifact. The plan itself remains `ok=false` and is not an acceptance
record.

Current counts:

| Metric | Count |
|---|---:|
| SourceNote snapshot | 1460 |
| Unique owner issues | 65 |
| Candidate identities | 1099 |
| skip-not-interview | 247 |
| already-materialized | 47 |
| would-materialize | 789 |
| blocked | 424 |
| total errors | 28 |

Blocked reasons are `boundary-transition-not-live-applied=408`,
`materialization-preflight-failed=2`, and
`boundary-evidence-missing-or-ambiguous=14`.

The 28 errors are: #910 missing exact boundary evidence, #910 SourceRevision
ref drift, and for each of the 13 authorized rows one current matching
boundary-evidence error plus one `receipt interview_note_ids` mismatch. These
are current-consumer results, not retroactive claims about the execution-time
schema.

The plan has `mutation_performed=false`, with `patch=0`, `post=0`, and
`create=0`. Its `dry_run_sha256` is
`96bd8d719baf970cad498ce095c2212867753e60dc52a190af3e2b4d5de0d73a`.

## Missing durability and checks

No durable issue-1658 journal or lock was found, and no relevant materialization
runner/apply process was active at the audit end. Their absence makes the
historical completion proof `UNKNOWN`; it does not prove that no live action
occurred. The current runner consequently cannot safely resume or declare the
13 rows complete from local durability alone.

Commands used, all read-only:

```text
git status --short --branch
git branch --show-current
git log --oneline --decorate -n 12
git remote -v
git ls-remote origin
find ... -iname '*journal*' -o -iname '*lock*'
ps ...
node scripts/generate-issue-1611-interview-note-ownership-inventory.js --output <temp>/ownership.inventory.json
node scripts/plan-issue-1611-live-materialization.js --ownership-file <temp>/ownership.inventory.json --source-notes-output <temp>/source.snapshot.json --boundary-report-output <temp>/boundary.report.json --boundary-manifest-output <temp>/boundary.manifest.json --output <temp>/materialization.plan.json
sha256sum <audit artifacts>
```

Evidence artifact SHA-256 values:

```text
13-reconcile.json       be5d643a549345eb1ca26c72ba891076d24ff844dca32b428d78a20b8cb6c4cd
full-plan-summary.json  61de827e2298ea92d557286637d52bc710c988a0afd2d42340f721a51f34d3b3
```

## Remaining risks and next gate

The smallest next gate is a controller-reviewed reconciliation decision for
the existing 13 owner/receipt records. It must decide how to preserve the
historical receipt while establishing compatibility with the current
consumer. It must not create another owner or append a business receipt by
assumption. Any later live action remains limited to the exact 13-row scope
and requires fresh GET/CAS, a durable journal/lock, and a new acceptance audit.

This PR deliberately does not persist “batch complete” to #1658 or #1611,
because the historical plan/journal are `UNKNOWN` and the current plan is
blocked.
