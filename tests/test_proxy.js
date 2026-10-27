const http = require('http');
const headers = {'X-Visitor':'proxy-test-001','X-Real-IP':'203.0.113.10','X-Forwarded-For':'203.0.113.10'};
function get(p){
  return new Promise(resolve=>{
    const req = http.get({hostname:'127.0.0.1',port:3721,path:p,headers},res=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve({code:res.statusCode,body:d}));
    });
    req.on('error',e=>resolve({code:0,err:e.message}));
  });
}
(async()=>{
  const s = await get('/v1/subs/status');
  console.log('status',s.code, typeof s.body);
  const g = await get('/v1/subs/gate?section=chatdeep');
  console.log('gate',g.code, typeof g.body);
  const p = await get('/v1/paywall');
  console.log('paywall',p.code, typeof p.body);
  if (p.body) console.log(p.body.slice(0,200));
})();
