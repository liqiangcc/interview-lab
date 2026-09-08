# Issue #1611 Aggregate downstream pipeline

本流程只负责把 #1606–#1610 已经产生的、可验证的上游 receipt 汇总成下游 plan。它不替 Boundary Review 做语义判断，也不把 Boundary evidence 当作 Source Review evidence。

固定输入：

```text
repository    = liqiangcc/interview-lab
parent issue  = #1605
aggregate     = #1611
source        = liqiangcc/xhs
source ref    = 95b77bb261048059846273688e4b90a2e108b437
```

固定 boundary 范围为 `#20–#392`、`#393–#765`、`#766–#1138`、`#1139–#1508`。manifest 必须逐批记录 report 路径、每条 SourceNote number、SourceNote identity 和 live body SHA；范围缺失、重叠、越界或 source ref 漂移都会 fail closed。

## 输入门禁

四个 boundary report 必须是 `source-note-boundary-review-batch.v1`，其自身 `dry_run_sha256` 必须可重算，且每条输入已经是 `already_applied`。Materialization report 必须是 `source-note-interview-materialization-batch.v1`，每个实际 child 必须已经是 `already-materialized`，并绑定：

```text
SourceNote body SHA
SourceNote identity
SourceRevision id
固定 XHS source ref
InterviewNote identity
唯一 InterviewNote Issue owner
```

#1610 必须同时给出 #1/#2 的明确 `source-ready` 或 `blocked` 终态。恢复失败只能保留 `blocked`，不能补造 Context 或标签。

## 独立 Source Review

聚合器为每个 materialized InterviewNote 生成一条 `aggregate-source-review-evidence-request.v1`，其中固定 SourceNote body SHA、SourceRevision、source ref、InterviewNote owner 和 `evidence_subject_sha256`。这是一条待审 evidence request，不是虚构的 review 结论。

只有存在独立的 `interview-note-source-review-applied.v1` receipt，且明确 `independent=true`、SourceNote body SHA / SourceRevision / source ref 精确匹配时，才能把该行作为 `source-ready` 下游输入。Boundary receipt、Boundary rationale 或其 digest 不能满足该门禁。没有 receipt 的行保持 pending，整批不产生 mutation。

## Context 与学习投影

Source Review 为 `source-ready` 后，必须再提供 reviewed `InterviewContext`、body-pinned live Issue snapshot、可重算 title 和完整 labels。Context 只能产生 title/labels/comment metadata mutation：

```text
Raw InterviewNote body SHA unchanged
                         ↓
reviewed InterviewContext → non-spoiler title + discovery labels
```

Unknown 不生成对应 label；`source-year` 只从 Source 的发布时间投影；`interview-year` 只从 Context 的实际面试时间投影；Outcome 保持 `sealed-until-source-reveal`。计划禁止出现 `body` / `next_body` 字段，防止 Derived 覆盖 Raw。

## Dry-run / apply

默认只读 plan：

```bash
node scripts/plan-aggregate-downstream-pipeline.js \
  --manifest data/pilot/issue-1611/aggregate-manifest.json \
  --output data/pilot/issue-1611/aggregate.dry-run.json
```

计划 digest 是 `canonical_digest`。计划必须记录逐条 selection、独立 evidence request、mutation 顺序、receipt 要求和 post-apply audit。缺任何 upstream receipt、body drift、duplicate ownership、missing artifact、missing required label 或不确定响应时，`mutation_count` 固定为 `0`。

live apply 需要同时具备主控提供的 `aggregate-downstream-apply-authorization.v1`、精确 `--confirm-plan-digest` 和 mutation 上限。授权文件必须明确 `parent_issue=1605`、`issue_number=1611`、`allow_live_github=true` 和授权人；没有它，`--apply` 在任何 GitHub PATCH/POST 前失败。当前子 issue 没有此授权，因此本轮只提交 planner、validator、fixture/test 和文档，不执行 apply。

授权后的命令还必须提供 durable journal：

```bash
node scripts/plan-aggregate-downstream-pipeline.js \
  --manifest data/pilot/issue-1611/aggregate-manifest.json \
  --output data/pilot/issue-1611/aggregate.dry-run.json \
  --apply --authorization-file data/pilot/issue-1611/authorization.json \
  --confirm-plan-digest <canonical_digest> \
  --max-mutations <N> \
  --journal data/pilot/issue-1611/aggregate.apply-journal.json
```

apply journal 的顺序固定为：观察 Source Review receipt → 立即重读 body SHA → metadata-only PATCH → 重读验证 Raw body/title/labels → POST 聚合 receipt → post-apply audit。POST 响应不确定时不得盲目重发；恢复必须先观察到匹配 receipt。
