const http = require('http');
const headers = {'X-Visitor':'p1','X-Real-IP':'203.0.113.5','X-Forwarded-For':'203.0.113.5','Content-Type':'application/json'};
const req = http.request({hostname:'127.0.0.1',port:3721,path:'/v1/subs/gate',method:'POST',headers}, res => {
  let d='';
  res.on('data',c=>d+=c);
  res.on('end',()=>{
    console.log('CODE', res.statusCode);
    console.log(d);
  });
});
req.on('error',e=>{console.log('ERR');console.log(e.message);});
req.write(JSON.stringify({section:'chatdeep'}));
req.end();
