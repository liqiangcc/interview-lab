# ExplorationSession History 校验

## 目的

单个 `exploration-session-checkpoint.v1` 只能证明一个 checkpoint 自身结构一致，不能证明同一 `session_id` 的前后状态没有倒退。

History validator 负责检查同一 Issue 中 machine checkpoints 的跨 comment 状态迁移。

它补充单 checkpoint validator，不替代 semantic no-look-ahead / attribution review。

## 输入与顺序

History validator 从 Issue comments 中只提取真正包含 machine marker 的 comment：

```text
<!-- exploration-session-checkpoint
{ ... }
-->
```

然后按：

```text
created_at
→ comment id
→ input order
```

建立稳定顺序，并按 `session_id` 分组。

历史上 contract 引入前没有 marker 的旧 comment 不参与 machine history，不要求迁移。

## v1 Session identity

同一 `session_id` 内以下字段必须稳定：

```text
target_type
target_id
mode
source_revision_id
revealed_range 的 start
```

尤其是 `source_revision_id`：v1 不定义 session 内 revision transition。

如果 SourceRevision 改变，应关闭 / 放弃当前 session，并创建新的 ExplorationSession；不要在同一 history 中静默切换 revision。

## Position 单调性

相邻 machine checkpoints 的 `revealed_position` 只能：

```text
N → N
或
N → N+1
```

禁止：

```text
N → N-1   # 倒退
N → N+2   # 跳过未 checkpoint 的 position
```

推进到 `N+1` 前，`N` 的最新 checkpoint 必须已经：

```text
ready-to-close
或
complete
或
deferred
```

不能从仍然 `active` 的 position 直接向前推进。

## 同一 Position 的稳定边界

当 `revealed_position` 不变时：

- `current_source_unit` 不得改变；
- `source_unit_type` 不得改变；
- known Source type 的 `loop_phase` 不得倒退；
- `position_status` 不得从 closure state 回到更早状态；
- 一旦 `has_withheld_within_unit=false`，同一 position 后续 checkpoint 不能重新声明为 `true`。

当前 v1 不能可靠比较任意字符串形式 `temporal_cursor` 的全序，因此只 machine-enforce 一个重要边界：

```text
fully revealed
不能回到
has withheld future Source
```

更细的 position 内语义顺序仍需要 review。

## Position status 状态机

同一 position 内允许：

```text
active
→ active | ready-to-close | complete | deferred

ready-to-close
→ ready-to-close | complete

complete
→ complete

deferred
→ deferred
```

`complete` / `deferred` 在同一 session、同一 position 内不重新变回 active。

当 position 增加时，新的 position 可以重新从 active loop 开始。

## Session completion

`session_status=completed` 是 terminal state。

一旦某个 machine checkpoint 把 session 标记为 completed，同一 `session_id` 后面不得再出现 checkpoint。

需要重新探索同一个 InterviewNote 时，创建新的 `session_id`，而不是复活已完成 session。

## Machine proof 与 semantic review 的边界

History validator 可以证明：

```text
identity / revision 稳定
position 单调
position advance 有 closure gate
known loop phase 不倒退
closure status 不倒退
fully-revealed frontier 不回退
completed session 不复活
```

它不能只靠 checkpoint JSON 证明：

```text
自然语言解释没有偷看未来
某个 temporal_cursor 的语义顺序一定正确
Outcome 没有被用来制造 hindsight attribution
Derived interpretation 一定忠于 Source
```

因此：

```text
machine history PASS
≠
semantic review PASS
```

两层门禁必须同时保留。

## Live workflow

`ExplorationSession checkpoint 校验` workflow 在新建 / 编辑 checkpoint comment 时执行：

```text
当前 comment validator
+
Issue 全量 machine checkpoint history validator
```

因此编辑旧的 v1 checkpoint 也会重新验证整条当前 history，避免通过修改过去 comment 静默破坏状态机。
