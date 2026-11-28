---
module: packages/service/src/a2a
tags: [a2a, fail-closed, zero-orphan, routing, cross-model-family]
problem_type: governance
status: active
source: PR #35 CR Round 1 M4 / Round 4 M1 / Round 5 M1-S3
paths:
  - packages/service/src/a2a/gateway.ts
  - packages/service/src/roles/routing.ts
---

# 路由校验必须全部前移到 `ledger.prepare` 之前

派单边界上的每一条路由约束（槽位、`deliveryMode`、跨模型族、peer 身份、声明的 peer 端点）都必须在 `ledger.prepare` 之前 fail-closed。`packages/service/src/a2a/gateway.ts:669` 起是这批前置校验，`ledger.prepare` 在 `packages/service/src/a2a/gateway.ts:807`；任何一条挪到 prepare 之后，失败就会落下一个孤儿 attempt，`execution_list` 再也回不到派单前的数量。

## 约束

1. **显式路由决策与钉住路由不可共存**。同时给出 `routingSlot`/`routingRoleId`/`routingFallback` 和显式或目标绑定的 `provider`/`model`，是两次互相矛盾的路由决策，必须拒单（`packages/service/src/a2a/gateway.ts:685`、`packages/service/src/a2a/gateway.ts:688`），不得静默挑一个继续。
2. **reviewer 槽必须能证明 peer**。`routingSlot: "reviewer"` 或 `purpose: "review"` 推导出的 reviewer 槽缺少 `peerJobId` 与 `parentJobRef.jobId` 一律拒单（`packages/service/src/a2a/gateway.ts:769`）；peer job 在账本里没有实际路由记录同样拒单（`packages/service/src/a2a/gateway.ts:1101`）。否则跨模型族不变量没有可比较的对手。
3. **声明式 `peerActualEndpoint` 要与账本对账**。调用方同时给 `peerActualEndpoint` 和 `peerJobId`/`parentJobRef.jobId` 时，以账本记录的真实落跑路由为准，模型族不一致直接拒单（`packages/service/src/a2a/gateway.ts:728`）。只信调用方声明，等于把“异模型审查”这条红线交给被审方自己签名。
4. **只读槽位是全槽属性**。槽内任一候选声明 `readOnly: true`，就要求 `deliveryMode` 与 `resultContract.deliveryMode` 都是 `none`（`packages/service/src/a2a/gateway.ts:798`、`packages/service/src/a2a/gateway.ts:801`）；实际中标候选的 `deliveryMode` 决定本跳的交付指令与账本记录。
5. **模型族以 `model` 为单一真源**。`extractModelFamily`（`packages/service/src/roles/routing.ts:114`）从模型 id 推导族，声明的 `family` 只作断言，矛盾抛 `INVALID_MODEL_FAMILY`；`assertCrossModelFamily`（`packages/service/src/roles/routing.ts:129`）在归一化阶段就硬校验 `family(reviewer) !== family(worker)`。新增模型族（如 minimax）要同步补 `inferModelFamilyFromModel` 的正则，否则族推导会退化成路径首段。

## 误判长什么样

- 校验写在 `prepare` 之后：坏请求留下 `unknown`/孤儿 attempt，重试再叠一层。
- 冲突时“优先显式路由、静默忽略槽位”：调用方以为在跑 reviewer 只读审查，实际派了可写的 worker。
- 只校验 primary 的 `family`，不看 fallbacks：fallback 命中后同族审查，异模型 CR 名存实亡。

## 回归

`packages/service/test/routing-v2-fallback.test.ts` 对每一类拒单都在前后取 `jobCount()` 并断言相等（0 孤儿），同时断言同族候选抛 `RoutingInvariantError("SAME_MODEL_FAMILY")`、伪造 `peerActualEndpoint` 抛 “does not match the peer's recorded actual route”。
