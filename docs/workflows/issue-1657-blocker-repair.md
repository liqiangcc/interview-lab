# Issue #1657：#904/#907/#910 materialization blocker audit

本文件、`data/pilot/issue-1657/live-reaudit.snapshot.json` 和 `data/pilot/issue-1657/blocker-repair.plan.json` 是只读审计产物。审计范围是 SourceNote、boundary evidence/receipt、InterviewNote owner/receipt 的当前绑定；采集器和 planner 均禁止 PATCH、POST、label mutation、issue comment 和任何 InterviewNote 写入。

## 当前证据

原始 owner/receipt snapshot 时间：`2026-09-09T07:03:46Z`；本次 live GET-only re-audit 时间：`2026-09-09T09:32:52.568Z`。来源快照是 `data/pilot/issue-1611/source-note-live.snapshot.json`，owner inventory 是 `data/pilot/issue-1611/interview-note-ownership.inventory.json`，上游 materialization dry-run 是 `data/pilot/issue-1611/materialization.live.dry-run.json`，live re-audit 是 `data/pilot/issue-1657/live-reaudit.snapshot.json`。

| SourceNote | 当前 SourceRevision / ref | boundary evidence / receipt | 唯一 InterviewNote owner | 结论 |
| --- | --- | --- | --- | --- |
| #904 | `xhs-note:63ecd286000000001303fd16:snapshot-95b77bb26104` / `95b77bb261048059846273688e4b90a2e108b437` | evidence `5579824204`，applied receipt `5584606650`，均精确绑定 `issue-1605-boundary-904-c` | #2，`legacy-r1`，无 materialization receipt | owner SourceRevision 冲突，必须 owner CAS/reconcile；不能重建第二个 owner |
| #907 | `xhs-note:656861da000000000f024258:snapshot-95b77bb26104` / `95b77bb261048059846273688e4b90a2e108b437` | evidence `5579824470`，applied receipt `5584607734`，均精确绑定 `issue-1605-boundary-907-c` | #4，`recovered-r2` / `23a56d5aa1388cfa6fc1fa68bdb6576acad825eb`，无 materialization receipt | owner SourceRevision/ref 与当前 SourceNote 冲突，必须独立审阅后 CAS/reconcile |
| #910 | `xhs:6a8abe2d000000001602b26e:r1` / `null`（runtime artifact store） | applied receipt `5535553800`；人类可读 evidence `5535513422` 不是 exact machine marker，故 evidence id 为 `null` | #915，receipt `5535863537` | owner/receipt 与 runtime revision 一致，但缺 exact boundary evidence；不得把 runtime revision 伪装成 Git ref |

三个目标的 SourceNote 当前 body digest 分别为：

```text
#904  39db5c325988d7d79cb1241b547f5464368facd450ea33e9313b8e6aaa1edb8a
#907  f548b38833ee4416efa336a0a91020ef3e3ae333f0b64a0e94a4094f2e80cd4e
#910  663871c4c273ff5cf58b053501b5b04bf2a631368e64b0c9b1ce6ea9243f041
```

当前上游 dry-run 已经给出同样的 fail-closed 结论：#904/#907 是 `materialization-preflight-failed`，#910 是 `boundary-evidence-missing-or-ambiguous`；其 digest 为 `67d848cf88be634d8137cc5ad13798e6d745f87ec19d770e0947be9dd724bb55`（见机器产物为准；文档中仅保留审计引用）。

## 最小安全路径

