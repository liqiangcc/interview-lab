# Issue #1539 Boundary Review expansion

本批次是 Issue #1539 的下一阶段，只审计固定的 17 条 SourceNote：

```text
#158 #278 #361 #478 #649 #692 #843 #901 #937 #942 #946 #952 #987 #1121 #1168 #1221 #1301
```

输入 manifest 为 `data/pilot/issue-1539/boundary-expansion-candidates.json`。它不是运行结果，而是受版本控制的候选事实集合：每项绑定 SourceNote body SHA、SourceRevision、固定 `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`、SourceNote 的 `source_projection` text artifact、Git blob SHA 和可复核正文 anchor。运行时仍必须读取并验证 commit tree 的实际 path/blob 内容；不能只相信 manifest 顶层 digest。

## 只读 planner

默认且当前唯一启用的入口是：

```sh
node scripts/plan-issue-1539-boundary-expansion.js \
  --manifest data/pilot/issue-1539/boundary-expansion-candidates.json \
  --report /tmp/issue-1539-boundary-expansion.report.json
```

`--apply` 会 fail closed。此阶段不创建、修改或评论 GitHub Issue，不改 label/status，也不生成 InterviewContext 或任何标签。报告中的 `source_ready_claimed` 和 `mutation_count` 必须为 0。

每项 planner 必须同时通过：

1. live Issue 是 open 的 SourceNote，body SHA、SourceNote id、SourceRevision id/ref、`boundary:pending` 和 boundary-review labels 精确匹配；REST label object 会先规范化为名称。
2. SourceNote 的 `source_projection` artifact 与 manifest 的 path/ref、Git blob SHA 一致；读取 pinned blob 后重新计算 Git object SHA，并确认内容非空且包含 exact anchor。
3. repository-scoped ownership search 的候选 Issue 必须再次读取并解析 `interview-note` machine marker；SourceNote 自身的文字提及不算 owner。owner 必须为 0，重复或不完整搜索 fail closed。
4. 已有 Boundary receipt 必须可解析；冲突 receipt、body/revision 漂移和 malformed evidence 都阻断整个固定集合。

## 两阶段顺序

planner 只生成候选 Boundary Review request template（没有 `review_evidence.comment_id`，所以不可执行）和后续 materialization request（期望 `boundary:single-interview`，但当前 live pending，故不可执行）。必须先由独立审阅产生并验证 Boundary Review evidence，再复用现有 `source-note-boundary-review-batch` 的 request validator/CAS/receipt；Boundary Review 收敛后再复用现有 materialization planner 的 ownership/CAS/receipt。Materialization 完成后仍需独立 Source Review，不能由 Boundary Review 或 materialization 直接写成 `source-ready`。

未来授权 apply 必须沿用现有安全工具链：固定集合、全量 preflight、body/SourceRevision/controlled-label CAS、独占 lock、durable intent/journal、逐项 receipt、response-loss 恢复和 stale re-plan。任何不确定结果都保留 pending intent 并 fail closed；不得把部分成功猜成完成。

既有 #921 选择中，18 条已被判定为 not-interview，2 条为 multi-interview，#90/#92/#1115/#1452/#1460 仍因证据不足 blocked；已 source-ready 的 #3/#4/#915 与 #1509–#1538 不在本批次。题库/教程/营销汇总以及混合多个互不相干流程的记录不进入这 17 条固定集合。候选审计中 #782 被明确记录为歧义排除项：正文混合多个独立面试流程，当前不能证明 single-interview，因此不猜测、不进入本批。

## Boundary Review evidence packet（Issue #1549）

Evidence packet 是独立于 Source Review 的边界证据。入口默认 plan-only：

```sh
node scripts/apply-issue-1539-boundary-evidence-batch.js \
  --candidate-manifest data/pilot/issue-1539/boundary-expansion-candidates.json \
  --report /tmp/issue-1549-boundary-evidence.dry-run.json \
  --progress /tmp/issue-1549-boundary-evidence.progress.json
```

固定 packet set digest 由 17 个 packet 的不可变 SourceNote/body SHA、SourceRevision、canonical pinned artifact、single-interview rationale、全部 Boundary checks 和 `source_ready_gate.allowed=false` 计算。Evidence subject digest 不包含 comment id、comment locator 或 reviewed_at；正式 transition request 只有在 POST 后 live re-read 得到唯一精确 evidence marker 才生成。

未来 apply 必须显式 `--apply --confirm-dry-run <digest> --reviewed-at <timestamp>`，并提供 request/receipt/progress 路径。runner 先完成全量 live preflight，再在独占 lock 内持久化 pending intent、POST、live 恢复确认、写 formal Boundary Review request 和本地 receipt；response loss、冲突 marker、stale body/labels/SourceRevision 或 receipt mismatch 都 fail closed，绝不重复 POST。每次 apply 前都必须基于当前 progress/live 状态重新 plan；旧 digest 不得沿用。

GitHub 只读 GET 可使用 `--get-max-attempts`（默认 3，最大 3）和 `--get-backoff-ms`（默认 250ms）的确定性指数退避。只对明确的瞬态网络错误、HTTP 429 和 HTTP 5xx 重试；HTTP 4xx 及未知错误立即 fail closed。该策略覆盖 Issue、comments、pinned blob、ownership search 及 ownership Issue reread。`createEvidenceComment` 的 POST 不经过此策略，始终只尝试一次；POST/PATCH 都不自动重试，响应丢失只能依靠 fresh live reconcile 和 durable intent 恢复。

此任务不执行 apply。Evidence comment 只能支持 Boundary Review；它不创建 InterviewNote、不执行 materialization、不执行独立 Source Review、不生成 learning labels，也不将 SourceNote 标为 source-ready。
