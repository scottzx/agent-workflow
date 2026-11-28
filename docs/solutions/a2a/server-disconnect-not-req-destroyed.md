---
module: packages/service/src/a2a
tags: [a2a, disconnect, abortsignal, duplicate-execution, node22]
problem_type: regression
status: active
source: PR #35 CR Round 2 M1 / Round 3 M1
paths:
  - packages/service/src/a2a/server.ts
  - packages/dsh-plugin/src/a2a-executor.ts
---

# 客户端断连不能用 `req.destroyed` 判断

Node 22 里 `for await (const chunk of req)` 把请求体读完之后，`req.destroyed` 恒为 `true`（`IncomingMessage` 读尽头即自毁）。把它当成“客户端提前断开”的判据，等于在 body 读完后无条件早退：请求永远拿不到响应，预分配阶段的 `X-1Agents-Dispatch-Rejected` 也会被吞掉。

## 约束

1. **不要用 `req.destroyed` 判早退**。判断客户端是否还在，只能用 `res.destroyed`、`res.writableEnded`、`req.socket?.destroyed`，以及自己维护的 `clientAborted` 标记。
2. **断连必须由事件驱动**。在 `res.once('close')` 和 `req.socket?.once('close')` 上挂同一个 `onDisconnect`，由它 `abort()` 一个 `AbortController`；`checkRouteAvailability({ signal })` 用这个 signal，慢准入（`modelCatalog` 等）才能被立刻打断。见 `packages/service/src/a2a/server.ts:399`、`packages/service/src/a2a/server.ts:406`、`packages/service/src/a2a/server.ts:422`。
3. **Task 分配前后都要守卫一次**。钩子返回后、进入 `transport.handle(body, context)`（`packages/service/src/a2a/server.ts:435`）之前必须再查一次 `isClientGone()`（`packages/service/src/a2a/server.ts:428`），否则网关侧 10s `AbortSignal.timeout` 放弃的主路由会在超时之后仍分配并执行 Task，与 fallback 路由形成同一任务的**双模型并发执行**。
4. **后端必须真正消费 signal**。`DshA2ABackend.checkRouteAvailability` 在每个 await 前后检查 `input.signal?.aborted`（`packages/dsh-plugin/src/a2a-executor.ts:259`），`prepare`/`run` 用 `signal.throwIfAborted()` 与 abort race 收口（`packages/dsh-plugin/src/a2a-executor.ts:296`、`packages/dsh-plugin/src/a2a-executor.ts:410`）。只把 signal 存在参数里不检查，等于没有断连保护。

## 误判长什么样

- 用 `req.destroyed` 判早退：body 一读完就 `return`，客户端收到空响应或超时；测试里表现为准入拒绝标记没有发出。
- 不监听 `res`/`socket` 的 `close`：请求被 `AbortSignal.timeout(10_000)` 放弃后，主路由仍走进 `transport.handle`，`executedRoutes` 里同时出现主模型和 fallback 模型。
- 只在分配前守卫、不管分配后：超时放弃的请求仍会在后端 `selectModel` 阶段“复活”，产生 `unknown` 轮次和重复执行。

## 回归

`packages/service/test/routing-v2-fallback.test.ts` 的 `real createA2AServer …` 用例用 `hang_timeout` 造出真实 `DOMException TimeoutError`，超时切换到 fallback 后释放主路由的挂起 Promise，再断言 `backend.executedRoutes` 只包含 fallback 模型；`S3: X-1Agents-Dispatch-Rejected …` 用例断言 Task 分配后的拒绝不得带预分配标记。
