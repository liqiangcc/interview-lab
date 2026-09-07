# InterviewContext 批量审核与学习发现投影

## 目的

本流程把已经完成 Source Review 的 `InterviewNote` 逐条投影为 reviewed `InterviewContext`，再同步 non-spoiler title 与 Learning Discovery Labels。`InterviewContext` 属于 Derived；SourceNote 不是 InterviewNote，也不能作为本流程输入。

## 依赖 gate

`#923` 的 Pilot request 必须声明并通过 `#917`、`#920`、`#921`、`#922` 四个依赖。四个 Issue 都必须是 closed；任一依赖未完成时 planner 只输出 blocked report，不读取或写入候选，不允许 `--apply`。

Pilot request 的 `pilot_size` 最大为 50；#923 首批 request 应为恰好 50 条。每一条必须绑定 InterviewNote Issue number、body SHA-256、reviewed `InterviewContext`，以及已提交到 Git 的 Context artifact `{path, ref, commit, sha256}`。`commit` 是不可变权威，Context 内容始终从 pinned commit 读取；`ref` 只需存在且通过 compare/ancestry 证明包含该 commit，不能要求 ref 永久停留在 receipt 写入时的 tip。四个依赖的 live Issue state、结构化 acceptance anchor 和 `acceptance_evidence` final comment 都必须逐一读取并严格匹配；closed 本身不是 acceptance proof。

学习子批次可以声明 `fixed_inventory_issue_numbers` 和 `audit_only_issue_numbers`。Issue #1598 固定为 50 个 source-ready Issue（#3、#4、#915、#1509–#1538、#1558、#1559、#1562–#1576），其中 #3/#4/#915 只能审计现有 Context/receipt；它们缺失或漂移时整批 fail closed，不能执行 receipt repair。#1598 另以 `completion_dependencies` 绑定 #1539/#1577 的关闭证据、返回 comment id、body digest 与必要文本，避免把 closed 状态当作完成证明。

## 输入与计算边界

request 以如下 marker 包裹 JSON：

```text
<!-- interview-context-batch-review
{ ... }
-->
```

每条 Context 必须通过 `interview-context.v1` validator，且：

- `context.interview_note_id` 必须等于 live InterviewNote marker/record identity；
- `context.source_revision_id` 必须等于 live InterviewNote 的 SourceRevision；
- live Issue 必须能通过 InterviewNote validator 并带有 `status:source-ready`；
- source publication year 只能从 live InterviewNote record 的 Raw-preserving `source_published_at` 计算；
- interview year 只能从 reviewed Context 的 `interview_occurred_at` 计算；`month_day` 和 `unknown` 不生成年份标签；
- `unknown` 保持原样且不生成对应 discovery label；
- title 只使用 Context 字段，并拒绝 outcome 词；Context 不得包含 result/outcome 等字段。

request 不允许指定 InterviewNote identity、SourceNote identity、标题或标签作为事实来源。所有标签都会从当前 live labels 去掉旧 discovery family 后重新计算，保留 workflow/source/quality 等其他 labels。

## Dry-run、apply 与恢复

默认只做 dry-run；live inventory 只请求 `type:interview-note` label，显式分页并验证每页结果没有越过 label 边界：

```bash
node scripts/plan-interview-context-learning-discovery.js --inventory
```

批量 planner 默认只做 dry-run：

```bash
node scripts/plan-interview-context-learning-discovery.js \
  --request <request.md> --max-items 50
```

报告必须给出 `ready_count`、`unknown_count`、`unknown_item_count`、`needs_review_count`、`already_applied_count`、`proposed_mutation_count` 与 `mutation_count`。存在需复核项时，`mutation_count` 固定为 0；任何 candidate 失败都会使整批 apply fail-closed。

