#!/usr/bin/env bash
# 丙大山AI · 阿里云 ECS 一键部署（Ubuntu/Debian）
# 用法（在本机 Git-Bash / WSL 里）：
#   bash deploy/deploy.sh <服务器IP> <SSH用户> [SSH端口]
# 例：bash deploy/deploy.sh 8.155.53.12 root 22
set -euo pipefail

HOST="${1:?用法: deploy.sh <服务器IP> <SSH用户> [端口]}"
USER="${2:?用法: deploy.sh <服务器IP> <SSH用户> [端口]}"
PORT="${3:-22}"
DOMAIN="bingdashanai.highkingflower.com"
APPDIR="/opt/bingdashan"
LOCAL="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> 1/6 服务器初始化（Node 20 + nginx + certbot）"
ssh -p "$PORT" "$USER@$HOST" 'bash -s' <<'REMOTE'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg nginx certbot python3-certbot-nginx rsync
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
mkdir -p /opt/bingdashan /var/log/bingdashan /var/www/certbot
node -v && nginx -v
REMOTE

echo "==> 2/6 同步代码到 $APPDIR（含 .env / data，排除日志与临时文件）"
rsync -az --delete -e "ssh -p $PORT" \
  --exclude 'node_modules' --exclude 'data/*.log' --exclude 'data/server.*' \
  --exclude 'data/_*' --exclude '.git' \
  "$LOCAL/" "$USER@$HOST:$APPDIR/"

echo "==> 3/6 安装依赖（如有 package.json）"
ssh -p "$PORT" "$USER@$HOST" "cd $APPDIR && [ -f package.json ] && npm install --omit=dev || true"

echo "==> 4/6 写入 systemd 服务 + nginx 站点配置"
scp -P "$PORT" "$LOCAL/deploy/bingdashan.service" "$USER@$HOST:/etc/systemd/system/bingdashan.service"
scp -P "$PORT" "$LOCAL/deploy/nginx.conf" "$USER@$HOST:/etc/nginx/sites-available/bingdashan.conf"
ssh -p "$PORT" "$USER@$HOST" "ln -sf /etc/nginx/sites-available/bingdashan.conf /etc/nginx/sites-enabled/bingdashan.conf; rm -f /etc/nginx/sites-enabled/default; nginx -t"

echo "==> 5/6 签发 HTTPS 证书 + 启动服务"
ssh -p "$PORT" "$USER@$HOST" "certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m admin@$DOMAIN --redirect || true"
ssh -p "$PORT" "$USER@$HOST" "systemctl daemon-reload; systemctl enable --now bingdashan; systemctl reload nginx; sleep 2; systemctl --no-pager status bingdashan | head -n 12"

echo "==> 6/6 自检"
ssh -p "$PORT" "$USER@$HOST" "curl -s -o /dev/null -w 'local  %{http_code}\n' http://127.0.0.1:3721/ ; curl -sk -o /dev/null -w 'https  %{http_code}\n' https://$DOMAIN/"

echo "✅ 完成。运营令牌请执行：ssh $USER@$HOST 'cd $APPDIR && node -e \"console.log(require(\\\"./core/store\\\").getSetting(\\\"adminToken\\\"))\"'"
