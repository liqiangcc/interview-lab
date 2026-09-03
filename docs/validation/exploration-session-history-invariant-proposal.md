# ExplorationSession history machine gate — Promotion Record

状态：**PROMOTED / HARD machine gate**

本文件保留从 proposal 到正式 machine-enforcement 的 promotion 证据；文件名保留 `proposal` 仅用于历史可追踪性。

## 已有正式 invariant 关系

History validator 直接实现 / 加强：

- I21：sequential no-look-ahead；
- I22：machine checkpoint frontier contract；
- I31：closure state 显式且自洽。

本次 promotion 将下面的**跨 checkpoint 单调性**视为 I22 / I31 的 HARD history extension；后续如统一重排 invariant 编号，可再并入中央编号表，不影响当前 machine gate。

## 已提升的 HARD 约束

同一 `session_id` 的 machine checkpoint history 必须满足：

```text
同一 session target / mode / source revision / range start 稳定
+
revealed_position 只能保持或 +1
+
advance 前 previous position 已 ready-to-close / complete / deferred
+
同 position current_source_unit / source_unit_type 稳定
+
known loop phase 不倒退
+
position closure status 不倒退
+
fully-revealed within-unit frontier 不回退到 withheld
+
completed session terminal，不得 resurrection
```

v1 不定义 session 内 SourceRevision transition。SourceRevision 改变时应创建新的 ExplorationSession，而不是在原 `session_id` 中静默切换。

## Promotion evidence

### PR gate

PR #6：`feat: validate ExplorationSession history transitions`

- head: `0349c0f0d1ecdba0b2ddd5b88ea652aaf4ebf316`
- merge commit: `150f4fcbf7e44dcbce1d9fa9c01e962012fd383b`
- repository check: PASS
- `node --test`: 37 / 37 PASS
- history-specific regression tests: 10 / 10 PASS
- `validate:exploration-history-fixture`: PASS，4 machine checkpoints / 1 session

### Live Issue-comment gate

Issue #3 上创建同一 validation session 的两个连续 machine checkpoints：

```text
5522868711
literal / active
↓
5522871691
closure / complete / completed
```

第二条触发 workflow run：`33733532285`。

关键步骤全部 PASS：

```text
校验当前 ExplorationSession checkpoint     PASS
提取 Issue 全量 comment history            PASS
校验 ExplorationSession history            PASS
```

因此 promotion gate 不再只依赖 fixture / unit test，而已经验证真实链路：

```text
Issue comment
→ GitHub issue_comment event
→ fetch full Issue comment history
→ group by session_id
→ history state-machine validation
→ PASS
```

## 仍不属于 machine proof 的部分

以下继续保留为 semantic review：

- 任意 `temporal_cursor` 字符串的真实语义先后关系；
- 自然语言解释是否实际偷看未来；
- Outcome / Cause / Verified Weakness 的语义归因；
- Derived interpretation 是否忠于 Source。

因此：

```text
machine checkpoint PASS
+
machine history PASS
≠
semantic review PASS
```

三层边界继续分离。
