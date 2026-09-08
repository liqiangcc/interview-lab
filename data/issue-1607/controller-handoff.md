# Boundary B controller handoff

本次是 #1607 的 scope-clean full-source semantic rerun，仅覆盖当前冻结选择集 #393..#765 中仍为 `boundary:pending` 的 257 条；未执行任何 GitHub PATCH/POST/apply，`mutation_count=0`。

```text
repository: liqiangcc/interview-lab
parent_issue: #1605
child_issue: #1607
scope: #393..#765
selection: 257 unique issues (min #394, max #765)
baseline_pending_count: 367
source: liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437
source_material: note_desc + note_json + note_detail HTML, 257/257 independently verified
live_snapshot_fetched_at: 2026-09-08T14:37:24.759Z
scope_compliance: pass
scope_reads: #393..#765 only; out_of_scope_reads=0; #392/#766 forbidden
mutation_count: 0
```

最终分类计数：`single-interview=106`、`multi-interview=20`、`not-interview=110`、`blocked=21`。其中 126 条为 `semantic_ready`，236 条为非 blocked review proposal；`ready=0`、`executable=false`，因为本产物不是主控授权，也没有复用父级 419-row authorization。每条非 blocked 记录保留完整 projection、三类 artifact ref/blob SHA/byte size、JSON locator 和独立 excerpt；blocked 不生成 request 文件，仅表示完整材料仍不足以确定 0/1/N boundary。

Canonical digest：

```text
selection_sha256: 20b9deb520f8c111cc969b749a45d0e56308126ae5f228ac9e1251ea92d8f7be
evidence_ledger_sha256: ae4f50178f1a1e9ac6c4c3eec28d733dabc7572430f59fe5051ace46d3399682
request_set_sha256: 91e465347f8927b0e34c8a9b8b5e96031d95b2b02c7c562bacf15ac09c9f4c1b
classification_ledger_sha256: e4635483cdd41b807e12e86cf7a91d7b8fc10945dbc4cd8ccc09141525ece205
dry_run_sha256: 8001a1f6e8f961230e8fd84517f72d2575cae769ec6f987eab77a03edb31b00f
journal_sha256: cf7f33014d81fac096830db98e6f2fa09f7618ae66c18b4abff264979d39c3d0
```

语义规则已包含 #393/#394/#401/#415/#437/#524/#584/#727 等反例：明确候选人已发生的一面/二面、问答、结果才可提出 single；同帖明确多场/多轮才是 multi；拒面、不参加、邀约、岗位咨询、建议、题库、面试官分享和营销转载为 not-interview；材料不足则 blocked。原始 Source 与 Derived 解释保持分离，未修改 Raw。

历史曾有 #766 只读探测，已记录但不纳入本次选择或处理；本次 snapshot 与产物没有 #766 读取。主控 review/授权前，所有 request 仍不可执行。
