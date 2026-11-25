# A2A 审批与任务单 MCP（`mcp-a2a-approval`）

`@1agents/acp-service` 提供轻量 stdio MCP Server（`acp-service mcp`），代理本机 `a2a-gateway`（默认 `http://127.0.0.1:36814`），对外直出 6 个专注审批与任务单的一级工具。

## 为什么可以直接 `dreammate_invoke`（跳过 `search → inspect`）

已按本文注册到本机 DreamMate MCP 后，服务 ID、方法名与参数契约固定不变：

- `node`: `"localhost"`（或实际运行 `a2a-gateway` 的目标节点）
- `service_id`: `"mcp-a2a-approval"`
- **已知下列精确方法名与参数契约时，可直接调用 `dreammate_invoke`，无需先执行 `dreammate_search_tools` 或 `dreammate_inspect`。**
- 收到 DSH `steer` 推送的 `<system-reminder>` 过程审批提醒时，提醒正文内也会附带完整定位字段与 `mcp-a2a-approval.a2a_process_answer` 直调模板，可一步落盘。

## 6 个方法与直调契约

| `method` | 用途 | 必填 `params` | 可选 `params` |
| --- | --- | --- | --- |
| `mcp-a2a-approval.a2a_pending_approvals` | 跨任务列出所有待审批过程请求（permission/plan/question）、待裁决任务单提议与活跃任务单 | 无（传 `{}`） | `originSessionId`, `jobId`, `includeResolved`, `limit` (1–200) |
| `mcp-a2a-approval.a2a_process_requests` | 查看单个任务上的全部过程请求（含已审批/已过期及审批人） | `originSessionId`, `jobId` | 无 |
| `mcp-a2a-approval.a2a_process_answer` | 审批/答复单条过程请求；自动生成幂等 `clientRequestId` 并强制记录为 `coach` | `originSessionId`, `jobId`, `requestId`, `outcome` | `note`, `stopTask` (仅 `rejected` 时可传 `true` 取消子任务), `answers` (仅 `question` + `accepted`), `clientRequestId`, `coachAgent`, `coachSessionId` |
| `mcp-a2a-approval.a2a_ticket_get` | 读取任务单详情（状态、轮次、意见 `items`、改进提议 `proposals`、历史） | `originSessionId`, `jobId` | 无 |
| `mcp-a2a-approval.a2a_ticket_proposal_decide` | 裁决任务单改进提议（运行结束后也可调用），强制记录为 `coach` | `originSessionId`, `jobId`, `proposalId`, `state` (`accepted`/`rejected`/`done`) | `note`, `coachAgent`, `coachSessionId` |
| `mcp-a2a-approval.a2a_execution_review` | 提交版本绑定业务验收结论，强制记录为 `coach` | `originSessionId`, `jobId`, `attemptId`, `resultRevision`, `resultDigest` (64位sha256), `reviewStatus` (`accepted`/`changes_requested`/`pending`) | `note`, `coachAgent`, `coachSessionId` |

### `outcome` 取值对照（`a2a_process_answer`）

- `permission`（工具权限）：`approved` | `rejected` | `cancelled`（高危操作拒绝并立即止损：`outcome: "rejected", stopTask: true`）
- `plan`（计划审批）：`approved` | `rejected` | `abandoned`
- `question`（提问答复）：`accepted`（必须附 `answers: { "<问题原文>": "<答案>" }`） | `cancelled`

### 直调示例（DreamMate `dreammate_invoke` / CLI）

1. **一键查看全部待审批项**：
```json
{
  "node": "localhost",
  "service_id": "mcp-a2a-approval",
  "method": "mcp-a2a-approval.a2a_pending_approvals",
  "params": {}
}
```

2. **收到 `steer` 提醒后一步批准工具权限**：
```json
{
  "node": "localhost",
  "service_id": "mcp-a2a-approval",
  "method": "mcp-a2a-approval.a2a_process_answer",
  "params": {
    "originSessionId": "session-xxx",
    "jobId": "job-xxx",
    "requestId": "prc-xxx",
    "outcome": "approved",
    "note": "符合任务授权范围，批准执行",
    "coachAgent": "dsh",
    "coachSessionId": "session-xxx"
  }
}
```

3. **拒绝越界操作并立即终止子任务**：
```json
{
  "node": "localhost",
  "service_id": "mcp-a2a-approval",
  "method": "mcp-a2a-approval.a2a_process_answer",
  "params": {
    "originSessionId": "session-xxx",
    "jobId": "job-xxx",
    "requestId": "prc-xxx",
    "outcome": "rejected",
    "stopTask": true,
    "note": "越界写入受限目录，拒绝并终止任务"
  }
}
```

4. **裁决任务单改进提议**：
```json
{
  "node": "localhost",
  "service_id": "mcp-a2a-approval",
  "method": "mcp-a2a-approval.a2a_ticket_proposal_decide",
  "params": {
    "originSessionId": "session-xxx",
    "jobId": "job-xxx",
    "proposalId": "R1-1",
    "state": "accepted",
    "note": "纳入下一轮规则迭代"
  }
}
```

若宿主机尚未接入 `mcp-a2a-approval`，可回退直调 `service_id: "a2a-gateway"` 的底层方法：`execution_pending_approvals`、`execution_process_requests`、`execution_process_answer`、`ticket_get`、`ticket_proposal`、`execution_review`。

## 启动与注册到 DreamMate MCP

在运行 `a2a-gateway` 的本机执行（使用 `sharing: "local"`，仅本机回环调用方可见，不向未授权局域网节点暴露审批能力）：

```sh
dreammate-node mcp add --config '{
  "mcpServers": {
    "a2a-approval": {
      "command": "acp-service",
      "args": ["mcp", "--url", "http://127.0.0.1:36814"],
      "sharing": "local"
    }
  }
}'
```

若本机使用指定路径的 Node 与源码/部署目录，可将 `command` 替换为绝对 Node 路径、`args` 首项替换为 `.../dist/bin/acp-service.js`。

也支持直接挂到任意标准 stdio MCP 客户端（Claude Code / Cursor / Antigravity / Codex）：

```json
{
  "mcpServers": {
    "a2a-approval": {
      "command": "acp-service",
      "args": ["mcp", "--url", "http://127.0.0.1:36814", "--agent", "claude-code"]
    }
  }
}
```

可用环境变量：`A2A_GATEWAY_URL`、`A2A_MCP_COACH_AGENT`、`A2A_MCP_COACH_SESSION_ID`。

## 权限与安全边界

- **强制教练身份（`coach`）**：所有通过本 MCP 落盘的审批、提议裁决与业务验收均自动写入 `kind: "coach"`，禁止且无法通过参数伪造 `kind: "person"`。
- **不触碰页面强人工关口（`PAGE_ONLY_ROUTES`）**：版本化人工审核决定（PPT 脚本/报告批准）、智能体发布上线、人类交接决定仍只能在工作台页面完成。
- **前提约束**：只有经 A2A 网关上报 `ProcessRequest` 的任务（外部 ACP 适配器或 `@1agents/dsh-a2a` 启用 `mode: "sdk"`）才会进入待审批列表；`headless --approval-policy never` 或宿主内部未上抛的子智能体不会进入网关账本。
