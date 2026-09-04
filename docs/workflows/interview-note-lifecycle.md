# InterviewNote 生命周期

## 目的

InterviewNote lifecycle 只治理第一手 Source capture 和 Source integrity。

它不能吞并下游 InterviewContext、Extraction、Canonicalization、Answer 或 learner review。

## Source 状态机

```text
discovered
    ↓
captured
    ↓
source-review
    ├──→ blocked
    │       ↓
    │   source recovered
    │       ↓
    └──── source-review
            ↓
       source-ready
            ↓
          closed
```

## discovered

已经知道存在这篇面经，但第一手资料还没有充分 capture。

例如：

- 只有 source id
- 只有 URL / search hit
- 只有 title，但正文或 artifact 缺失

Label：

```text
status:discovered
```

## captured

当前能够获得的第一手资料已经 capture 并保存/引用。

Capture 完成不等于 review 完成。

Label：

```text
status:captured
```

从这里开始，已注册 SourceRevision 不可变。

## source-review

只审核 Source integrity 和 provenance，例如：

- source id 与 artifact 是否属于同一 case
- 正文是否异常截断
- 图片集合/顺序是否完整，或 limitation 是否已记录
- artifact hash / ref 是否有效
- 是否存在 duplicate capture
- 是否存在编码或提取损坏
- “文件存在”是否真的代表 artifact 有效

这一阶段不判断技术正确性，也不做 InterviewContext / Canonical knowledge 审核。

Label：

```text
status:source-review
```

## blocked

当 Source integrity 当前无法解决时使用，例如：

- 原图缺失且暂时无法恢复
- 只剩二手转述
- source identity 冲突
- artifact 损坏
- provenance 缺失

绝不能为了 unblock 而编造 Source 内容。

常见 Label：

```text
status:blocked
quality:<specific-source-problem>
task:source-recovery
```

## source-ready

只有满足以下条件才进入：

- source identity 稳定
- 可获得 Raw Material 已保存
- 已知缺失明确记录
- provenance 足够支撑下游使用
- 没有未解释的 Source-level integrity 问题

`source-ready` 只表示 Source 可以作为稳定第一手输入。

它不表示 InterviewContext、SourceQuestion、Canonical、Answer 或 Training 完成。

Label：

```text
status:source-ready
```

## closed

达到 `source-ready` 且 Source lifecycle 完成后关闭 Issue。

Closed InterviewNote 仍然是一等可读 case，可以继续参与 Learning Discovery、Exploration、Knowledge 和 Training。

# Learning Discovery Readiness

Learning Discovery 是 **Source lifecycle 之后、正式学习之前** 的独立 Derived 步骤，不新增 Source lifecycle 状态。

推荐链路：

```text
Source lifecycle complete / source-ready
↓
InterviewContext extraction
↓
Context review
↓
Learning Discovery Labels
↓
non-spoiler Issue title
↓
进入可筛选学习池
↓
ExplorationSession
```

它负责识别：

```text
company
role family
recruitment type
round
interview time
```

并保持：

```text
Outcome sealed
```

因此：

```text
Source ready
≠
Learning discovery ready
```

但 InterviewContext 缺失或修订也**不应该 reopen Source lifecycle**，因为它属于 Derived discovery metadata，不是 Raw Source integrity。

Learning Discovery readiness 当前通过 reviewed `InterviewContext` + Label/title projection 表达，而不是再增加一个 `status:*` lifecycle Label。

## Reopen policy

只因 Source 层变化 reopen，例如：

- 找到更完整原始快照
- artifact 绑错 note
- 发现隐藏 truncation
- source identity 需要修正
- duplicate ownership 变化

不要因为：

- InterviewContext company / role / recruitment mapping 修正
- Learning Discovery Label 修正
- SourceQuestion 提取错了
- Canonical boundary 改变
- Answer 过期
- Mock Interview 答失败

而 reopen Source lifecycle。

## Revision rule

更好的 capture 创建新 SourceRevision：

```text
InterviewNote
├── source revision 1
└── source revision 2
```

新 revision 可以成为 preferred，但旧 evidence 保留用于审计。

InterviewContext 必须绑定一个具体 `source_revision_id`。如果 preferred SourceRevision 改变，Context 是否仍适用需要重新 review，但这仍是 Derived readiness，不是自动修改旧 Raw Source。

## 核心语义

```text
InterviewNote Source 生命周期结束
≠
Learning Discovery 已完成
≠
这篇面经的知识价值耗尽
```

Source 可以 closed；InterviewContext、Exploration 和 Knowledge 仍然可以继续演化。

## Source Review transition

`captured → source-review → source-ready|blocked` 的机器化 CAS / evidence / receipt 协议见：

- `docs/workflows/interview-note-source-review.md`

不要手工把 `status:captured` 直接改成 `status:source-ready`。
