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
evidence_ledger_sha256: c5e15a172e83c4ee7e109ac40bff3eda7e72f9c54ea4d526f53c62cea175b194
request_set_sha256: a792921691d795c7e74d871d5dd2f3ba65d3b209d0961ea1def2d5a69ebba3e8
classification_ledger_sha256: ba9aa474aa4a4412a2d2a31ff2cc7a6bac5e960fd8303cf9176f055c8bbaf2be
dry_run_sha256: a9fe77f9e968c5265b604dd7f89a18d82ed3af225724a2e3977d5e95c880c8de
journal_sha256: 0681a3fcb31fac621bed9710d1784c3803d50b5891ed2775e00368e3ddde5a95
```

367 条均为 `decision=pending` / `evidence_status=review-required`，Source projection 为 367/367 verified、source blocked=0；分类 proposal 为 single-interview=105、not-interview=5、pending=257。每条 evidence 独立绑定 frozen body SHA、SourceRevision、pinned `note_desc` ref/blob SHA、完整 projection 文本与依据行号；没有新增 GitHub evidence comment 或 machine marker。request set 仍为 `executable=false`，dry-run `ready=0`，mutation count=0。

分类 ledger 是 proposal-only：邀约、求助、建议、面试官分享、题库/题目列表均不会仅凭“面试/问题”字样提出 single；明确拒面才可提出 not-interview。主控仍需逐条复核并创建 durable evidence 后，才可生成正式 transition request。

后续必须由主控安排独立 Source 复核，重新读取 live body/labels/revision，创建唯一 durable evidence comment，再按 transition contract 生成正式 request。主控明确授权前不得 POST/PATCH。

Fail-closed incident：早期抽样阶段曾只读探测 #766；没有写入，也没有纳入选择集，但违反了本子 issue 的越界读取约束。本批次因此标记为非 scope-clean，需主控知悉并重新执行严格 scoped read 后才能继续。
