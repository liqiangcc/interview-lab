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

最终分类计数：`single-interview=178`、`multi-interview=19`、`not-interview=50`、`blocked=10`。其中 197 条为 `semantic_ready`，但 `ready=0`、`executable=false`，因为本产物不是主控授权，也没有复用父级 419-row authorization。每条非 blocked 记录保留完整 projection、三类 artifact ref/blob SHA/byte size、JSON locator 和独立 excerpt；blocked 仅表示完整材料仍不足以确定 0/1/N boundary。

Canonical digest：

```text
selection_sha256: 20b9deb520f8c111cc969b749a45d0e56308126ae5f228ac9e1251ea92d8f7be
evidence_ledger_sha256: b13bdd74996a00495347203da5bc6b303b2a60ca5ab17088a3848aaa53dacfa6
request_set_sha256: 26f1a4f4845d6cea13ad3733040f6019fd255e63212c668414c9980fb7c390cc
classification_ledger_sha256: 1e6add76aa5c7d99d5c81bef22156db92020d7cefa52252861b0597dfca5b6f8
dry_run_sha256: e3cb87b342b0bd87804cb5ae956bf645ee73e3a1541d264e6f71f71cd0bf6623
journal_sha256: 1dbb767d8239c81028690c8219f7b0d05b3a0b419e1fdddae040a0d6228b7cb7
```

语义规则已包含 #393/#394/#401/#415/#437/#524/#584/#727 等反例：明确候选人已发生的一面/二面、问答、结果才可提出 single；同帖明确多场/多轮才是 multi；拒面、不参加、邀约、岗位咨询、建议、题库、面试官分享和营销转载为 not-interview；材料不足则 blocked。原始 Source 与 Derived 解释保持分离，未修改 Raw。

历史曾有 #766 只读探测，已记录但不纳入本次选择或处理；本次 snapshot 与产物没有 #766 读取。主控 review/授权前，所有 request 仍不可执行。
