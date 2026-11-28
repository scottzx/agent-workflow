---
name: local-deploy-verify
description: PR 合并后执行本机 @1agents/acp-service 与 DSH Desktop 原子部署同步，并核验 36814 与 3466 端口页面静态资源逐字节一致。
whenToUse: 用户要求更新本机 DSH Desktop / a2a-gateway 运行版本、核验本地发布包一致性或排查 36814 与 3466 界面不一致时。
disable-model-invocation: false
user-invocable: true
---

# 本机原子部署与核验（local-deploy-verify）

## 执行规范

1. 始终使用 `scripts/local-deployment.mjs` 按 `packages/service/package.json` 精确版本号定位 `release/1agents-acp-service-<ver>.tgz`，严禁通配符抓旧包或手工 `tar` 覆盖。
2. 使用 `--desktop-profile` 原子同步 `.tgz` 与解包目录（保留嵌套 `node_modules/`，任一步失败自动逆序回滚）。
3. 严禁随意执行 `launchctl kickstart -k gui/$(id -u)/com.1agents.acp-service` 强杀正在承载回调的常驻服务。
4. 同步完成后执行 `node scripts/local-deployment.mjs verify-live-css` 确认 `36814` 与 `3466` 的 `/workbench/ui/app.css` 逐字节一致。
