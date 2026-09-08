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

固定 boundary 范围为 `#20–#392`、`#393–#765`、`#766–#1138`、`#1139–#1508`。旧四批输入必须逐批记录 report 路径、每条 SourceNote number、SourceNote identity 和 live body SHA；范围缺失、重叠、越界或 source ref 漂移都会 fail closed。基于最新 #1605 的 aggregate manifest 可以改用完整 `issue-1605-boundary-transition-report.v1` adapter；它必须覆盖完整 419 条已应用 transition，并由 boundary decision 派生出恰好 350 个 InterviewNote candidate。

manifest 还必须 pin 一个完整的 `aggregate-interview-note-ownership-inventory.v1`。该 inventory 覆盖仓库全库 InterviewNote Issue owner，以 `interview_note_id` 和 Issue number 双索引并带 canonical digest；父级 pending SourceNote ownership 只用于 SourceNote inventory，不能替代这个全库 owner inventory。

## 输入门禁

最新 #1605 materialization 规划使用 `issue-1605-interview-note-materialization-plan.v1` adapter。该产物必须以 canonical JSON（递归 key sort）重算 `dry_run_sha256`，明确 `plan-only`、`mutation_performed=false` 和 `{patch:0,post:0,create:0}`。350 个 candidate 的 union 必须与 boundary transition report 的 350 个 identity 完全相等；`would-materialize` / `would-repair-receipt` / blocked 行只进入 `pending-materialization` selection，不能冒充已 materialized、`source-ready`、reviewed Context 或 learning-ready。

`type:interview-note` owner inventory 是独立的全库分页 GET 快照，必须观察 `<100` 的短终止页、逐条验证 machine identity，并以 `aggregate-interview-note-ownership-inventory.v1` canonical digest 固定。pending SourceNote ownership 不能替代它。若 GitHub inventory GET 超时、返回非数组、分页达到上限仍无短页，inventory 和 aggregate 都 fail closed。

只读生成命令：

```bash
npm run inventory:issue-1611-interview-note-ownership -- \
  --output data/pilot/issue-1611/interview-note-ownership.inventory.json
```

该命令只使用 GitHub GET，不包含 apply 参数；输出必须作为 manifest 的 pinned ownership dependency，不能用即时 label 查询结果绕过 digest 或分页完整性。

四个 boundary report 按各批最终契约校验：A/D 仍可使用 `source-note-boundary-review-batch.v1` / `issue-1609-boundary-dry-run.v1`，B 使用实际的 `issue-1607-boundary-dry-run-plan.v1`，C 使用带完整报告 `dry_run_sha256` 的 `issue-1608-boundary-dry-run.v1`。这些 report 的 `dry_run_sha256` 必须按项目 canonical JSON（递归 key sort）对完整报告（去除 digest 字段）可重算，且每条输入已经是 `already_applied`。C 的 `issue-1608-boundary-batch.v1` 只有 selection/request 元数据、没有 report digest，不能作为 aggregate 输入；缺少 digest 的报告 fail closed，不会被当作已验证。若未来要消费该 schema，必须先生成包含完整 report 与 `dry_run_sha256` 的固定 adapter 产物并单独校验。Materialization report 必须是 `source-note-interview-materialization-batch.v1`，其 `dry_run_sha256` 使用同一 canonical 算法；Recovery 则按其 schema 的明确规则校验（例如 `issue-1610-recovery-dry-run.v1` 的 `plan_sha256` 覆盖 `digest_input`）。每个实际 child 必须已经是 `already-materialized`，并绑定：

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
  --lock data/pilot/issue-1611/aggregate.apply.lock \
  --journal data/pilot/issue-1611/aggregate.apply-journal.json
```

apply 会先在单 writer lock 下重新读取 live InterviewNote Issues 并 fresh re-plan，要求 canonical digest 与已授权 plan 完全一致；每项 PATCH 前再做 body/title/labels CAS。journal 必须记录 mutation ceiling、`mutation_attempted`、`mutation_performed`、`possibly_performed` 及 receipt reconcile 尝试。POST 响应不确定时只允许有限次、分页且有页数上限的 GET marker reconcile；找不到唯一匹配 marker 或 GET 状态未知即停止，禁止重发。stale/损坏/被替换的 lock 一律 fail closed；释放前复核 lock token 与 inode，TOCTOU 变化时不删除当前 lock。

## Future 350 Context / learning handoff

The future candidate handoff is executable through:

```bash
npm run plan:issue-1611-context-learning
```

It consumes the 419-row `issue-1605-boundary-transition-report.v1` plus the required complete `aggregate-interview-note-ownership-inventory.v1` snapshot at `data/pilot/issue-1611/interview-note-ownership-inventory.json`, and emits one plan row for each of the exact 350 InterviewNote identities. The inventory must carry a recomputable `canonical_digest`, unique `interview_note_id` and `issue_number` values, and bidirectional ownership is checked before any downstream stage. Each row carries the same ordered contract:

```text
materialization
  -> independent Source Review receipt
  -> reviewed InterviewContext with a body-pinned live Issue
  -> buildLearningDiscovery title and labels
```

The planner never invents an InterviewNote Issue number before materialization. It records `pending-materialization` and blocks the later three stages until a unique owner exists. For an `already-materialized` row, both `interview_note_id -> issue_number` and `issue_number -> interview_note_id` must match the full inventory; an outside or colliding Issue cannot satisfy the gate. Source Review must use `interview-note-source-review-applied.v1` with `independent=true`; Boundary Review evidence cannot be reused. Context must bind the InterviewNote identity, SourceRevision, and Raw body SHA, and must not contain `body`, `next_body`, `result`, or `outcome`. Only then may `buildLearningDiscovery` produce `company:*`, coarse `role:*`, `recruitment:*`, `round:*`, `source-year:*`, and proven `interview-year:*` labels; Unknown values produce no label and Outcome remains sealed.

The output schema is `schemas/issue-1611-context-learning-plan.schema.json`. `mode=plan-only`, `mutation_performed=false`, and `{patch:0,post:0,create:0}` are mandatory. Missing, incomplete, digest-drifted, or ownership-colliding inventory; missing materialization plan, Source Review receipt, Context, or body-pinned live snapshot are explicit blocked ledger entries; they are not treated as successful no-ops.
