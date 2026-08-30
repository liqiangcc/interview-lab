# InterviewNote Issue 契约

## 目的

一篇真实面经通过一个主 GitHub Issue 管理。

```text
1 InterviewNote
↕ 1:1
1 GitHub Issue
```

Issue 是该 case 面向 AI / 人的主要操作文档；不可变 Raw Artifact 仍然是证据根。

## 标题

推荐格式：

```text
[XHS] <来源原始标题或可读描述> · <面试时间 / 来源时间 / unknown> · <短 source id>
```

标题只用于导航，不承担领域 identity。标题中的时间必须注明语义；不能把来源发布时间显示成实际面试时间。

如果公司、岗位、轮次来自 Derived 推断，而不是来源直接提供，不得通过标题让它看起来像已确认的 Source fact。

## Machine marker

新建 InterviewNote Issue 顶部必须包含稳定隐藏 marker：

```text
<!-- interview-note: id=<interview-note-id> schema=interview-note-issue.v2 -->
```

用于幂等同步、重复检测和机器 identity 解析。历史 `v1` Issue 只为兼容读取，不再用于新建记录。

## Machine record

Issue 中应包含一个隐藏的 `interview-note-record` JSON block。字段名、enum、schema version 保持英文稳定。

`v2` 明确拆分三种时间事实：

```text
source_published_at
    来源内容首次发布/机器发布时间

source_edited_at
    来源页面明确显示或机器字段证明的编辑时间

interview_occurred_at
    原文能够直接证明的实际面试发生时间
```

示例：

```text
<!-- interview-note-record
{
  "schema_version": "interview-note-issue.v2",
  "interview_note_id": "xhs:<note_id>",
  "source": {...},
  "source_revision": {...},
  "source_published_at": {"precision": "exact", "value": "2023-02-15T20:39:34+08:00"},
  "source_edited_at": {"precision": "exact", "value": "2023-02-16"},
  "interview_occurred_at": {"precision": "exact", "value": "2022-08-02"},
  "artifacts": [...],
  "limitations": [...]
}
-->
```

不能继续使用语义含混的单一 `source_time` 字段创建新记录。

Machine block 不用于替代人类可读正文。

## 时间事实规则

每个时间字段都显式记录精度：

```text
exact   YYYY-MM-DD 或带时区 timestamp
month   YYYY-MM
year    YYYY
unknown value=null
```

禁止为了排序提高时间精度。例如只知道 2023 年时不能持久化为 `2023-01-01`。

三种时间可以同时存在，且可能相差很远。典型情况：作者在 2023 年重新发布一篇 2022 年真实面经。

## 可读正文必需章节

推荐固定顺序：

```text
## 来源身份
## 原始标题
## 原始正文
## 原始附件
## 来源限制
## 派生链接
```

### 来源身份

可包含来源直接提供或 capture 层确认的信息，例如：

- source system
- external source id
- original URL（如有）
- SourceRevision
- capture timestamp
- 来源发布时间 / 编辑时间
- 原文明确给出的实际面试发生时间

这三类时间必须保持语义独立。

### 原始标题

只展示能够从第一手来源直接验证的标题。

如果只有 parser 或 Derived 推断结果，必须明确其 provenance，不能升级为 Raw title。

### 原始正文

忠实展示来源正文或经过 provenance 校验的 readable source projection。

不得：

- 润色原文
- 纠正技术结论
- 把陈述改成问题
- 补写缺失内容
- 把 OCR 与原始正文静默合并

如果使用 projection，必须明确它不是 Raw bytes，并保持可追溯。

### 原始附件

引用 HTML、JSON、图片、hash 等不可变 artifact。大体积内容应引用，不要全部复制进 Issue。

如果历史文件存在但实际为空、损坏或不可用，必须明确标记，不能仅因路径存在就视为有效证据。

### 来源限制

显式记录已知缺失、不确定性和采集限制，例如：

- 原图缺失
- URL 未恢复
- 某个时间字段 unknown
- 正文可能截断

Unknown 必须保持 unknown，不能为了流程顺畅而猜测补全。

### 派生链接

Derived 内容必须与 Raw 清晰隔离，例如：

- SourceQuestion
- CanonicalQuestion
- ExplorationSession
- 历史 `note_structured` / `note_tagged`

不得让 Derived 在视觉上成为“原始面经的一部分”。

## Label

Label taxonomy 的唯一 SSOT：

- `config/issue-labels.json`
- `docs/issues/label-taxonomy.md`

典型 InterviewNote：

```text
type:interview-note
source:xhs
status:source-review
quality:image-missing
task:source-review
```

Label 只是查询和状态投影，不是领域有效性的 proof。

## Comment

Comment 用于记录：

- source-review finding
- recovery attempt
- uncertainty / decision rationale
- ExplorationSession 摘要
- commit / report 链接

Comment 不得成为“修订后的 Raw Source”替代品。

## Close 语义

正常关闭 InterviewNote Issue 只表示：

> 第一手来源 case 已达到稳定的 `source-ready` 完成状态。

不表示 SourceQuestion、Canonical mapping、Answer 或 learner mastery 完成。

## Reopen 语义

只因 Source 层原因 reopen，例如找到缺失的第一手资料、identity 错误、artifact 损坏、更好的 SourceRevision、截断或 duplicate ownership 变化。

下游知识或训练变化不 reopen Source lifecycle。

## 幂等要求

迁移和同步在创建 Issue 前必须按稳定 InterviewNote identity / machine marker 查询。

重复执行必须 reconcile 已有 Issue，而不是创建 duplicate。

## 核心不变量

```text
一篇真实面经一个主 Issue。
Issue 是操作文档，不是唯一证据存储。
Raw 与 Derived 必须可见分离。
来源发布时间、来源编辑时间、面试发生时间互不替代。
Machine identity 独立于标题和 Issue number。
迁移和同步必须幂等。
```
