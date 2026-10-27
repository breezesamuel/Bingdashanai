// tests/_isolate.js — 测试数据隔离（2026-10-23）
//
// 【为什么必须有】此前测试直接使用项目 data/db.json —— 在生产服务器上跑一次
// 回归就会往**真实台账**写数据：
//   · 生产库现有 129 笔 void_test 订单，就是历次回归留下的
//   · gatePool 测试会消耗真实访客额度 → 线上断言因"额度已用掉"而失败
//   · regress_usage_margin 会轮换真实管理令牌（把运维挡在门外）
//
// 现在：任何 require 了本文件的测试，默认使用**独立临时数据目录**，
// 只有显式设置 BINGDASHAN_DATA_DIR 时才复用（CI/调试场景）。
// 必须在 require('../core/store') 之前 require 本文件（store 在加载时读环境变量）。
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

if (!process.env.BINGDASHAN_DATA_DIR) {
  const dir = path.join(os.tmpdir(), 'bingdashan-test-' + process.pid + '-' + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  process.env.BINGDASHAN_DATA_DIR = dir;
}
process.env.BD_TEST_ISOLATED = '1';

module.exports = { dir: process.env.BINGDASHAN_DATA_DIR };
