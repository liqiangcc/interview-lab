# 13 个已有 InterviewNote 的 Context 事实审核

本批次为全量标签化目标准备 13 份 `interview-context.v1` Derived artifact。仅审核公司、粗粒度岗位、招聘类型、轮次和发生时间；未执行 Source Review lifecycle、标签或标题写入，也不代表 #1658/#1661/#1662 完成。`mutation_performed=false`。

## 来源与审核边界

2026-09-12 全量 GET 得到 1460 个 SourceNote（15 页、短终页），全库 owner inventory 为 65。planner 对这 65 个 owner 再次逐条 GET，对 body、identity 和完整 labels 做精确匹配。`full-plan-summary.json` 保存此次当前输出摘要；有一次 #1566 GET EOF，经 planner 自身有限重试恢复，最终完整生成输出。summary 内的 `ownership_search_errors=[]` 是 planner 字段，不能解释成额外执行了 GitHub Search。

Context 使用固定提交 `4aec350d402f667458282bb36be124e12f978e0a` 的 `audit/issue-1658-receipt-repair/current-live-snapshot.json` owner 原文。生成时将每条原文 SHA 与此次 fresh inventory 匹配，同时将 SourceNote 原文 SHA 与本轮完整 source GET 匹配；13/13 相同。原始附件固定在 `liqiangcc/xhs@95b77bb261048059846273688e4b90a2e108b437`。`review.json` 保存 body/revision 绑定、审核摘录、Context 文件 SHA 和标签/title 投影。

这是内容事实审核，不是 source-ready 声明。`source_review_preflight` 用原有 `computeChecks()` 回放 13 条 source/owner 快照，ownership 检查的传入范围仅为这 13 个 owner；它不替代未来 apply 时全库唯一性 fresh GET。13 条都有 `raw_projection_traceability=fail`，其余机械检查通过。仓库已有 pinned-source-artifact 路径，后续仍须实际核验 artifact、生成固定 manifest、独立 review evidence，并通过最终 Source Review 门禁；不能伪造 Raw 血缘。

## 事实判断

- #1309 的 Java 应用研发归入 backend 为 reviewed inference，结合标题及正文服务端中间件问题；日期来自明确写出年份的原始标题。
- #1333 的公司与 data 岗位来自正文“深蓝汽车-大数据开发岗”。换面试官不等于第二轮，轮次仍 unknown。
- #1380 的 C++、#1447 的 Java 不足以单独证明粗粒度岗位，role 保持 unknown。
- #1418/#1428 明确为后端实习，生成 internship；其他招聘类型保持 unknown，不能由谈到过去实习或秋招标签直接推成当前岗位类型。
- 只写月日的来源不借发布时间推断面试年份。没有原始 note_desc 的十条仅提取已有标题能够支持的事实，未使用历史 OCR 回填正文。
- Outcome 未进入 Context 或 discovery title/labels。审核摘录保留来源文字，属于复核证据，不是学习前展示内容。

## 重放

在包含固定输入提交的仓库执行：

```bash
# 全新 clone 若没有该对象，先取固定来源提交：
git fetch origin 4aec350d402f667458282bb36be124e12f978e0a
node data/pilot/issue-1662/context-review-13/verify.js
node --check data/pilot/issue-1662/context-review-13/verify.js
npm test
git diff --check
```

verify 为只读离线核验，无生成或 apply 模式。它校验 13 条精确 scope、owner/source body、Context SHA/identity/revision、原始摘录、evidence 引用、现有 Context schema 和可重算投影。它不重新执行语义审核，也不证明当前 live 状态持续未变。

## 当前全量剩余项

本轮实际 planner：`skip-not-interview=247`、`already-materialized=47`、`would-materialize=789`、`blocked=411`、`would-repair-receipt=13`；errors=15。其中 408 条 boundary pending，另外 2 条 materialization preflight blocked、1 条 boundary evidence blocked。13 条 applied receipt `interview_note_ids` mismatch 仍在，#910 的两个诊断单列保留。不同阶段的计数不能相加当作 learning-ready 数量。

此提交只预备可复用的 Context；后续必须修复上游真实阻塞、完成独立 Source Review，再 fresh re-plan 后执行受约束的标题/标签投影。保留历史执行 UNKNOWN，不把新的 Context 审核当作原 materialization plan/journal 的替代品。
