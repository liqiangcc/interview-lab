# Issue #1607 Boundary B preparation

本目录对应主控 #1605 的 Boundary B 子任务，只读取 #393–#765 的 live Issue labels/body snapshot，并选择同时具有：

```text
type:source-note + source:xhs + status:captured + boundary:pending + task:boundary-review
```

固定 Source snapshot 为 `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`。本次冻结选择集为 257 条（当前最小 #394、最大 #765）；不读取 #392 以下或 #766，不把父级 419-row authorization 当作本批授权。

## 只读生成

live inventory 必须使用 scope-clean GraphQL：

```sh
node scripts/prepare-issue-1607-boundary-batch.js \
  --fetch-live --scope-clean --cache data/issue-1607/live-issues.json
```

full-source prepare 复用 `/tmp/xhs-note-desc-cache`，并从 `/tmp/issue-1607-source-artifacts` 复用已验证的 `note_detail` HTML 与 `note_json`；每项校验 byte size 与 Git blob SHA：

```sh
node scripts/prepare-issue-1607-boundary-batch.js \
  --prepare --full-source --scope-clean --allow-unverified-source \
  --cache data/issue-1607/live-issues.json \
  --source-cache-dir /tmp/xhs-note-desc-cache \
  --source-artifact-cache-dir /tmp/issue-1607-source-artifacts \
  --output-dir data/issue-1607
node scripts/generate-issue-1607-boundary-evidence.js \
  --selection data/issue-1607/selection.json --output-dir data/issue-1607
```

最终三类 pinned Source artifact 覆盖为 257/257，source material 全部 `verified`。生成器逐条写出 classification/evidence/request，并生成 `source-artifact-ledger.json`、`dry-run.plan.json`、`apply.journal.json` 与 `canonical-digest.json`；逐条目录恰为当前 257 条，无陈旧选择项。

## 当前审计结论

```text
single-interview: 147
multi-interview: 20
not-interview: 73
blocked: 17
semantic_ready: 167
ready: 0
executable: false
mutation_count: 0
```

标题/正文中有明确已发生的候选人面试过程、面试官问答、候选人回答或结果才可提出 single；同帖明确多场/多轮才提出 multi。题库/题目列表、求职建议、预约/邀约、岗位咨询、面试官分享、营销转载和明确拒面/未参加均不提出 interview decision；完整材料仍无法建立边界的条目保留 blocked。每个非 blocked decision 都包含 exact artifact ref、locator、excerpt、完整 `note_desc` projection 与 line basis。`Raw` Source 未被 Derived 结果覆盖。
轮次解析将“一面/1️⃣面/1面”等归一为同一 round key；`2面试`、`p12面试`、页面引用、听说/可能/已约等 speculative 或 scheduled token 不计为新轮次。仅含模糊轮次标题与通用话题标签（如 #760 同类）不具备独立过程证据，统一 blocked；标题明确“刚面完/面完”或明确轮次结果（如 #471/#518）则可形成 single。#733 的“已约二面”按预约处理，因此仅 single。

scope audit：`selection.scope_compliance=pass`、`plan.scope_compliance=pass`、`scope_regression=pass`、`out_of_scope_reads=0`、`out_of_scope_mutations=0`；明确禁止 #392/#766。`apply.journal.json` 为 `not-started` 且 mutation count=0。未经主控在 issue/会话中明确授权，不得 POST/PATCH 或 apply；这些 request template 不是可执行 transition request。

最终 canonical digest 位于 `data/issue-1607/canonical-digest.json`：

```text
selection_sha256: 20b9deb520f8c111cc969b749a45d0e56308126ae5f228ac9e1251ea92d8f7be
evidence_ledger_sha256: 7772087b360777a52327d9a6d3efdd9d4e4620e512237b898d1c041826387f7d
request_set_sha256: c22d410b238a441ae137d0ea97c295e9c45d0ef1a3a75e81398108f3c8dddd42
classification_ledger_sha256: 1e8b3f74109aa41256e5d026ac46847da6947bd63312cbbbb459e19a31f4087b
dry_run_sha256: 3fbe0f07e4a8882f22638e1fc2d8aeaca0b17442ee8a06cdc28436055d50f9ca
journal_sha256: bc8a87dead4868070ca9f1adb3553744be9cad012021b7071ebff3dba48a32e4
```
