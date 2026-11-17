#!/usr/bin/env bash
#
# 同步 Clash Verge 配置中「走 Tailscale 的节点」的 interface-name 绑定。
#
# 背景
#   macOS 上 Tailscale 的 utun 序号会随 tailscaled 重建而漂移（utun4 → utun2 → utun6 …）。
#   Clash Verge 的 DO-TS / DO-TS-V2 节点必须显式写 interface-name，否则 mihomo 的
#   auto-detect-interface 会把 100.64.0.0/10 的目标一律绑到 en0，绕不开隧道；
#   但写死的网卡号一旦过期，socket 绑定后 IPv4 路由表里查不到目标 →
#   `connect: network is unreachable`，节点直接不可用（DO 等公网节点却完全正常，
#   很容易误判成服务端故障）。
#
# 用法
#   scripts/sync-clash-tailscale-iface.sh            # 只检查并提示
#   scripts/sync-clash-tailscale-iface.sh --apply    # 改写 profile + 运行时配置
#   scripts/sync-clash-tailscale-iface.sh --apply --reload   # 改写后重启 Clash Verge 使其生效
#
# 环境变量
#   VERGE_DIR  Clash Verge Rev 数据目录（默认 ~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev）
#   PROFILE    目标 profile 文件（默认 $VERGE_DIR/profiles/LwArikta1IAF.yaml）
#
set -euo pipefail

VERGE_DIR="${VERGE_DIR:-$HOME/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev}"
PROFILE="${PROFILE:-$VERGE_DIR/profiles/LwArikta1IAF.yaml}"
RUNTIME="$VERGE_DIR/clash-verge.yaml"
LAUNCH_AGENT="io.github.clash-verge-rev.clash-verge-rev"
BACKUP_DIR="$VERGE_DIR/backups"

APPLY=0
RELOAD=0
for arg in "$@"; do
  case "$arg" in
    --apply)  APPLY=1 ;;
    --reload) APPLY=1; RELOAD=1 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $arg（可用 --apply / --reload / --help）" >&2; exit 2 ;;
  esac
done

die() { echo "错误: $*" >&2; exit 1; }

[ -f "$PROFILE" ] || die "找不到 profile: $PROFILE"

# ── 1. 定位当前承载 Tailscale IPv4 的网卡 ───────────────────────────────
if ! command -v tailscale >/dev/null 2>&1; then
  die "找不到 tailscale CLI，无法自动判断网卡号"
fi

TS_IP="$(tailscale ip -4 2>/dev/null | head -1 | tr -d '[:space:]')"
[ -n "$TS_IP" ] || die "tailscale 未提供 IPv4 地址（tailscale 未连接？）"

TS_IFACE="$(ifconfig | awk -v ip="$TS_IP" '
  /^[a-zA-Z0-9]+:/ { name=$1; sub(/:$/, "", name) }
  $1 == "inet" && $2 == ip { print name; exit }
')"
[ -n "$TS_IFACE" ] || die "找不到持有 Tailscale 地址 $TS_IP 的网卡"

echo "Tailscale IPv4      : $TS_IP"
echo "Tailscale 网卡      : $TS_IFACE"

# ── 2. 找出配置里走 Tailscale 的节点，并核对路由 ───────────────────────
# Tailscale CGNAT 网段 100.64.0.0/10
ts_servers="$(awk '
  /^[[:space:]]*server:[[:space:]]/ {
    s=$2
    if (s ~ /^100\./) print s
  }
' "$PROFILE" | sort -u)"

if [ -z "$ts_servers" ]; then
  echo "profile 中没有走 Tailscale 的节点，无需同步。"
  exit 0
fi

echo "Tailscale 目标      : $(echo "$ts_servers" | tr '\n' ' ')"

for srv in $ts_servers; do
  route_if="$(route -n get "$srv" 2>/dev/null | awk '/interface:/ {print $2}')"
  if [ -n "$route_if" ] && [ "$route_if" != "$TS_IFACE" ]; then
    echo "警告: 到 $srv 的路由走 $route_if，与检测到的 Tailscale 网卡 $TS_IFACE 不一致；" >&2
    echo "      若 $route_if 是 Clash 自己的 TUN（utun1024），说明 TUN 抢占了路由。" >&2
  else
    echo "路由核对 $srv        : ${route_if:-（无路由记录）} ✓"
  fi
done

# ── 3. 改写配置 ────────────────────────────────────────────────────────
# 只改写 server 属于 100.64.0.0/10 的节点；en0 等其它绑定保持不动。
rewrite() {
  local file="$1" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/clash-sync.XXXXXX")"
  awk -v new="$TS_IFACE" '
    /^[[:space:]]*server:[[:space:]]/ { srv=$2 }
    /^[[:space:]]*interface-name:[[:space:]]/ {
      if (srv ~ /^100\./) {
        if ($2 != new) { print "  " $1 " " new; changed=1; next }
      }
    }
    { print }
    END { if (!changed) exit 3 }
  ' "$file" > "$tmp" || {
    rc=$?
    if [ "$rc" = "3" ]; then rm -f "$tmp"; return 1; fi   # 无变化
    rm -f "$tmp"; return "$rc"
  }
  cp "$file" "$BACKUP_DIR/$(basename "$file").$(date +%Y%m%d-%H%M%S).bak"
  cat "$tmp" > "$file"
  rm -f "$tmp"
  return 0
}

apply_one() {
  local file="$1"
  [ -f "$file" ] || { echo "跳过（不存在）: $file"; return 0; }
  echo "--- $file"
  if rewrite "$file"; then
    echo "  已更新（备份: $BACKUP_DIR/$(basename "$file").*.bak）"
  else
    echo "  已是最新，无需改动"
  fi
}

if [ "$APPLY" -eq 1 ]; then
  mkdir -p "$BACKUP_DIR"
  apply_one "$PROFILE"
  apply_one "$RUNTIME"
else
  echo
  echo "当前为只读检查模式。加 --apply 执行改写，加 --reload 同时重启 Clash Verge。"
  echo "将要改写: $PROFILE"
  echo "          $RUNTIME"
  exit 0
fi

# ── 4. 让改动生效 ──────────────────────────────────────────────────────
if [ "$RELOAD" -eq 1 ]; then
  if launchctl kickstart -k "gui/$(id -u)/$LAUNCH_AGENT" 2>/dev/null; then
    echo "已重启 Clash Verge（$LAUNCH_AGENT），等待内核重载…"
    sleep 12
  else
    echo "警告: 重启 Clash Verge 失败，请手动在 Clash Verge 界面重新点一次该配置。" >&2
  fi
else
  echo
  echo "改写已落盘。使其生效："
  echo "  · 在 Clash Verge 界面重新点一次当前配置，或"
  echo "  · 运行本脚本加 --reload 自动重启。"
fi
