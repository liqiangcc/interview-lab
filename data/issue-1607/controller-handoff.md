# Boundary B controller handoff

本地只读准备已完成，未执行 live GitHub mutation。

```text
repository: liqiangcc/interview-lab
parent_issue: #1605
child_issue: #1607
scope: #393..#765, exact pending label selection
selected: 367
excluded_in_range: #478, #500, #551, #649, #692, #757
source: liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437
```

Canonical digest：

```text
selection_sha256: 036c567cdaeaca6fde5014de0de40b5cdbbb714ea784a2827c5e0dc17bf81b4d
evidence_ledger_sha256: 00ad4eec130c0585bf9f86afbec98e7b39d0e72b850ff0bb9181bf0bd1f519b9
request_set_sha256: 55b31b398c7420338afcde225d8ef5c2ed2fb1615e372a07d634ed6d37c58e03
dry_run_sha256: 84286de39d0492c42df6cfd7a92e4e3e802ee1f4566016c3317772a9747cbc40
journal_sha256: 37d10b2b7b7f958d3611604bdb965b7beb137e65a27eaf3272fb208530b30961
```

367 条均为 `decision=pending` / `evidence_status=blocked`：pinned Source projection bytes 在本次网络运行中未完成独立验证。Issue body 中的 projection copy 仅作为定位线索，未被升级为 Source evidence。dry-run 与 journal 的 mutation count 均为 0；子 issue 当前没有新增 machine evidence marker。

后续必须由主控安排独立 Source 复核，重新读取 live body/labels/revision，创建唯一 durable evidence comment，再按 transition contract 生成正式 request。主控明确授权前不得 POST/PATCH。

Fail-closed incident：早期抽样阶段曾只读探测 #766；没有写入，也没有纳入选择集，但违反了本子 issue 的越界读取约束。本批次因此标记为非 scope-clean，需主控知悉并重新执行严格 scoped read 后才能继续。
