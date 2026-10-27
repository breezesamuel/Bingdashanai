// 测试邮件发送能力
const mailer = require('../core/mailer');
console.log('CONFIGURED:', !!mailer.CONFIGURED);

// 测试发一封给自己
mailer.send('460123249@qq.com', '丙大山AI · 订阅测试', '<p>这是一封测试邮件，请忽略。</p>')
  .then(r => console.log('Result:', JSON.stringify(r)))
  .catch(e => console.log('ERR:', e.message));
