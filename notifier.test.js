const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNotifier } = require('./notifier');

test('HTTP routes forward raw bytes without starting a listener on import', async () => {
  const { createApp } = require('./server');
  const calls = [];
  const app = createApp({receiveGithub:(raw,h) => (calls.push([raw.toString(),h]), 200), receiveTelegram: async () => 401});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    const raw = '{  "action": "opened" }';
    const response = await fetch(url + '/webhook', {method:'POST',headers:{'content-type':'application/json','x-github-event':'issues','x-github-delivery':'id','x-hub-signature-256':'sig'},body:raw});
    assert.equal(response.status,200);
    assert.equal(calls[0][0],raw);
    assert.equal(calls[0][1].delivery,'id');
    assert.equal((await fetch(url+'/telegram-webhook',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  } finally { server.close(); }
});

test('digest combines queued events into a single message', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'notifier-'));
  const sent = [];
  const n = createNotifier({webhookSecret:'s',telegramSecret:'t',chatId:'1',users:['2'],dataFile:path.join(dir,'state'),digestMs:1}, {send:async x => (sent.push(x),{message_id:1}),comment:async()=>{}});
  const raw = Buffer.from(JSON.stringify({action:'opened',repository:{full_name:'a/b'},sender:{login:'x'},issue:{number:1,title:'x'}}));
  const signature = 'sha256=' + crypto.createHmac('sha256','s').update(raw).digest('hex');
  n.receiveGithub(raw,{signature,event:'issues',delivery:'1'});
  n.receiveGithub(raw,{signature,event:'issues',delivery:'2'});
  await new Promise(r => setTimeout(r,5));
  await n.process();
  assert.equal(sent.length,1);
  assert.equal((sent[0].text.match(/a\/b/g) || []).length,2);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('failed sends survive restart and filters reject excluded events', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'notifier-'));
  const config = {webhookSecret:'s',telegramSecret:'t',chatId:'1',users:['2'],dataFile:path.join(dir,'state'),repos:['a/b']};
  let count = 0;
  const io = {send:async () => { count++; throw Error('unavailable'); },comment:async()=>{}};
  const n = createNotifier(config,io);
  const raw = Buffer.from(JSON.stringify({action:'opened',repository:{full_name:'a/b'},sender:{login:'x'},issue:{number:1,title:'x'}}));
  const signature = 'sha256=' + crypto.createHmac('sha256','s').update(raw).digest('hex');
  assert.equal(n.receiveGithub(raw,{signature,event:'issues',delivery:'d'}),200);
  await n.process();
  assert.equal(count,1);
  assert.equal(JSON.parse(fs.readFileSync(config.dataFile)).queue[0].attempts,1);
  const other = Buffer.from(JSON.stringify({repository:{full_name:'c/d'}}));
  const sig = 'sha256=' + crypto.createHmac('sha256','s').update(other).digest('hex');
  assert.equal(n.receiveGithub(other,{signature:sig,event:'issues',delivery:'e'}),200);
  assert.equal(JSON.parse(fs.readFileSync(config.dataFile)).queue.length,1);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('authenticated raw deliveries persist and deduplicate; replies use stored mapping', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'notifier-'));
  const sent = [], comments = [];
  const config = { webhookSecret: 'github', telegramSecret: 'telegram', chatId: '-1', users: ['42'], dataFile: path.join(dir, 'state.json') };
  const n = createNotifier(config, { send: async x => (sent.push(x), { message_id: 7 }), comment: async x => comments.push(x) });
  const payload = { action:'opened', repository:{full_name:'a/b'}, installation:{id:123}, sender:{login:'user'}, issue:{number:9,title:'hello',html_url:'https://github.com/a/b/issues/9',labels:[]} };
  const raw = Buffer.from(JSON.stringify(payload, null, 2));
  const signature = 'sha256=' + crypto.createHmac('sha256','github').update(raw).digest('hex');
  assert.equal(n.receiveGithub(raw, {signature, event:'issues', delivery:'abc'}), 200);
  assert.equal(n.receiveGithub(raw, {signature, event:'issues', delivery:'abc'}), 200);
  assert.equal(n.receiveGithub(raw, {signature:'bad', event:'issues', delivery:'abc'}), 401);
  await n.process();
  assert.equal(sent.length, 1);
  const n2 = createNotifier(config, { send: async () => ({}), comment: async x => comments.push(x) });
  assert.equal(await n2.receiveTelegram({message:{chat:{id:-1},from:{id:42},text:'hello',reply_to_message:{message_id:7}}}, 'bad'), 401);
  assert.equal(await n2.receiveTelegram({update_id:1,message:{chat:{id:-1},from:{id:42},text:'hello',reply_to_message:{message_id:7}}}, 'telegram'), 200);
  assert.deepEqual(comments[0], {owner:'a',repo:'b',issue_number:9,installation:123,body:'hello'});
  fs.rmSync(dir, {recursive:true,force:true});
});


