#!/usr/bin/env bash
# THEWIND 一键安装（Linux / macOS / Git Bash）
# 用法：在 project 目录执行  bash ./install.sh
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v docker >/dev/null 2>&1; then
  echo "未检测到 Docker，请先安装 Docker Desktop（macOS）或 Docker Engine + Compose（Linux）" >&2
  exit 1
fi
docker compose version >/dev/null
if [ ! -f .env ]; then
  cp .env.example .env
  echo "已生成 .env"
fi
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else
    od -An -N32 -tx1 /dev/urandom 2>/dev/null | tr -d " \n"; fi
}
set_secret() {
  key="$1"; val="$2"
  if grep -q "^$key=" .env; then
    awk -v k="$key" -v v="$val" 'BEGIN{done=0} $0 ~ "^"k"=" {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' .env > .env.tmp && mv .env.tmp .env
  else
    printf "%s=%s\n" "$key" "$val" >> .env
  fi
}
set_secret SESSION_SECRET "$(rand_hex)"
set_secret IMG_PROXY_SIGN_SECRET "$(rand_hex)"
if ! grep -Eq "^ADMIN_PASSWORD=.+" .env; then set_secret ADMIN_PASSWORD "admin-$(rand_hex | cut -c1-12)"; fi
echo "开始构建并启动（首次约 3-8 分钟）..."
docker compose up -d --build
echo "等待服务就绪..."
ok=0
for _ in $(seq 1 40); do
  sleep 3
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ok=1; break; fi
done
if [ "$ok" -ne 1 ]; then echo "健康检查未通过，请查看 docker compose logs web api" >&2; fi
if [ -f database/demo/demo-data.sql ]; then
  echo "导入演示数据（无需 API Key 即可浏览完整页面）..."
  docker cp database/demo/demo-data.sql aihot-db-1:/tmp/demo-data.sql
  docker compose exec -T db psql -U aihot -d aihot -f /tmp/demo-data.sql >/dev/null
fi
echo ""
echo "完成：打开 http://localhost:3000 ，后台 http://localhost:3000/admin"
echo "后台密码见 .env 的 ADMIN_PASSWORD"
