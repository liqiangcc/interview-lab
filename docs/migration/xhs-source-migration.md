# XHS 来源迁移协议

## 目的

本文定义如何把 `liqiangcc/xhs` 的历史材料迁入 Interview Lab，同时避免把历史 AI 解释错误升级成第一手 Source fact。

迁移首先是证据保存，不是知识清洗。

## 范围

```text
xhs 中的真实面经 Source case
        ↓
interview-lab InterviewNote identity
        ↓
一篇 InterviewNote 一个主 GitHub Issue
        ↓
引用可追溯的 Source Artifact
```

SourceQuestion、CanonicalQuestion、Analysis、Answer 和 Training 属于后续阶段，不得悄悄混进 Source migration。

## 旧 XHS 数据分层

### 第一手证据候选

```text
note_detail/*.html
    捕获的页面快照

downloaded_images/<note_id>/
    捕获的原图；必须实际检查文件是否有效

note_images/*_urls.txt
    在有效时可作为图片引用/顺序证据
```

**仅仅存在文件路径不代表 artifact 有效。** 0 字节图片必须视为缺失/损坏，不能当作已保存原图。

### Source projection

```text
note_json/*.json
note_desc/*.txt
```

Parser 生成文本不能冒充原始 bytes。只有 provenance 明确、fidelity 检查通过后，才可以作为 Issue 的 readable source projection。

### Derived interpretation

```text
note_img_txt/*.txt
note_structured/*.json
note_tagged/*.json
data/questions/*
review/*
```

这些仍有价值，但不能进入 Raw 区域冒充原作者内容。

## Stable identity

```text
interview_note_id = xhs:<note_id>
```

identity 独立于 Issue number、Issue title、公司/岗位推断、文件路径和迁移顺序。

## 一篇面经一个 Issue

新建记录使用：

```text
<!-- interview-note: id=xhs:<note_id> schema=interview-note-issue.v2 -->
```

如果 identity 已存在，必须 reconcile/update 已有 projection，而不是再创建 Issue。迁移必须幂等。

## 时间模型

`v2` 不再使用含混的单一 `source_time`。

每个 InterviewNote 独立记录：

```text
source_published_at
    来源发布时间

source_edited_at
    来源编辑时间

interview_occurred_at
    原文可直接证明的实际面试发生时间
```

例如一篇笔记可能同时是：

```text
interview_occurred_at = 2022-08-02
source_published_at   = 2023-02-15T20:39:34+08:00
source_edited_at      = 2023-02-16
```

这些事实不冲突，也不能互相覆盖。

### 时间精度

```text
exact   YYYY-MM-DD 或带时区 timestamp
month   YYYY-MM
year    YYYY
unknown null
```

禁止把 partial / unknown 时间伪造成精确日期。

## 正式时间线 / 迁移排序

用户学习目标是按照真实面试输入形成历史时间线，因此正式排序采用：

```text
1. interview_occurred_at（原文能直接证明时）
2. source_published_at（仅作为 fallback chronology）
3. 两者都 unknown → unknown-time backlog
```

`source_edited_at` 永远不作为实际面试时间线的替代值。

Planner 必须同时输出 chronology basis，例如：

```text
basis: interview_occurred_at
```

或：

```text
basis: source_published_at_fallback
```

这样 fallback 排序不会被误读成“实际面试发生日期”。

Issue number 只记录创建顺序，不代表面经时间线。

不得使用 Git commit time、local file modification time、capture time、Issue number、未定义的 source-id 编码或 AI 猜测来补时间。

## Issue 内容顺序

迁入 Issue 优先展示：

1. stable source identity
2. 三类时间事实及证据语义
3. 来源直接提供的元数据
4. 有 provenance 的 readable source projection
5. Raw Artifact 引用和 hash
6. 已知 capture limitation
7. 与 Raw 清楚隔离的 historical Derived links

不要因为 `note_structured` / `note_tagged` 中已有 company、role 等字段，就自动提升为第一手事实。

## Pilot 先于全量迁移

在协议和 Validator 被实际验证前禁止全量迁移。

初始 pilot：5 个代表性 Source case，覆盖 text-dominant、image-dominant、mixed、incomplete 和 boundary case。

Pilot 是机制验证例外，不用于建立正式全量时间线。

## Pilot 验收

每个 candidate 至少检查：

- stable identity 是否唯一
- 是否恰好一个主 Issue
- machine marker 是否正确
- readable Source 是否忠实对应 Raw Artifact
- Raw 与 Derived 是否视觉分离
- 三类时间是否保持独立、可追溯且不提高精度
- 缺失是否保持缺失，而不是被 AI 补全
- Label 是否符合 lifecycle
- 重复执行是否无 duplicate Issue
- 第二个 AI / 人是否能仅从 Issue 找到证据根

## 迁移生命周期

```text
发现历史来源
    ↓
解析 stable identity
    ↓
注册 / 检查 artifact 与时间事实
    ↓
create or reconcile Issue
    ↓
status:captured
    ↓
source integrity review
    ↓
status:source-review
    ↓
source-ready 或 blocked
    ↓
满足 Source lifecycle 后才能 close
```

## Fail-closed 条件

以下情况不能标记为 source-ready：identity 歧义、artifact 跨 note、readable text 无法追溯、预期 artifact 损坏但 limitation 未记录、必须靠 AI 编造补齐 Source、duplicate ownership 未解决。

应使用 `status:blocked` 或继续 `source-review`，并记录原因。

## 全量迁移开启条件

只有同时满足以下条件才允许全量迁移：Issue contract、Label taxonomy、SourceRevision policy 稳定；Pilot 证明幂等；Validator PASS；Pilot Issue 可用于 source-first reading；没有发现需要推翻 Raw/Derived 根边界的问题。

## 核心不变量

```text
迁移首先保存证据，再做解释。
历史 Derived 永远保持 Derived。
Unknown 保持 Unknown。
三类时间事实保持独立。
真实面试时间优先形成 chronology；来源发布时间只能显式 fallback。
Identity 稳定。
Migration 幂等。
```
