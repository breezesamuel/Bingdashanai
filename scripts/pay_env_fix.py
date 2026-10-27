# -*- coding: utf-8 -*-
# pay_env_fix.py — 微信/MoltSpay .env 校验 + 安全自动修复。
#
# 用法：python pay_env_fix.py [--apply]
#   默认 dry-run：只打印每个字段的状态与缺什么，不改任何东西。
#   --apply：执行**唯一一处安全自动修复**——把误填进 WECHAT_MCH_PRIVATE_KEY 的
#            「微信支付公钥ID」(PUB_KEY_ID_…) 搬到它本该在的 WECHAT_PAY_PUBLIC_KEY_ID。
#            这不是编造密钥，是把已在服务器上的值挪到代码真正读取的字段（代码自身的
#            报错信息就是这么建议的）。改前自动备份 .env.bak-<ts>。
#
# 绝不编造/写入任何商户密钥：私钥、appid、公钥、MoltSpay 密钥必须由运营从
# 微信支付商户平台 / MoltSpay 后台获取后手工填入。本脚本只校验格式 + 搬运错位值。
import sys, re, os, time
import paramiko

HOST = '8.155.53.12'; USER = 'root'; APP = '/opt/bingdashan'

WX_FIELDS = ['WECHAT_MCHID','WECHAT_APPID','WECHAT_SERIAL_NO','WECHAT_MCH_PRIVATE_KEY',
             'WECHAT_APIV3_KEY','WECHAT_PAY_PUBLIC_KEY','WECHAT_PAY_PUBLIC_KEY_ID','WECHAT_NOTIFY_URL']
MOLT_FIELDS = ['MOLTSPAY_GATEWAY','MOLTSPAY_MCH_ID','MOLTSPAY_API_KEY','MOLTSPAY_NOTIFY_URL']

def parse_env(raw):
    parsed = {}; order = []
    cur_key = None; cur_buf = []
    for line in raw.splitlines():
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*=', line):
            if cur_key is not None:
                parsed[cur_key] = '\n'.join(cur_buf).strip()
            k, _, v = line.partition('=')
            cur_key = k.strip(); cur_buf = [v]; order.append(cur_key)
        else:
            if cur_key is not None:
                cur_buf.append(line)
    if cur_key is not None:
        parsed[cur_key] = '\n'.join(cur_buf).strip()
    return parsed, order

def check_wx(p):
    issues = []; missing = []
    priv = (p.get('WECHAT_MCH_PRIVATE_KEY') or '').strip()
    appid = (p.get('WECHAT_APPID') or '').strip()
    pubid = (p.get('WECHAT_PAY_PUBLIC_KEY_ID') or '').strip()
    pub   = (p.get('WECHAT_PAY_PUBLIC_KEY') or '').strip()
    apiv3 = (p.get('WECHAT_APIV3_KEY') or '').strip()
    for f in ['WECHAT_MCHID','WECHAT_APPID','WECHAT_SERIAL_NO','WECHAT_MCH_PRIVATE_KEY','WECHAT_APIV3_KEY']:
        if not (p.get(f) or '').strip(): missing.append(f)
    if priv and re.match(r'^PUB_KEY_ID_', priv, re.I):
        issues.append('MISPLACED: WECHAT_MCH_PRIVATE_KEY 里是「微信支付公钥ID」，应搬到 WECHAT_PAY_PUBLIC_KEY_ID')
    if priv and priv.strip().startswith('-----BEGIN') and 'PRIVATE KEY-----' in priv:
        priv_ok = True
    elif priv and not re.match(r'^PUB_KEY_ID_', priv, re.I):
        priv_ok = False; issues.append('BAD: WECHAT_MCH_PRIVATE_KEY 不是 PEM 私钥（应含 -----BEGIN ... PRIVATE KEY-----）')
    else:
        priv_ok = False
    if appid and not re.fullmatch(r'wx[0-9a-fA-F]{16}', appid):
        issues.append('BAD: WECHAT_APPID 应为 wx + 16 位十六进制，当前=%r' % appid)
    if not pub:
        missing.append('WECHAT_PAY_PUBLIC_KEY（公钥模式需微信支付公钥 PEM）')
    if not pubid:
        missing.append('WECHAT_PAY_PUBLIC_KEY_ID（PUB_KEY_ID_…）')
    ready = (not missing and not issues and priv_ok
             and bool(re.fullmatch(r'wx[0-9a-fA-F]{16}', appid or ''))
             and bool(pub) and bool(pubid))
    return ready, missing, issues

