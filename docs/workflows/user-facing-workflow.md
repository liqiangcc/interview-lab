# User-Facing Workflow 用户使用工作流

## 目的

Interview Lab 的底层可以复杂，但用户日常使用必须简单。

用户的核心任务不是维护 `SourceSequenceManifest`、`SourceSequenceReview`、checkpoint schema 或 validator，而是：

```text
筛选 / 选择一篇真实面经
↓
查看非剧透基础信息
↓
按真实顺序逐步学习
↓
理解当前输入
↓
AI 层层分析结构 / 因果 / 边界
↓
沉淀可复用知识
↓
继续下一条真实信息
```

底层机制的职责是保护这个体验，而不是成为用户必须学习的新工作流。

## 面经从录入到学习

一篇面经不是录入后立刻进入逐题解释，而是先变成一个可筛选学习样本：

```text
Raw capture
↓
InterviewNote / Source review
↓
InterviewContext extraction
↓
Context review
↓
同步 Learning Discovery Labels
↓
生成 non-spoiler Issue title
↓
进入可筛选学习池
↓
用户选择 Issue
↓
ExplorationSession
```

学习前默认允许展示：

```text
公司
岗位族
校招 / 社招 / 实习
面试轮次
面试时间
```

默认不展示：

```text
结果
offer / reject
作者事后自评
外部反馈
```

Outcome 必须等 Source 时间线真正走到结果阶段后再 reveal。

## 用 Label 选择今天要学什么

用户可以从 Learning Discovery Labels 直接筛选 Issue，例如：

```text
company:kuaishou
role:backend
round:2
```

或：

```text
company:kuaishou
recruitment:campus
```

Label 是 reviewed `InterviewContext` 的查询 projection，不是 Source truth。

Unknown 不生成学习标签；结果不进入普通学习发现标签。

因此 Issue 列表的职责是回答：

> 我今天想分析哪一类真实面试？

而不是提前告诉用户这篇面经最后有没有通过。

## 默认用户心智模型

用户默认只需要理解：

```text
筛选面经
↓
当前输入
↓
学习 / 分析 / 深入
↓
沉淀
```

对应到常见交互：

```text
找快手后端二面
开始读这篇面经
下一句 / 下一步
这里什么意思？
这个怎么回答？
再深入一点
复盘一下
```

用户不需要为了正常学习主动提供：

```text
manifest_id
source_unit_id
source_fragment_id
source_review_id
checkpoint schema version
transition_id
validator command
```

这些属于 runtime infrastructure。

## 三层表面

### 1. User Surface

默认向用户暴露：

- 学习筛选条件；
- 当前是哪篇 InterviewNote；
- non-spoiler InterviewContext；
- 当前真实 Source 输入；
- 当前解释 / 分析内容；
- 当前是继续、深入、复盘还是完成；
- 有价值的知识沉淀结果；
- 真正需要用户决策的阻塞或歧义。

日常流程：

```text
Filter InterviewNotes
↓
Pre-learning Context
↓
Current Source
↓
Learn / Analyze / Deepen
↓
Next
```

### 2. Domain Surface

在需要理解项目结构、审核沉淀结果或做知识维护时，可以暴露：

```text
InterviewNote
InterviewContext
SourceQuestion
CanonicalQuestion
Analysis
Answer
ExplorationSession
```

这是领域模型，不应该成为每一步学习都必须操作的 UI。

### 3. Runtime Infrastructure

默认隐藏：

```text
SourceRevision
SourceSequenceManifest
SourceUnit / SourceFragment identity
SourceSequenceReview
checkpoint v1/v2/v3
history validator
review transition
staleness impact
CI workflow
```

这些机制负责：

- 证明 Source provenance；
- 防止偷看未来；
- 固定学习 frontier；
- 保证 review 与历史可复现；
- 阻止 stale write；
- 为审计提供证据。

## 默认学习入口

当用户要求开始或继续阅读一篇面经时，Agent 应自动完成必要准备，而不是要求用户逐项执行基础设施步骤。

推荐流程：

