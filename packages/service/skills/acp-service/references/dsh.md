# DSH 插件使用

## 安装与服务生命周期

在兼容当前插件公开 API 的 DSH checkout 中执行：

```sh
pnpm dsh plugin --profile web add @1agents/acp-service
# 本地构建也可使用绝对包目录或构建好的 tgz
```

安装后按该部署的方式重启 DSH。若使用已安装的 `dsh` 可执行文件，省略 `pnpm`。同一个包还提供 CLI，无需独立安装旧 `@1agents/dsh-acp` 或 runtime 包。

已有旧 bundle 时先停止 DSH，移除旧 bundle，再安装统一包；保留自定义配置和绑定文件。使用 profile 的 `cordis.patch.yml` 配置插件，不修改 DSH 源码或默认 profile。

默认 `serviceMode: auto`：插件复用健康的本地 ACP 服务，未运行时在 `127.0.0.1:36812` 启动内嵌服务。卸载/停止插件时，只关闭自己拥有的服务；远端 URL 或 `serviceMode: external` 不管理服务进程。

## 选择执行 Agent

新建会话时选择工作区与预设：

| 预设 | 执行者 | 模型来源 |
| --- | --- | --- |
| `standard` | DSH 标准 Agent，使用该部署的工具和模型路由 | DSH 默认 provider/model 或会话模型选择 |
| `oneagents-acp-codex` | 外部 Codex Agent | Codex 原生配置和公布的模型选项 |
| `oneagents-acp-<agent-id>` | 对应外部 ACP Agent | 对应 Agent 原生配置 |

插件按 `/agents` 中 `chat_ready` 的条目注册 `ACP · Agent` 预设。显式配置 `agents` 可限制范围；`agents: []` 不注册 ACP 预设，但不会把普通 `standard` 预设变成 ACP。

ACP 会话的 prompt 直接交给原生 Agent。原生 Agent 拥有其模型、工具、项目指令与历史；DSH 提供界面、权限/问题交互和本地会话记录。DSH 显示外部工具进度，不会再次执行那些工具。

会话开始后保留工作目录和 Agent；切换执行 Agent 或工作区应新建会话。`standard` 不是 ACP 的 `modeId`：它是 DSH 预设 ID。

## 模型、模式与交互

ACP 会话里的 `/model`、模式与“ACP 设置”使用 Agent 公布的选项：模型/思考强度走 `session/set_config_option`，模式走 `session/set_mode`。缺失的选项不会自动生成；执行中拒绝修改配置。

ACP 设置里被 Agent 接受的值，按工作区绝对路径和 Agent 名称记在插件状态目录的 `agent-session-settings.json`。Grok Build 与 Codex 各自保存自己的 mode id 和配置 id。之后同一工作区、同一 Agent 的新建会话会在首条 prompt 前回放：模型在前，其余选项对照每次返回的新目录，模式最后。目录缺少当初的 id 或值时，在 prompt 前失败。已有会话保持原设置。没有试跑记录时，新会话仍只套用 `sessionPolicies.initialModeId`。调用参数不增加这些字段。

普通 DSH 会话仍选择 DSH provider/model。检查实际模型时，以模型目录和会话请求记录为准；例如部署默认 MiniMax 时标准预设会使用它，换部署不能假定仍是 MiniMax。

需要工具审批、问题回答时，使用 DSH 的现有交互 UI。浏览器刷新不取消 Host 请求；停止 DSH 当前轮会发送 ACP 取消。当前插件接入支持文本 prompt，不能承诺 DSH 附件也已转发给外部 Agent。

## 配置与状态

在已有 `oneagents-acp` 配置行里设置，例如：

```yaml
config:
  serviceMode: auto
  serviceUrl: http://127.0.0.1:36812
  agents: [codex]
  reconnectAttempts: 5
  reconnectDelayMs: 1000
```

删除 `agents` 字段可恢复自动发现。`stateDirectory` 设置 ACP 绑定目录；默认 `<DSH_HOME>/plugins/1agents-acp/sessions`。A2A 的 `a2a.stateDirectory` 是另一份状态，见 [A2A](a2a.md)。

原生 Agent 可执行文件和凭据必须能被服务进程读取。`auto` 子服务继承 DSH 环境，既有外部服务则使用自己的启动环境。安装 CLI 或看见预设都不等于认证成功。

安装配套 `@1agents/session-reader` 后，可在支持的 Claude/Codex/Grok 历史中选择“在 DSH 中继续原会话”。它恢复原生身份并导入历史，不重发旧 prompt；有活跃原生 writer 时保持只读，等待 writer 释放后恢复输入。

完整插件配置、恢复和导入 API 随包位于 `vendor/dsh/README.md`。