def check_molt(p):
    missing = [f for f in MOLT_FIELDS if not (p.get(f) or '').strip()]
    return (len(missing) == 0), missing, []

def main():
    apply = '--apply' in sys.argv
    cli = paramiko.SSHClient(); cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(HOST, username=USER, timeout=20, banner_timeout=20, auth_timeout=20, look_for_keys=True, allow_agent=True)
    def run(cmd, timeout=30):
        _i, o, e = cli.exec_command(cmd, timeout=timeout)
        return o.read().decode('utf-8','replace'), e.read().decode('utf-8','replace')
    raw, _ = run("cd %s && cat .env 2>/dev/null || true" % APP)
    if not raw.strip():
        print('ERROR: 无法读取 %s/.env' % APP); cli.close(); return 1
    parsed, order = parse_env(raw)

    wx_ready, wx_missing, wx_issues = check_wx(parsed)
    mo_ready, mo_missing, mo_issues = check_molt(parsed)

    # 唯一安全自动修复：搬错位的公钥ID
    applied = []
    if apply:
        priv = (parsed.get('WECHAT_MCH_PRIVATE_KEY') or '').strip()
        if re.match(r'^PUB_KEY_ID_', priv, re.I) and not (parsed.get('WECHAT_PAY_PUBLIC_KEY_ID') or '').strip():
            ts = time.strftime('%Y%m%d%H%M%S')
            run("cd %s && cp .env .env.bak-%s" % (APP, ts))
            # 从原文中删除该行的值，并确保 PAY_PUBLIC_KEY_ID 被设置
            lines = raw.splitlines()
            out = []
            for ln in lines:
                if re.match(r'^WECHAT_MCH_PRIVATE_KEY=', ln):
                    out.append('WECHAT_MCH_PRIVATE_KEY=')   # 清空错位私钥
                elif re.match(r'^WECHAT_PAY_PUBLIC_KEY_ID=', ln):
                    out.append('WECHAT_PAY_PUBLIC_KEY_ID=' + priv)  # 搬到正确字段
                else:
                    out.append(ln)
            if not any(re.match(r'^WECHAT_PAY_PUBLIC_KEY_ID=', l) for l in out):
                out.append('WECHAT_PAY_PUBLIC_KEY_ID=' + priv)
            newraw = '\n'.join(out) + '\n'
            # 写回（heredoc 安全：用 base64 中转，避免 shell 转义问题）
            import base64
            b64 = base64.b64encode(newraw.encode('utf-8')).decode('ascii')
            run("cd %s && echo %s | base64 -d > .env" % (APP, b64))
            applied.append('moved PUB_KEY_ID -> WECHAT_PAY_PUBLIC_KEY_ID (backup .env.bak-%s)' % ts)
            # 重新解析
            raw2, _ = run("cd %s && cat .env" % APP)
            parsed, order = parse_env(raw2)
            wx_ready, wx_missing, wx_issues = check_wx(parsed)

    print('===== 微信支付 =====')
    print('READY : %s' % wx_ready)
    if wx_issues:
        for i in wx_issues: print('ISSUE : %s' % i)
    if wx_missing:
        for m in wx_missing: print('MISSING: %s' % m)
    print('\n===== MoltSpay =====')
    print('READY : %s' % mo_ready)
    for m in mo_missing: print('MISSING: %s' % m)
    if applied:
        print('\n===== 已自动修复 =====')
        for a in applied: print('APPLIED: %s' % a)
    print('\n微信 READY 后需重启生效：systemctl restart bingdashan')
    cli.close()
    return 0

if __name__ == '__main__':
    sys.exit(main())
