# @1agents/acp-service 0.10.5

## 新增与修复

- 导出 `./a2a-standalone` 窄构建入口，仅提供宿主无关的 A2A server 和 preflight 实现，供 `@1agents/dsh-a2a` 构建时打包；避免其运行时安装 ACP 组合包。
- 导出 `WorkbenchUi`，使独立工作台复用同源 Cookie 登录。
- 扩展工作台资源目录查找，支持 dist 中捆绑的 workbench-ui 页面资源。

## 验证

- 通过本地 A2A 构建、10 项测试、独立 tarball 无 acp-service 运行测试。
- 本地 tarball 发布命令已返回 `+ @1agents/acp-service@0.10.5`；npm registry 仍在同步，当前公开查询暂时仍为 0.10.4，未重复发布。构建与 465 项测试全部通过，公开 dsh-a2a@0.1.1 已独立安装并运行，不依赖该 service 版本。
