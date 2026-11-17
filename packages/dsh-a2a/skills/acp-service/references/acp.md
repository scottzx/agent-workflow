# ACP CLI 与常驻服务

## 能力与前提

统一 CLI 可运行注册的原生 Agent，支持持久命名会话、一次性执行、排队、取消、历史回放、导出/导入、模型/模式控制、结构化输出和 typed flows。注册 Agent 不代表可执行文件与登录已经就绪；先检查实际安装与认证。

常驻服务为这些 Agent 提供 ACP v1 JSON-RPC 2.0 over WebSocket。WebSocket 是本包的自定义 ACP 传输，原生 adapter 仍由内嵌 runtime 管理。支持哪些内容块、模式和配置取决于 Agent。

## 本地 CLI

```sh
# 一次性任务
acp-service --cwd /absolute/project codex exec '阅读 README 并总结项目，不修改文件'

# 命名持久会话：先确保存在，再发送消息
acp-service --cwd /absolute/project codex sessions ensure --name review
acp-service --cwd /absolute/project codex -s review '调查测试失败原因，先不要修改'
acp-service --cwd /absolute/project codex -s review '根据刚才的证据给出修复方案'

# 排队后立即返回；不是等待任务完成
acp-service --cwd /absolute/project codex -s review --no-wait '完成后列出结论'
acp-service --cwd /absolute/project codex status -s review
acp-service --cwd /absolute/project codex sessions history review --limit 20
acp-service --cwd /absolute/project codex cancel -s review

# 结构化事件或最终文本
acp-service --cwd /absolute/project --format json codex exec '说明项目用途'
acp-service --cwd /absolute/project --format quiet claude exec '说明项目用途'
```

持久 CLI 会话按 Agent 命令、绝对 cwd、可选会话名确定作用域；改变 cwd 会改变会话查找。`prompt` 需要该作用域的会话存在，`exec` 是一次性会话。默认权限模式为 `approve-reads`，非交互场景中仍受权限策略约束。

原生 Agent 提供对应选项时，CLI 可以指定模型或调整已存在会话的配置：

```sh
# 用实际公布的模型、配置键和值替换尖括号内容
acp-service --cwd /absolute/project --model <advertised-model-id> codex exec '任务说明'
acp-service --cwd /absolute/project codex set-mode <advertised-mode-id> -s review
acp-service --cwd /absolute/project codex set <config-key> <advertised-value> -s review
```

这些 CLI 模型/模式选项不等于 A2A spawn 支持同名参数。超时的设置操作可能已经生效，核对后再重试。

更多 runtime 选项以 `acp-service <agent> --help`、`acp-service --skill show acpx` 为准；阅读内嵌 `acpx` 技能中的示例时，此统一包使用 `acp-service` 命令和 `@1agents/acp-service/runtime`、`/flows` 导入路径。

## 常驻 HTTP/WebSocket 服务

```sh
acp-service serve --host 127.0.0.1 --port 36812 --no-report
curl http://127.0.0.1:36812/health
curl http://127.0.0.1:36812/agents
curl http://127.0.0.1:36812/manifest
```

默认端口 `36812`。CLI 未传 host 时默认监听 `0.0.0.0`，本地使用显式选择 `127.0.0.1`。服务当前没有连接认证；需要远程开放时由部署网络或认证代理限制访问。省略 `--no-report` 会向本机 DreamMate node 报备。

`GET /agents` 返回服务主机上的 Agent 清单与 `chat_ready`；发现过程不执行 Agent、不下载 adapter，也不验证登录或模型访问。`/manifest` 描述服务契约，不是认证成功证明。`ACP_STATE_DIR` 可覆盖默认 `~/.1agents/acpx-state`。

连接 `ws://127.0.0.1:36812/agents/codex`，或使用清单里的 `/agents/<agent-id>`。每帧是一个 JSON-RPC 对象；客户端要实现通知、工具权限请求和所声明的文件/终端能力。

依次发送：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
```

```json
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/absolute/project","mcpServers":[]}}
```

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"returned-service-session-id","prompt":[{"type":"text","text":"阅读 README，总结项目用途"}]}}
```

`session/prompt` 返回时该轮才结束，输出通过 `session/update` 流式到达。`session/request_permission` 是服务向客户端发送的请求，要返回本次公布的 option ID 或取消结果，不能杜撰永久授权。

| ACP 方法 | 用途 |
| --- | --- |
| `session/new` | 创建服务会话；cwd 是服务执行主机上的绝对目录 |
| `session/load` | 恢复同一服务会话，并回放记录的 ACP 历史 |
| `session/resume` | 恢复但不回放历史 |
| `session/prompt` | 执行一轮；普通重叠请求会被拒绝为 busy |
| `session/cancel` | 取消当前轮的通知，无 RPC 响应；原 prompt 会结束 |
| `session/close` | 释放执行资源，保留持久历史 |
| `session/list` | 查询当前 Agent endpoint 的可恢复会话，可按 cwd 过滤 |
| `session/delete` | 关闭并使服务会话不可恢复/列出 |
| `session/set_mode` / `session/set_config_option` | 切换 Agent 实际公布的模式或配置 |

后续请求使用 `session/new` 返回的 **服务 session ID**。`_meta.1agents.agentSessionId` 可能是原生 ID，不能混用。传输断开后的恢复应使用已有身份；不明确的已受理 prompt 不应自动重发。

## 编程入口与流程

```ts
import { serveAcpService } from '@1agents/acp-service/service';
const service = await serveAcpService({ host: '127.0.0.1', port: 36812, report: false });
// 结束时：await service.close();
```

- `@1agents/acp-service/runtime`：内嵌 runtime API。
- `@1agents/acp-service/agent-registry`：Agent registry API。
- `@1agents/acp-service/flows`：`defineFlow`、`acp`、`decision`、`action`、`compute`、`checkpoint` 等流程 API。
- `acp-service flow run ./task.flow.ts --input-file ./input.json`：运行流程；流程中的动作按用户任务授权执行。

导入包本身不会启动服务。完整协议、配置和恢复说明见随 npm 包分发的顶层 `README.md`。
