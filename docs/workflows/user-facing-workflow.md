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
练习回答与追问
↓
沉淀可复用知识
↓
以后再次训练
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

> 我今天想练哪一类真实面试？

而不是提前告诉用户这篇面经最后有没有通过。

## 默认用户心智模型

用户默认只需要理解：

```text
筛选面经
↓
当前输入
↓
学习 / 回答 / 追问
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
- 当前解释 / 训练内容；
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
Learn / Answer / Train
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
ReviewProgress
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
只向用户展示当前 Source + 当前解释层
↓
等待“下一步 / 提问 / 深入”
```

用户看到的应该是：

```text
快手 · 后端 · 校招 · 二面 · 09-18
↓
当前输入
↓
识别
↓
结构
↓
回答策略 / 学习点
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

## 默认 Agent 行为

### 筛选学习样本

用户说：

```text
我想练快手后端二面
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
7. 展示第一条可学习输入。

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

Agent 只在当前 Source-backed depth frontier 内继续。

如果继续展开已经主要由一般知识驱动，应明确区分：

```text
Source-backed learning
vs
General knowledge expansion
```

### 复盘 / 沉淀

用户说：

```text
复盘一下
```

Agent 可以汇总本 session 的 reusable findings，但：

```text
Exploration finding
≠
自动修改 CanonicalQuestion / Analysis / Answer
```

真正 promotion 仍走相应 domain operation。

## Non-spoiler Issue projection

原始标题属于 Source，应原样保存。

Issue display title 则是 Derived projection，应优先使用：

```text
[公司] 岗位族 · 招聘类型 · 轮次 · 面试时间 · short-id
```

例如：

```text
Raw title:
9.18快手五战二面凉经

Issue title:
[快手] 后端 · 校招 · 二面 · 09-18 · 6508552c
```

这样用户可以从 Issue 列表选择学习样本，而不会因为标题中的“凉经 / offer / 挂了”等字样提前知道结果。

## 基础设施何时应该暴露

默认不展示 machine ID 和 validator 细节。

只有以下情况需要升级可见性：

### A. 用户主动要求审计

例如：

```text
为什么你说这是校招？
为什么你说现在读到这里？
这个分段怎么来的？
检查一下 no-look-ahead 是否真的成立
```

此时可以展示：

```text
InterviewContext evidence basis
SourceRevision
Manifest / Unit / Fragment
Review
Checkpoint / History evidence
```

### B. 运行时阻塞

例如：

```text
InterviewContext 未审核
Raw Source 不完整
Manifest 未审核
SourceRevision 冲突
Review 已变更导致 active session stale
```

用户只需要先看到可行动的高层状态，再在需要排障时展开具体 machine reason。

### C. 用户正在开发 Interview Lab 本身

如果当前任务就是设计 schema、validator、review lifecycle、CI，则 runtime infrastructure 本身就是工作对象，可以完整暴露。

## 用户可见错误语言

内部错误：

```text
source_review_id != current effective review
```

用户默认应看到：

```text
当前学习会话依赖的 Source 审核版本已经过期，不能继续沿用旧会话。
```

内部错误：

```text
source_fragment_id regressed
```

用户默认应看到：

```text
当前学习位置出现顺序冲突，系统已停止继续推进以避免偷看或回退。
```

原则：

> 先说明“对学习意味着什么”，再在需要时展开机器原因。

## 复杂度预算

新增 runtime 对象或 machine contract 时必须问：

```text
它是否解决了真实 correctness / provenance / concurrency 问题？
↓
如果是
它能否隐藏在 runtime 下？
↓
如果可以
不要增加新的用户日常操作
```

默认规则：

> **Backend complexity must not become user workflow complexity.**

新增一个 validator、schema 或内部 identity，不应自动增加一个用户命令。

## 新机制的进入门槛

以后再增加底层机制，需要至少满足一个条件：

- 真实 Pilot 已暴露可复现 correctness bug；
- 会破坏 Raw / Derived separation；
- 会破坏 no-look-ahead；
- 会导致历史不可复现；
- 会导致并发 / stale write 覆盖新状态；
- 会使正式知识 mutation 缺少授权边界。

仅仅因为“理论上还能再加一层证明”，不足以继续扩张 runtime。

## 系统停止继续向下复杂化的原则

当前已有严格 runtime 足以覆盖首个真实 Pilot 暴露的主要 Source-first 风险。

默认优先：

```text
录入更多真实面经
↓
先形成 reviewed InterviewContext 与学习标签
↓
用 Label 选择真实学习样本
↓
继续 source-first 学习
↓
验证知识沉淀与训练效果
↓
只有真实失败再扩展底层协议
```

## 成功标准

对于普通学习者，Interview Lab 应最终表现为：

```text
我筛一组想练的面经
↓
我选一篇
↓
AI 告诉我非剧透基础信息
↓
AI 陪我一点一点读
↓
我不断说“下一步”或提问
↓
AI 帮我形成面试反应链路
↓
有价值的东西被安全沉淀
```

如果用户必须理解大量 manifest/review/checkpoint/transition 才能完成普通学习，说明系统虽然技术上更严格，但产品边界失败。

## 核心原则

```text
先把面经变成可筛选学习样本。
学习前 Context 可见，Outcome sealed。
用户操作简单。
领域边界清楚。
Runtime 可以严格。
基础设施默认隐藏。
真正阻塞才升级可见性。
真实 Pilot 决定是否增加复杂度。
```
