# Issue #1658 post-#1689 只读审计

审计分支已合入 main `92b76907a2edaa86ee8459aff20ed768a4b4b352`，合并提交为 `f61fbd9`。本目录只保存只读审计产物和核验脚本，不修改 live Issue、SourceNote、labels、历史 receipt 或生产数据。

本次范围仍是 [#1611 评论 5602915668](https://github.com/liqiangcc/interview-lab/issues/1611#issuecomment-5602915668) 授权的 13 条：`1309, 1325, 1333, 1363, 1375, 1376, 1380, 1401, 1406, 1418, 1428, 1447, 1458`。`max_create=13`、`max_receipts=13`。原授权 input plan、bounded input plan 和 durable journal 在本次查找范围内仍未找到，因此历史执行统一为 `UNKNOWN`，不能用当前产物替代。

## 当前四维判定

- `owner_fact`：13/13 `PASS`。使用已保存的完整 65-owner inventory，核对 identity、owner body SHA、title、完整 label set 和 owner validator。
- `receipt_fact`：13/13 `PASS`。每条都有唯一可解析的 materialization receipt，且 source、owner、body、revision、ref 和 InterviewNote identity 一致。
- `historical_execution`：13/13 `UNKNOWN`。缺少原授权 input plan/journal；正常没有 lock 不作为失败证据。
- `consumer_compatibility.full_live_planner`：13/13 `FAIL`，但每行当前唯一错误都是 applied boundary receipt 的 `interview_note_ids=[]` mismatch；新 main 已识别 `issue-1608-boundary-evidence.v1`，13 行 `matching boundary evidence got 0` 已为 0。
- `generic_runner`、`bounded_runner`：13/13 `NOT_VERIFIED`。没有补造原 plan/journal，也没有执行 runner。

| SourceNote → Owner | issue-1608 evidence | applied boundary receipt | materialization receipt | 当前行诊断 |
|---|---:|---:|---:|---|
| [#1309](https://github.com/liqiangcc/interview-lab/issues/1309) → [#1674](https://github.com/liqiangcc/interview-lab/issues/1674) | 5601731380 | 5602392005 | 5613888065 | `interview_note_ids=[]` mismatch |
| [#1325](https://github.com/liqiangcc/interview-lab/issues/1325) → [#1675](https://github.com/liqiangcc/interview-lab/issues/1675) | 5601733863 | 5602395322 | 5613892926 | `interview_note_ids=[]` mismatch |
| [#1333](https://github.com/liqiangcc/interview-lab/issues/1333) → [#1676](https://github.com/liqiangcc/interview-lab/issues/1676) | 5601734915 | 5602397470 | 5613896228 | `interview_note_ids=[]` mismatch |
| [#1363](https://github.com/liqiangcc/interview-lab/issues/1363) → [#1677](https://github.com/liqiangcc/interview-lab/issues/1677) | 5601736517 | 5602399300 | 5613898735 | `interview_note_ids=[]` mismatch |
| [#1375](https://github.com/liqiangcc/interview-lab/issues/1375) → [#1678](https://github.com/liqiangcc/interview-lab/issues/1678) | 5601737634 | 5602400786 | 5613903360 | `interview_note_ids=[]` mismatch |
| [#1376](https://github.com/liqiangcc/interview-lab/issues/1376) → [#1679](https://github.com/liqiangcc/interview-lab/issues/1679) | 5601746468 | 5602403224 | 5613905233 | `interview_note_ids=[]` mismatch |
| [#1380](https://github.com/liqiangcc/interview-lab/issues/1380) → [#1680](https://github.com/liqiangcc/interview-lab/issues/1680) | 5601747308 | 5602404677 | 5613908279 | `interview_note_ids=[]` mismatch |
| [#1401](https://github.com/liqiangcc/interview-lab/issues/1401) → [#1681](https://github.com/liqiangcc/interview-lab/issues/1681) | 5601748374 | 5602406000 | 5613911802 | `interview_note_ids=[]` mismatch |
| [#1406](https://github.com/liqiangcc/interview-lab/issues/1406) → [#1682](https://github.com/liqiangcc/interview-lab/issues/1682) | 5601749401 | 5602407754 | 5613915850 | `interview_note_ids=[]` mismatch |
| [#1418](https://github.com/liqiangcc/interview-lab/issues/1418) → [#1683](https://github.com/liqiangcc/interview-lab/issues/1683) | 5601750274 | 5602408908 | 5613920895 | `interview_note_ids=[]` mismatch |
| [#1428](https://github.com/liqiangcc/interview-lab/issues/1428) → [#1684](https://github.com/liqiangcc/interview-lab/issues/1684) | 5601752211 | 5602410444 | 5613923886 | `interview_note_ids=[]` mismatch |
| [#1447](https://github.com/liqiangcc/interview-lab/issues/1447) → [#1686](https://github.com/liqiangcc/interview-lab/issues/1686) | 5601752917 | 5602412434 | 5614172867 | `interview_note_ids=[]` mismatch |
| [#1458](https://github.com/liqiangcc/interview-lab/issues/1458) → [#1687](https://github.com/liqiangcc/interview-lab/issues/1687) | [5601753678](https://github.com/liqiangcc/interview-lab/issues/1458#issuecomment-5601753678) | [5602413639](https://github.com/liqiangcc/interview-lab/issues/1458#issuecomment-5602413639) | [5614208444](https://github.com/liqiangcc/interview-lab/issues/1458#issuecomment-5614208444) | `interview_note_ids=[]` mismatch |

## post-#1689 full planner

使用新 main 的 GET-only planner 实际重跑：复用已保存的 1460 条 SourceNote snapshot 和 65-owner inventory，重新读取全量 comments；没有执行任何 mutation。当前 planner 结果见 [full-plan-summary.json](./full-plan-summary.json)。

精确结果：

- action counts：`skip-not-interview=247`、`already-materialized=47`、`would-materialize=789`、`would-repair-receipt=13`、`blocked=411`，合计 1507。
- blocked reasons：`boundary-transition-not-live-applied=408`、`materialization-preflight-failed=2`、`boundary-evidence-missing-or-ambiguous=1`。
- full plan errors：15 条；其中 #910 有 2 条全局错误，13 条授权 scope 各 1 条 `receipt interview_note_ids mismatch`。
- 13 条 scope 的 `got 0`：0；13 条 scope 的 receipt ID mismatch：13。
- `plan_ok=false`，`mutation_performed=false`，写入计数 `patch=0/post=0/create=0`。
- #910 单列为 `matching evidence got 0` 和 SourceRevision ref drift，不传播到其他 13 行。

分页结果：本次 GET-only 重跑最终 boundary comments 为 27 页、SourceNote snapshot 为 15 页，均有短终页，ownership search errors 为空；本次重跑未观察到 page14 EOF。分页完整性为 `PASS`，不改变 planner 因 errors 导致的 `ok=false`。

1460、1507、1099、65 的单位不同：1460 是 SourceNote issues；1507 是展开后的 planner rows；1099 是规划出的 distinct InterviewNote identity claims；65 是 live InterviewNote owner issues。29 个 multi-interview SourceNote 展开为 76 个 case rows，因此不能直接比较这些数值。

`issue-1656-materialization-*` 与当前 generic planner 生成的 `xhs-note-<external_id 前 8 位>-materialization-1` 差异只记录为 named consumer 的 current request binding observation，不推导历史执行失败，也不修改历史 receipt。当前 generic/bounded runner 仍为 `NOT_VERIFIED`。

## 产物与核验

- [13-reconcile.json](./13-reconcile.json)：post-#1689 的 13 行四维结果；`source_tree_sha=92b76907a2edaa86ee8459aff20ed768a4b4b352`。
- [full-plan-summary.json](./full-plan-summary.json)：post-#1689 full planner 实际 counts、errors、分页和 digest。
- [repro-input.json](./repro-input.json)：13 条 source、owner、applied boundary 和 materialization marker 快照。
- [owner-inventory.json](./owner-inventory.json)：65-owner identity/Issue 最小快照。
- [verify-13-reconcile.js](./verify-13-reconcile.js)：默认 `check-only`；只有显式 `--write` 才刷新 13 行结果。

实际验证命令：

```text
node --check audit/issue-1658/verify-13-reconcile.js
node audit/issue-1658/verify-13-reconcile.js
```

两条命令均通过，默认 check 未改写文件。定向负例保持原预期：owner body、receipt owner number、duplicate owner 均非零失败；仅保留 #910 全局错误时退出码 0，13 行不继承 #910 错误。

本审计不宣称 #1658、boundary review、Source Review 或整个 materialization 已完成；PR 保持 Draft，等待主控独立审查。
