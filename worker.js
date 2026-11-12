const crypto = require('node:crypto');
const { format } = require('./format');
const list = value => (value || '').split(',').map(x => x.trim()).filter(Boolean);
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && !!b && Buffer.byteLength(a) === Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const run = (env,sql,...args) => env.DB.prepare(sql).bind(...args).run();
const first = (env,sql,...args) => env.DB.prepare(sql).bind(...args).first();
const all = (env,sql,...args) => env.DB.prepare(sql).bind(...args).all();
const response = status => new Response(null,{status});
async function publish(env,id) { try { await env.QUEUE.send({id}); } catch (e) { console.error('Queue publish failed:',e.message); } }
async function github(request,env) {
  if (!env.WEBHOOK_SECRET) return response(503);
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > 2*1024*1024) return response(413);
  const sig = 'sha256='+crypto.createHmac('sha256',env.WEBHOOK_SECRET).update(raw).digest('hex');
  if (!equal(request.headers.get('x-hub-signature-256'),sig)) return response(401);
  const id=request.headers.get('x-github-delivery'), event=request.headers.get('x-github-event');
  if (!id || !event) return response(400);
  let p; try { p=JSON.parse(raw.toString()); } catch { return response(400); }
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  const item = x => object(x) && Number.isSafeInteger(x.number) && typeof x.title === 'string' && (x.labels === undefined || (Array.isArray(x.labels) && x.labels.every(label => object(label) && typeof label.name === 'string')));
  const shapes = {
    issues: () => item(p.issue) && !p.pull_request,
    issue_comment: () => item(p.issue) && object(p.comment) && typeof p.comment.body === 'string' && !p.pull_request,
    pull_request: () => item(p.pull_request) && !p.issue,
    pull_request_review: () => item(p.pull_request) && object(p.review) && typeof p.review.state === 'string' && !p.issue,
    push: () => typeof p.ref === 'string' && Array.isArray(p.commits) && p.commits.every(c => object(c) && typeof c.id === 'string' && typeof c.message === 'string'),
    star: () => typeof p.action === 'string' && !p.issue && !p.pull_request,
    check_run: () => object(p.check_run) && typeof p.check_run.name === 'string' && !p.issue && !p.pull_request,
    workflow_run: () => object(p.workflow_run) && typeof p.workflow_run.name === 'string' && !p.issue && !p.pull_request
  };
  if (!object(p) || (Object.hasOwn(shapes,event) && (!object(p.repository) || typeof p.repository.full_name !== 'string' || !object(p.sender) || typeof p.sender.login !== 'string' || (event !== 'push' && typeof p.action !== 'string') || !shapes[event]()))) return response(400);
  const allowed=(key,value)=>{const values=list(env[key]); return !values.length || values.includes(value)};
  const labels=Array.isArray((p.issue || p.pull_request)?.labels) ? (p.issue || p.pull_request).labels.map(x=>x?.name) : [];
  const filterLabels=list(env.FILTER_LABELS);
  const pass=allowed('FILTER_REPOS',p.repository?.full_name) && allowed('FILTER_EVENTS',event) && allowed('FILTER_ACTORS',p.sender?.login) && (!filterLabels.length || filterLabels.some(x=>labels.includes(x)));
  const result=await run(env,'INSERT OR IGNORE INTO deliveries (id,event,payload,status,next_at) VALUES (?,?,?,?,?)',id,event,raw.toString(),pass?'pending':'done',Date.now()+Math.max(0,Number(env.DIGEST_MS)||0));
  if (result.meta.changes && pass) await publish(env,id);
  return response(200);
}
async function send(env,entries,text) {
  const entry=entries[0], p=JSON.parse(entry.payload);
  if (!text) return null;
  const topics=JSON.parse(env.TOPIC_ROUTES || '{}'); const topic=topics[p.repository?.full_name] || topics[entry.event];
  const res=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,...(topic?{message_thread_id:topic}:{})}),signal:AbortSignal.timeout(10000)});
  const body=await res.json(); if (!res.ok || !body.ok || !Number.isSafeInteger(body.result?.message_id)) throw Error('Telegram rejected message');
  const item=p.issue || p.pull_request; const [owner,repo]=(p.repository?.full_name || '').split('/');
  if (entries.length === 1 && item?.number && p.installation?.id && owner && repo) await run(env,'INSERT OR REPLACE INTO messages (chat_id,message_id,owner,repo,issue_number,installation) VALUES (?,?,?,?,?,?)',String(env.TELEGRAM_CHAT_ID),body.result.message_id,owner,repo,item.number,p.installation.id);
  return body.result;
}
async function deliver(env,id) {
  const now=Date.now(), lease=now+60000;
  const claimed=await run(env,"UPDATE deliveries SET lease_until=? WHERE id=? AND status='pending' AND next_at<=? AND lease_until<=?",lease,id,now,now);
  if (!claimed.meta.changes) return;
  const entry=await first(env,'SELECT * FROM deliveries WHERE id=?',id);
  const entries=[entry];
  try {
    let text=format(entry.event,JSON.parse(entry.payload));
    if (text && Number(env.DIGEST_MS)>0) {
      const topics=JSON.parse(env.TOPIC_ROUTES || '{}');
      const topic=x=>{const p=JSON.parse(x.payload); return topics[p.repository?.full_name] || topics[x.event] || null};
      const rows=await all(env,"SELECT * FROM deliveries WHERE id<>? AND status='pending' AND next_at<=? AND lease_until<=? ORDER BY next_at LIMIT 100",id,now,now);
      // ponytail: scan at most 100 due rows; use indexed topic buckets if throughput matters.
      for (const candidate of rows.results) {
        if (topic(candidate)!==topic(entry)) continue;
        const part=format(candidate.event,JSON.parse(candidate.payload));
        if (!part || text.length+part.length+2>4000) continue;
        const claim=await run(env,"UPDATE deliveries SET lease_until=? WHERE id=? AND status='pending' AND next_at<=? AND lease_until<=?",lease,candidate.id,now,now);
        if (claim.meta.changes) { entries.push(candidate); text+='\n\n'+part; }
      }
    }
    if (text) await send(env,entries,text);
    for (const item of entries) await run(env,"UPDATE deliveries SET status='done',lease_until=0 WHERE id=? AND lease_until=?",item.id,lease);
  } catch(e) {
    console.error('Delivery failed:',e.message);
    for (const item of entries) {
      const delay=Math.min(3600000,1000*2**Math.min(item.attempts+1,12));
      await run(env,'UPDATE deliveries SET attempts=attempts+1,next_at=?,lease_until=0 WHERE id=? AND lease_until=?',Date.now()+delay,item.id,lease);
    }
  }
}
async function comment(env,target,text) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY) throw Error('GitHub App is not configured');
  const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const now=Math.floor(Date.now()/1000), data=enc({alg:'RS256',typ:'JWT'})+'.'+enc({iat:now-60,exp:now+540,iss:env.GITHUB_APP_ID});
  const jwt=data+'.'+crypto.sign('RSA-SHA256',Buffer.from(data),env.GITHUB_PRIVATE_KEY.replace(/\\n/g,'\n')).toString('base64url');
  const headers={accept:'application/vnd.github+json','user-agent':'github-telegram-notifier','content-type':'application/json','x-github-api-version':'2022-11-28'};
  const auth=await fetch(`https://api.github.com/app/installations/${target.installation}/access_tokens`,{method:'POST',headers:{...headers,authorization:`Bearer ${jwt}`},signal:AbortSignal.timeout(10000)});
  if (!auth.ok) throw Error('GitHub installation authentication failed');
  const token=(await auth.json()).token; if (!token) throw Error('GitHub returned no token');
  const result=await fetch(`https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues/${target.issue_number}/comments`,{method:'POST',headers:{...headers,authorization:`Bearer ${token}`},body:JSON.stringify({body:text}),signal:AbortSignal.timeout(10000)});
  if (!result.ok) throw Error('GitHub comment failed');
}
async function telegram(request,env) {
  if (!equal(request.headers.get('x-telegram-bot-api-secret-token'),env.TELEGRAM_WEBHOOK_SECRET)) return response(401);
  const raw=await request.text(); if (Buffer.byteLength(raw)>1024*1024) return response(413);
  let body; try { body=JSON.parse(raw); } catch { return response(400); }
  const m=body?.message;
  if (!m || String(m.chat?.id)!==String(env.TELEGRAM_CHAT_ID) || !list(env.TELEGRAM_ALLOWED_USER_IDS).includes(String(m.from?.id))) return response(403);
  if (!m.text || !m.reply_to_message?.message_id) return response(200);
  const target=await first(env,'SELECT * FROM messages WHERE chat_id=? AND message_id=?',String(m.chat.id),m.reply_to_message.message_id);
  if (!target) return response(200);
  if (!Number.isSafeInteger(body.update_id)) return response(400);
  const id=String(body.update_id), now=Date.now(), lease=now+60000;
  await run(env,"INSERT OR IGNORE INTO updates (id,status,lease_until) VALUES (?,'pending',0)",id);
  const claim=await run(env,"UPDATE updates SET lease_until=? WHERE id=? AND status='pending' AND lease_until<=?",lease,id,now);
  if (!claim.meta.changes) { const u=await first(env,'SELECT status FROM updates WHERE id=?',id); return response(u?.status==='done'?200:503); }
  try { await comment(env,target,m.text); await run(env,"UPDATE updates SET status='done',lease_until=0 WHERE id=? AND lease_until=?",id,lease); return response(200); }
  catch(e) { console.error('GitHub comment failed:',e.message); await run(env,'UPDATE updates SET lease_until=0 WHERE id=? AND lease_until=?',id,lease); return response(503); }
}
module.exports = {
  format,
  async fetch(request,env) {
    try {
      const path=new URL(request.url).pathname;
      if (request.method==='GET' && path==='/') return Response.json({status:'ok'});
      if (request.method!=='POST') return response(404);
      if (path==='/webhook') return await github(request,env);
      if (path==='/telegram-webhook') return await telegram(request,env);
      return response(404);
    } catch(e) { console.error('Webhook failed:',e.message); return response(503); }
  },
  async queue(batch,env) { for (const message of batch.messages) { try { await deliver(env,message.body.id); message.ack(); } catch(e) { console.error('Queue failed:',e.message); message.retry(); } } },
  async scheduled(_event,env) {
    const rows=await all(env,"SELECT id FROM deliveries WHERE status='pending' AND next_at<=? AND lease_until<=? ORDER BY next_at LIMIT 100",Date.now(),Date.now());
    for (const row of rows.results) await publish(env,row.id);
  }
};
