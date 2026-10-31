# 贡献指南

感谢参与 agent-workflow！

## 环境准备

- Node.js >= 22.13（`package.json` 的 `engines`；CI 和开发推荐 Node 24）
- pnpm 11（版本固定在 `packageManager`）：`corepack enable` 后会自动使用，或用 `npx pnpm@11`

## 构建与测试

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm -r test
```

- DSH 插件（`packages/dsh-plugin`）运行时依赖 DeepSeek Harness 宿主提供的 `@deepseek-ai/*` 包。npm 上有同名的 rc 版本包，**不要从 npm 安装它们**；需要真实类型和运行时时用 `pnpm link:dsh /path/to/DSH`。未链接时，依赖宿主的测试会被跳过。
- 格式检查使用 oxfmt。目前只有 `packages/runtime`（`@scottzx/1acp`）配置了该脚本，CI 也会检查：

  ```sh
  pnpm --filter @scottzx/1acp format:check   # 检查
  pnpm --filter @scottzx/1acp format         # 自动修复
  ```

## 分支与提交

- 从最新 `main` 拉分支，命名为 `<类型>/<简述>`，如 `fix/standalone-build`、`ci/build-workbench-deps`、`docs/contributing`。
- 提交信息沿用现有风格：`<类型>(<可选范围>): <英文小写开头的简述>`，类型有 `feat`、`fix`、`docs`、`test`、`ci`、`build` 等，例如 `feat(rsi): add a QA agent review to the outline run`。

## Pull Request

- 每个 PR 只做一件事，在描述里写清动机和验证方式。
- CI 必须全部通过。
- 至少一位维护者 review 通过后才能合并。

## 报告问题

请在 [GitHub Issues](https://github.com/scottzx/agent-workflow/issues) 提交，附上复现步骤、期望与实际结果、Node/pnpm 版本和操作系统；涉及 DSH 时注明 DSH 版本。请勿在 issue 中粘贴密钥或令牌。

## 许可

提交贡献即表示你同意贡献内容按本项目的许可证（MIT）授权，详见 LICENSE（随 PR #3 加入）。
