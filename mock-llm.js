// 本地 Mock LLM（OpenAI 兼容）— 监听 127.0.0.1:11434
// 用途：模拟"本地 Ollama"这条官方免费通道，端到端验证 免费轮换 → /v1/chat 的完整链路。
const http = require('http');

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'local-mock-8b', object: 'model' }, { id: 'local-mock-mini', object: 'model' }]
    }));
  }

  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let j = {};
      try { j = JSON.parse(body); } catch (e) {}
      const users = (j.messages || []).filter(m => m.role === 'user');
      const lastText = String((users[users.length - 1] || {}).content || '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: j.model || 'local-mock-8b',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: '[本地免费通道应答] 已收到你的问题，长度 ' + lastText.length + ' 字。' },
          finish_reason: 'stop'
        }]
      }));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{}');
});

server.listen(11434, '127.0.0.1', () => console.log('mock LLM listening on 127.0.0.1:11434'));
