# 丙大山AI · 部署手册（阿里云 ECS）

目标：`https://bingdashanai.highkingflower.com` 对外提供落地页（`/`）与运营驾驶舱（`/app`）。
Node 只监听 `127.0.0.1:3721`，由 nginx 终止 TLS 并反代。

## 一、前置
1. ECS：`8.155.53.12`（Ubuntu 22.04/24.04 最佳）。
2. 安全组放行 **80 / 443**；**不要**对公网放行 3721。
3. DNS：把 `bingdashanai.highkingflower.com` 的 A 记录指到 `8.155.53.12`（阿里云云解析）。
   - 验：`nslookup bingdashanai.highkingflower.com` 应返回该 IP。
4. 本机具备 SSH：`ssh <用户>@8.155.53.12`。密钥或密码由你提供后我执行。

## 二、一键部署
```bash
bash deploy/deploy.sh 8.155.53.12 root 22
```
脚本会：装 Node20+nginx+certbot → rsync 代码到 `/opt/bingdashan` → 写 systemd 与 nginx →
签发 Let's Encrypt 证书 → 启动并自检。

## 三、部署后必做
1. **取运营令牌**（`/app` 在公网不是回环，必须带令牌才不被收费墙挡住）：
   ```bash
   ssh root@8.155.53.12 'cd /opt/bingdashan && node -e "console.log(require(\"./core/store\").getSetting(\"adminToken\"))"'
   ```
   打开 `https://bingdashanai.highkingflower.com/app` → 在“运营令牌”输入框填入并保存
   （前端存入 `localStorage.bd_adminToken`，此后接口带 `X-Admin-Token`）。
2. 若令牌已泄露，轮换：
   ```bash
   curl -X POST https://<域名>/v1/subs/rotate-admin-token -H 'X-Admin-Token: <旧令牌>'
   ```
3. 配置买家可见的收款方式（管理端 `/v1/subs/pay-config`）：
   - `receiveQrAlipay` / `receiveQrWechat`：上传的收款码图片 URL（推荐，买家直接扫码）。
   - `receiveAccount`：买家需要看到的口头账号（如支付宝账号）。**银行账号不要放这里**，
     银行账号是运营侧最终入账账户，仅存 `.env`（`BANK_ACCT` 等），永不下发前端。
4. 支付宝异步回调需要公网 HTTPS：
   `ALIPAY_NOTIFY_BASE=https://bingdashanai.highkingflower.com`
   然后真实下 1 元试用单，用支付宝/微信/PayPal 各走一遍，确认回调验签 → 自动开通。

## 四、安全要点（已修）
- `server.js` 的 `isLoopback()` 现在**忽略代理头来源**：带 `X-Forwarded-For/X-Real-IP`
  的请求一律不认回环。否则 nginx 之后全世界都会被当成运营，收费墙与运营接口全开。
  因此 nginx **必须**转发 `X-Real-IP` / `X-Forwarded-For`（见 `deploy/nginx.conf`）。
- 静态资源已 `Cache-Control: no-cache`，且 `web/index.html` 脚本带 `?v=` 构建戳。

## 五、日常运维
```bash
systemctl status bingdashan      # 状态
journalctl -u bingdashan -n 100  # 日志(或 /var/log/bingdashan/*.log)
systemctl restart bingdashan     # 重启（改代码后 rsync + restart）
certbot renew --dry-run          # 证书续期演练（cron 已自带）
```