```text
用户通过 Label 筛选 / 指定 InterviewNote
↓
Agent 读取 reviewed InterviewContext
↓
只展示 non-spoiler context
↓
Agent 自动解析 Issue 与 Source
↓
Agent 自动确认当前可用 SourceRevision
↓
有 approved manifest 时自动选择 review-pinned v3
无 manifest 时使用兼容路径并保留 limitation
↓
Agent 恢复或创建 ExplorationSession
↓
只向用户展示当前 Source + AI 当前解释层
↓
AI 主动结构化 / 解释当前已知信息
↓
等待“下一步 / 提问 / 深入”
```

用户看到的应该是：

```text
快手 · 后端 · 校招 · 二面 · 09-18
↓
当前输入
↓
接上前文并找出当前 cue / 约束
↓
补足必要前提
↓
逐步建立结构并推导关键因果
↓
处理影响结论的条件 / 边界
↓
推导后形成当前判断 / 回答策略
↓
停在自然边界
```

而不是：

```text
先创建 manifest
再 review
再生成 checkpoint
再跑 validator
再告诉用户可以学习
```

后者是 Agent/runtime 的内部责任。

## 默认分析表达风格

正常 Learning mode 的用户可见分析必须遵循 [`docs/learning/interview-analysis-style.md`](../learning/interview-analysis-style.md)。

### 开始时提示当前分析风格

开始一篇新的真实面经分析时，Agent 应在第一次正式分析前提示一次当前风格。用户未指定时，不增加选择步骤，直接采用默认：

```text
本次分析风格：Golden Style（原始逐步推导）。
你只需要继续说“下一步”；如需切换风格，可以随时直接说明。
```

同一连续 session 中，后续“下一步”不重复提示。fresh conversation 恢复已有 session 时，如果能够确认原风格，提示：

```text
已恢复分析风格：Golden Style（原始逐步推导）。
```

如果用户显式切换到另一种已经正式定义的风格，则在切换时提示一次新的风格名称。风格提示只说明“这次怎么分析”，不能改变 Source frontier、no-look-ahead 或 provenance 边界。

默认节奏是：

```text
真实 question-like cue
→ 接上前面已经建立的理解
→ 找出当前 wording 中的证据 / 约束
→ 建立当前问题模型
→ 补足必要前提
→ 一步一步展开关键因果
→ 说明影响结论的条件分支 / 反例 / 边界
→ 推导充分后自然得到当前结论
→ 必要时再压成最小回答骨架
→ 到当前自然闭环就停
→ 等真实下一步
```

默认不要求用户先答题、猜测或复述。用户的最低操作可以始终只是“下一步 / 这里什么意思 / 再深入一点”。

重点是让 AI 承担信息整理成本，同时**保留决定结论的详细推导链**。用户看到的应是逻辑连贯的“线索 / 前提 / 结构 / 中间判断 / 因果 / 条件分支 / 边界 / 结论 / 回答”分析，而不是直接结论、额外流程、checkpoint 审计日志或无关知识百科。

## 默认 Agent 行为

### 筛选学习样本

用户说：

```text
我想看快手后端二面
```

Agent 应优先使用 Learning Discovery Labels 查询：

```text
company:kuaishou
role:backend
round:2
```

返回候选时不主动展示 Outcome。

### 开始阅读

用户说：

```text
开始读这篇面经
```

Agent 应自动：

1. 找到主 InterviewNote Issue；
2. 读取 reviewed InterviewContext；
3. 展示 non-spoiler 基础信息；
4. 定位可信 Source；
5. 解析当前 sequential frontier；
6. 必要时创建/恢复 ExplorationSession；
7. 提示本次采用的分析风格；
8. 展示第一条可学习输入并直接进入当前有意义的解释层。

这里的风格提示不能变成“先让用户选模式”的新门槛；未指定时直接采用 Golden Style（原始逐步推导）。

只有在真正阻塞时才向用户报告基础设施问题。

### 继续

用户说：

```text
下一步
```

默认语义：

```text
当前 Source unit 的下一个有意义学习层
或
当前 position 已 closure 后的下一个 Source unit
```

Agent 自己负责 checkpoint/history 更新。

用户不应需要说：

