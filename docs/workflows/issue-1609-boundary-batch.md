# Issue #1609 Boundary D batch

本批次严格限定为当前 live baseline 中的 `#1139–#1508`：精确读取该区间的
370 个编号，只将当前仍具备 `type:source-note`、`status:captured`、
`boundary:pending` 的 238 个 SourceNote 纳入本次 selection；其余 132 个排除，
不再进入本次 evidence/request。固定来源为
`liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`。

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
冻结 manifest 的文件才算 cache hit。当前本批次为 7 hit、161 miss、70
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

冻结器按 50 个 issue 分块发出精确编号的 GraphQL 只读查询，并对 TLS/EOF/超时
等 transient read 做最多 5 次有界重试；不合格的最终读取保持 fail closed，且
不会把网络错误伪装成 Source 证据。此次重放有一次 TLS timeout，重试后取得完整
区间；未发生任何写操作。selection manifest 是本批次唯一冻结输入。

## Ambiguity audit

`data/issue-1609/ambiguity-audit.json` 对当前 238 条逐条记录以下 flags 及对应
issue number：`multi-company-or-process`、`question-list-only`、`question-only`、
`outcome-or-offer-only`、`no-first-person-event`、`no-candidate-event-evidence`、
`generic-question-bank-or-job-ad`、`generic-advice-or-aggregated`、
`scheduled-only`、`job-or-title-only` 和 `non-interview-format`。规则是：

当前 flag counts 为：multi-company/process 3、question-list-only 104、
question-only 117、outcome/offer-only 18、no-first-person-event 216、
no-candidate-event-evidence 232、generic question-bank/job-ad 15、
generic-advice-or-aggregated 23、scheduled-only 6、job/title-only 1（#1200）、
non-interview-format 5。完整 issue number
列表在 audit JSON 的 `flag_issue_numbers` 中。

- 只有 Source 明确记录一个已完成的 bounded candidate event，并有结构化过程/问答
  证据，才能得到 `single-interview`；单一流程中的一面/二面/三面仍是一个 case。
- 多个独立流程若各有可定位的详细 Source 段落，才产生稳定 `case_key` 和唯一
  locator 的 `multi-interview`；否则 `blocked`。
- 通用建议/汇总、预约/邀请、只有题目列表、只有结果/offer、仅职位元数据、缺少
  事件边界或候选人实际过程证据时统一保持 `blocked`；不能用 round、时长或问题
  清单单独升级边界。
- NFKC 只用于识别兼容字符，不授权事件边界；只有岗位、轮次、时长、base 等
  标题元数据的 #1200 标为 `blocked`，因为没有候选人实际经历、问答或过程。

本轮重点复核结果：#1141（多公司社招总结）、#1267（多公司但仅进度/结果）、
#1447（多家公司累计内容）均为 `blocked`。#1452 已不再属于当前 pending
selection，因 live boundary 已不再是 pending 而排除；它不会被本次重新申请。
题库/岗位广告、建议/汇总、预约、仅题目、仅结果和无事件证据均保持 `blocked`。

本次没有确定性 terminal candidate，故 staged request 数为 0；旧计划中的
blocked 项不生成伪 terminal request。producer 仍以 `validateTransitionRequest`
校验任何未来可生成的 request，contract 使用
`source-note-boundary-review-transition.v1/v2`、`transition_id`、固定
`reviewed_at`、`reviewer_kind`、`review_evidence` placeholder、
`expected_manifest_sha256=null` 和固定 source ref；v2 的每个 case 仅含
`case_key` 与 `evidence:[{ref,locator}]`。placeholder 不是 live comment，故
不能被 planner 的 live evidence gate 通过。`blocked` 不是现有 transition
decision，故当前 238 项不生成伪 terminal request，只在逐条 evidence/audit/receipt
中保留 `transition_request_staged=false`。

## 当前结果

| 项目 | 数值 |
|---|---:|
| frozen range | 370 issue numbers read |
| current pending selection | 238 |
| `single-interview` candidate | 0 |
| `multi-interview` candidate | 0 |
| `not-interview` candidate | 0 |
| blocked / pending | 238 |
| schema-valid staged requests | 0 |
| mutation attempted | 0 |
| `possibly_performed` | 0 |

完整 digest 见 `data/issue-1609/canonical-digest.json`：

```text
selection_sha256: c7d3f55dc62ec6e2ebef2bdd2715f74f298db83dae7d531dd6ab3390632b76f9
dry_run_sha256: 8aff930d77a21e356bc15395a5e545df763dca26efbc6d1e4a9730ec3463fb3e
canonical_digest_sha256: 030f2a010b6cb2125154be26813fc721dd7e373f00258b25c523fc7233b68541
```

证据不足的 238 项保持 blocked/pending；尤其是空/`null` readable projection、
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
