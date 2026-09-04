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

创建前先按完整 InterviewNote identity 调用 repository-scoped GitHub Search，再只直读 Search 返回的候选 Issue，并在候选 Issue 上验证 InterviewNote machine marker：

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

不能因为 title、Issue number 或相似正文判断重复；Search 不完整、分页超限或候选数量不一致时 fail closed。生产 CLI 不执行全仓 Issue body 扫描。

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
source-note-interview-materialized.v1（single）或 `source-note-interview-materialized.v2`（multi child，必须绑定 `case_key`）
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

## 批量 preflight（Issue #922）

批量编排只提供默认 dry-run 的 planner：

```text
SourceNote inventory
↓
逐条校验 SourceNote / Boundary Review
↓
not-interview → 0 InterviewNote
single-interview → 生成单对象 materialization request
multi-interview / pending / invalid / duplicate → blocked
↓
逐条调用现有 materialization planner
↓
输出 materialized candidates / already materialized / receipt repair / blocked 汇总
```

入口：

```text
node scripts/plan-xhs-interview-note-materialization-batch.js \
  --repository liqiangcc/interview-lab \
  --report issue-922-materialization-report.json
```

这个入口不接受 `--apply`，也不创建、修改或评论 GitHub Issue。`ready_for_apply` 只有在依赖 gate（#917、#920、#921 均已关闭、验收为 pass 且有 durable evidence）通过且没有 hard-block case 时才为 true；预期的 `boundary-review-required` pending 会保留在 recovery 队列，不阻止其他已批准 case 的后续授权 apply。依赖未满足或存在其他 hard-block 时，即使 planner 能生成 request，也不得执行 mutation。

受控 apply 由独立 runner 执行，必须同时提供 `--apply --confirm-dry-run --authorization-digest <dry_run_sha256>`；runner 重新校验 report digest、`ready_for_apply`、candidate 行数和 action counts。默认 `--pause-ms 2200`，写前逐项 reread SourceNote、comments 与 exact ownership，写后 validator + bounded ownership retry + final re-plan。每项完成后原子更新 `<report>.apply-progress.json`；崩溃后依靠已有 owner/receipt 和 progress digest 自然恢复，不重复创建。

若该项没有独立的 InterviewNote Source Review evidence，runner 不复用 Boundary Review comment，而是在对应 InterviewNote 上幂等写入 `interview-note-source-review-blocked.v1`、`status:blocked` 和 `task:source-recovery`。只有后续提供逐条真实 evidence，才能另行运行 Source Review transition 进入 `source-ready`。

批量 planner 不把 Boundary Review evidence 直接当作 InterviewNote Source Review evidence。物化后仍必须使用 `interview-note-source-review-transition.v1`，并由该 transition 独立证明 `source-ready` 或 `blocked`；`source_ready` 计数不会因 InterviewNote 已物化而增加。

`multi-interview` 使用 #921 已批准的 `interview_note_cases[].case_key`。每个 child 生成独立的 `source-note-interview-materialization.v2` request；child identity 重新由 SourceNote source + case_key 派生，调用方不能提交 `interview_note_id`。每个 child 有独立 materialization id、ownership gate 和 SourceNote receipt/backlink。

批量 CLI 对 25 个 single identity + 5 个 multi child identity 做 exact candidate search，默认每次 Search 间隔 `2200ms`，可通过 `--search-pause-ms` 配置但不得低于 `2100ms`。`not-interview` identity 也必须进入 exact candidate search，用于发现错误已有 owner，但始终为零物化；测试覆盖已有 owner 时 fail closed。`--interview-issues-file` 必须有 repository/scope、completeness 和 `issues_sha256` proof，且仅测试用途，永远不会让 report `ready_for_apply`。

依赖 gate 的每项必须显式声明 `issue_number`、`state=closed`、`acceptance=pass`、`evidence_schema=issue-dependency-acceptance.v1`、machine-marker anchor URL 和 `acceptance_evidence` URL。apply 会从 `repos/OWNER/REPO/issues/comments/COMMENT_ID` 读取 anchor，校验返回 `issue_url` 精确归属依赖 Issue，并严格解析唯一的：

```text
<!-- issue-dependency-acceptance
{"schema_version":"issue-dependency-acceptance.v1","issue_number":N,"acceptance":"pass","accepted_by":"...","acceptance_evidence":"https://github.com/OWNER/REPO/issues/N#issuecomment-ID"}
-->
```

关键词、人类叙述或 artifact 自报 `pass` 均不足以通过 live dependency gate。

Materialization 后的 InterviewNote 必须单独使用 `interview-note-source-review-transition.v1`；multi child 的 Source Review request 绑定 `case_key`，不能把 SourceNote Boundary evidence 直接当作 InterviewNote evidence。只有独立 review evidence 通过后才可进入 `source-ready`，否则进入带失败 checks 与 recovery task label 的 `blocked`。

## GitHub write-after-list consistency

GitHub 新建 Issue 后，按 Issue number 直接读取可能已经成功，但仓库级 Issue list / machine-marker ownership scan 仍可能短暂返回旧快照。Post-create ownership gate 因此采用有界 retry/backoff：仅 `0 owner` 允许重试；一旦观察到错误 sole owner 或多个 owner，立即 fail closed。重试耗尽仍不可见时同样失败，并依赖 `1 exact owner + no receipt` 的 crash-recovery 路径恢复，而不是再次创建 Issue。
