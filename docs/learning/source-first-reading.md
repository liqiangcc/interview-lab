# Source-First 顺序阅读协议

## 目的

本协议使用真实面经训练“面试反应链路”，而不是背标准答案。

学习过程尽量模拟真实面试中信息逐步出现的状态。

## 核心规则：禁止偷看未来

在步骤 `N`，解释只能使用：

```text
之前已经揭示的面试上下文
+
当前输入
```

同一篇面经中尚未揭示的未来内容不得影响当前解释。

这是硬规则。

## 为什么

真实面试是因果、增量发生的。候选人不知道下一问是什么。

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
→ 一次只揭示一个输入
→ 一次只拆一个解释层
```

不要一次把所有层都讲完。

对一个输入，可以逐层推进：

1. 当前这句话字面在说什么？
2. 它属于什么面试信号/问题类型？
3. 它触发了哪块知识结构？
4. 此刻应该形成怎样的回答骨架？
5. 基于当前信息应该答到多深？
6. 现在合理的追问维度有哪些？

当前层被充分消化后再进入下一层。

## Interview Reasoning Loop

反复训练的目标链路：

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

## AI 行为

Learning mode 下，AI 应：

- 只揭示当前 Source unit
- 只使用允许的历史上下文
- 一层一层解释
- 不过早给出完整答案
- 清楚区分 Source wording 与 Derived interpretation
- 解释哪些 cue 触发哪些知识结构
- 显示新输入如何改变之前判断
- 在自然学习边界停下，而不是一路讲完

用户不需要为了维持协议不断输入长提示词。

## 两种模式

### Learning mode

AI 逐步解释，并严格遵守 no-look-ahead。

目标：形成识别能力和回答结构。

### Training mode

AI 暂时不解释，更接近真实面试官。

目标：验证反应链路是否已经内化。

Training mode 可以使用真实问题顺序和 follow-up，但仍然必须顺序 reveal。

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
focus
observed_cues
response_structure
new_findings
knowledge_gaps
follow-up candidates
actions
```

这样多次学习会形成可审计的轨迹，同时不会修改原始面经。

## 核心不变量

```text
Source 保持稳定。
上下文只能向前增长。
理解一次只加深一点。
反复练习形成可复用的面试反应链路。
```
