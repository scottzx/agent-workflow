# DSH 0.2.1-rc.2 兼容核对

- 日期：2026-10-27（Asia/Shanghai），macOS，Node 22.22.1，pnpm 11.27.1。
- 对应 [scottzx/1acp#7](https://github.com/scottzx/1acp/issues/7)：报告者在 Windows 11、Node 24.13.0、DSH 0.2.1-rc.2 上看到 host 半边能激活、启用插件后 Web 界面空白。
- 源码：分支 `a2a-gap-closure-20261027`，含 A2A 缺口收口 P0–P3 与 G9（`d7ad911`），以及本次的 `imageRequestTarget` 补充。
- DSH：npm `@deepseek-ai/dsh@0.2.1-rc.2`（npm `latest`，与本机安装的 DeepSeek Harness 同版本）。本次没有升级到 `next` 的 0.2.1-rc.4。

## 编译

把插件开发用的 `node_modules/@deepseek-ai/*` 临时指向 npm 上 0.2.1-rc.2 的同名包（`cordis` 4.0.5）后，`tsc` 只报一处：`LlmAdapter` 新增必需的 `imageRequestTarget`。ACP 适配器只收文本，补上与基类默认相同的实现即可，参数按结构写，在原 0.2.0-rc.1 源码基线上同样能编译。核对结束后链接已恢复到原 DSH 检出。

`test/tool-conversation.test.mjs` 需要 DSH 源码检出（打包 `ui-conversation`、`ui-chat` 源文件），对 npm 包不能运行，本次没有跑。客户端合约改由下面的真实浏览器检查覆盖。

## 安装与界面

在单独的 `DSH_HOME` 里用 `web` 模板新建 profile，`dsh plugin add` 安装当前源码打出的 `@1agents/acp-service@0.9.0` 包，放进 `dsh.profile.bundles`。ACP 服务改到 36832，`ACP_STATE_DIR`、`ACP_CAPACITY_DIRECTORY` 都是单独目录，Web 在 36822。本机正在运行的 DSH（`:3080`）没有动过。

- 首次安装与 2026-10-09 相同，pnpm 拦下 `esbuild` 构建；只放行 `esbuild`，`@1agents/dreammate-node` 保持 false。
- host 半边：插件激活，ACP 服务 `/health` 为 ok，`/manifest` 正常。
- client 半边：页面正常渲染，没有空白，控制台没有错误。`@1agents/acp-service/client.js` 已随插件模块一起加载。
- 预设选择器列出 ACP · Claude Code、Codex、Cursor Agent、Grok、Pi。
- 选 ACP · Codex 后连上本机 codex-acp，显示原生模型 6.1 Sol；「ACP 设置」展开 Collaboration mode 和模式。没有发送 prompt。
- 我们的补丁对 `ui-model-selection` 的 disable 在 0.2.1 里仍然命中该模块。

**#7 的空白界面在 macOS 上没有复现。** 报告者是 Windows 11 + Node 24.13.0，平台差异还没有排除。

## A2A

profile 打开 `a2a`（`defaultAgentPreset: standard`），另起一个隔离网关（36844、单独 state 与容量目录、`--no-report` 不登记 DreamMate）。

- agent card 发布 `/a2a`。`/a2a/sessions/status|close|delete` 都挂到了 0.2.1 的 webServer：无鉴权 401，未知会话 404 `SESSION_NOT_FOUND`。
- 网关 `/health` 带 `taskSlot`、`processSlot` 和 `sessions` 计数。
- G9：`standard` 请求目录里没有的 provider/model，在任何 prompt 之前失败，`MODEL_UNAVAILABLE`；one-shot 随后关闭。ACP 预设带 provider/model 在网关被拒绝。
- 生命周期（真实 DeepSeek 调用两次，经环境里的 `DEEPSEEK_API_KEY`）：spawn 完成并回复 ok → close 得到 `closed` → message 在同一会话上完成 → `mode: "delete"`（网关 `allowDelete: true`）得到 `deleted` → 再 message 返回「Session was deleted」。`/health` 计数 explicit 1、one-shot 1。

没有对 `oneagents-acp-*` 跑 A2A 回合，因为那会用本机 Codex/Grok 账号真正执行。ACP 进程的关闭与接回仍只有隔离单测覆盖。

## 顺带发现

- `standard` 任务失败时结果文字仍是「ACP execution failed.」。
- ACP 预设带 provider/model 被拒时，错误里已有 `jobId`、`attemptId`，说明拒绝发生在账本建 job 之后。`remote_agent_list` 里看不到任务。
