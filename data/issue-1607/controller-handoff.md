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

最终分类计数：`single-interview=147`、`multi-interview=20`、`not-interview=73`、`blocked=17`。其中 167 条为 `semantic_ready`，240 条为非 blocked review proposal；`ready=0`、`executable=false`，因为本产物不是主控授权，也没有复用父级 419-row authorization。每条非 blocked 记录保留完整 projection、三类 artifact ref/blob SHA/byte size、JSON locator 和独立 excerpt；blocked 不生成 request 文件，仅表示完整材料仍不足以确定 0/1/N boundary。

Canonical digest：

```text
selection_sha256: 20b9deb520f8c111cc969b749a45d0e56308126ae5f228ac9e1251ea92d8f7be
evidence_ledger_sha256: 7772087b360777a52327d9a6d3efdd9d4e4620e512237b898d1c041826387f7d
request_set_sha256: c22d410b238a441ae137d0ea97c295e9c45d0ef1a3a75e81398108f3c8dddd42
classification_ledger_sha256: 1e8b3f74109aa41256e5d026ac46847da6947bd63312cbbbb459e19a31f4087b
dry_run_sha256: 3fbe0f07e4a8882f22638e1fc2d8aeaca0b17442ee8a06cdc28436055d50f9ca
journal_sha256: bc8a87dead4868070ca9f1adb3553744be9cad012021b7071ebff3dba48a32e4
```

语义规则已包含 #393/#394/#401/#415/#437/#524/#584/#727 等反例：明确候选人已发生的一面/二面、问答、结果才可提出 single；同帖明确多场/多轮才是 multi；拒面、不参加、邀约、岗位咨询、建议、题库、面试官分享和营销转载为 not-interview；材料不足则 blocked。原始 Source 与 Derived 解释保持分离，未修改 Raw。
轮次解析将“一面/1️⃣面/1面”等归一为同一 round key；`2面试`、`p12面试`、页面引用、听说/可能/已约等 speculative 或 scheduled token 不计为新轮次。仅含模糊轮次标题与通用话题标签（如 #760 同类）不具备独立过程证据，统一 blocked；标题明确“刚面完/面完”或明确轮次结果（如 #471/#518）则可形成 single。#733 的“已约二面”按预约处理，因此仅 single。

历史曾有 #766 只读探测，已记录但不纳入本次选择或处理；本次 snapshot 与产物没有 #766 读取。主控 review/授权前，所有 request 仍不可执行。
