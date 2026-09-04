# XHS 全量 Issue 迁移

## 状态

当前阶段从 Pilot 迁移切换为 XHS 全量 intake。

固定 Source snapshot：

```text
liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437
```

## 目标

`liqiangcc/xhs/note_json/*.json` 中每个稳定 `note_id` 都建立一个可审计的 GitHub Issue intake identity：

```text
xhs:<note_id>
```

全量迁移的首要目标是建立 Source inventory，不是在创建时就证明每条来源都是可学习的单次真实面试事件。

因此：

```text
XHS note
↓
InterviewNote intake Issue
↓
status:captured
↓
后续 Source / boundary review
↓
source-ready 或 blocked
```

## Issue 创建顺序

本轮 Issue **创建顺序只使用来源发布时间**：

```text
source_published_at ASC
↓
同一发布时间使用 note_id ASC 作为稳定 tie-breaker
↓
发布时间 unknown 的记录放在最后
```

也就是最早发布的来源先创建，后发布的来源后创建。

这只是 migration / Issue-number ordering，不改变领域时间线：

```text
Issue number
≠ interview_occurred_at
```

后续做真实面试时间研究时，仍然使用独立的 `interview_occurred_at`；不得从 Issue number 反推面试发生时间。

## Existing Issue

Stable identity 是唯一幂等键：

```text
interview_note_id = xhs:<note_id>
```

如果仓库里已经存在相同 machine marker：

```text
existing-preserved
```

不重新创建、不覆盖 Pilot 已经完成的 SourceRevision / Context / labels / title / Exploration history。

因此现有少量 Pilot Issue number 不保证满足全量发布时间顺序；本轮新增 Issue 在它们之后按 `source_published_at ASC` 创建。这是保持 identity 与历史不被改写的必然结果。

## Intake Issue 内容

初始迁移登记：

```text
stable InterviewNote identity
source_published_at
source_edited_at
fixed XHS source commit
Raw HTML / image reference / available image blobs
note_json / note_desc source projection
known limitations
Derived links
```

但：

```text
interview_occurred_at = unknown
```

除非后续 Source review 实际找到明确证据。

不得在批量 intake 时根据标题、来源发布时间、秋招届次、OCR 或历史 structured/tagged 数据猜测真实面试时间。

## 全量不等于 source-ready

本次要求“全量迁移”意味着所有 XHS note 都要建立 intake Issue，而不是只有 Pilot 认定为普通单次面试的样本才创建。

边界样本也创建 Issue，但只停留在 `captured`，等待后续 boundary review。

只有满足既有 Source gate 后才允许：

```text
captured
→ source-review
→ source-ready
→ InterviewContext
→ Learning Discovery Labels
→ 学习池
```

所以：

```text
Issue 存在
≠
已经是可学习 InterviewNote
```

## Non-spoiler title

初始批量 Issue title 不使用 Raw title，而使用：

```text
[XHS] YYYY-MM-DD · <note_id 前 8 位>
```

发布时间未知时：

```text
[XHS] 发布时间未知 · <note_id 前 8 位>
```

Raw title 原样保存在 Issue Source body 中。这样 Issue 列表不会因为“凉经 / 挂 / offer”等原始标题提前剧透 Outcome。

## 执行 Gate

正式 apply 前必须 dry-run：

```text
固定 XHS commit
↓
扫描全部 note_json
↓
解析 source_published_at
↓
生成全部 Issue projection
↓
逐条运行 InterviewNote Issue validator
↓
读取已有 Issue stable marker
↓
输出：total / existing / to_create / earliest / latest
↓
preflight 全 PASS 才允许生成 apply 计划；apply 完成后，必须重新读取 live inventory，并以 final gate dry-run 验收，不能把“missing identity 已进入计划”当成“最终已完成”。
```

真实 dry-run `33753646023` 已确认：

```text
total_candidates      1459
known_published_at     1412
unknown_published_at     47
existing_preserved        4
to_create              1455

2022-04-12T19:39:03+08:00
→
2025-12-19T16:54:37+08:00
```

## Scale-safe apply

1455 条 Issue 不使用单条 REST 循环硬写。

Apply 使用 GraphQL 顶层 mutation alias 批量创建：

```text
按 source_published_at 已排序 projections
↓
每批 8 条
↓
同一 mutation 内按 alias 顺序执行 createIssue
↓
批次之间节流
↓
每批完成后立即持久化 report
```

因此创建顺序仍然与 migration plan 一致。

如果 GitHub API 中途限流或失败：

```text
已创建 Issue 保留
↓
report 记录 created_this_run / remaining_after_run / failure
↓
重新执行 apply
↓
再次读取全部 stable marker
↓
existing-preserved
↓
只创建剩余 identity
```

不通过重试创建 duplicate。

## migration:xhs-bulk

批量 intake Issue 临时携带：

```text
migration:xhs-bulk
```

它只表示：

> 该 Issue 来自已经逐条通过 batch preflight 的 XHS 全量 intake。

它不是 Source / Knowledge / Learning fact。

批量创建前，1459 个 projection 已经调用与普通 Issue live workflow 相同的 InterviewNote validator。因此在 `opened` 事件上，如果 Issue 仍带 `migration:xhs-bulk`，live validator job 会 skip，避免为 1455 条完全相同的已预检内容重复占用 runner。

进入某篇 Source review 前必须先：

```text
remove migration:xhs-bulk
↓
unlabeled event
↓
普通 InterviewNote live validator 恢复
↓
再推进 source-review
```

因此 bulk skip 只存在于 intake 写入瞬间，不降低后续 Source 治理强度。

## Workflow

执行 workflow：

```text
.github/workflows/full-xhs-migration.yml
```

触发策略：

```text
ops/full-xhs-migration-*
+
ops/full-xhs-migration.dry-run
```

只做 dry-run。

增加：

```text
ops/full-xhs-migration.apply
```

才执行真实 Issue 创建。

## 核心不变量

```text
全量 Source inventory，不全量提升 source-ready。
创建顺序由 source_published_at 决定。
Issue number 不承担真实面试时间语义。
Existing identity 永远 preserve，不为排序重建。
Raw / Source projection / Derived 继续分层。
Bulk intake 不猜 interview_occurred_at。
Outcome 不进入初始 Issue display title。
Bulk label 只优化 intake execution，不改变领域语义。
迁移可恢复、重复执行不得创建 duplicate。
```
