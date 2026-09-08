# Issue 1605：boundary 迁移后的全量 InterviewNote materialization plan-only

`scripts/plan-issue-1605-interview-note-materialization.js` 是 boundary migration 后的只读 materialization planner。它接受一个或多个 boundary transition report，以及同一 SourceRevision 的 live SourceNote snapshot；输出 `issue-1605-interview-note-materialization-plan.v1` 和 `dry_run_sha256`。

## Gate

每一行必须有可校验的 report digest、SourceNote body SHA、SourceRevision id、boundary decision 和 transition id。只有行级状态为 `already_applied` 或 `applied` 时，planner 才会从 live SourceNote 重新派生身份；`not-applied`、`pending`、`review-required`、`blocked` 等状态全部输出 `boundary-transition-not-live-applied` 或 `boundary-transition-blocked`，不会产生 InterviewNote identity 或 mutation candidate。当前 #1605 的 #1606–#1609 仍是 plan-only，因此真实运行应明确 blocked。

## Identity and ownership

- single case identity 是 `xhs:<external_id>`，由 live SourceNote 派生；调用方不能注入 `interview_note_id`。
- multi case identity 使用 `childInterviewNoteId(source, case_key)` 派生，并验证 case key、SourceNote 声明和 report identity 完全一致。
- 所有 report 行先做全局 SourceNote identity 和 InterviewNote identity 去重，再检查 GitHub exact marker ownership；多 owner、ownership search error、stale body/revision/label 都 fail-closed。
- `not-interview` 只可得到 `skip-not-interview`，或在已有 owner 时 blocked；它永远不会被当作 InterviewNote 创建。

## Invocation

```sh
npm run plan:issue-1605-materialization -- \
  --boundary-report data/issue-1606/boundary.final.json \
  --boundary-report data/issue-1607/boundary.final.json \
  --boundary-report data/issue-1608/boundary.final.json \
  --boundary-report data/issue-1609/boundary.final.json \
  --output data/pilot/issue-1605/materialization.dry-run.json
```

默认从 GitHub 只读获取 `type:source-note` Issues，并对每个待 materialize identity 做 exact ownership search；搜索间隔至少 2100ms。测试或受控复核可以用 `--source-notes-file`、`--ownership-file` 和 `--receipts-file` 提供带完整性证明的离线 snapshot。命令拒绝 `--apply`、`--max-mutations` 等 apply 参数，也不调用 PATCH/POST；后续 apply 若获授权，必须由独立 runner 重新执行 live CAS/idempotency gate。
