// Email sender（兼容别名入口）
// 真实实现见 ./mailer（smtpSend/send/log）；本文件仅为文档中
// `require("./core/email")` 的用法提供稳定别名，避免空导出误导调用方。
const mailer = require('./mailer');
module.exports = { ...mailer };