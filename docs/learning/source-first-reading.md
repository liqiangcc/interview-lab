# Source-First 顺序阅读协议

## 目的

本协议使用真实面经训练“面试反应链路”，而不是背标准答案。

学习过程尽量模拟真实面试中信息逐步出现的状态。

## 核心规则：禁止偷看未来

在步骤 `N`，解释只能使用：

```text
之前已经揭示的面试上下文
+
当前已经揭示的 Source 信息
```

同一篇面经中尚未揭示的未来内容不得影响当前解释。

这是硬规则。

### Position 不是唯一时间边界

`revealed_position` 只表示已经推进到哪个 Source unit，但一个 Source unit 内部也可能混合多个时间阶段，例如：

```text
即时问题
→ 作者事后意图摘要
→ 作者事后后续追问摘要
```

因此，当一个 Source unit 内部还存在尚未揭示的信息时，必须继续维护 position 内的时间边界，例如：

```text
revealed_position
+
temporal_cursor
+
revealed_within_unit
```

在当前 `temporal_cursor` 之后的信息，仍然属于未来 Source，不能提前用于解释、预测或评分。

## 为什么

真实面试是因果、增量发生的。候选人不知道下一问是什么，也不知道当前一句话后面是否还隐藏着作者事后补充的 follow-up 信息。

如果允许未来上下文倒灌，就训练成了“看完答案后的事后解释”，而不是现场判断。

目标能力是：

```text
有限信息
→ 当前判断
→ 回答结构
→ 新信息到来
→ 更新判断
```

## 学习粒度

默认使用最小有用单元：

```text
一篇面经
→ 一次只揭示一个输入或一个时间片段
→ 一次只拆一个解释层
```

不要一次把所有层都讲完。

同时，不同 Source unit 不强制使用同一组解释层。先识别 Source 类型，再选择对应 learning loop。

## Source 类型与默认 learning loop

下面三类是当前推荐的默认类型，不是封闭枚举。

### 1. Question-like / interviewer-cue Source

适用于真实问题、追问或明确 interviewer cue。

默认可以逐层推进：

1. 当前这句话字面在说什么？
2. 它属于什么面试信号/问题类型？
3. 它触发了哪块知识结构？
4. 此刻应该形成怎样的回答骨架？
5. 基于当前信息应该答到多深？
6. 现在合理的追问维度有哪些？
7. 是否已经达到当前 Source 的 closure gate？

也可以表示为：

```text
literal
→ classification
→ knowledge
→ response
→ depth
→ anticipation
→ closure
```

当前层被充分消化后再进入下一层。

### 2. Stage-summary Source

适用于“项目深挖一段时间”“系统设计阶段”“行为面阶段”等只记录阶段而没有逐字问题的 Source。

不要伪造本场不存在的具体问题。

更适合：

```text
literal
→ classification
→ preparation structure
→ routing
→ dynamic depth
→ plausible dimensions
→ closure
```

目标是建立可导航准备结构，等待真实 cue 再进入具体 reasoning loop。

### 3. Outcome / reflection-summary Source

适用于结果、候选人感受、过程摘要、事后解释等非 interviewer cue Source。

这类 Source 不需要强行生成 response skeleton、回答深度或 interviewer follow-up。

推荐短路径：

```text
literal
→ evidence classification
→ structured extraction
→ attribution boundary
→ closure
```

统一的是 evidence discipline，而不是固定 layer 数量。

## Interview Reasoning Loop

对 question-like Source，反复训练的目标链路是：

```text
Input
  ↓
Recognize
  ↓
Locate knowledge
  ↓
Infer current intent
  ↓
Build response skeleton
  ↓
Choose depth
  ↓
Anticipate plausible follow-up dimensions
  ↓
Receive new input
  ↓
Update
```

目标不是暴露私有 chain-of-thought，而是形成可观察、可训练的 reasoning structure：cue、classification、response skeleton、boundary 和 update。

Stage-summary / outcome-summary Source 可以使用不同 loop，但仍然必须保持同样严格的 evidence discipline。

## Closure gate 与 depth frontier

每个 Source position 或当前时间片段都需要一个显式停止条件。

推荐判断：

```text
Source-backed cue
↓
已经形成可复述、可推导、可应对合理追问的最小闭环
↓
继续扩展将主要由一般知识而不是 Source 驱动
↓
close current learning loop
```

关键语义：

> “深挖”不授权无限展开；Source 仍然决定 depth frontier。

关闭当前 position 的 learning loop 不代表相关知识已经全部学完，也不代表 InterviewNote 永久探索完成。后续可以在其他 session 中针对 CanonicalQuestion、Answer、知识缺口或训练目标继续深入。

## Outcome 与归因边界

结果型 Source 必须区分不同证据等级。

至少要避免下面的错误等价：

```text
Outcome
≠
Failure Cause
≠
Verified Weakness
```

例如“未通过”只能证明结果，不能自动证明前面某一道题答错，也不能把候选人的自我感受升级为面试官评价。

结果 / 反思信息建议区分：

```text
Outcome
Process Evidence
Self Assessment
External Evaluation
Verified Weakness
Cause
Hypotheses
```

其中：

- `Verified Weakness` 需要独立、可定位或可重复验证的 evidence；
- `Cause` 没有直接证据时保持 `unknown`；
- `Hypotheses` 必须显式标记为假设；
- 后来的 outcome 不能反向污染前面已经按当时 evidence 得出的分析。

## AI 行为

Learning mode 下，AI 应：

- 只揭示当前 Source unit 或当前允许的时间片段
- 只使用允许的历史上下文
- 必要时维护 `temporal_cursor`
- 先识别 `source_unit_type`，再选择合适的 learning loop
- 一层一层解释
- 不过早给出完整答案
- 清楚区分 Source wording 与 Derived interpretation
- 解释哪些 cue 触发哪些知识结构
- 显示新输入如何改变之前判断
- 显式判断 closure gate，而不是沿一般知识无限扩张
- 不因最终 outcome 反向重写前面 evidence
- 在自然学习边界停下，而不是一路讲完

用户不需要为了维持协议不断输入长提示词。

## 两种模式

### Learning mode

AI 逐步解释，并严格遵守 no-look-ahead。

目标：形成识别能力和回答结构。

### Training mode

AI 暂时不解释，更接近真实面试官。

目标：验证反应链路是否已经内化。

Training mode 可以使用真实问题顺序和 follow-up，但仍然必须顺序 reveal；如果 Source unit 内存在时间片段，也必须遵守 `temporal_cursor`。

## 多遍阅读

一篇面经不会因为读过一遍就耗尽价值。

后续不同 pass 可以关注：

- SourceQuestion boundary
- interview sequence
- follow-up chain
- expected depth
- Canonical mapping
- Answer coverage
- knowledge gap
- Mock Interview 行为

Raw Source 保持不变，理解不断加深。

## Session 记录

一个有用的 ExplorationSession 可以记录：

```text
case
revealed_position
source_unit_type
temporal_cursor
revealed_within_unit
position_status
focus
observed_cues
response_structure
new_findings
knowledge_gaps
follow-up candidates
actions
```

这些字段不要求一次全部具备；重点是让“当前看到了什么、还没看到什么、属于哪类 Source、为什么停止”可审计。

## 核心不变量

```text
Source 保持稳定。
上下文只能向前增长。
Position 内的未来信息同样不能提前泄漏。
Source 与 Derived 永远分离。
Outcome 不自动生成 Cause 或 Weakness。
理解一次只加深一点。
每个 learning loop 都有明确停止边界。
反复练习形成可复用的面试反应链路。
```
