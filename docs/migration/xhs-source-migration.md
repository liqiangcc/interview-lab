# XHS 来源迁移协议

## 目的

本文定义如何把 `liqiangcc/xhs` 的历史材料迁入 Interview Lab，同时避免把历史 AI 解释错误升级成第一手 Source fact。

迁移首先是证据保存，不是知识清洗。

## 范围

初始迁移目标：

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

历史仓库存在多代数据，不能视为等价。

### 第一手证据候选

最接近 Raw Source：

```text
note_detail/*.html
    捕获的页面快照

downloaded_images/<note_id>/
    捕获的原图；必须实际检查文件是否有效

note_images/*_urls.txt
    在有效时可作为图片引用/顺序证据
```

每个 artifact 都应记录实际类型和 provenance。

**仅仅存在文件路径不代表 artifact 有效。** 例如 0 字节图片必须视为缺失/损坏，而不能当作已保存原图。

### Source projection

下面内容可能忠实展示 Source，但本质是 parser/extraction 输出，必须可追溯到 Raw：

```text
note_json/*.json
note_desc/*.txt
```

Parser 生成的文本不能冒充原始 bytes。只有在 provenance 明确、fidelity 检查通过后，才可以作为 Issue 的 readable source projection。

### Derived interpretation

以下属于 Derived，不是 Raw Source：

```text
note_img_txt/*.txt       OCR / 图片解释
note_structured/*.json   结构化元数据、问题提取
note_tagged/*.json       分类/标签结果

data/questions/*         后续 Question / CanonicalQuestion
review/*                  Answer / Review state
```

这些历史派生数据仍然有价值，可以以后作为 comparison / regression input，但不能复制到 Raw 区域冒充原作者内容。

## Stable identity

初始 InterviewNote identity 使用来源系统 + 稳定 external id：

```text
interview_note_id = xhs:<note_id>
```

identity 必须独立于：

- Issue number
- Issue title
- company inference
- role inference
- 文件路径
- 迁移顺序

## 一篇面经一个 Issue

创建前必须按 machine marker 查询：

```text
<!-- interview-note: id=xhs:<note_id> schema=interview-note-issue.v1 -->
```

如果 identity 已存在，必须 reconcile/update 已有 projection，而不是再创建一个 Issue。

迁移必须幂等。

## Issue 内容顺序

迁入的 InterviewNote Issue 应优先展示：

1. stable source identity
2. 来源直接提供的元数据
3. 有 provenance 的 readable source projection
4. Raw Artifact 引用和 hash
5. 已知 capture limitation
6. 与 Raw 清楚隔离的 historical Derived links

不要因为 `note_structured` / `note_tagged` 中已有 company、role 等字段，就把它们自动提升为第一手事实。

Issue title 可以为了导航使用可验证的来源标题，也可以使用明确标注的 Derived display value，但 title 永远不承担权威 provenance。

## 时间顺序

Pilot 通过后，全量 Source migration 按可辩护的来源时间从旧到新进行。

时间证据优先级：

1. 捕获页面直接显示的 source publication/display timestamp
2. 来源直接提供的部分日期 / 年份
3. 否则 `unknown-time`

不得用以下信息伪造 Source 时间：

- Git commit time
- local file modification time
- capture time
- Issue number
- source id 编码（除非 Source contract 明确定义）
- AI 根据上下文猜测的日期

### Partial / Unknown

保持不确定性：

```text
2023-08-02    来源可以确认到日
2023-08       只能确认到月
2023          只能确认到年
unknown       无可靠来源时间
```

不能为了排序把 `2023` 伪造成 `2023-01-01`。

内部 planner 可以生成稳定 sort key，但不能把 sort key 持久化成虚假的 Source fact。

推荐顺序：

```text
known time：oldest → newest
partial time：只按可确认精度排序
unknown-time：进入独立 backlog
```

Issue number 只记录创建顺序，不代表面经时间线。

## Pilot 先于全量迁移

在协议和 Validator 被实际验证前禁止全量迁移。

初始 pilot：

```text
5 个代表性 source case
```

按来源条件选择，而不是追求数量：

- text-dominant
- image-dominant
- mixed text + image
- incomplete source
- ambiguous / legacy-derived boundary case

Pilot 是机制验证例外，不用于建立正式全量时间线。

## Pilot 验收

每个 candidate 至少检查：

- stable identity 是否唯一
- 是否恰好一个主 Issue
- machine marker 是否正确
- readable Source 是否忠实对应 Raw Artifact
- Raw 与 Derived 是否视觉分离
- 缺失是否保持缺失，而不是被 AI 补全
- Label 是否符合 lifecycle
- 重复执行是否无 duplicate Issue
- 第二个 AI / 人是否能仅从 Issue 找到证据根
- 完成 Source migration 是否不依赖修改下游 Knowledge

## 迁移生命周期

```text
发现历史来源
    ↓
解析 stable identity
    ↓
注册 / 检查 artifact
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

## Derived 数据保留

历史 `note_structured`、`note_tagged`、Question、CanonicalQuestion、Answer 不因为不是 Raw 就删除。

未来可以作为：

- candidate derived record
- regression comparison
- extraction-review input
- knowledge migration input

但永远必须与 Raw Source 区分。

## Fail-closed 条件

以下情况不能标记为 source-ready：

- source identity 有歧义
- artifact 疑似来自多个 note
- readable text 无法追溯 Source Artifact / projection
- 预期 artifact 损坏且 limitation 未明确记录
- 必须靠 AI 编造才能补齐 Source
- stable identity duplicate ownership 未解决

应使用 `status:blocked` 或继续 `source-review`，并记录原因。

## 全量迁移开启条件

只有同时满足以下条件，才允许全量按时间迁移：

1. Issue contract 稳定
2. Label taxonomy 稳定
3. SourceRevision policy 稳定
4. Pilot 证明 migration idempotent
5. Repository invariants / validators PASS
6. Pilot Issue 真正可以用于 AI source-first reading
7. Pilot 未发现需要推翻 Raw/Derived 根边界的问题

## 核心不变量

```text
迁移首先保存证据，再做解释。
历史 Derived 永远保持 Derived。
Unknown 保持 Unknown。
Identity 稳定。
Migration 幂等。
Pilot 通过后，全量按可辩护 Source chronology 迁移。
```