```text
请把 loop_phase 从 classification 改成 knowledge
```

### 深入

用户说：

```text
再深入一点
```

默认语义：

```text
仍然保持当前 Source frontier
↓
只把当前问题或当前知识节点向下展开一层
↓
不提前 reveal 下一条真实 Source
```

### 这里什么意思

用户说：

```text
这里什么意思？
```

Agent 优先围绕当前已 reveal 的 Source 和已经建立的解释，把歧义点讲清楚。

除非用户明确要求，不切换到整个题目的完整答案。

### 这个怎么回答

用户说：

```text
这个怎么回答？
```

Agent 可以在当前 Source 已允许的范围内，把已经建立的分析压缩成一个现场可执行的回答骨架。

不因为进入 answer mode 就读取未来 Source。

### 复盘

用户说：

```text
复盘一下
```

Agent 可以回看已经揭示的内容：

```text
Source cues
↓
建立过的结构
↓
关键 reasoning
↓
当前 knowledge gaps
↓
可复用 finding
```

但不能把尚未揭示的未来内容作为复盘材料。

## 恢复已有学习会话

用户在 fresh conversation 中说：

```text
继续 Issue #3
```

Agent 应优先恢复已有 ExplorationSession，而不是新开一套学习状态。

对用户只展示：

```text
已恢复：快手后端二面
当前进度：HTTP 请求 / TCP 连接关系
继续从这里分析。
```

必要的 review identity、checkpoint、history validation 在后台完成。

如果恢复失败，用户看到的是一个真实 blocker：

```text
当前无法证明应从哪个 Source frontier 继续，所以我不会猜位置或提前读取后文。
```

而不是内部 schema dump。

## 阻塞时怎么表现

只有真实 correctness/provenance blocker 才阻塞用户：

- Source 不可访问；
- Source identity 不可证明；
- approved review 与 checkpoint 冲突；
- 无法确定 current frontier；
- 必须的 validator 失败且无法证明 no-look-ahead。

纯 runtime 噪声不应变成用户 blocker，例如：

- 某个 label 还没同步但 Issue 身份明确；
- 某个展示字段缺省但不影响 Source frontier；
- 某个 optional derived artifact 尚未生成；
- 用户没有手工指定 manifest/review/checkpoint ID。

## 用户主动表达理解

如果用户主动说：

```text
我觉得 HTTP 请求就是一个 TCP 连接
```

Agent 不要忽略这个表达重新讲一遍完整答案，而是：

```text
保留当前 Source frontier
↓
判断这条理解覆盖了什么
↓
指出最关键缺口
↓
解释为什么这个缺口重要
↓
给一个更稳定的结构
```

用户的表达属于对话上下文，不自动成为 Source 或 CanonicalAnswer。

## 什么时候才展示底层机制

只有以下情况才展开 runtime 细节：

1. 用户明确要求审计 provenance；
2. 当前任务本身是开发 Interview Lab；
3. 出现 blocker，需要解释为什么不能继续；
4. 需要证明某个 review/checkpoint 是否 stale；
5. 需要人为处理 Source mapping 歧义。

其他时候，把复杂度留在系统内部。

## 验收标准

一个合格的用户体验应该满足：

- 用户可以用 `company / role / round` 快速筛选面经；
- 用户看到的是 reviewed、non-spoiler context；
- 一次只看到当前真实输入；
- AI 基于当前输入做高质量逐层分析；
- 用户主要通过“下一步 / 提问 / 深入 / 复盘”推进；
- 题目之间保持逻辑连续，不要求用户自己拼上下文；
- 结论由可见线索、必要前提、中间判断、关键因果和条件边界自然推出；
- 不要求用户为了普通学习先答题、自测、复述或评分；
- runtime/provenance 正确性由后台机制保护；
- Outcome 在时间线走到之前保持 sealed；
- 后续新机制只有真实 Pilot 暴露 correctness 问题时才增加。

最终用户心智模型应该稳定为：

```text
选真实面经
↓
看当前输入
↓
让 AI 一层一层把它讲清楚
↓
继续下一步
↓
长期积累可复用分析能力
```
