# Issue #1605 pending inventory

本流程是 #1605 的只读依赖输入。它冻结父级全库的 pending SourceNote selection，生成逐条 ownership index，并把 live Issue body、SourceNote identity、SourceRevision 和完整 labels 固化到可提交 snapshot。它不修改 Issue body、title、labels 或 comments，也不把 Raw 覆盖为 Derived。

固定选择集：先按 GitHub Issues API 的 `type:source-note` 分页读取 `state=all`，每页固定 100 条；再在本地要求同时存在 `source:xhs`、`status:captured`、`boundary:pending`、`type:source-note`。每条记录还必须通过仓库 SourceNote validator，且 `source_revision.source_repository_ref` 精确等于 `95b77bb261048059846273688e4b90a2e108b437`。网络超时、非数组页、短页前结束、重复 ownership、body/record/label/ref 漂移都会 fail closed。

运行：

```bash
npm run inventory:issue-1605-pending
```

输出：

```text
data/pilot/issue-1605/pending-inventory.snapshot.json
data/pilot/issue-1605/pending-inventory.ownership.json
```

snapshot 的 `canonical_digest` 对稳定选择、分页证据、四批摘要和逐条事实做 canonical SHA-256；运行时间不进入 digest。ownership index 通过 `snapshot_canonical_digest` 绑定 snapshot，且按 `source_note_id` 唯一索引 issue number、body SHA、SourceRevision id/ref 和 labels。

四批证明固定为：#1606 `20–392 / 327`、#1607 `393–765 / 367`、#1608 `766–1138 / 337`、#1609 `1139–1508 / 366`。生成成功必须同时满足 `count=1397`、四批 union `count=1397`、批次 pairwise disjoint、union 与 inventory 完全相等。该 snapshot/ownership index 仅作为 #1605 后续 review/materialization 的依赖输入；任何 live apply 必须另行取得主控明确授权，本脚本没有 apply 路径。
