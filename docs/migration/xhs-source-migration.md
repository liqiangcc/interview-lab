# XHS 来源迁移协议

## 目的

本文定义如何把 `liqiangcc/xhs` 的历史材料迁入 Interview Lab，同时避免把“来源帖子”提前等同于“一次真实面试”。

迁移首先是证据保存和来源建档，不是 InterviewNote 判定，更不是知识清洗。

## 核心模型

```text
XHS note
↓
SourceNote
↓ Boundary Review
├─ 0 InterviewNote
├─ 1 InterviewNote
└─ N InterviewNote
```

review 发现的真实来源包括：题库、教程、模拟面试、多次面试经验总结、一帖多家公司，以及真正的单场面经。因此全量 intake 必须先落 SourceNote。

## Stable identity

来源 identity：

```text
source_note_id = xhs-note:<note_id>
```

新建 SourceNote 使用：

```text
<!-- source-note: id=xhs-note:<note_id> schema=source-note-issue.v1 -->
```

历史 Pilot #3/#4 已经在旧一对一模型下建立正式 InterviewNote identity，作为兼容历史保留；bulk reconciliation 不改写这些无 `migration:xhs-bulk` 的正式 InterviewNote。

## SourceNote 初始状态

```text
type:source-note
source:xhs
status:captured
boundary:pending
task:boundary-review
```

批量迁移期间额外携带：

```text
migration:xhs-bulk
```

`boundary:pending` 不得携带 InterviewNote 学习标签，也不得预声明 InterviewNote id。

## Boundary Review

结果：

```text
boundary:not-interview
boundary:single-interview
boundary:multi-interview
```

含义：

```text
not-interview
→ 题库 / 教程 / 模拟 / 泛经验等，不产生 InterviewNote

single-interview
→ 确认一个真实面试事件

multi-interview
→ 一帖包含多个可独立识别的真实面试事件
```

只有 boundary review 完成后，才进入 InterviewNote Source lifecycle、InterviewContext、Learning Discovery、SourceSequenceManifest 和 ExplorationSession。

## 旧 XHS 数据分层

### 第一手证据候选

```text
note_detail/*.html
downloaded_images/<note_id>/
note_images/*_urls.txt
```

`downloaded_images` 必须检查真实 byte size。路径存在但 `byte_size=0` 的文件必须记录：

```text
integrity: zero-byte
```

不能把它当作有效图片证据。

### Source projection

```text
note_json/*.json
note_desc/*.txt
```

Parser 生成文本不能冒充原始 bytes。

### Derived interpretation

```text
note_img_txt/*.txt
note_structured/*.json
note_tagged/*.json
data/questions/*
review/*
```

尤其 OCR 永远保持 Derived，必须能追溯到对应 Raw image。

## 时间模型

SourceNote 只登记来源时间：

```text
source_published_at
source_edited_at
```

`interview_occurred_at` 不属于 SourceNote intake。它只有在 boundary review 确认 InterviewNote 后，才由 InterviewNote / InterviewContext 按既有证据规则维护。

全量 SourceNote Issue 创建顺序按：

```text
source_published_at ASC
↓
unknown 发布时间统一放最后
```

Issue number 只是 intake 创建顺序的结果，不成为领域时间事实。

如果出现：

```text
source_edited_at < source_published_at
```

保持来源值不变，并记录：

```text
edited-before-published
```

不得静默修正。

## Intake anomaly

SourceNote 至少支持：

```text
zero-byte-artifacts
edited-before-published
```

anomaly 只表示采集/来源异常，不决定该 Source 是不是 InterviewNote。

## 幂等 reconciliation

正式工具：

```text
scripts/reconcile-xhs-source-notes.js
```

行为：

```text
已有 SourceNote
→ source-note-exists / skip

旧 bulk InterviewNote + migration:xhs-bulk
→ 保留 Issue number，原地转换 SourceNote

正式 InterviewNote，无 migration:xhs-bulk
→ protected-formal-interview-note

尚未迁移 XHS note
→ create-source-note
```

