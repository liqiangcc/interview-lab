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
可消费的 terminal transition request（仅确定性 terminal candidate）、planned
receipt、journal 和 dry-run plan：

```sh
node scripts/issue-1609-boundary-batch.js \
  --mode evidence \
  --selection data/issue-1609/selection-manifest.json \
  --output data/issue-1609/dry-run-plan.json \
  --evidence-dir data/issue-1609/evidence \
  --requests-dir data/issue-1609/requests \
  --receipts-dir data/issue-1609/receipts \
  --journal data/issue-1609/apply-journal.json \
  --ambiguity-audit data/issue-1609/ambiguity-audit.json \
  --desc-cache /tmp/xhs-note-desc-cache
```

`--source-snapshot <file>` 仅用于离线重放已经取得并单独校验过的 source
snapshot；在线运行默认从固定 commit 的 `raw.githubusercontent.com` 读取，且
会重新校验 Git blob SHA 和 byte length。

若存在 `/tmp/xhs-note-desc-cache`，producer 会按同一 external_id 精确查找
`note_desc/<external_id>.txt`；只有非空、byte length 和 Git blob SHA 都匹配
冻结 manifest 的文件才算 cache hit。当前本批次为 7 hit、239 miss、120
not-applicable；miss/不合格缓存会回退已取得的 source snapshot 或固定 ref 网络
读取，不会因为网络抖动直接改变 disposition。每项状态写入 ambiguity audit，
便于复现本次读取路径。

重算完整 canonical digest：

```sh
node scripts/issue-1609-boundary-batch.js \
  --mode digest \
  --selection data/issue-1609/selection-manifest.json \
  --source-inventory data/issue-1609/dry-run-plan.json \
  --evidence-dir data/issue-1609/evidence \
  --requests-dir data/issue-1609/requests \
  --receipts-dir data/issue-1609/receipts \
  --journal data/issue-1609/apply-journal.json \
  --ambiguity-audit data/issue-1609/ambiguity-audit.json \
  --output data/issue-1609/canonical-digest.json
```

冻结器按 50 个 issue 分块发出精确编号的 GraphQL 只读查询，避免单个大查询
造成超时。当前工作会话曾对该只读重放做 90 秒超时审计；GitHub API 未返回
结果、未生成替代清单，也未发生任何写操作。已提交的清单仍是本批次唯一冻结
输入；若 fresh freeze 无法完整返回，必须保持 fail closed。

## Ambiguity audit

`data/issue-1609/ambiguity-audit.json` 对 366 条逐条记录以下 flags 及对应
issue number：`multi-company-or-process`、`question-list-only`、
`outcome-or-offer-only`、`no-first-person-event`、`no-candidate-event-evidence`、
`generic-question-bank-or-job-ad`、`job-or-title-only` 和
`non-interview-format`。规则是：

当前 flag counts 为：multi-company/process 4、question-list-only 104、
outcome/offer-only 18、no-first-person-event 291、no-candidate-event-evidence
142、generic question-bank/job-ad 16、job/title-only 1（#1200）、
non-interview-format 5。完整 issue number
列表在 audit JSON 的 `flag_issue_numbers` 中。

- 只有 Source 明确记录一个 bounded candidate event 才能得到 `single-interview`；
  单一流程中的一面/二面/三面仍是一个 case。
- 多个独立流程若各有可定位的详细 Source 段落，才产生稳定 `case_key` 和唯一
  locator 的 `multi-interview`；否则 `blocked`。
- 只有题目列表、只有结果/offer、缺少事件边界或缺少足够的一人称/候选人事件
  证据时保持 `blocked`；通用题库、岗位广告、招聘/笔试资源为 `not-interview`。
- NFKC 只用于识别兼容字符，不授权事件边界；只有岗位、轮次、时长、base 等
  标题元数据的 #1200 标为 `blocked`，因为没有候选人实际经历、问答或过程。

本轮重点复核结果：#1141（多公司社招总结）、#1267（多公司但仅进度/结果）、
#1447（多家公司累计内容）均为 `blocked`；#1452 有 OPPO、得物、贝壳找房
三个独立且各自带问题段落的 Source 区块，记录为 `multi-interview`，case keys
分别为 `dewuu-process`、`ke-house-process`、`oppo-process`，locator 为对应
`semantic-anchor`。题库/岗位广告等 16 条为 `not-interview`，其余证据不足项
保持 `blocked`。

正式 staged request 严格通过 `validateTransitionRequest`：使用
`source-note-boundary-review-transition.v1/v2`、`transition_id`、固定
`reviewed_at`、`reviewer_kind`、`review_evidence` placeholder、
`expected_manifest_sha256=null` 和固定 source ref；v2 的每个 case 仅含
`case_key` 与 `evidence:[{ref,locator}]`。placeholder 不是 live comment，故
不能被 planner 的 live evidence gate 通过。`blocked` 不是现有 transition
decision，故 203 项不生成伪 terminal request，只在逐条 evidence/audit/receipt
中保留 `transition_request_staged=false`。

## 当前结果

| 项目 | 数值 |
|---|---:|
| frozen selection | 366 |
| `single-interview` candidate | 108 |
| `multi-interview` candidate | 1 (3 cases) |
| `not-interview` candidate | 18 |
| blocked / pending | 239 |
| schema-valid staged requests | 127 |
| mutation attempted | 0 |
| `possibly_performed` | 0 |

完整 digest 见 `data/issue-1609/canonical-digest.json`：

```text
selection_sha256: 500bb51557ffed8898caed61faf7bceacff5b25b3d7261b1f49b3ab9f4fc3eb8
dry_run_sha256: 350f164cceddfe8ce41f78344b781e64f913ec2f4e276c2de6ca7b0b8ba5772b
canonical_digest_sha256: 6586ddfbb7929e0e0ad3f8ed6787152956ebe0f21d9de76217961b05a3a1b4a4
```

证据不足的 239 项保持 blocked/pending；尤其是空/`null` readable projection、
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
