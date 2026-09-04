# InterviewContext 批量审核与学习发现投影

## 目的

本流程把已经完成 Source Review 的 `InterviewNote` 逐条投影为 reviewed `InterviewContext`，再同步 non-spoiler title 与 Learning Discovery Labels。`InterviewContext` 属于 Derived；SourceNote 不是 InterviewNote，也不能作为本流程输入。

## 依赖 gate

`#923` 的 Pilot request 必须声明并通过 `#917`、`#920`、`#921`、`#922` 四个依赖。四个 Issue 都必须是 closed；任一依赖未完成时 planner 只输出 blocked report，不读取或写入候选，不允许 `--apply`。

Pilot request 的 `pilot_size` 最大为 50；#923 首批 request 应为恰好 50 条。每一条必须绑定 InterviewNote Issue number、body SHA-256、reviewed `InterviewContext`，以及已提交到 Git 的 Context artifact `{path, ref, commit, sha256}`。四个依赖的 live Issue state、结构化 acceptance anchor 和 `acceptance_evidence` final comment 都必须逐一读取并严格匹配；closed 本身不是 acceptance proof。

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

apply 必须显式确认本次原生 dry-run digest 和 mutation 上限；`--apply` 单独使用会 fail closed：

```bash
node scripts/plan-interview-context-learning-discovery.js \
  --request <request.md> --max-items 50 \
  --apply --confirm-dry-run-digest <dry_run_digest> --max-mutations <n>
```

apply 前会重新读取依赖、四个 acceptance evidence、Issues、receipts 和全部 Git Context artifacts，并要求 re-check digest 与已确认 dry-run 完全一致；成功后按默认 1 秒间隔更新 title/labels 并写 receipt。脚本不会在 apply 中写本地 Context 文件：Context 必须在 mutation 前已经存在于可解析的 Git commit/ref，receipt 同时记录 artifact path/ref/commit/digest。PATCH 或 receipt 响应丢失时，重跑同一 request 会通过 live projection、receipt 和 artifact 重读收敛；receipt 存在但 artifact 缺失/冲突、多 receipt 或 marker 冲突均 fail closed。

脚本不会修改 Raw Source、SourceNote body 或 InterviewNote machine record。Crash 后可用同一 request 重跑；body 漂移、identity/revision 漂移、依赖回退、validator 失败或 receipt 冲突都会停止，不自动猜测或覆盖。

## 学习发现语义

只有 `status:source-ready` 且 Context `reviewed` 的 InterviewNote 才可进入 discovery。输出的 title 不复制 Raw title；Outcome 始终保持 `sealed-until-source-reveal`。`source-year:*` 与 `interview-year:*` 是不同事实，不能互相替代。
