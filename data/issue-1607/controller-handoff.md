# Boundary B controller handoff

本地只读准备已完成，未执行任何批次 Issue 的 live mutation/apply；仅按交付要求更新了关联 PR 元数据。

```text
repository: liqiangcc/interview-lab
parent_issue: #1605
child_issue: #1607
scope: #393..#765, exact pending label selection
baseline_pending_count: 367
selected: 257 (current pending rerun)
excluded_in_range: 116 current non-selected issues (including 110 no longer pending since the 367-row baseline)
source: liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437
source_fetch: controlled raw GET, concurrency=1, retries=3/item, cache validation=byte_size+git_blob_sha
live_snapshot_fetched_at: 2026-09-08T14:37:24.759Z
scope_compliance: pass (fresh GraphQL reads #393..#765 only; out_of_scope_reads=0; out_of_scope_mutations=0)
mutation_count: 0
```

Canonical digest：

```text
selection_sha256: 48dfb6bbfe94c96ed82d3e20db000426ceb8a3d691cf781e40c316b0d586568a
evidence_ledger_sha256: 15529e3d6c0d5a47ccbbbe77ed51e5ce314dc691cb5d63ec948e0be37e3b64ed
request_set_sha256: 0a382eb83a03080a945cdcaaff54ce3c796fda1f079e0668a8c6cc0291e76acf
classification_ledger_sha256: df5b7036e2e783fbe7d2b3e3f599d6a1460d409588b4147dd92a7770ab355a1a
dry_run_sha256: b5ca37af6a44f1f9ff5a626158385fc8439982473c1e77e0fb3e512b219dd832
journal_sha256: 9ce57e13dc38f93cbceddef57f7d352ee635c8f13499737d2af32e6c0fb7d933
```

257 条均为 `decision=pending` / `evidence_status=review-required`，Source projection 为 257/257 verified、source blocked=0；当前 rerun 没有把任何 proposal 提升为决议。每条 evidence 独立绑定 fresh snapshot 的 frozen body SHA、SourceRevision、pinned `note_desc` ref/blob SHA、完整 projection 文本与依据行号；没有新增 GitHub evidence comment 或 machine marker。request set 仍为 `executable=false`，dry-run `scope_compliance=pass`、`scope_regression=pass`、`ready=0`、mutation count=0。

父级此前的 419-row authorization 仅覆盖主控已独立处理的固定选择集，不覆盖本次 257 条 rerun；本次没有推断或消费新的授权，也没有把旧授权当作 transition permission。

分类 ledger 是 proposal-only：邀约、求助、建议、面试官分享、题库/题目列表均不会仅凭“面试/问题”字样提出 single；明确拒面才可提出 not-interview。主控仍需逐条复核并创建 durable evidence 后，才可生成正式 transition request。

后续必须由主控安排独立 Source 复核，重新读取 live body/labels/revision，创建唯一 durable evidence comment，再按 transition contract 生成正式 request。主控明确授权前不得 POST/PATCH。

历史 fail-closed 记录：早期准备运行曾只读探测 #766；没有写入，也没有纳入选择集。本次 fresh rerun 未读取 #766，scope regression 明确排除 #392/#766，故本次产物 scope_compliance=pass。
