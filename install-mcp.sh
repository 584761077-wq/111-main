#!/usr/bin/env sh
set -eu

APP_DIR="${MCP_APP_DIR:-/opt/ephone-mcp}"
REPO_URL="${MCP_REPO_URL:-}"
BRANCH="${MCP_BRANCH:-main}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 执行：sudo sh install-mcp.sh"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "正在安装 Docker..."
  curl -fsSL https://get.docker.com | sh
fi

docker compose version >/dev/null 2>&1 || {
  echo "当前 Docker 缺少 Compose 插件，请先安装 docker-compose-plugin。"
  exit 1
}

if [ -n "$REPO_URL" ]; then
  if ! command -v git >/dev/null 2>&1; then
    apt-get update && apt-get install -y git
  fi
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" pull --ff-only
  else
    rm -rf "$APP_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
else
  mkdir -p "$APP_DIR"
  cp mcp-server.js package.json package-lock.json Dockerfile.mcp docker-compose.mcp.yml "$APP_DIR/"
fi

cd "$APP_DIR"
mkdir -p data/mcp
if [ ! -f .env ]; then
  TOKEN="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  umask 077
  SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  printf 'MCP_API_TOKEN=%s\nMCP_CREDENTIAL_SECRET=%s\nMCP_VAPID_SUBJECT=mailto:admin@localhost\nMCP_PUBLIC_PORT=8787\n' "$TOKEN" "$SECRET" > .env
fi

docker compose --env-file .env -f docker-compose.mcp.yml up -d --build

TOKEN="$(sed -n 's/^MCP_API_TOKEN=//p' .env)"
IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
echo
echo "部署完成"
echo "后端地址：http://${IP}:8787"
echo "API Token：${TOKEN}"
echo "健康检查：http://${IP}:8787/health"
echo "请确保云服务器安全组和防火墙已开放 TCP 8787。"
