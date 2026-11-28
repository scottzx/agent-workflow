---
module: packages/service/src/a2a
tags: [a2a, session-delivery, pretask, unknown, rejected]
problem_type: governance
status: active
source: PR #35 CR Round 4 M1/S1
paths:
  - packages/service/src/a2a/session-delivery.ts
  - packages/service/src/a2a/session-hosts.ts
  - packages/service/src/a2a/server.ts
  - packages/service/src/a2a/gateway.ts
  - packages/dsh-plugin/src/session-notice.ts
---

# 预分配拒绝标记只属于准入阶段，投递队列不得混并 unknown

`X-1Agents-Dispatch-Rejected: 1` 与响应体里的 `preTaskRejected: true` 是网关判断“这一单**确定没有提交**”的唯一凭据（可以记 `known_not_submitted`/`rejected`，配额恢复后还能 `execution_continue` 同一个 `jobId`）。它一旦在 Task 分配之后发出，或 `unknown` 的投递被当作 `rejected` 合并处理，就会把“模型可能已经在跑”的轮次变成“确定没跑”，重试即双执行。

## 约束

1. **标记只在准入钩子阶段发出**。`packages/service/src/a2a/server.ts:370` 的 `inPreTaskAdmission` 只包裹 `checkRouteAvailability`（`packages/service/src/a2a/server.ts:416`），返回后立刻复位（`packages/service/src/a2a/server.ts:425`）；只有该阶段抛出的 `A2ADispatchRejectedError` 才写标记（`packages/service/src/a2a/server.ts:461`）。`backend.prepare`/`run` 阶段的同类错误必须落成普通的 JSON-RPC 错误。
2. **网关只信标记，不信状态码**。`packages/service/src/a2a/gateway.ts:1583` 只有在收到该响应头时才把它翻译成 `A2ADispatchRejectedError`；派单循环用“全候选都在分配前被拒”判定 `known_not_submitted`（`packages/service/src/a2a/gateway.ts:1017`、`packages/service/src/a2a/gateway.ts:1050`），任何一次超时或网络歧义都会把 `allRejectedPreTask` 拉回 false，最终走 `markUnknown`（`packages/service/src/a2a/gateway.ts:1069`）。
3. **`unknown` 与 `rejected` 是两种不可合并的边界**。`packages/service/src/a2a/session-delivery.ts:331`、`packages/service/src/a2a/session-delivery.ts:340` 把两者都作为 FIFO 阻塞项与统计项分别计数；`resolve` 只允许处理 `unknown`/`rejected`（`packages/service/src/a2a/session-delivery.ts:369`）；投递失败时只有“确定性拒绝”才记 `rejected`，其余（含网关重启时遗留的 `dispatching`）一律 `unknown`（`packages/service/src/a2a/session-delivery.ts:172`、`packages/service/src/a2a/session-delivery.ts:417`）。
4. **同一 FIFO 内不混并**。`pumpQueue`（`packages/service/src/a2a/session-delivery.ts:392`）遇到 `unknown`/`rejected` 只阻塞本 scope 的头条（`packages/service/src/a2a/session-delivery.ts:394`），绝不与其他 scope 的消息合并重排；`packages/service/src/a2a/session-hosts.ts` 与 `packages/dsh-plugin/src/session-notice.ts` 只负责投递与通知渲染，不得替调用方决定“当作已送达”。

## 误判长什么样

- Task 分配后的 429 也带预分配标记：网关记 `rejected` 并允许立刻重试，实际模型已开始执行，同一 `jobId` 出现两条并行执行链。
- 把 `unknown` 和 `rejected` 合并成一个“失败”桶：未确认的投递被当成确定未送达，`session-delivery` 的阻断统计（`blockedOrigins`/`blockedTargets`）失效。
- 重启后把 `dispatching` 直接当 `rejected`：丢失“可能已送达”的事实，重复通知使用者。

## 回归

`packages/service/test/routing-v2-fallback.test.ts` 的 `S3: X-1Agents-Dispatch-Rejected and preTaskRejected are reported for admission rejections only` 用例分别在 `prepare`、`run` 两个阶段注入拒绝，断言响应头与 `preTaskRejected` 都不再出现、轮次收敛为 `failed` 且 `unresolvedAttemptIds` 为 0；再断言准入阶段拒绝仍带标记且 job 记为 `rejected`、0 未决 attempt。
