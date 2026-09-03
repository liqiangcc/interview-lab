# InterviewContext 面试上下文

## 目的

`InterviewContext` 表示一篇真实 InterviewNote 在**正式学习之前**经过审核的基础面试上下文。

它回答：

```text
这是谁的面试？
什么岗位族？
校招 / 社招 / 实习？
第几轮？
什么时候？
```

它不回答：

```text
最后过没过？
作者觉得自己表现怎样？
面试官给了什么结果反馈？
```

后者属于 Outcome / 后续 Source 时间线，默认不能在学习前剧透。

## 生命周期位置

推荐流程：

```text
Raw capture
↓
InterviewNote / Source review
↓
InterviewContext extraction
↓
Context review
↓
Learning Discovery Labels
↓
进入可筛选学习池
↓
ExplorationSession
```

Context extraction 属于 Derived，不修改 Raw Source。

## v1 字段

```text
context_id
interview_note_id
source_revision_id
review_status
reviewed_at
company
role
recruitment_type
round
interview_occurred_at
outcome_visibility
```

### Company

```text
company.id
company.display_name
company.basis
company.evidence_refs
```

`company.id` 是稳定 normalized machine id，例如：

```text
kuaishou
alibaba
tencent
bytedance
```

显示名称保留中文或来源常用名称。

### Role

`role.family` 只做粗粒度学习分类：

```text
backend
frontend
client
algorithm
data
qa
product
other
unknown
```

精确岗位放在：

```text
role.title
```

例如：

```text
Java 后端开发
商业化服务端开发
```

### Recruitment type

```text
campus
social
internship
unknown
```

### Round

```text
1..9
hr
final
unknown
```

### Interview time

时间继续保留已有 precision：

```text
exact
month
year
month_day
unknown
```

不能因为来源发布时间或招聘标签存在，就补造实际面试年份。

## Evidence basis

每个基础事实必须显式区分：

```text
source-explicit
reviewed-inference
unknown
```

### source-explicit

来源直接表达该事实。

例如：

```text
Raw title: 快手二面
↓
company = kuaishou
round = 2
```

### reviewed-inference

来源没有逐字给出标准 machine value，但有足够证据，经 review 后接受映射。

例如：

```text
Source topic: #24秋招
↓
reviewed inference
↓
recruitment_type = campus
```

这里 Label 可以投影为：

```text
recruitment:campus
```

但 Context 必须继续保留 `basis=reviewed-inference`，不能伪装成来源逐字写了“校招”。

### unknown

证据不足就保持 unknown。

Unknown 默认不生成 Learning Discovery Label。

## Learning Discovery projection

只有 `review_status=reviewed` 的 Context 才能驱动学习标签。

当前投影：

```text
company.id
→ company:<id>

role.family
→ role:<family>

recruitment_type.value
→ recruitment:<value>

round.value
→ round:<value>
```

Interview time 暂不默认投影成 GitHub Label。

## Non-spoiler title

学习 Issue 的展示标题应使用 Context 生成 non-spoiler projection，而不是直接复制可能包含“凉经 / offer / 挂了”等结果信息的原始标题。

例如 Pilot #3：

```text
Raw title:
9.18快手五战二面凉经

Non-spoiler Issue title:
[快手] 后端 · 校招 · 二面 · 09-18 · 6508552c
```

原始标题仍完整保存在 Raw Source 区域，不被改写。

## Outcome sealed

v1 固定：

```text
outcome_visibility = sealed-until-source-reveal
```

`InterviewContext` 不允许保存：

```text
result
outcome
self_assessment
external_feedback
```

这些信息即使系统后台已经从完整 Source 中识别，也不能进入 pre-learning Context 或普通 Learning Discovery Labels。

当 sequential Source 真正走到 outcome position 时，再按 Source 时间线 reveal。

## 用户体验

学习前允许展示：

```text
公司：快手
岗位：后端
招聘类型：校招
轮次：二面
面试时间：09-18
```

不展示：

```text
结果：未通过
```

然后直接进入第一条真实 Source。

## 核心边界

```text
InterviewContext
= Derived pre-learning discovery metadata

Raw Source
= Evidence root

Learning Labels
= Reviewed InterviewContext projection

Outcome
= sealed future Source
```