1. 重新执行 GET-only live snapshot，并要求 SourceNote body、SourceRevision、fixed source ref、boundary comment id、完整 owner inventory 和 receipt marker 的 digest 全部收敛。任何漂移都生成新计划，不复用本计划。
2. #904/#907 标为 `repairable-after-independent-owner-review-and-CAS`，使用 `issue-1657-interview-note-owner-reconcile-request.v1`。request 绑定旧 owner body SHA、旧 owner revision、当前 SourceNote body SHA、当前 SourceRevision/ref、唯一 `interview_note_id` 和 owner Issue number。执行前需独立审阅 artifact/provenance；执行时需 owner body CAS 与 SourceNote body/revision/ref CAS。严禁删除 owner、创建 duplicate、静默改写 Derived 内容；#904 的 image-missing 仍是独立的 source-recovery limitation。
3. #910 标为 `must-manually-confirm-boundary-evidence-and-runtime-provenance`，使用 `issue-1657-boundary-evidence-recovery-request.v1`。先取得与 `xhs-note-6a8abe2d-boundary-review-1`、当前 SourceNote body、`xhs:...:r1`、manifest SHA `0e408ad...` 精确绑定的 `source-note-boundary-review-evidence.v1` machine evidence。`source_repository_ref=null` 是 runtime contract 的事实，不能填入 `95b77...`；若下游必须要求 Git ref，只能另取固定 Git snapshot 并建立新的 SourceRevision/transition，不能改写现有 runtime 事实。
4. 只有上述修复/恢复完成并重新运行 full `plan:issue-1611-live-materialization` 后，且顶层 `errors=[]`、三条不再以当前 blocker 出现，才可由独立授权流程讨论 materialization。当前计划不授权任何写入。

## 机器计划与零写入保证

```sh
npm run plan:issue-1657-blocker-repair
```

`npm run audit:issue-1657-live` 通过显式 GET 重新抓取三条 SourceNote、三个 owner Issue 及其 comments/events，生成 live snapshot；`npm run plan:issue-1657-blocker-repair` 读取五份本地审计输入并生成 plan。两个 CLI 都拒绝 `--apply`、`--patch`、`--post`、`--label` 和 `--interview-note`。本次产物的 `ok=false` 是预期的 blocker 结果，不是输入损坏；三条 target 都被解析并逐条输出 request，但 `authorized_operations=[]`。

当前 plan digest（schema v2，含 live re-audit digest）：

```text
e0ae0fad4a39aa9caa014ea7fadb72519076c825d35a49be3dc0e2307eedf933
```

Receipt/owner audit snapshot digest（计算输入明确不含 `canonical_digest` 字段）：

```text
7786f58aa9c6c6294ade44c992908466d3f9606682cc557465b94ec9535a5016
```

Live re-audit snapshot digest（计算输入明确不含 `canonical_digest` 字段）：

```text
5b1b8bfa8f47721c0fc758988b95bfd09fc467197f9d22d0fe72e2d3aaf3c457
```

上游输入 digest：

```text
SourceNote snapshot       a1804b09a3a293b33dfb59856b723da19b587816705e8659cdf6ee829175acf2
InterviewNote inventory   d49779dbc5e0c94bc3c67c2b6781f99e940c71afb046a9f2d0a0a2f9189484e0
Boundary report           b91961567526bc1be0a987e275e367e845c89da274fd8f5f74c9d281f963c021
Boundary manifest         6fbff5de05abbed9d239a6a8cf3b981d94ed2e0b711342ea6f84c79ffad1b165
Materialization dry-run  67d848cf88be634d8137cc5ad13798e6d745f87ec19d770e0947be9dd724bb55
Receipt/owner audit     7786f58aa9c6c6294ade44c992908466d3f9606682cc557465b94ec9535a5016
Live re-audit           5b1b8bfa8f47721c0fc758988b95bfd09fc467197f9d22d0fe72e2d3aaf3c457
```

所有 digest 应以对应 JSON 产物重新计算为准；计划内写入计数固定为：

```json
{"patch":0,"post":0,"label":0,"interview_note":0,"create":0}
```

## 测试

`test/issue-1657-blocker-repair.test.js` 使用真实 #1611 snapshot 与 live re-audit fixture，而不是人工 mini fixture，断言 #904/#907/#910 的 SourceNote identity、body SHA、SourceRevision、boundary status、owner identity、comments/receipts 逐条绑定；同时验证 receipt/owner/live audit 篡改均 fail closed、runtime ref 不能被篡改为 Git ref，CLI 不能接受 mutation-shaped 参数。

Schema review 对应：`schemas/issue-1657-owner-receipt-audit-snapshot.schema.json`、`schemas/issue-1657-live-reaudit-snapshot.schema.json`、`schemas/issue-1657-blocker-repair-plan.schema.json`。JSON digest 均采用“去掉自身 digest 字段后 canonicalize”的输入规则；runtime validator 另外执行 target identity、body SHA、SourceRevision/ref、comment/receipt 交叉绑定。
