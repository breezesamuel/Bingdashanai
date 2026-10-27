#!/usr/bin/env node
'use strict';
// scripts/gen-license.js — 授权码发码机（运营方在本机/服务器上跑，私钥不离开这台机器）
//
// 用法：
//   node scripts/gen-license.js keygen
//       生成运营密钥对 → license.pub（仓库根，随安装包发布）+ license.key（数据目录，保密！）
//       只在第一次做一次；重新生成会让**已发出的授权码全部失效**。
//
//   node scripts/gen-license.js issue --plan m [--days 30] [--fp <机器码>] [--who 买家备注] [--id 自定义]
//       按套餐签发一枚授权码。plan: t=7天体验 / m=1月 / q=3月 / y=1年 / p=买断
//       --fp 传客户端 /v1/license/status 里显示的 fingerprint 即可绑定到那台机器（不传＝不绑，可换机）。
//
//   node scripts/gen-license.js verify <授权码>      只验签并打印内容（不激活）
//   node scripts/gen-license.js fp                  打印本机指纹（给客户报"机器码"用）
//   node scripts/gen-license.js pub                 打印公钥（发布客户端用）
//   node scripts/gen-license.js signing             自查"这台机器能不能签发"（私钥是否就位）
//   node scripts/gen-license.js fp                  打印本机指纹（给客户报"机器码"用）
//   node scripts/gen-license.js pub                 打印公钥（发布客户端用）
//
// 典型商业闭环：客户在 App 里看到收费墙 → 扫码付款 → 运营在后台 /v1/subs/confirm 确认真实到账
//   → 用本脚本给客户签发授权码 → 客户在 App「激活」页粘贴 → 本机闸门全开。
'use strict';
const path = require('path');
const lic = require(path.join(__dirname, '..', 'core', 'license.js'));

const cmd = process.argv[2];
const argv = process.argv.slice(3);
function flag(name) {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : null;
}

function main() {
  if (cmd === 'keygen') {
    // 【公钥/私钥分离存放】
    //  · license.pub → 仓库根：**公开**，会被打进安装包（客户端只用它验签）。
    //  · license.key → 数据目录：**机密**，绝不能提交/分发/进安装包。放数据目录而非仓库根，
    //    是为了让"运行期机密"跟代码分开——仓库根目录最容易在打包时被整体带走。
    const fsx = require('fs');
    const pathx = require('path');
    const kp = lic.genKeyPair();
    const pubPath = pathx.join(__dirname, '..', 'license.pub');
    const keyPath = lic.dataFile('license.key');
    fsx.writeFileSync(pubPath, kp.pub + '\n', 'utf8');
    try { fsx.mkdirSync(pathx.dirname(keyPath), { recursive: true }); } catch (e) {}
    fsx.writeFileSync(keyPath, kp.priv + '\n', { mode: 0o600 });
    console.log('已生成授权密钥对：');
    console.log('  公钥（随安装包发布，可公开）: ' + pubPath);
    console.log('  私钥（绝不要提交/分发/打包）: ' + keyPath);
    console.log('\n公钥: ' + kp.pub);
    console.log('\n⚠ 重新 keygen 会让**已发出的授权码全部失效**（换公钥=旧码验不过）。只做一次，并立刻离线备份私钥。');
    console.log('下一步：npm run license:issue -- --plan m --who buyer@example.com');
    return;
  }
  if (cmd === 'issue') {
    if (!lic.pubConfigured()) {
      console.error('尚未生成密钥对：请先执行  node scripts/gen-license.js keygen');
      process.exit(2);
    }
    let out;
    try { out = lic.issue({ plan: flag('plan') || 'm', days: Number(flag('days')) || 0, fp: flag('fp'), who: flag('who'), id: flag('id') }); }
    catch (e) { console.error('签发失败：' + e.message); process.exit(2); }
    const p = out.payload;
    console.log('授权码（发给客户，在 App 的「激活」页粘贴）：\n');
    console.log(out.key + '\n');
    console.log('内容: plan=' + p.plan + '  id=' + p.id + '  iat=' + new Date(p.iat).toISOString().slice(0, 10) +
      '  exp=' + new Date(p.exp).toISOString().slice(0, 10) + '  fp=' + (p.fp || '(不绑定设备)') + (p.who ? '  who=' + p.who : ''));
    return;
  }
  if (cmd === 'verify') {
    const key = argv[0];
    if (!key) { console.error('用法: node scripts/gen-license.js verify <授权码>'); process.exit(2); }
    try {
      const i = lic.inspect(key);
      console.log('验签通过');
      console.log('  plan=' + i.payload.plan + '  id=' + i.payload.id);
      console.log('  到期=' + new Date(i.payload.exp).toISOString() + '  (' + (i.expired ? '已过期' : '剩 ' + i.daysLeft + ' 天') + ')');
      console.log('  机器绑定=' + (i.payload.fp ? (i.fpMatch ? '匹配本机' : '绑定的是另一台机器') : '未绑定'));
    } catch (e) { console.error('验签失败：' + e.message); process.exit(1); }
    return;
  }
  if (cmd === 'fp') { console.log(lic.machineFingerprint()); return; }
  if (cmd === 'signing') {
    console.log('签发就绪: ' + (lic.signingReady() ? '是' : '否'));
    console.log('私钥来源: ' + (lic.signingSource() || '(未配置)'));
    console.log('可信公钥来源: ' + (lic.pubSources().join(', ') || '(无 → 无法验签；客户端会报 NO_PUBKEY)'));
    return;
  }
  if (cmd === 'pub') {
    try { console.log(require('fs').readFileSync(path.join(__dirname, '..', 'license.pub'), 'utf8').trim()); }
    catch (e) { console.error('还没有 license.pub，请先 keygen'); process.exit(2); }
    return;
  }
  console.log('用法：\n  node scripts/gen-license.js keygen\n  node scripts/gen-license.js issue --plan m [--days 30] [--fp <机器码>] [--who <备注>]\n  node scripts/gen-license.js verify <授权码>\n  node scripts/gen-license.js fp\n  node scripts/gen-license.js pub\n  node scripts/gen-license.js signing');
}
main();
