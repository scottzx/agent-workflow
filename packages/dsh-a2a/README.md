# @1agents/dsh-a2a

独立的 A2A HTTP 服务，仅调用已安装的 DSH headless runtime。它不依赖 `@1agents/dsh-acp`，不连接 ACP 端口，不注册 ACP preset，不管理 ACP 进程。

```sh
dsh-a2a ./dsh-a2a.local.json
```

配置示例（令牌通过 `DSH_A2A_TOKEN` 环境变量提供）：

```json
{
  "host": "127.0.0.1",
  "port": 3080,
  "publicUrl": "http://127.0.0.1:3080",
  "stateDirectory": "/absolute/path/to/.1agents/state/dsh-a2a",
  "runtime": {
    "command": "dsh",
    "args": ["--profile", "headless"]
  },
  "workbench": {
    "url": "http://127.0.0.1:36814",
    "token": "<gateway-workbench-token>",
    "pageRelaySecret": "<gateway-workbench-page-relay-secret>"
  }
}
```

服务在自己的端口提供 `/.well-known/agent-card.json` 和 `/a2a`。DSH 插件模式通过 Cordis effect 管理相同服务的生命周期；只应由一个实例启动服务，其他客户端连接其 A2A 地址。`publicUrl` 仅描述对外地址，监听由 `host` 和 `port` 决定。

运行环境须安装支持 `--json`、`--session-id`、`--approval-policy never` 的 DSH headless。源码契约参考本机 DSH 0.2.2-rc.2。`runtime.command` 和 `runtime.args` 是管理员配置的可执行文件和参数数组，不经过 shell；可以显式指向安装版的命令入口。模型、工具、权限和凭据由 headless profile 配置，不继承 Web/Desktop 的全部设置。默认 headless 不读取 GUI 的保存登录，需按 DSH 官方配置启用所需认证。

每次执行启动一个 headless 进程，最终回执和退出码同时成功才报告完成；后续任务通过持久化 runtime session ID 续跑。A2A 返回的是服务自己的稳定 session ID，运行记录保存对应 DSH ID。崩溃、取消或缺少 final 回执会标记结果不确定，阻止静默重发；需人工检查运行记录和 DSH 会话再恢复。

本版本只接受 headless 固定 composition（省略 agentPreset 或使用 standard）；不支持任意 preset、逐任务模型选择、ACP 会话删除和原 Web 工作台接管。默认 headless 模式由 `--approval-policy never` 拒绝需要审批的调用；需要交互式执行审批时使用下述 SDK 模式。Web 工作台迁移到本服务的 `/workbench/ui`（默认 `http://127.0.0.1:3080/workbench/ui`）。使用 `DSH_A2A_TOKEN` 登录，服务端通过 `workbench.url` 转发任务、聊天、产物与审核 API；网关凭据不会发送到浏览器。`pageRelaySecret` 必须与网关一致，才能提交发布、验收和继续任务等人工决定。任务账本仍由网关管理，本包不另建一套账本。未配置网关时可以加载页面和登录，但业务 API 返回配置缺失。原来的父级 DSH GUI 接管入口与 MCP 回传仍不可用。

A2A 协议、持久化任务和预检在构建阶段复用 `@1agents/acp-service` 的宿主无关实现，并打包进本包 dist。发布包没有 `@1agents/acp-service` 依赖，不会安装或启动 ACP 服务。插件启用时把随包的 `acp-service` 用法技能放到 `~/.dsh/skills/acp-service`（`$DSH_HOME/skills` 优先），只保留这一份。技能 frontmatter 的 `version` 是 `@1agents/acp-service` 的版本；已有副本相同或更新时不替换，更旧或没有版本时换成随包的这一份。

交互式执行审批配置：

```json
{
  "runtime": {
    "mode": "sdk",
    "command": "dsh",
    "args": ["--profile", "sdk"],
    "permissionMode": "workspace-write",
    "provider": "<configured-provider>",
    "model": "<configured-model>"
  }
}
```

SDK 模式使用 DSH 原生 JSON-RPC，初始化启用 `approvalRequests`，不使用 ACP。runtime 的权限策略应允许 ask（never 会在发送审批前拒绝）。A2A 任务须由网关携带 `metadata.1agents.execution` 的 jobId/attemptId，且配置 workbench.url/token。审批以 permission 过程请求展示在现有工作台，浏览器原有回答 API 决定批准或拒绝；批准仅授予 allowed-once。缺少任务绑定、请求过期、网关失败、执行取消或连接中断不会放行；取消尽力写回网关。子 Agent 的审批当前拒绝为 cancelled，避免未验证父子关系时错绑任务。SDK 会话与 headless 会话的 profile 不同，应使用独立 stateDirectory，禁止直接切换既有会话。

SDK 每轮等待 session/wait 和精确根会话的 turn/end，再关闭 runtime；恢复使用 session/resume。原生问答、计划审核、DSH GUI 接管不在本次执行审批接入范围。

本地验收：10 项自动测试通过；在 DSH 0.2.2-rc.2 上通过真实 Web 页面登录、真实 Grok SDK 模型执行、工作区外写入审批与浏览器“允许本次”回传，文件内容核验通过；浏览器拒绝后模型停止，拒绝目标文件未创建。独立 tarball 从 npm 公共依赖干净安装后，agent card、工作台 HTML 和脚本可访问。验收同时修复后台标签首次不加载任务的问题。Grok Web 插件采用延迟注册时，SDK composition 须等待适配器就绪后再 initialize。尚未配置系统常驻启动。