学习标签必须先通过受控 taxonomy 预检。`config/issue-labels.json` 的 `company.managed_values` 是允许的 company label 闭集；`scripts/lib/issue-label-taxonomy.js` 会校验 projection 中的 discovery labels，并将 live repository label catalog 显式分页读取。报告中的 `label_preflight` 必须列出 `required`、`existing`、`missing`、`unknown` 和 catalog digest。缺失或未知 label 时 planner 仍可输出 plan-only 投影，但 apply 必须 fail-closed；planner 不会隐式创建 label。经独立复核后，管理员只能通过受控的 `scripts/reconcile-labels.sh` / taxonomy provisioning 流程补齐并验证这些 label，再重新 dry-run。`PATCH` 响应必须返回并完整匹配目标 labels；缺字段、静默丢 label 或 live re-read 不收敛都会停止批次。

固定 inventory 先用 GitHub 原生 `label=type:interview-note` 显式分页读取，并要求 live `status:source-ready` 集合与 request 完全相等；不扫描未筛选的全库 body，也不把 blocked/captured SourceNote 纳入候选。审计-only 条目必须已有匹配 receipt、artifact 和收敛 projection；新条目才可在 plan 中形成 mutation proposal。Context artifact 在 mutation 前必须已经存在于可解析 Git commit/ref，planner 通过 pinned commit 读取内容并校验 digest。

apply 必须显式确认本次原生 dry-run digest 和 mutation 上限；`--apply` 单独使用会 fail closed：

```bash
node scripts/plan-interview-context-learning-discovery.js \
  --request <request.md> --max-items 50 \
  --apply --confirm-dry-run-digest <dry_run_digest> --max-mutations <n>
```

apply 前会重新读取依赖、四个 acceptance evidence、Issues、receipts 和全部 Git Context artifacts，并要求 re-check digest 与已确认 dry-run 完全一致；同时先以原子写入、fsync、rename 持久化逐项 apply intent/progress journal，启动时校验 batch、Issue、body/context/artifact/title/labels 映射。apply 进程还必须独占 progress lock；已有（包括 stale）lock 一律 fail closed，只有持有者在 `finally` 中释放。GitHub Issue GET 的 ETag 仅用于读取诊断；GitHub REST 官方未保证 unsafe method 的 conditional request，当前 Issue PATCH 没有受支持的 atomic precondition，因此只要 plan 含有 PATCH mutation，apply 在任何 candidate mutation 前整体 fail closed。脚本不会在 apply 中写本地 Context 文件：Context 必须在 mutation 前已经存在于可解析的 Git commit/ref，receipt 同时记录 artifact path/ref/commit/digest。保留的 mutation 调用使用 `gh api --include`，HTTP 4xx/5xx 的 status、response body 与 GitHub request id 进入 durable failed error，且 mutation 不自动重试。每一条恢复重读路径都必须按 request 的 `audit_only_issue_numbers` 重新计算 scope；历史批次 receipt 不得因重读丢失 audit-only 语义而被误判为冲突或 repair。#3/#4/#915 的历史 receipt 只能在 receipt、artifact 与 projection 全部收敛时报告 `already_applied`，否则保持 fail closed。重跑同一 request 会先 live recheck 已成功项并跳过；failed 项只有 live 已明确收敛才能转 complete，不能盲目重发不确定 mutation。receipt 存在但 artifact 缺失/冲突、ref 不存在或 diverged、多 receipt 或 marker 冲突均 fail closed。

保留的 mutation 请求使用显式 JSON headers 并请求 `gh api --include`；HTTP 4xx/5xx 的 status、response body 与 GitHub request id 必须进入 durable failed error，mutation 不得自动重试。由于当前 Issue PATCH 没有受支持的 atomic precondition，任何需要 PATCH 的 plan 都在首个 candidate mutation 前整体 fail closed。脚本不会修改 Raw Source、SourceNote body 或 InterviewNote machine record。Crash 后可用同一 request 重跑；body 漂移、identity/revision 漂移、依赖回退、validator 失败或 receipt 冲突都会停止，不自动猜测或覆盖。

## 学习发现语义

只有 `status:source-ready` 且 Context `reviewed` 的 InterviewNote 才可进入 discovery。输出的 title 不复制 Raw title；Outcome 始终保持 `sealed-until-source-reveal`。`source-year:*` 与 `interview-year:*` 是不同事实，不能互相替代。
