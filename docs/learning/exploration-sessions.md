# ExplorationSession 探索会话

## 目的

真实面经不是一次性 ETL 输入，而是可以反复回看的 case。我们可以不断从中加深理解、验证回答模式、发现关系、暴露知识缺口。

`ExplorationSession` 表示一次有明确边界的探索/学习过程，不修改 Raw Source。

## 原则

```text
Source 保持稳定。
Exploration 不断累积。
理解可以继续加深或修正。
```

不能因为完成一轮探索，就把 InterviewNote 标记成永久 `processed=true`。

## Session target

一次 session 应有一个主目标：

```text
InterviewNote
或
CanonicalQuestion
```

初期优先支持 InterviewNote，因为真实面经负责驱动学习和后续知识建设。

## Session mode

### Learning

AI 一点一点解释当前 Source unit 和可观察的 reasoning structure。

目标：

- 识别 cue
- 判断当前问题类型
- 激活相关知识结构
- 形成 response skeleton
- 理解新输入为什么改变之前判断

### Training

AI 更接近面试官，在合适 checkpoint 前不主动解释。

目标：

- 测 spontaneous recognition
- 测 response structure
- 测 follow-up handling
- 找出反应链路在哪里断掉

### Source analysis

重点分析来源结构，而不是学习者表现，例如：

- SourceQuestion boundary
- sequence segmentation
- follow-up candidate
- source ambiguity
- real phrasing variant

### Knowledge audit

用真实面经挑战现有 Knowledge，例如：

- Canonical mapping coverage
- Answer 是否覆盖真实问法
- 缺失的 follow-up handling
- Knowledge boundary 问题

## No-look-ahead

顺序探索必须维护 revealed position。

当处于 Source position `N` 时，只能使用：

```text
source units 1..N
+
当前 mode 允许使用的已有知识
```

禁止使用 `N+1..end` 来解释、预测或评分当前步骤。

后来的 session 可以带着更多知识回看早期位置，但必须明确这是 retrospective analysis，而不是实时模拟。

## 小步交互

默认粒度：

```text
一个 Source 输入
→ 一个解释层
→ 消化 / 停顿
→ 下一层
```

不要一次性把字面意思、考察意图、完整答案、follow-up 和总结全部倒出来。

目标是训练可复用 mental path，而不是最大化一次输出的信息密度。

## 建议的 Session record

```text
session_id
target_type
target_id
mode
started_at
source_revision_id
revealed_position
focus
observed_cues
classification
response_skeleton
plausible_followup_dimensions
new_findings
knowledge_gaps
relation_candidates
actions
completed_at
```

第一版不要求所有字段都存在。最重要的是稳定 target identity、SourceRevision、时间顺序，以及 observation 与正式 action 的分离。

## Finding 与 Action 分离

Session 可以发现：

- 可能的 SourceQuestion
- 可能的 follow-up relation
- 可能的 Canonical boundary 问题
- Answer coverage 缺失
- learner weakness

但发现本身不授权正式 mutation。

```text
Exploration finding
    ↓
显式 review / domain operation
    ↓
validated state change
```

避免一次对话中的临时判断悄悄变成正式知识。

## Issue 中的 Session history

InterviewNote Issue 是 Exploration 的自然入口。

可以把简洁 session summary 写入 Issue Comment 或链接到 artifact，至少标明：

- session / mode
- source revision
- revealed range
- 关键 finding
- 产生的 action

不要因为 AI 生成了长对话，就把大量重复 transcript 全塞进 Issue。只沉淀可复用发现、决策和学习 checkpoint。

## 多遍挖掘示例

```text
Pass A：按真实顺序经历整场面试
Pass B：检查问题边界
Pass C：检查 sequence / follow-up
Pass D：映射 CanonicalQuestion
Pass E：用真实问法挑战 Answer
Pass F：Mock Interview / response-loop 训练
Pass G：知识提升后再次回看
```

这些只是示例，不是固定 lifecycle。Session 应按目的划界，而不是把 pass 编号变成永久状态。

## Completion 语义

一个 ExplorationSession 可以完成。

一篇 InterviewNote 不存在“永远彻底探索完成”。

新的知识、新的 SourceRevision、新的求职目标或新的薄弱点，都可以触发下一轮探索。

## 核心不变量

```text
一次 Session 有边界。
Source case 可以长期复用。
未来 Source context 永远不能泄漏到当前顺序解释。
Finding 经过显式 review/apply 后才成为正式 mutation。
反复练习应该不断强化 Interview Reasoning Loop。
```
