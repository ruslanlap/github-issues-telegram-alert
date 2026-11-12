const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const worker = require('./worker');
function setup() {
  const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync('schema.sql','utf8'));
  const DB = {prepare(sql) { return {bind(...args) { return {async run(){const r=db.prepare(sql).run(...args); return {meta:{changes:Number(r.changes)}}},async first(){return db.prepare(sql).get(...args) || null},async all(){return {results:db.prepare(sql).all(...args)}}}}}}};
  const queued=[]; const env={DB,QUEUE:{send:async x=>queued.push(x)},WEBHOOK_SECRET:'s',TELEGRAM_WEBHOOK_SECRET:'t',TELEGRAM_CHAT_ID:'1',TELEGRAM_ALLOWED_USER_IDS:'2',TELEGRAM_BOT_TOKEN:'token'};
  return {db,env,queued};
}
function req(id, event, payload, secret='s') {const body=JSON.stringify(payload); return new Request('https://test/webhook',{method:'POST',headers:{'content-type':'application/json','x-github-delivery':id,'x-github-event':event,'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(body).digest('hex')},body});}
const payload={action:'opened',repository:{full_name:'a/b'},installation:{id:3},sender:{login:'alice'},issue:{number:1,title:'issue'}};
test('authentication, deduplication and cron recover queue publish failure',async()=>{const {env,db,queued}=setup(); env.QUEUE.send=async()=>{throw Error('offline')}; assert.equal((await worker.fetch(req('bad','issues',payload,'wrong'),env)).status,401); assert.equal((await worker.fetch(req('one','issues',payload),env)).status,200); assert.equal((await worker.fetch(req('one','issues',payload),env)).status,200); assert.equal(db.prepare('select count(*) n from deliveries').get().n,1); env.QUEUE.send=async x=>queued.push(x); await worker.scheduled({},env); assert.equal(queued.length,1);});
test('delivery retries, review and CI rendering, and reply mapping',async()=>{const {env,db,queued}=setup(); let calls=[]; const old=global.fetch; global.fetch=async(url,opts)=>{calls.push([url,JSON.parse(opts.body)]); if(calls.length===1) return new Response('{}',{status:500}); return Response.json({ok:true,result:{message_id:7}})}; try {await worker.fetch(req('one','issues',payload),env); let ack=0; const msg={body:queued[0],ack(){ack++},retry(){}}; await worker.queue({messages:[msg]},env); assert.equal(db.prepare('select attempts from deliveries').get().attempts,1); db.prepare('update deliveries set next_at=0').run(); await worker.queue({messages:[msg]},env); assert.equal(ack,2); assert.equal(db.prepare('select issue_number from messages').get().issue_number,1); assert.match(worker.format('pull_request_review',{...payload,action:'submitted',pull_request:{number:2},review:{state:'approved'}}),/approved/); assert.match(worker.format('check_run',{...payload,issue:undefined,action:'completed',check_run:{name:'build',conclusion:'failure'}}),/build/); } finally {global.fetch=old}});

test('Telegram secret, chat, user, mapping and update deduplication protect replies',async()=>{
  const {env,db}=setup(); const {privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  env.GITHUB_APP_ID='10'; env.GITHUB_PRIVATE_KEY=privateKey.export({type:'pkcs8',format:'pem'});
  db.prepare('insert into messages values (?,?,?,?,?,?)').run('1',7,'a','b',1,3);
  const update={update_id:5,message:{chat:{id:1},from:{id:2},text:'hello',reply_to_message:{message_id:7}}};
  const post=(data,secret='t')=>worker.fetch(new Request('https://test/telegram-webhook',{method:'POST',headers:{'x-telegram-bot-api-secret-token':secret},body:JSON.stringify(data)}),env);
  const old=global.fetch; const calls=[]; global.fetch=async(url,options)=>{calls.push([url,options]); return Response.json(calls.length===1?{token:'installation-token'}:{});};
  try {
    assert.equal((await post(update,'bad')).status,401);
    assert.equal((await post({...update,message:{...update.message,from:{id:9}}})).status,403);
    assert.equal((await post(update)).status,200);
    assert.equal((await post(update)).status,200); assert.equal(calls.length,2);
    assert.match(calls[1][0],/repos\/a\/b\/issues\/1\/comments/);
    assert.equal(JSON.parse(calls[1][1].body).body,'hello');
  } finally {global.fetch=old}
});