因此旧批次中断、重跑或在修复 PR 合并前继续产生少量 legacy bulk Issue，都不会要求删除历史 Issue。

## Apply 安全边界

默认运行仅生成 reconciliation plan/report，不写 GitHub。

写入必须显式使用：

```text
--apply
--max-mutations <N>
--pause-ms <milliseconds>
```

每次 apply 都重新扫描 live marker，不能靠“上次剩余 index”假设状态没有变化。

GitHub 的 content-creation secondary limit 必须遵守；遇到平台限流时停止并幂等续跑，不通过增加并发绕过。

每次 dry-run / apply report 都必须包含并核对固定 snapshot 的 inventory summary：

```text
total_candidates = 1459
unaccounted_source_id = 0
duplicate_source_note = 0
invalid_source_note = 0
invalid_interview_note_marker = 0
closed_pending_source_note = 0
closed_legacy_bulk = 0
```

`protected_formal_interview_note` 只作为保留证据统计；它的 SourceNote backfill 不能覆盖 formal `InterviewNote`。这里有两个不同层次的 gate，不能混称：

```text
preflight_gate
→ 允许 unaccounted_source_id 作为计划中的 create/backfill mutation
→ 允许可由 label-only 修复的 invalid_source_note
→ duplicate / unrepairable invalid / ownership conflict / closed legacy bulk / closed pending SourceNote / malformed InterviewNote marker 仍立即 fail closed

final_gate
→ 必须 unaccounted_source_id = 0
→ 必须 invalid_source_note = 0、duplicate_source_note = 0
→ 必须 mutation_candidates = 0 且 global_remaining_after_run = 0
→ 才能 final_dry_run_ready = true
```

因此，`preflight_gate = pass` 只表示计划可以安全生成，绝不表示 1459 条已经完成对账；missing candidate 的 create action 必须先执行，再用一次新的全量 dry-run 获得 `final_gate = pass`。报告只使用 `preflight_gate` 与 `final_gate` 两个明确字段，不再输出含义混淆的 `inventory_gate`。

SourceNote reconciliation 固定要求 `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437` 且扫描到的 `note_json` 总数必须为 `1459`；source ref 或数量不符时在任何 GitHub mutation 前 `source_gate = blocked`。`--max-mutations` 每批最多为 `100`。正常 POST 返回后只对返回的 Issue 做一次 direct GET，并校验完整 SourceNote identity/record；不对每一条 Issue 再做全量 issues scan。POST 异常或响应 identity 丢失时，当前批只允许用一次 inventory snapshot 恢复，恢复后停止批次以避免重复创建。批次成功完成后只做一次全局 inventory duplicate audit；任何 duplicate、invalid 或 identity 不一致都阻断批次完成。InterviewNote owner 的 marker schema、record schema/id 和完整 validator 也必须通过，v99、缺 record、多 marker 均计 invalid 并 fail closed。apply 运行会逐步持久化成功记录；report 使用明确的 `batch_remaining_after_run` / `global_remaining_after_run`，若第 N 条失败，`failure` 同时记录 `batch_remaining` / `global_remaining`，其中 global 数覆盖 `maxMutations` 批次之外的剩余 mutation。

## Fail-closed

以下任何一项都不能把 SourceNote 提升成 InterviewNote：

- 标题包含“面经”“一面”“二面”；
- hashtag 包含公司/岗位/校招；
- OCR 看起来像题目列表；
- Derived classifier 猜测为某公司面试；
- 来源发布时间与某招聘季一致。

这些只能成为 boundary review 的候选证据。

## 核心不变量

```text
一条来源帖子 ≠ 一次真实面试。
SourceNote 先于 InterviewNote。
Boundary Review 才决定 0..N InterviewNote。
Raw Source immutable。
Historical Derived 永远保持 Derived。
0-byte artifact 必须显式标记。
来源时间异常保留并记录，不静默修正。
迁移按 source_published_at 创建 Issue，但 Issue number 不是领域时间。
Migration / reconciliation 必须幂等。
正式 InterviewNote 不允许被 bulk reconciliation 改写。
```
