# SourceNote：来源采集对象

## 为什么需要 SourceNote

全量 XHS review 证明：一条来源帖子不等于一次真实面试事件。

真实来源至少包含以下情况：

```text
题库 / 教程 / 模拟面试
→ 0 InterviewNote

单场真实面经
→ 1 InterviewNote

一篇汇总多家公司 / 多轮独立面试
→ N InterviewNote
```

因此来源采集和 InterviewNote identity 必须分离。

## 定义

`SourceNote` 表示“一条外部来源帖子在固定 Source snapshot 中的采集身份”。

XHS identity：

```text
source_note_id = xhs-note:<note_id>
```

它负责：

- 固定来源系统与 external id；
- 保存 `source_published_at` / `source_edited_at`；
- 固定 `source_revision` 和 source repository ref；
- 登记 Raw / Source projection artifacts；
- 显式记录 zero-byte 等 intake anomaly；
- 保存 boundary review 状态；
- 从有年份证据的 `source_published_at` 统一投影 `source-year:YYYY`。

它不负责：

- 判断帖子是不是一次真实面试；
- 推断公司 / 岗位 / 招聘类型 / 轮次；
- 推断实际面试时间；
- 创建 InterviewNote-only Learning Discovery Labels；
- 预声明 InterviewNote identity。

## Issue contract

新建 SourceNote Issue 使用：

```text
<!-- source-note: id=xhs-note:<note_id> schema=source-note-issue.v1 -->
```

初始 labels：

```text
type:source-note
source:xhs
status:captured
boundary:pending
task:boundary-review
source-year:YYYY      # source_published_at 含已知年份时统一生成
migration:xhs-bulk   # 仅批量 intake/reconciliation 时
```

`source-year:*` 是 **Source Discovery**，不是 InterviewNote 学习结论：

```text
source_published_at = 2024-07-19...
→ source-year:2024

source_published_at = unknown / 只有 MM-DD
→ 不生成 source-year
```

`boundary:pending` 时禁止携带：

```text
company:*
role:*
recruitment:*
round:*
interview-year:*
result:*
outcome:*
```

这些需要真实 InterviewNote 或其 reviewed InterviewContext 才能成立。

## Boundary Review

审核结果只有四种：

```text
pending
not-interview
single-interview
multi-interview
```

关系：

```text
SourceNote
↓ Boundary Review
├─ not-interview       → 0 InterviewNote
├─ single-interview    → 1 InterviewNote
└─ multi-interview     → 2..N InterviewNote
```

在 `pending` 状态下：

```text
interview_note_ids = []
```

禁止根据标题、hashtag、OCR 或 Derived 分类提前创建 InterviewNote identity。

## Source integrity

SourceNote artifact 额外保存：

```text
byte_size
integrity = present | zero-byte
```

0-byte 文件仍然是来源仓库中的历史事实，可以登记，但必须明确标记为 `zero-byte`，不能把“路径存在”当作“图片可用”。

当前 intake anomaly 至少包括：

```text
zero-byte-artifacts
edited-before-published
```

异常只描述采集事实，不自动决定 boundary review 结果，也不自动修正来源时间。

## 与 InterviewNote 的关系

`InterviewNote` 从此表示“经过 boundary review 确认的一次真实面试事件”，而不是“一条来源帖子”。

```text
SourceNote
   └── boundary review
          └── InterviewNote*
                 ├── InterviewContext
                 ├── SourceSequenceManifest
                 ├── SourceQuestion
                 └── ExplorationSession
```

历史 Pilot #3/#4 在旧的一对一模型下已经建立正式 InterviewNote identity。它们作为兼容历史保留，不通过 bulk reconciliation 改写；新的批量 intake 不再复制这一旧假设。

## Reconciliation

`scripts/reconcile-xhs-source-notes.js` 只允许以下转换：

```text
已有 SourceNote
→ idempotent skip

migration:xhs-bulk + 旧 InterviewNote
→ 保留 Issue number，原地改为 SourceNote

正式 InterviewNote（没有 migration:xhs-bulk）
→ protected，绝不改写

尚未迁移的 XHS note
→ 创建新的 SourceNote
```

转换/新建时会根据 `source_published_at` 自动附加匹配的 `source-year:YYYY`；缺失的动态年份 Label 会在 apply 前确保存在。

这使迁移中断、重复执行以及旧批次继续产生少量 legacy intake 时，都可以通过 stable source identity 恢复，而不删除历史 Issue。

## Runtime SourceCapture intake（v2）

`source-note-issue.v1` 继续表示历史 `liqiangcc/xhs` Git snapshot intake；其 Git commit / blob provenance 不改写。

`source-note-issue.v2` 专门承接 `source-acquisition-runtime` 产生的 `source-capture.v1`。两种 revision identity 不得混用：

```text
v1 Git snapshot
  source_repository + source_repository_ref
  artifact.git_blob_sha = Git blob

v2 Runtime SourceCapture
  producer = liqiangcc/source-acquisition-runtime
  source_capture_schema = source-capture.v1
  storage_kind = runtime-artifact-store
  manifest_sha256 + manifest_byte_size
  artifact.git_blob_sha = null
  artifact.sha256 + byte_size = required
```

v2 artifact 使用逻辑引用，而不是部署机绝对路径：

```text
source-capture:<source_revision_id>#<artifact-relative-path>
```

这样 consumer 可以验证一个已经 materialize 的 SourceCapture revision，但不会依赖 Chrome、CDP、MCP Gateway、Secure MCP Tunnel 或 `/var/lib/...` 的具体部署路径。

### Intake Gate

`scripts/intake-source-capture.js` 默认只做 dry-run/project：

```text
manifest expected SHA-256
→ manifest identity
→ 每个 artifact path/ref 归一化
→ artifact size 重算
→ artifact SHA-256 重算
→ Raw / Source Projection / Derived provenance 保留
→ SourceNote v2 projection
→ SourceNote validator
```

任一 hash、size、identity 或临时访问参数约束失败时 fail closed。

当前允许保留的 producer provenance：

```text
raw_capture
raw_dom_snapshot
raw_context_capture
source_projection
derived_projection
```

它们不能被压平：特别是 `derived_projection` 不能反向覆盖或替代 Raw Source。

### Identity normalization

`source_id=xhs:<external_id>` 是稳定来源身份。`external_id` 如果作为冗余字段缺失，只允许从这个稳定 identity 精确恢复；若两者同时存在但不一致则 fail closed。

artifact locator 在 `source-capture.v1` Pilot 中存在 `ref` / `path` 两种字段名；adapter 只统一 locator 字段，不改变 artifact provenance、hash、size 或 sequence。

### Access boundary

如果 SourceCapture 登记：

```text
bare_canonical_replay = xhs_error_300031
live_rediscovery = success
stable_note_id_match = true
```

SourceNote v2 只能保存这个访问事实与 limitation，不能推断：

```text
已删除
私密
永久不可用
```

临时 XHS access parameters 不允许进入 canonical URL、SourceNote artifact ref 或 Issue body。

### Boundary Review 不变

v2 intake 只改变 Source revision provenance，不改变 SourceNote → InterviewNote 边界：

```text
source-capture.v1
→ SourceNote v2 (boundary:pending)
→ Boundary Review
→ 0..N InterviewNote
```

intake 阶段仍然禁止提前创建 InterviewNote identity、公司/岗位/轮次标签或答案类 Derived 数据。
