# Issue Label 分类体系

## 目的

Label 是 Interview Lab 的低基数查询索引和工作流索引，让人和 AI 不必解析所有 Issue body 就能快速找到下一项工作。

Label 属于操作元数据。它不能单独证明 Source 完整、Knowledge 正确、Answer 合格或学习者已掌握。

## 设计规则

1. Label 必须低基数、可复用。
2. 不同 Label family 表达正交维度，不把多个含义塞进一个 Label。
3. 公司、岗位、年份、source id、technology、canonical id 等高基数事实进入结构化正文或生成索引，不进入全局 Label namespace。
4. lifecycle Label 是验证后状态的 projection，手工加 Label 不能绕过 Validator。
5. 对互斥 family，一个 Issue 正常最多只有一个 active Label。

## 核心 family

### 对象类型

```text
type:interview-note
type:canonical-question
```

初期优先实现 `type:interview-note`。其他类型必须先有正式 Issue contract。

### 来源

```text
source:xhs
source:nowcoder
source:maimai
source:manual
source:other
```

Source Label 表示数据来源平台，不表示被面试公司。

### InterviewNote 生命周期

InterviewNote Issue 处于 open 状态时，正常只应有一个：

```text
status:discovered
status:captured
status:source-review
status:source-ready
status:blocked
```

GitHub Close 是额外的操作事件，不另造领域状态。

### 来源质量信号

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

### 工作意图

```text
task:source-review
task:source-recovery
task:artifact-check
task:identity-review
```

Task Label 只表示下一步工作，不表示长期领域事实。

### 优先级

```text
priority:P0
priority:P1
priority:P2
```

这里只表示工作调度优先级，不等同于题目重要性或真实面试频率。

## 推荐组合

刚发现：

```text
type:interview-note
source:xhs
status:discovered
```

已 capture，等待来源审核：

```text
type:interview-note
source:xhs
status:source-review
task:source-review
```

因原图缺失 blocked：

```text
type:interview-note
source:xhs
status:blocked
quality:image-missing
task:source-recovery
```

来源完成、准备关闭：

```text
type:interview-note
source:xhs
status:source-ready
```

## 禁止的 Label 模式

不要创建无限增长的 taxonomy：

```text
company:alibaba
role:java-backend
year:2023
note:630e2e...
tech:redis
canonical:cq_...
```

也不得把 AI 推断伪装成 Source fact。例如 AI 猜测是二面，不应生成一个暗示“来源明确写了二面”的 Source-level Label。

## 状态转换规则

正确方向：

```text
请求操作
    ↓
领域 / Source 验证
    ↓
正式状态变化
    ↓
同步 Issue Label
```

禁止：

```text
手工修改 Label
    ↓
反过来假设领域状态有效
```

## 查询目标

Label 应让这些查询简单稳定：

```text
type:interview-note status:source-review

type:interview-note status:blocked quality:image-missing

type:interview-note source:xhs status:source-ready
```

成功标准是：AI 能快速找到下一项工作，但仍必须读取 Issue 与 Source Evidence 才能做实质判断。
