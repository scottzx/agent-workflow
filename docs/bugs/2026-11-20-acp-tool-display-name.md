# ACP 工具在 DSH 里只显示种类名

状态：2026-11-23 起，插件不再把这条流投影成自己的聊天行。`tool-conversation.js` 和替换 `assistant-step` 的渲染已删除，所以不会再叠出「Bash, Bash」。正文和思考走 DSH 自己的 assistant 流。远程工具仍记在空文本块的 `acpTool` 上，不在本地执行，聊天区也不再为它们单画卡片。下面是当时的定位，桥的显示名规则没有改。

## 看到的现象

2026-11-19 23:12，DSH 桌面版，会话 `session-02f048e1-b885-48ff-ba88-6942ee3c70fd`，预设 `oneagents-acp-antigravity`，工作目录 `/Users/scott/src/dsh-superagent`。

用户气泡下面叠着两行：

- `已注入上下文`
- `Bash, Bash`

这两行不是同一条数据。

## 桥实际转发了什么

Antigravity 的 `session/update` 没有工具说明，也没有 Claude 的 `_meta.claudeCode.toolName`。这条会话第一条工具调用的字段是：

- `toolCallId`
- `title`：整条命令，或 `Running client_view_file`、`Running generate_image`
- `kind`：`execute` / `read` / `edit` / `other`
- `status`
- `rawInput`：`CommandLine`、`Cwd`，或读文件的 `absolute_path`
- 结束时还有 `rawOutput`、`content`、`locations`

上游 acpx 把一轮收成一条 Agent 消息，块是 `Text`、`Thinking`、`ToolUse`。`ToolUse.name` 用的是 ACP 的 `title`，`raw_input`、`kind`、`locations` 都在。服务的历史投影 `extractFromRuntimeRecord` 已经按这个读，没有把 `execute` 写成 `Bash`。

实时路径也转发了 `title`、`kind`、`rawInput`、输出和位置。丢失的是显示名，不是字段。

## 为什么界面只剩名字

1. `packages/service/src/bridge.js` 的 `resolveToolDisplayName`：没有显式 `toolName` 时，用 `kind` 标签盖掉 `title`。`execute` 变成 `Bash`，`read` 变成 `Read`。这条会话里是 `execute→Bash` 13 次，`read→Read` 23 次。
2. `packages/dsh-plugin/src/tool-events.ts` 把桥写上的 `toolName` 存成 `tool.name`。
3. `packages/dsh-plugin/src/tool-conversation.js` 的 `rootOf` 优先用这个名字。还没有助手正文时，第 107 行把名字拼成占位正文，所以看到 `Bash, Bash`。`title` 和 `rawInput` 仍在工具对象上，这条摘要不用。

`已注入上下文` 是 DSH 过程组标题 `message.stepProcess.done.context`。这一组是 DSH 自己的工作目录快照（`user/message`，`source.kind = runtime-context`），不是 Antigravity 的工具列表。它和工具名摘要叠在一起，看起来像注入内容只有工具名。

## 以后要改的话

只改桥、去套上游消息块，挡不住这行 `Bash, Bash`。实时路径要对齐的是身份，不是再造一套块格式。

1. 桥：名字和类型分开。有显式 `toolName`（Claude）才用它，否则用 `title`。`kind` 继续单独转发，只表示类型，不再生成 `Bash` / `Read`。历史投影已经是 `toolName: ToolUse.name`，实时路径对齐它。
2. 插件：`tool-events.ts` 只在确实有显式工具名时写入 `tool.name`。`tool-conversation.js` 用 `kind` 选卡片（`execute` 仍可用命令卡片），可见标题用 `title`。没有助手正文时不要拼名字；工具只走卡片。

`已注入上下文` 不用动。

## 不改的原因

2026-11-20 确认：不影响使用，先保留这篇，不改代码。
