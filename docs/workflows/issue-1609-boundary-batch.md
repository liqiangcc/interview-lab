# Issue #1609 Boundary D batch

本批次严格限定为当前 live baseline 中的 `#1139–#1508`：同时具备
`type:source-note`、`status:captured`、`boundary:pending` 的 366 个
SourceNote。固定来源为 `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`。

## 只读产物

`scripts/issue-1609-boundary-batch.js` 是本批次的 plan/evidence producer，故意
没有 `--apply` 路径；传入 `--apply`、`--confirm-dry-run` 或 `--gate-proof` 会
直接 fail closed。它只读取 live Issue 和固定 source snapshot，不调用 GitHub
PATCH/POST。

重新冻结选择集：

```sh
node scripts/issue-1609-boundary-batch.js \
  --mode freeze \
  --output data/issue-1609/selection-manifest.json
```

根据冻结选择集读取 exact Raw/source projection artifact，生成逐条 evidence、
candidate request、planned receipt、journal 和 dry-run plan：

```sh
node scripts/issue-1609-boundary-batch.js \
  --mode evidence \
  --selection data/issue-1609/selection-manifest.json \
  --output data/issue-1609/dry-run-plan.json \
  --evidence-dir data/issue-1609/evidence \
  --requests-dir data/issue-1609/requests \
  --receipts-dir data/issue-1609/receipts \
  --journal data/issue-1609/apply-journal.json
```

`--source-snapshot <file>` 仅用于离线重放已经取得并单独校验过的 source
snapshot；在线运行默认从固定 commit 的 `raw.githubusercontent.com` 读取，且
会重新校验 Git blob SHA 和 byte length。

冻结器按 50 个 issue 分块发出精确编号的 GraphQL 只读查询，避免单个大查询
造成超时。当前工作会话曾对该只读重放做 90 秒超时审计；GitHub API 未返回
结果、未生成替代清单，也未发生任何写操作。已提交的清单仍是本批次唯一冻结
输入；若 fresh freeze 无法完整返回，必须保持 fail closed。

## 当前结果

| 项目 | 数值 |
|---|---:|
| frozen selection | 366 |
| `single-interview` candidate | 246 |
| `not-interview` candidate | 7 |
| blocked / pending | 113 |
| mutation attempted | 0 |
| `possibly_performed` | 0 |

完整 digest 见 `data/issue-1609/canonical-digest.json`：

```text
selection_sha256: 500bb51557ffed8898caed61faf7bceacff5b25b3d7261b1f49b3ab9f4fc3eb8
dry_run_sha256: 396220b55d792b15c162043eec6f98a445c43432898aee221ecde2cedc12372b
canonical_digest_sha256: 0c048eeacb0ac8c8ebd3910979424d2a069438f1b8077f2370878b46d3d151dd
```

证据不足的 113 项保持 blocked/pending；尤其是空/`null` readable projection、
只有来源标签或不能证明有界事件的内容，未因标题、hashtag、Issue number 或
Derived 数据而升级。`source_evidence` 只引用 Raw 或 source projection，未把
Raw 覆盖为 Derived，也未创建 InterviewNote、source-ready、InterviewContext 或
学习标签。

## Apply boundary

当前没有主控在 issue/会话中对本批次的 live apply 授权，因此：

- evidence comments 未批量 POST；
- SourceNote body/labels 未 PATCH；
- planned receipts 不是 live receipts，均标记 `receipt_state=not-applied`；
- `post-apply-audit.json` 明确为 `audit_status=not-run`，不能冒充 apply 后审计。

主控若后续授权，必须先审阅新鲜 selection/dry-run digest，再沿用现有受保护的
Boundary Review transition runner；任何 live body、labels、SourceRevision、
evidence 或 ownership 漂移都必须重新 plan 并 fail closed。
