# 全量 live planner：已有 request 摘要重放后的实际结果

实际执行代码为 `2462c18a72f8f118aaa02c4c818d241e30361d2b`；`live-summary.json` 保存代码文件 SHA、来源分页信息、计数、全部错误及目标 13 行。`full-plan.json.gz` 是此次完整 planner JSON 的无损压缩，保留全部 1507 行，避免在 diff 重复展开约 1.8 MB。

本次重新 GET SourceNote 全集（1460 条，15 页，短终页）、重新生成完整 owner inventory（65 个），planner 又逐个 GET owner 对账；全仓库 comments 2682 条、27 页、短终页。没有复用旧 SourceNote/owner 输入作为本轮 fresh 快照，也没有额外执行 GitHub Search；`ownership_search_errors` 是沿用的 planner 字段名。

实际命令（全部 GET-only）：

```bash
node scripts/generate-issue-1611-interview-note-ownership-inventory.js \
  --output /tmp/interview-lab-request-replay-20260912/ownership.inventory.json
node scripts/plan-issue-1611-live-materialization.js \
  --ownership-file /tmp/interview-lab-request-replay-20260912/ownership.inventory.json \
  --source-notes-output /tmp/interview-lab-request-replay-20260912/source.snapshot.json \
  --boundary-report-output /tmp/interview-lab-request-replay-20260912/boundary.report.json \
  --boundary-manifest-output /tmp/interview-lab-request-replay-20260912/boundary.manifest.json \
  --output /tmp/interview-lab-request-replay-20260912/full.plan.json
```

结果：`already-materialized=60`、`would-materialize=789`、`skip-not-interview=247`、`blocked=411`、`would-repair-receipt=0`。目标 13 行全部 already-materialized，errors=[]，采用已有 receipt ID 且完整 request SHA 匹配，没有新增 owner 或 materialization receipt。

全量仍返回 exit 1：#910 的 matching evidence got0/ref drift 两项错误仍保留；blocked 411 包含 408 boundary pending、#904/#907 的 existing owner SourceRevision mismatch、#910 boundary evidence blocked。没有隐藏这些行或伪称全量 apply-ready。

单位说明：1460 是 SourceNote 数；29 个 multi-interview SourceNote 展开为 76 个 case，使结果行比 SourceNote 多 47，得到 1507 行。1099 是 planner identity claim 数（包括 247 个 not-interview 排除检查）；65 是实际 InterviewNote owner Issue 数。60 是本轮被当前 SourceNote/materialization 契约识别为 already-materialized 的行数，不是全库 owner 或 learning-ready 数。

离线核验完整计划摘要、逐行计数及 13 行结果：

```bash
node - <<'NODE'
const fs=require('fs'), zlib=require('zlib'), assert=require('node:assert/strict');
const dir='./data/pilot/issue-1658/materialization-request-replay-20260912/';
const plan=JSON.parse(zlib.gunzipSync(fs.readFileSync(dir+'full-plan.json.gz')));
const summary=JSON.parse(fs.readFileSync(dir+'live-summary.json'));
const {sha256Text,canonicalJson}=require('./scripts/lib/source-note-interview-materialization');
const {dry_run_sha256,...input}=plan;
assert.equal(dry_run_sha256,sha256Text(canonicalJson(input)));
assert.equal(dry_run_sha256,summary.plan_digest);
const counts={};for(const row of plan.results)counts[row.action]=(counts[row.action]||0)+1;
assert.deepEqual(counts,summary.counts);
assert.equal(plan.results.length,summary.result_rows);
assert.deepEqual(plan.errors,summary.errors);
const rows=plan.results.filter(r=>summary.scope.includes(r.source_note_issue_number));
assert.equal(rows.length,13);assert.ok(rows.every(r=>r.action==='already-materialized'&&r.errors.length===0));
assert.equal(counts['would-repair-receipt']||0,0);
console.log('PASS: canonical plan digest, 1507 row counts, 13 already-materialized, remaining errors preserved');
NODE
```

该结果证明当前计划的幂等识别已收敛，不证明历史原授权 plan/journal 已找回，也不代表 Source Review、Context apply 或全量标签化完成。历史执行继续 UNKNOWN。
