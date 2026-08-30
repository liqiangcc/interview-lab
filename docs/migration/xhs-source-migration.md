# XHS 来源迁移协议

## 目的

本文定义如何把 `liqiangcc/xhs` 的历史材料迁入 Interview Lab，同时避免把历史 AI 解释错误升级成第一手 Source fact。迁移首先是证据保存，不是知识清洗。

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
downloaded_images/<note_id>/
note_images/*_urls.txt
```

`downloaded_images` 必须实际检查文件有效性。0 字节图片不能当作原图证据；非空图片应登记 Git blob / size，并在需要时继续做内容完整性审核。

### Source projection

```text
note_json/*.json
note_desc/*.txt
```

Parser 生成文本不能冒充原始 bytes。

### Derived interpretation

```text
note_img_txt/*.txt
note_structured/*.json
note_tagged/*.json
data/questions/*
review/*
```

尤其 `note_img_txt` 是 OCR Derived。即使正文主要信息只存在于图片、OCR 看起来高度可信，也不得把 OCR 直接提升为 Raw Source。它必须追溯到对应原图 artifact。

## Stable identity

```text
interview_note_id = xhs:<note_id>
```

identity 独立于 Issue number、title、公司/岗位推断、文件路径和迁移顺序。

## 一篇面经一个 Issue

新建记录使用 `interview-note-issue.v2` machine marker。identity 已存在时必须 reconcile，不创建 duplicate。

## 时间模型

独立记录：

```text
source_published_at
source_edited_at
interview_occurred_at
```

### 时间精度

```text
exact      YYYY-MM-DD 或带时区 timestamp
month      YYYY-MM
year       YYYY
month_day  MM-DD
unknown    null
```

`month_day` 用于“9.18”这类原文明确提供月日但没有可证明年份的事实。不能因为来源发布时间、秋招标签或其他上下文看起来一致，就自动补年份。

## 正式时间线 / 迁移排序

正式排序采用：

```text
1. interview_occurred_at，且 precision 包含可排序年份（exact/month/year）
2. source_published_at 作为显式 fallback
3. 否则 unknown-time backlog
```

如果 `interview_occurred_at` 是 `month_day`，保留该 Source fact，但因为缺少年份，不能独立参与跨年排序；planner 必须显式回退并记录 `basis: source_published_at_fallback`。

`source_edited_at` 永远不替代实际面试时间线。

不得使用 Git commit time、local file modification time、capture time、Issue number、未定义 source-id 编码或 AI 猜测补时间。

## Issue 内容顺序

优先展示 stable identity、三类时间及证据语义、来源元数据、可追溯 readable projection、Raw Artifact/hash、已知 limitation、清楚隔离的 Derived links。

## Pilot 先于全量迁移

初始 Pilot 5 个代表性 case，覆盖 text-dominant、image-dominant、mixed、incomplete、boundary case。Pilot 用于发现机制问题，不用于追求迁移数量。

## Pilot 验收

每个 candidate 至少检查：stable identity 唯一、一个主 Issue、marker 正确、readable Source 可追溯、Raw/Derived 分离、三类时间不混淆且不提高精度、图片 bytes 是否真实有效、OCR 是否保持 Derived、缺失不被 AI 补全、Label 符合 lifecycle、重复执行无 duplicate、第二个读者能找到证据根。

## 迁移生命周期

```text
发现历史来源
→ 解析 stable identity
→ 注册 / 检查 artifact 与时间事实
→ create or reconcile Issue
→ captured
→ source-review
→ source-ready 或 blocked
```

## Fail-closed 条件

identity 歧义、artifact 跨 note、readable text 无法追溯、预期 artifact 损坏但 limitation 未记录、必须靠 AI 编造 Source、duplicate ownership 未解决时，不得 source-ready。

## 全量迁移开启条件

Issue contract、Label taxonomy、SourceRevision policy 稳定；Pilot 证明幂等；Validator PASS；Pilot Issue 可用于 source-first reading；没有需要推翻 Raw/Derived 根边界的问题后，才允许全量迁移。

## 核心不变量

```text
迁移首先保存证据，再做解释。
Historical Derived 永远保持 Derived。
Unknown / partial time 保持原始精度。
只知道月日，不猜年份。
OCR 不能替代原图。
真实面试时间优先 chronology；不足以排序时来源发布时间只能显式 fallback。
Identity 稳定。
Migration 幂等。
```
