# Issue Label 分类体系

## 目的

Label 是 Interview Lab 的查询索引和工作流索引，让人和 AI 不必解析所有 Issue body 就能快速找到下一项工作或下一组学习样本。

Label 属于操作元数据 / Derived projection。它不能单独证明 Source 完整、Knowledge 正确、Answer 合格或学习者已掌握。

## 两类 Label

Interview Lab 明确区分：

```text
Workflow Labels
→ 这篇面经现在处于什么处理状态

Learning Discovery Labels
→ 这篇面经适合怎样被筛选出来学习
```

两者都只是 projection，不是 Source truth。

## 设计规则

1. 不同 Label family 表达正交维度，不把多个含义塞进一个 Label。
2. lifecycle Label 是验证后状态的 projection，手工加 Label 不能绕过 Validator。
3. 对互斥 family，一个 Issue 正常最多只有一个 active Label。
4. Learning Discovery Label 必须来自经过 review 的 `InterviewContext`；不能直接从标题字符串猜测后就打标签。
5. Unknown 默认不生成 learning label；不使用 `company:unknown`、`role:unknown` 等污染学习筛选。
6. 结果 / outcome 默认不进入学习发现 Label，避免在 Issue 列表阶段剧透。
7. company 是 Interview Lab 的一级学习入口，允许进入受控 Label namespace，但必须先归一化 stable company id。
8. 精确岗位、年份、source id、technology、canonical id 等仍进入结构化 metadata / 索引，不扩张全局 Label namespace。

# Workflow Labels

## 对象类型

```text
type:interview-note
type:canonical-question
```

初期优先实现 `type:interview-note`。其他类型必须先有正式 Issue contract。

## 来源

```text
source:xhs
source:nowcoder
source:maimai
source:manual
source:other
```

Source Label 表示数据来源平台，不表示被面试公司。

## InterviewNote 生命周期

InterviewNote Issue 处于 open 状态时，正常只应有一个：

```text
status:discovered
status:captured
status:source-review
status:source-ready
status:blocked
```

GitHub Close 是额外的操作事件，不另造领域状态。

## 来源质量信号

只在当前问题仍存在时使用：

```text
quality:source-incomplete
quality:image-missing
quality:text-truncated
quality:artifact-corrupt
quality:identity-conflict
quality:duplicate-source
quality:provenance-missing
```

Quality Label 是审核信号，不能替代 limitation / decision record。

## 工作意图

```text
task:source-review
task:source-recovery
task:artifact-check
task:identity-review
```

Task Label 只表示下一步工作，不表示长期领域事实。

## 优先级

```text
priority:P0
priority:P1
priority:P2
```

这里只表示工作调度优先级，不等同于题目重要性或真实面试频率。

# Learning Discovery Labels

Learning Discovery Labels 在面经录入 / Source 整理之后、正式学习之前生成。

来源链：

```text
Raw Source / Source projection
↓
InterviewContext extraction
↓
Context review
↓
Reviewed InterviewContext
↓
Learning Discovery Label projection
```

## 公司

```text
company:<normalized-id>
```

例如：

```text
company:kuaishou
company:alibaba
company:tencent
company:bytedance
```

公司名称必须先归一化：

```text
“字节” / “字节跳动” / “ByteDance”
↓
company id = bytedance
↓
company:bytedance
```

不能为同一公司因为显示文本差异创建多个 Label。

Company Label 数量可能高于其他 family，但它是核心学习筛选入口，因此是有意允许的受控例外。

## 岗位族

Label 只使用粗粒度 role family：

```text
role:backend
role:frontend
role:client
role:algorithm
role:data
role:qa
role:product
role:other
```

精确岗位名称继续保存在 `InterviewContext.role.title`，例如：

```text
Java 后端开发
商业化服务端开发
搜索算法工程师
```

不要为每个精确 title 创建 Label。

## 招聘类型

```text
recruitment:campus
recruitment:social
recruitment:internship
```

如果来源没有足够证据，保持 `unknown`，默认不生成 Label。

`reviewed-inference` 可以生成 Label，但必须在 InterviewContext 中保留推断 provenance。例如：

```text
Source: #24秋招
↓
reviewed inference: campus
↓
recruitment:campus
```

Label 本身是 Derived projection，不表示来源逐字写了“校招”。

## 面试轮次

```text
round:1
round:2
round:3
...
round:hr
round:final
```

Unknown 不生成 Label。

## 面试时间

面试时间保留在结构化 metadata / InterviewContext 中，不默认创建 year/date Label。

原因：

- 时间 precision 可能只是 `month_day`；
- 强行生成年份 Label 容易把来源发布时间误当成实际面试年份；
- 时间筛选更适合使用结构化索引。

## Outcome / 结果

默认禁止把结果作为普通 InterviewNote 的 Learning Discovery Label：

```text
result:rejected     # 不使用
result:passed       # 不使用
outcome:offer       # 不使用
```

原因不是结果不重要，而是学习入口需要 non-spoiler：

```text
公司 / 岗位 / 招聘类型 / 轮次 / 时间
→ 学习前可见

结果 / 自评 / 外部反馈
→ Source 时间线到达结果阶段后再 reveal
```

如未来确实需要 outcome analytics，应建立与普通学习发现界面隔离的查询机制，而不是让结果直接出现在学习 Issue 列表里。

# 推荐组合

刚发现：

```text
type:interview-note
source:xhs
status:discovered
```

已完成 Source 与 InterviewContext review，进入可筛选学习池：

```text
type:interview-note
source:xhs
status:source-ready
company:kuaishou
role:backend
recruitment:campus
round:2
```

这样可以自然支持：

```text
company:kuaishou role:backend round:2
```

或：

```text
company:kuaishou recruitment:campus
```

来选择下一篇真实面经。

# 禁止的 Label 模式

仍不要创建无限增长或容易伪造 Source 精度的 taxonomy：

```text
year:2023
note:630e2e...
tech:redis
canonical:cq_...
role:java-backend-commercialization
```

也不得把未经 review 的 AI 猜测直接投影成 Learning Label。

## 状态转换规则

正确方向：

```text
Source capture / Context extraction
    ↓
领域 / Source 验证
    ↓
Reviewed InterviewContext
    ↓
同步 Learning Discovery Labels
```

禁止：

```text
手工修改 Label
    ↓
反过来假设 InterviewContext 有效
```

## 查询目标

Workflow 查询：

```text
type:interview-note status:source-review

type:interview-note status:blocked quality:image-missing
```

Learning 查询：

```text
type:interview-note company:kuaishou role:backend round:2

type:interview-note company:kuaishou recruitment:campus
```

成功标准是：用户能先筛出“我今天想练什么”，然后再进入 source-first sequential learning；同时结果和未来 Source 不会因为 Label / title 提前泄漏。
