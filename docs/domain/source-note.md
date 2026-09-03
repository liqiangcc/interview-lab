# SourceNote：来源采集对象

## 为什么需要 SourceNote

全量 XHS review 证明：一条来源帖子不等于一次真实面试事件。

真实来源至少包含以下情况：

```text
题库 / 教程 / 模拟面试
→ 0 InterviewNote

单场真实面经
→ 1 InterviewNote

一篇汇总多家公司 / 多轮独立面试
→ N InterviewNote
```

因此来源采集和 InterviewNote identity 必须分离。

## 定义

`SourceNote` 表示“一条外部来源帖子在固定 Source snapshot 中的采集身份”。

XHS identity：

```text
source_note_id = xhs-note:<note_id>
```

它负责：

- 固定来源系统与 external id；
- 保存 `source_published_at` / `source_edited_at`；
- 固定 `source_revision` 和 source repository ref；
- 登记 Raw / Source projection artifacts；
- 显式记录 zero-byte 等 intake anomaly；
- 保存 boundary review 状态。

它不负责：

- 判断帖子是不是一次真实面试；
- 推断公司 / 岗位 / 招聘类型 / 轮次；
- 推断实际面试时间；
- 创建 Learning Discovery Labels；
- 预声明 InterviewNote identity。

## Issue contract

新建 SourceNote Issue 使用：

```text
<!-- source-note: id=xhs-note:<note_id> schema=source-note-issue.v1 -->
```

初始 labels：

```text
type:source-note
source:xhs
status:captured
boundary:pending
task:boundary-review
migration:xhs-bulk   # 仅批量 intake/reconciliation 时
```

`boundary:pending` 时禁止携带：

```text
company:*
role:*
recruitment:*
round:*
source-year:*
interview-year:*
result:*
outcome:*
```

这些都属于 InterviewNote 学习/发现语义。

## Boundary Review

审核结果只有四种：

```text
pending
not-interview
single-interview
multi-interview
```

关系：

```text
SourceNote
↓ Boundary Review
├─ not-interview       → 0 InterviewNote
├─ single-interview    → 1 InterviewNote
└─ multi-interview     → 2..N InterviewNote
```

在 `pending` 状态下：

```text
interview_note_ids = []
```

禁止根据标题、hashtag、OCR 或 Derived 分类提前创建 InterviewNote identity。

## Source integrity

SourceNote artifact 额外保存：

```text
byte_size
integrity = present | zero-byte
```

0-byte 文件仍然是来源仓库中的历史事实，可以登记，但必须明确标记为 `zero-byte`，不能把“路径存在”当作“图片可用”。

当前 intake anomaly 至少包括：

```text
zero-byte-artifacts
edited-before-published
```

异常只描述采集事实，不自动决定 boundary review 结果，也不自动修正来源时间。

## 与 InterviewNote 的关系

`InterviewNote` 从此表示“经过 boundary review 确认的一次真实面试事件”，而不是“一条来源帖子”。

```text
SourceNote
   └── boundary review
          └── InterviewNote*
                 ├── InterviewContext
                 ├── SourceSequenceManifest
                 ├── SourceQuestion
                 └── ExplorationSession
```

历史正式 Pilot 在旧的一对一模型下已经建立 InterviewNote identity。兼容原则是：

```text
正式 InterviewNote Issue
→ 原样保留，绝不通过 bulk reconciliation 改写

对应 XHS Source
→ 仍必须补建独立 SourceNote
→ boundary:pending
```

因此兼容历史不会成为 SourceNote inventory 的永久缺口。SourceNote 的建立只补齐来源根，不反向宣布旧 InterviewNote 的 boundary review 已完成。

## Reconciliation

`scripts/reconcile-xhs-source-notes.js` 只允许以下转换：

```text
已有 SourceNote
→ idempotent skip

migration:xhs-bulk + 旧 InterviewNote
→ 保留 Issue number，原地改为 SourceNote

正式 InterviewNote（没有 migration:xhs-bulk）
→ 正式 Issue protected，绝不改写
→ 旁路创建对应 SourceNote

尚未迁移的 XHS note
→ 创建新的 SourceNote
```

这样所有固定 XHS Source 都能够进入完整 SourceNote inventory，同时：

- 正式 InterviewNote 不被覆盖；
- legacy bulk 可以原地修正；
- 迁移中断后可按 stable source identity 幂等续跑；
- boundary review 仍然是产生 0..N InterviewNote 的唯一新路径。
