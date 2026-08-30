# Issue-Driven 工作流

## 目的

Interview Lab 使用 GitHub Issue 作为主要的人类 / AI 操作界面。

总体架构：

```text
source-first data model
+
Issue-driven workflow
+
validator-guarded mutation
```

Issue 让领域对象容易被发现、读取、讨论、分配和反复使用，但工作流元数据不等于 Source truth。

## Control plane 与 Evidence plane

```text
GitHub Issues / Labels / Comments / Assignees
                │
                │ control / query / coordination
                ▼
        validated domain operations
                │
                ▼
Source Artifacts / Derived Records / Knowledge Assets
```

对 InterviewNote 而言，不可变 Source Artifact 是 Evidence root；Issue 是操作文档。

## 一个领域对象一个主 Issue

初始契约：

```text
1 InterviewNote
↕ 1:1
1 primary GitHub Issue
```

Issue body 内稳定 machine identity 防止 Issue number、title 或人工 wording 成为领域 identity。

不要因为同一 InterviewNote 上有不同小任务，就为每个小任务创建新 Issue。Recovery attempt、source review、exploration history 正常都附着在主 case Issue 上。

## Agent 工作循环

AI 默认按以下流程工作：

```text
1. 通过 type/status/task Label 查询 Issue
2. 读取目标 Issue
3. 解析 stable domain identity
4. 只读取当前任务允许的 Source / Derived 数据
5. 形成显式 observation 或 proposed operation
6. 进入对应 validation / guarded mutation path
7. 持久化正式结果
8. 同步 Issue body / Label
9. 重要 decision / exception 用简洁 Comment 留审计记录
10. 停止或进入下一个 Issue
```

AI 不能只看 Label 就推断任务已经完成。

## Read path

InterviewNote 推荐读取路径：

```text
Issue
  ↓
machine identity
  ↓
source references
  ↓
current SourceRevision / limitations
  ↓
当前任务需要的 Derived links
```

Sequential learning 还要受 no-look-ahead 约束。AI 技术上能看到整个 Issue，不代表它有权让未来 Source 内容影响当前学习步骤。

## Write path

任何正式状态 mutation 必须显式，例如：

- 注册新的 SourceRevision
- 记录 Source limitation
- 解决 duplicate-source identity
- 转换 InterviewNote lifecycle state
- 创建/修订 SourceQuestion
- 后续修改 CanonicalQuestion / Answer state

Issue 本身可以作为操作文档被编辑，但 formal mutation 必须遵守所属层 contract 和 Validator。

## Label synchronization

Label 在合法 state transition 后同步：

```text
formal state
   ↓
projection
   ↓
Issue labels
```

如果 Label 与正式状态 drift，修复方向应从 validated state → Label，而不是 Label → domain truth。

## Comment 作为审计历史

适合记录：

- source-review finding
- recovery attempt
- explicit uncertainty
- decision rationale
- ExplorationSession summary
- commit / generated report link

Comment 在精神上是 append-only history，但不是不可变 Raw Evidence。

不能把“修正后的原始面经”写进 Comment 后再当作新的 Raw Source。

## Close / Reopen

语义由 owning domain contract 决定。

对 `type:interview-note`：

- close = Source lifecycle 达到稳定 source-ready completion
- reopen = 只因 Source-level reason
- 下游 Knowledge / Training 变化继续进行，不 reopen Source case

## Concurrency 与 Idempotency

自动化必须假设人和多个 Agent 可能同时操作仓库。

最低要求：

- 按 stable domain identity 解析，不能只按 title 匹配
- mutation 前检查 current state
- migration/sync 幂等
- 禁止同一 InterviewNote duplicate Issue
- expected SourceRevision / identity 改变时 fail closed
- stale agent result 不得覆盖更新的 decision

## Issue-driven 不代表什么

它不代表：

- 所有仓库对象都只能存 Issue
- 大型 HTML / image 应塞进 Issue body
- Label 是 transaction authorization
- Issue edit 可以改写不可变 Source Artifact
- AI 应无视学习边界消费所有上下文

## 成功标准

当人或 AI 从下面这样的查询开始：

```text
type:interview-note status:source-review
```

能够安全完成下一项有边界工作，同时不丢 provenance、不绕过 Validator、也不需要从无关文件恢复隐藏工作流状态，Issue-driven workflow 才算成功。
