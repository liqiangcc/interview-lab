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
4. Learning Discovery Label 必须来自经过 review 的 `InterviewContext`，或来自显式指定的权威 Source field；不能直接从 Issue title 猜测后打标签。
5. Unknown 默认不生成 learning label；不使用 `company:unknown`、`role:unknown` 等污染学习筛选。
6. 结果 / outcome 默认不进入学习发现 Label，避免在 Issue 列表阶段剧透。
7. company 是 Interview Lab 的一级学习入口，允许进入受控 Label namespace，但必须先归一化 stable company id。
8. 时间 Label 必须写清语义：只允许 `source-year:*` 与 `interview-year:*`，禁止含义模糊的 `year:*`。
9. 精确岗位、source id、technology、canonical id 等继续进入结构化 metadata / 索引，不扩张全局 Label namespace。

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
Learning Discovery projection
├── Context-derived labels
└── authoritative Source-field-derived labels
```

只有 `status:source-ready` 且已经完成 Context review 的 InterviewNote 才进入整组 Learning Discovery projection。

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

精确岗位名称继续保存在 `InterviewContext.role.title`。

## 招聘类型

```text
recruitment:campus
recruitment:social
recruitment:internship
```

如果来源没有足够证据，保持 `unknown`，默认不生成 Label。

`reviewed-inference` 可以生成 Label，但必须在 InterviewContext 中保留推断 provenance。

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

## 发布时间年份

```text
source-year:YYYY
```

例如：

```text
source_published_at = 2023-09-18T21:48:28+08:00
↓
source-year:2023
```

`source-year` 直接从权威 `InterviewNote.source_published_at` 机器投影，不经过 AI 推断。

但它仍属于 Learning Discovery projection：不会因为刚捕获到发布时间，就单独把尚未完成 Context review 的 Issue 提前送入学习池。它应与该 InterviewNote 的整组 Learning Discovery Labels 一起同步。

如果 `source_published_at` 只有 `month_day` 或 `unknown`，不生成 `source-year`。

## 实际面试年份

```text
interview-year:YYYY
```

它回答的是“这场面试实际发生在哪一年”，不是“帖子在哪一年发布”。

只在 reviewed `InterviewContext.interview_occurred_at` 真正包含年份时生成，例如：

```text
interview_occurred_at = 2022-08-02
↓
interview-year:2022
```

而：

```text
interview_occurred_at = 09-18
年份未知
↓
不生成 interview-year
```

尤其禁止：

```text
interview_occurred_at = 09-18
source_published_at = 2023-09-18
↓
interview-year:2023   ❌
```

发布时间不能替代实际面试年份。

## 两个年份允许不同

例如：

```text
实际面试：2022-08-02
来源发布：2023-02-15
```

Learning Discovery 可以同时拥有：

```text
interview-year:2022
source-year:2023
```

两者没有冲突，因为回答的是不同问题。

## Outcome / 结果

默认禁止把结果作为普通 InterviewNote 的 Learning Discovery Label：

```text
result:rejected     # 不使用
result:passed       # 不使用
outcome:offer       # 不使用
```

结果 / 自评 / 外部反馈继续在 Source 时间线到达相应阶段后 reveal。

# 推荐组合

已完成 Source 与 InterviewContext review，进入可筛选学习池：

```text
type:interview-note
source:xhs
status:source-ready
company:kuaishou
role:backend
recruitment:campus
round:2
source-year:2023
```

如果实际面试年份也被可靠证明，再增加：

```text
interview-year:2023
```

可以自然支持：

```text
company:kuaishou role:backend round:2 source-year:2023
```

或：

```text
company:baidu interview-year:2022
```

# 禁止的 Label 模式

```text
year:2023              # 含义模糊，禁止
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
Source / Context 验证
    ↓
status:source-ready + Reviewed InterviewContext
    ↓
统一同步 Learning Discovery Labels
```

禁止：

```text
手工修改 Label
    ↓
反过来假设 InterviewContext / Source fact 有效
```

## 查询目标

Workflow 查询：

```text
type:interview-note status:source-review

type:interview-note status:blocked quality:image-missing
```

Learning 查询：

```text
type:interview-note company:kuaishou role:backend round:2 source-year:2023

type:interview-note company:kuaishou recruitment:campus

type:interview-note interview-year:2022 role:backend
```

成功标准是：用户能先筛出“我今天想练什么”，然后再进入 source-first sequential learning；同时发布时间与真实面试时间不会被混淆，结果和未来 Source 也不会因为 Label / title 提前泄漏。
