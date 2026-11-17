# [Bug] Clash Verge 的 DO-TS-V2 连不上，但 DO 正常

- 记录日期：2026-11-12
- 状态：已定位并修复，已在真实内核上验证
- 环境：macOS ARM64，Clash Verge Rev 2.5.8（内核 verge-mihomo），Tailscale 1.98.5 客户端

## 问题概述

Clash Verge 当前 profile `DO`（`profiles/LwArikta1IAF.yaml`）里的 `DO-TS-V2` 节点完全连不上，
所有走该节点的域名（`claude.ai`、`anthropic.com`）请求失败；而同一 profile 的 `DO` 节点
（直连公网 `178.128.74.214:2096`）一直正常。

`DO` 与 `DO-TS-V2` 指向同一台 SFO 机器（`ubuntu-s-1vcpu-512mb-10gb-sfo2`），出口 IP 都是
`178.128.74.214`，服务端与 REALITY 参数完全一致，唯一差别是**入口链路**：

| 节点 | server:port | interface-name |
| --- | --- | --- |
| `DO` | `178.128.74.214:2096`（公网 IPv4 直连） | 无 |
| `DO-TS` | `100.92.59.9:34475`（Tailscale 内网） | `utun2` |
| `DO-TS-V2` | `100.92.59.9:34475`（Tailscale 内网） | `utun2` |

## 根因

macOS 上 Tailscale 的 utun 网卡序号会随 `tailscaled` 重建而漂移。配置里写死了
`interface-name: utun2`，而**当前实际承载 Tailscale 地址（`100.88.227.56`）的网卡已经是
`utun6`**，utun2 只剩下 IPv6 link-local、没有任何 IPv4 地址。

mihomo 依据 `interface-name` 对出站 socket 设置 `IP_BOUND_IF`（macOS 上对应
`IP_BOUND_IF`/`SO_BINDTODEVICE` 语义）。绑定到一个没有 IPv4 的 utun2 之后，
内核在该网卡范围内查不到 `100.92.59.9` 的路由，直接返回 `ENETUNREACH`：

```
dial tcp4 100.92.59.9:34475: connect: network is unreachable
```

`DO` 节点没有 `interface-name`，走默认出站接口 en0，所以一直正常——这正是本次"一个通一个不通"
的迷惑点，实际两者与服务端毫无关系。

配置注释里其实已经记过一次同样的问题：

> 2026-10-31: Tailscale 重建后网卡序号由 utun4 变为 utun2（utun4 现只剩 IPv6 link-local）

本次是第二次复发（utun4 → utun2 → utun6）。

## 排查证据

1. **路由指向哪个网卡**

   ```
   $ route -n get 100.92.59.9
   route to: 100.92.59.9
     interface: utun6
   ```

   `ifconfig` 显示只有 `utun6` 持有 `inet 100.88.227.56`；`utun2` 只有 `inet6 fe80::...`。

2. **复刻 mihomo 的绑定行为**

   用 `IP_BOUND_IF`（macOS 上 mihomo 绑定 `interface-name` 的实际方式）分别绑各网卡拨号：

   | 绑定网卡 | 结果 |
   | --- | --- |
   | `utun2`（配置里写的） | `[Errno 51] Network is unreachable` |
   | `utun6`（实际的 Tailscale 网卡） | 连接成功 |
   | `en0` | 超时（Tailscale 地址本就不可从公网直连） |

3. **真实内核 A/B 对照**（`/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo`，
   两份仅 `interface-name` 不同的配置，分别监听 7891 / 7892）

   ```
   OLD(utun2): http=502 total=3.66s
     [TCP] dial Proxy ... error: 100.92.59.9:34475 connect error:
       dial tcp4 100.92.59.9:34475: connect: network is unreachable
   NEW(utun6): http=204 total=0.55s
   NEW 出口 IP: 178.128.74.214
   ```