test('long issue text preserves link and author, retries survive restart, and Telegram updates deduplicate', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'notifier-'));
  const config = {webhookSecret:'s',telegramSecret:'t',chatId:'1',users:['2'],dataFile:path.join(dir,'state')};
  const sent=[], comments=[];
  const raw=Buffer.from(JSON.stringify({action:'opened',repository:{full_name:'a/b'},installation:{id:3},sender:{login:'alice'},issue:{number:1,title:'x'.repeat(5000),body:'description',html_url:'https://github.com/a/b/issues/1'}}));
  const signature='sha256='+crypto.createHmac('sha256','s').update(raw).digest('hex');
  let n=createNotifier(config,{send:async()=>{throw Error('offline')},comment:async()=>{}});
  assert.equal(n.receiveGithub(raw,{signature,event:'issues',delivery:'1'}),200);
  await n.process();
  const state=JSON.parse(fs.readFileSync(config.dataFile)); state.queue[0].next=0; fs.writeFileSync(config.dataFile,JSON.stringify(state));
  n=createNotifier(config,{send:async x=>(sent.push(x),{message_id:7}),comment:async x=>comments.push(x)});
  await n.process();
  assert.match(sent[0].text,/https:\/\/github.com\/a\/b\/issues\/1/);
  assert.match(sent[0].text,/alice/); assert.match(sent[0].text,/description/); assert.ok(sent[0].text.length<=4000);
  const update={update_id:10,message:{chat:{id:1},from:{id:2},text:'hello',reply_to_message:{message_id:7}}};
  assert.equal(await n.receiveTelegram(update,'t'),200);
  n=createNotifier(config,{send:async()=>({}),comment:async x=>comments.push(x)});
  assert.equal(await n.receiveTelegram(update,'t'),200); assert.equal(comments.length,1);
  fs.rmSync(dir,{recursive:true,force:true});
});


test('authorization, event rendering, filters and topic routing', async () => {
  const dir=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'notifier-'));
  const sent=[];
  const n=createNotifier({webhookSecret:'s',telegramSecret:'t',chatId:'1',users:['2'],dataFile:path.join(dir,'state'),repos:['a/b'],actors:['alice'],topics:{'a/b':123}}, {send:async x=>(sent.push(x),{message_id:sent.length}),comment:async()=>{throw Error('must not comment')}});
  const post=(event,payload,id)=>{const raw=Buffer.from(JSON.stringify(payload)); return n.receiveGithub(raw,{signature:'sha256='+crypto.createHmac('sha256','s').update(raw).digest('hex'),event,delivery:id});};
  const base={repository:{full_name:'a/b',html_url:'https://github.com/a/b'},sender:{login:'alice'}};
  const cases=[['issues',{action:'opened',issue:{number:1,title:'issue',body:'body',html_url:'https://example.com/i'}}],['issue_comment',{action:'created',issue:{number:1},comment:{body:'comment',html_url:'https://example.com/c'}}],['pull_request',{action:'opened',pull_request:{number:2,title:'pr'}}],['pull_request_review',{action:'submitted',pull_request:{number:2},review:{state:'approved'}}],['star',{action:'created'}],['push',{ref:'refs/heads/main',commits:[{id:'abcdef123',message:'commit message'}],compare:'https://example.com/diff'}],['check_run',{action:'completed',check_run:{conclusion:'failure',name:'build'}}],['workflow_run',{action:'completed',workflow_run:{conclusion:'failure',name:'ci'}}]];
  for (const [i,[event,payload]] of cases.entries()) { assert.equal(post(event,{...base,...payload},String(i)),200); await n.process(); }
  assert.equal(sent.length,cases.length); assert.ok(sent.every(x=>x.message_thread_id===123));
  assert.match(sent[5].text,/abcdef1.*commit message/); assert.match(sent[1].text,/https:\/\/example.com\/c/);
  post('issues',{...base,sender:{login:'other'},action:'opened',issue:{number:4}},'filtered'); await n.process(); assert.equal(sent.length,cases.length);
  assert.equal(await n.receiveTelegram({message:{chat:{id:1},from:{id:3},text:'x',reply_to_message:{message_id:1}}},'t'),403);
  assert.equal(await n.receiveTelegram({message:{chat:{id:9},from:{id:2},text:'x',reply_to_message:{message_id:1}}},'t'),403);
  fs.rmSync(dir,{recursive:true,force:true});
});
