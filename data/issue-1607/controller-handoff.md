# Boundary B controller handoff

本地只读准备已完成，未执行任何批次 Issue 的 live mutation/apply；仅按交付要求更新了关联 PR 元数据。

```text
repository: liqiangcc/interview-lab
parent_issue: #1605
child_issue: #1607
scope: #393..#765, exact pending label selection
selected: 367
excluded_in_range: #478, #500, #551, #649, #692, #757
source: liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437
source_fetch: controlled raw GET, concurrency=1, retries=3/item, cache validation=byte_size+git_blob_sha
```

Canonical digest：

```text
selection_sha256: 34d9796c7d60cff3a2e818143da8a2cea2ff83ea052a55911e6402a9dd392420
evidence_ledger_sha256: 018ec50ecc3769cb5312612e933f7ca8461cac5e50cd3590b095c6965af93e30
request_set_sha256: 56f7f087504c50dd3a73b0124c9d3064afcb430da5026db1eb6196a1247c1fd4
classification_ledger_sha256: eebac785c242cc4aea6b93ca7def9241963f4b50ae137bca231466efd5bf1215
dry_run_sha256: 8a352f9eaa0de1005441df316d9fb2ddba165bf3d6a4aef0c12de93123ef7f50
journal_sha256: 64f57b1f83e1937a7d57ee1996c95599f2f090bb5f25ec092f00b4ed841b1980
```

367 条均为 `decision=pending` / `evidence_status=review-required`，Source projection 为 367/367 verified、source blocked=0；分类 proposal 为 single-interview=12、not-interview=3、pending=352。每条 evidence 独立绑定 frozen body SHA、SourceRevision、pinned `note_desc` ref/blob SHA、完整 projection 文本与依据行号；没有新增 GitHub evidence comment 或 machine marker。request set 仍为 `executable=false`，dry-run `ready=0`，mutation count=0。

分类 ledger 是 proposal-only：邀约、求助、建议、面试官分享、题库/题目列表均不会仅凭“面试/问题”字样提出 single；明确拒面才可提出 not-interview。主控仍需逐条复核并创建 durable evidence 后，才可生成正式 transition request。

后续必须由主控安排独立 Source 复核，重新读取 live body/labels/revision，创建唯一 durable evidence comment，再按 transition contract 生成正式 request。主控明确授权前不得 POST/PATCH。

Fail-closed incident：早期抽样阶段曾只读探测 #766；没有写入，也没有纳入选择集，但违反了本子 issue 的越界读取约束。本批次因此标记为非 scope-clean，需主控知悉并重新执行严格 scoped read 后才能继续。
