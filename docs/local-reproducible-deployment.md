# 本机 A2A 网关与 DSH 的可复现部署

本流程只生成本地发布目录，不发布 npm、不修改公共版本号，也不自动重启宿主。网关和 DSH 使用同一份完整 `@1agents/acp-service` tarball，避免只复制编译后的一个文件而无法追溯。现有通知、任务状态和配置格式不变。

## 构建并冻结输入

在工程根目录执行既有构建与测试。所有编辑结束后再 capture；capture 会比较打包前后的源码指纹，源文件仍在变化时拒绝生成发布。

```sh
pnpm build
pnpm test:integration
node --test scripts/local-deployment.test.mjs
node scripts/local-deployment.mjs capture \
  --root "$PWD" \
  --output /absolute/path/to/new-immutable-release \
  --dependency-root /absolute/path/to/current-runtime/node_modules
```

`dependency-root` 应为已知可运行、采用 npm 目录布局的完整运行时依赖目录。工具逐一核验统一包的直接依赖名称、别名和版本范围；缺失、版本不符、不支持的范围或指向目录外的软链接均停止。源码快照只收集 Git 可见的根构建清单、锁文件、scripts、packages 与 `examples/ppt-beautifier`，排除 node_modules、构建目录和常见凭据文件。发布目录放在源码树外或被忽略的 release 目录中。

发布目录包含统一安装包、`source.tar.gz`、`dependencies.tar.gz`、`release-manifest.json`。清单记录：

- 包版本、tarball 摘要、每个包文件的字节数/摘要/执行位，以及两个入口和 DSH root patch 的验证。
- Git HEAD、真实 dirty 标记与状态、源码快照及逐文件指纹、锁文件摘要。未提交源码不能只用 HEAD 代称。
- Node、pnpm、平台和架构；依赖镜像、直接依赖的实际版本及完整依赖逐文件指纹。
- 源码还原和重建命令。源码重建还需要锁定的依赖来源/缓存及目标 DSH SDK。清单明确区分“源码可追溯”和“已验证逐字节源码重建”，不会默认声称后者成立。

本机发布 ID 为公共版本加源码和包摘要后缀；无需修改 npm 版本。既有公开发布脚本和 CI 语义不受影响。依赖镜像仅适用于记录的平台、架构及相容 Node 运行时。

## 离线安装与验证

```sh
node scripts/local-deployment.mjs verify-release --release /absolute/path/to/release
node scripts/local-deployment.mjs stage --release /absolute/path/to/release --target /absolute/path/to/new-stage
node scripts/local-deployment.mjs verify --target /absolute/path/to/new-stage
```

stage 不访问网络、不运行 npm lifecycle，不依赖 package manager 缓存。它先核对三个归档及清单摘要，恢复完整依赖，再从同一 tarball 安装整个包；随后核对实际文件、依赖和 Host/Client/CLI 入口。再次用相同 release 安装到另一个空目录，两份安装的 package/dependencies 指纹应相同。各目录的绝对路径和安装时间可不同。

网关的入口为 `STAGE/node_modules/@1agents/acp-service/dist/bin/acp-service.js`。检查共享宿主没有正在运行的会话后，由部署者切换服务入口并重启；私密网关配置、任务账本、DSH profile、模型默认设置和产物存储均保留在原位置。新版本启动后还需真实健康检查、方法发现及派单回归。

DSH 可以将其包槽位切换到已验证的完整 stage：

```sh
node scripts/local-deployment.mjs activate \
  --stage /absolute/path/to/new-stage \
  --mode copy \
  --target /absolute/path/to/dsh-profile/node_modules/@1agents/acp-service \
  --receipt-path /absolute/path/to/release/dsh-activation.json
```

DSH 建议使用 `--mode copy`：先将完整 stage 包和冻结依赖复制到目标槽位旁的临时目录，核验后将原包目录原子改名为备份，再将完整新安装移入槽位。包的运行时依赖安装在包内 node_modules；DSH 的原生 @deepseek peer 模块仍由目标宿主/profile 提供，不纳入通用网关依赖镜像。这样可保留 DSH 的宿主模块查找路径。未指定 mode 时仍采用 symlink；该模式只适用于已经验证 peer 解析兼容的宿主。两种模式均只修改指定包槽位。调用者应先检查空闲并停止宿主；工具不会自行停止或启动共享宿主。激活回执记录安装方式、前后位置、发布 ID、包与完整安装指纹。以后通过包管理器改动 profile 可能覆盖此本地安装，因此以该回执和部署脚本作为本地版本来源。

## 回滚

停止宿主后，使用原激活回执恢复 DSH 包：

```sh
node scripts/local-deployment.mjs rollback --receipt-path /absolute/path/to/release/dsh-activation.json
```

若包槽位或完整安装的文件指纹已被其他操作改变，rollback 拒绝覆盖。网关将入口切回上一完整 release。回滚后重新启动并检查健康状态。回滚不删除任务状态或产物，也不能代替正在执行任务的无损迁移。

本机有正在运行的 DSH 时，测试应将 `DSH_HOME` 与 `ACP_STATE_DIR` 指向独立的临时测试目录，避免测试默认诊断存储与真实 profile 争用租约。本轮记录在 `docs/dreammate-chain-deployment-20261021.json`，完整证据保存在其中的 evidenceDirectory。

## dev / test 两个固定环境

网关只有两个环境，各自固定在 `~/.local/share/1agents/a2a-gateway/<env>/runtime`，每次部署原地替换，不再按日期保留 release 目录；版本固定靠 Git，不做本地快照。`test` 由 LaunchAgent `com.1agents.a2a-gateway` 运行，`current` 软链指向 `test/runtime`。

```sh
pnpm build && pnpm test:integration
launchctl bootout gui/$(id -u)/com.1agents.a2a-gateway
node scripts/local-deployment.mjs deploy --env test --root "$PWD"
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.1agents.a2a-gateway.plist
```

`deploy` 内部在临时目录里完成 capture、stage 和校验，成功后才替换环境目录，结束后清掉临时目录。首次部署需加 `--dependency-root` 指向现有运行时的 `node_modules`。脚本不会停止或启动宿主，部署前先确认网关空闲（`/health` 中 `taskSlot.used` 与 `sessions.busy` 为 0）。