4. **隧道本身是健康的**（排除服务端/封锁/带宽问题）

   ```
   $ tailscale ping 100.92.59.9
   pong from ubuntu-s-1vcpu-512mb-10gb-sfo2 (100.92.59.9) via 178.128.74.214:41641 in 140ms
   ```

   WireGuard 直连（非 DERP 中继），140ms。`netcheck` 显示 UDP 可用。
   即：**不是**服务端挂了，**不是** 34475 端口又被封，**不是** 隧道退化。

5. **端到端复现**（改动前，走真实 Clash 127.0.0.1:7890）

   | 域名 | 命中节点 | 结果 |
   | --- | --- | --- |
   | `claude.ai` | `DO-TS-V2` | `http=000`（连接失败） |
   | `api.anthropic.com` | `DO-TS-V2` | `http=000`（连接失败） |
   | `www.gstatic.com` | `DO` | `http=204` |
   | `chatgpt.com` | `ChatGPT-JP-Home` | `http=200` |

## 修复

把 `DO-TS` 与 `DO-TS-V2` 的 `interface-name` 从 `utun2` 改为 `utun6`，并重启 Clash Verge
使运行时配置 `clash-verge.yaml` 重新生成。

修复后端到端复测：

| 域名 | 命中节点 | 结果 |
| --- | --- | --- |
| `claude.ai` | `DO-TS-V2` | `http=403`（已到达服务端，403 是 Cloudflare 对 curl 的机器人校验） |
| `api.anthropic.com` | `DO-TS-V2` | `http=404`（已到达服务端） |
| `www.anthropic.com` | `DO-TS-V2` | `http=200` |
| `www.gstatic.com` | `DO` | `http=204` |
| `chatgpt.com` | `ChatGPT-JP-Home` | `http=200` |

出口 IP 恢复为 `178.128.74.214`。

## 防复发

新增 `scripts/sync-clash-tailscale-iface.sh`：

- 从 `tailscale ip -4` 取本机 Tailscale 地址，再用 `ifconfig` 定位承载它的 utun；
- 用 `route -n get <peer>` 交叉核对到 Tailscale 节点的路由网卡，不一致时告警；
- 只改写 `server` 落在 `100.64.0.0/10` 的节点的 `interface-name`，`en0` 等其它绑定不动；
- 备份写入 `$VERGE_DIR/backups/`，不污染 Clash Verge 的 `profiles/` 目录；
- `--apply` 落盘，`--reload` 顺带重启 Clash Verge 让改动生效。

用法：

```bash
scripts/sync-clash-tailscale-iface.sh                    # 只检查并提示
scripts/sync-clash-tailscale-iface.sh --apply            # 改写 profile + 运行时配置
scripts/sync-clash-tailscale-iface.sh --apply --reload   # 改写后重启 Clash Verge
```

已验证：把 `interface-name` 手动改回过期的 `utun2` 后，脚本能自动纠正回 `utun6`，
且 5 个 `interface-name: en0` 的节点保持不变。

## 遗留与建议

- **网卡号仍会漂移**。脚本解决的是"发现 + 纠正"，不是"自动纠正"。若要彻底免维护，
  可再加一个 launchd agent 定期跑 `--apply --reload`，或在 Tailscale 重建后手动执行一次。
- `interface-name` 无法省略。mihomo 的全局 `auto-detect-interface: true` 会把出站统一绑到
  默认网关（en0），不显式指定就会绕过隧道；全局关掉 `auto-detect-interface` 则有
  mihomo 出站被自己的 TUN 捕获形成环路的风险，不建议。
- **历史遗留**：配置注释记录 `2026-10-26` 时 `178.128.74.214:34475` 的 TCP 回程 SYN-ACK
  曾被链路丢弃。本次的失败与端口封锁无关（`tailscale ping` 显示 WireGuard 外层走
  `178.128.74.214:41641` 直连、140ms），但该端口在公网路径上的可达性值得单独复核。
- 另观察到 Tailscale 客户端版本 `1.98.5` 与服务端 `tailscaled 1.102.3` 不一致，
  CLI 每次调用都会打印告警。与本次故障无因果关系，但建议后续对齐版本。
