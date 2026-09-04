# SourceNote → InterviewNote Materialization

## 目的

Boundary Review 解决的是：一条 SourceNote 最终对应 0 / 1 / N 个 InterviewNote case。

当 SourceNote 已稳定为：

```text
boundary:single-interview
```

并声明唯一 InterviewNote identity 后，仍然**不能手工创建 InterviewNote Issue**。Materialization 负责把已审核 Source case 机械、可审计、幂等地物化成正式 `type:interview-note` Issue。

## 输入门禁

Materialization request 必须绑定：

- SourceNote repository / Issue number / SourceNote id；
- SourceNote body SHA-256；
- `boundary:single-interview`；
- exact SourceRevision id；
- SourceCapture v2 manifest SHA，或历史 v1 fixed source repository ref。

调用方不能指定 InterviewNote id。合法 identity 始终重新计算：

```text
<source.system>:<source.external_id>
```

并要求与 SourceNote `boundary_review.interview_note_ids[0]` 完全一致。

## Duplicate / ownership gate

创建前扫描全部 Issue 的 InterviewNote machine marker：

```text
0 owner
    → create candidate

1 owner + exact source/revision binding
    → existing / idempotent

1 owner + conflicting binding
    → fail closed

>1 owner
    → HARD duplicate ownership conflict
```

不能因为 title、Issue number 或相似正文判断重复。

## InterviewNote v2 投影

Materialization 只做 Source-preserving mechanical projection：

- `source`：从 SourceNote 原样复制；
- `source_revision.id/captured_at`：原样复制；
- `source_published_at` / `source_edited_at`：原样复制；
- `interview_occurred_at`：没有直接 Source evidence 时保持 `unknown`；
- Raw / Source projection refs 和 hashes 保持不变；
- SourceNote artifact kind 若不在 InterviewNote v2 enum 内，machine record 中使用 `other`，原始 kind/sequence/size/content-type 继续由 SourceNote 保持权威；
- SourceNote 的原始标题、可读 Source projection、限制继续作为 Source 内容展示。

Materialization 不做：

- InterviewContext；
- company / role / recruitment / round 推断；
- outcome；
- SourceQuestion 拆分；
- CanonicalQuestion；
- Answer；
- OCR 提升；
- 技术正确性修订。

## 初始 lifecycle

新 InterviewNote 初始 labels：

```text
type:interview-note
source:<system>
status:captured
```

`captured` 仅表示可获得的第一手资料已物化，不代表 Source review 完成。

## Apply

默认命令只 dry-run：

```text
node scripts/plan-source-note-interview-materialization.js --request <request.md>
```

`--apply` 时：

1. 读取 live SourceNote / comments / repository Issue ownership；
2. 完整 plan；
3. 写入前再次读取并重新 plan；
4. 仅当 ownership=0 时创建 InterviewNote Issue；
5. 重新读取新 Issue；
6. 运行 InterviewNote validator；
7. 再次扫描 ownership，必须 exactly 1；
8. 在 SourceNote 写 durable materialization receipt/backlink；
9. final re-plan 必须进入 `already_materialized`。

## Crash recovery

若 Issue 已创建但 receipt 写入失败：

```text
1 exact owner + no receipt
```

下一次 apply 不再创建第二个 Issue，而是验证 existing Issue 的 identity/source/revision 后补写 receipt。

若 receipt 已存在但 InterviewNote owner 不存在，则 fail closed；不自动重建。

## Receipt

成功后 SourceNote comment 写：

```text
source-note-interview-materialized.v1
```

至少绑定：

- materialization id；
- request SHA-256；
- SourceNote id / body SHA；
- SourceRevision；
- manifest SHA 或 fixed source ref；
- InterviewNote id；
- InterviewNote Issue number；
- InterviewNote body SHA；
- materialized_at。

## 核心不变量

```text
先 boundary review，再 materialize。
identity 由 Source 推导，调用方不能指定。
create 前必须检查 machine-marker ownership。
SourceNote 是 capture provenance 根，InterviewNote 不反向改写 Source。
unknown 不提高精度。
materialization 不等于 source-ready。
materialization 不进入 Interview-derived 分析。
相同 request 重跑不得创建第二个主 Issue。
```

## GitHub write-after-list consistency

GitHub 新建 Issue 后，按 Issue number 直接读取可能已经成功，但仓库级 Issue list / machine-marker ownership scan 仍可能短暂返回旧快照。Post-create ownership gate 因此采用有界 retry/backoff：仅 `0 owner` 允许重试；一旦观察到错误 sole owner 或多个 owner，立即 fail closed。重试耗尽仍不可见时同样失败，并依赖 `1 exact owner + no receipt` 的 crash-recovery 路径恢复，而不是再次创建 Issue。
