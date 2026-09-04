# InterviewNote Source Review transition

## 目的

`InterviewNote` 被创建为 `status:captured` 只表示当前可获得的第一手 Source 已登记；它还没有完成 Source integrity / provenance 审核。

正式生命周期保持：

```text
status:captured
    ↓
status:source-review + task:source-review
    ↓
status:source-ready
    或
status:blocked + task:source-recovery
```

禁止把 `captured` 直接当作 `source-ready`。

## Request

机器 request：

```text
interview-note-source-review-transition.v1
```

必须固定：

- InterviewNote Issue / stable identity；
- InterviewNote body SHA-256；
- 初始 lifecycle=`captured`；
- SourceRevision id；
- SourceNote Issue + body SHA-256；
- Runtime SourceCapture manifest SHA-256；
- durable review evidence comment；
- decision=`source-ready|blocked`；
- explicit checks / limitations。

## Required checks

```text
source_identity
source_revision_binding
artifact_reference_integrity
raw_projection_traceability
known_limitations_recorded
duplicate_ownership
no_fabrication
```

Planner 不只相信 request 里的 `pass/fail`，而是根据 live InterviewNote、SourceNote 和 repository ownership 自己重新计算这些结果。调用方声明与机器证据不一致时 fail closed。

`source-ready` 要求所有 required checks 都 PASS。

`blocked` 要求至少存在一个真实 FAIL；不能在所有检查都通过时任意把 Source 标成 blocked。

## Runtime SourceNote binding

Runtime materialization case 以 SourceNote 为 provenance 根：

- InterviewNote identity 必须等于 SourceNote `single-interview` 唯一 identity；
- InterviewNote 与 SourceNote 必须绑定同一个 SourceRevision；
- manifest SHA 必须等于 SourceNote 登记的 `source-capture.v1` manifest；
- 每一个 InterviewNote artifact `ref/sha256/provenance` 必须能回到 SourceNote artifact；
- Source projection 的 `derived_from` 必须能解析到登记的 Raw capture；
- SourceNote 的已知 limitations 不得在 InterviewNote 中丢失；
- Source 发布时间/编辑时间机械保持；没有直接证据时 `interview_occurred_at` 继续 unknown。

## 两阶段 durable apply

一次 `--apply` 会显式写两个 lifecycle 状态：

```text
captured
→ source-review + task:source-review
→ final decision
```

这样 GitHub live state 与文档状态机一致。

Crash recovery：

- 已停在 `source-review`：相同 request 继续完成；
- 已到 final，但 receipt 未写：只补 receipt；
- final + receipt 已存在：返回 `already_applied=true`；
- body / revision / SourceNote / manifest / ownership 漂移：拒绝继续。

## Receipt

成功后写：

```text
interview-note-source-review-applied.v1
```

Receipt 固定 transition/request digest、InterviewNote、SourceNote、SourceRevision、manifest、decision、reviewed_at 和 applied_at。

## Non-goals

Source Review 只治理第一手 Source。

不会在本阶段：

- 创建 InterviewContext；
- 增加 company/role/recruitment/round；
- 拆 SourceQuestion；
- 生成 CanonicalQuestion / Answer；
- 推断 outcome；
- 用 OCR / Derived 反向补 Raw Source。
