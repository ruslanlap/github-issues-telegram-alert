const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createNotifier(config, io) {
  if (!config.webhookSecret || !config.telegramSecret || !config.chatId || !config.users?.length || !config.dataFile) throw Error('Missing required notifier configuration');
  const file = config.dataFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { deliveries: {}, queue: [], messages: {} };
  function save(next) {
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    state = next;
  }
  const copy = () => JSON.parse(JSON.stringify(state));
  const allowed = (list, value) => !list?.length || list.includes(value);
  function receiveGithub(raw, headers) {
    const expected = 'sha256=' + crypto.createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
    if (!equal(headers.signature, expected)) return 401;
    if (!headers.delivery || !headers.event) return 400;
    if (Object.hasOwn(state.deliveries, headers.delivery)) return 200;
    let payload;
    try { payload = JSON.parse(raw); } catch { return 400; }
    const repo = payload.repository?.full_name, actor = payload.sender?.login;
    const labels = (payload.issue || payload.pull_request)?.labels?.map(x => x.name) || [];
    const pass = allowed(config.repos, repo) && allowed(config.events, headers.event) && allowed(config.actors, actor) && (!config.labels?.length || config.labels.some(x => labels.includes(x)));
    const next = copy();
    next.deliveries[headers.delivery] = true;
    if (pass) next.queue.push({ id: headers.delivery, event: headers.event, payload, attempts: 0, next: Date.now() + (config.digestMs || 0) });
    try { save(next); } catch (e) { console.error('Persistence failure:', e.message); return 503; }
    return 200;
  }
  function format(event, p) {
    const repo = p.repository?.full_name;
    if (!repo) return null;
    const item = p.issue || p.pull_request;
    const actions = { issues:['opened','closed','reopened'], issue_comment:['created'], pull_request:['opened','closed','reopened','review_requested'], pull_request_review:['submitted'], star:['created'] };
    if (actions[event] && !actions[event].includes(p.action)) return null;
    if (event === 'push' && !p.commits?.length) return null;
    if (event === 'check_run' && !(p.action === 'completed' && ['failure','timed_out','cancelled'].includes(p.check_run?.conclusion))) return null;
    if (event === 'workflow_run' && !(p.action === 'completed' && ['failure','timed_out','cancelled'].includes(p.workflow_run?.conclusion))) return null;
    if (!actions[event] && !['push','check_run','workflow_run'].includes(event)) return null;
    const clip = (value, max) => String(value || '').slice(0, max);
    const subject = item ? ` #${item.number} ${clip(item.title, 500)}` : '';
    const detail = event === 'issue_comment' ? p.comment?.body : event === 'pull_request_review' ? p.review?.state : event === 'pull_request' && p.action === 'review_requested' ? p.requested_reviewer?.login || p.requested_team?.name : event === 'push' ? `${clip(p.ref, 200)} (${p.commits.length} commits)\n${p.commits.slice(0, 3).map(c => `${clip(c.id, 7)} ${clip(c.message?.split('\n')[0], 200)}`).join('\n')}` : event === 'check_run' ? p.check_run?.name : event === 'workflow_run' ? p.workflow_run?.name : item?.body;
    const url = p.comment?.html_url || p.review?.html_url || item?.html_url || p.check_run?.html_url || p.workflow_run?.html_url || p.compare || p.repository.html_url || '';
    return `${clip(repo, 200)}${subject}\n${clip(event, 40)}: ${clip(p.action, 40)}\nAuthor: ${clip(p.sender?.login || p.pusher?.name, 200)}\n${clip(detail, 1500)}\n${clip(url, 1000)}`;

  }
  let running = false;
  async function process() {
    if (running) return;
    running = true;
    try {
      const entry = state.queue.find(x => x.next <= Date.now());
      if (!entry) return;
      const topicFor = x => config.topics?.[x.payload.repository?.full_name] || config.topics?.[x.event];
      const topic = topicFor(entry);
      const batch = [entry];
      let text = format(entry.event, entry.payload);
      if (!text) { const next = copy(); next.queue = next.queue.filter(x => x.id !== entry.id); save(next); return; }
      if (config.digestMs) {
        for (const candidate of state.queue) {
          if (candidate.id === entry.id || candidate.next > Date.now() || topicFor(candidate) !== topic) continue;
          const part = format(candidate.event, candidate.payload);
          if (part && text.length + part.length + 2 <= 4000) { text += '\n\n' + part; batch.push(candidate); }
        }
      }
      try {
        const result = await io.send({ chat_id: config.chatId, text, ...(topic ? {message_thread_id: topic} : {}) });
        if (!result || !Number.isSafeInteger(result.message_id)) throw Error('Telegram returned no message_id');
        const next = copy();
        const item = entry.payload.issue || entry.payload.pull_request;
        const [owner, repo] = entry.payload.repository.full_name.split('/');
        if (batch.length === 1 && item?.number && entry.payload.installation?.id && owner && repo) next.messages[`${config.chatId}:${result.message_id}`] = { owner, repo, issue_number:item.number, installation:entry.payload.installation.id };
        const ids = new Set(batch.map(x => x.id));
        next.queue = next.queue.filter(x => !ids.has(x.id));
        save(next);
      } catch (e) {
        console.error('Delivery failed:', e.message);
        const next = copy(), item = next.queue.find(x => x.id === entry.id);
        if (item) { item.attempts++; item.next = Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(item.attempts, 12)); save(next); }
      }
    } finally { running = false; }
  }
  const inFlightUpdates = new Set();
  async function receiveTelegram(body, secret) {
    if (!equal(secret, config.telegramSecret)) return 401;
    const m = body?.message;
    if (!m || String(m.chat?.id) !== String(config.chatId) || !config.users.includes(String(m.from?.id))) return 403;
    if (!m.text || !m.reply_to_message?.message_id) return 200;
    const target = state.messages[`${m.chat.id}:${m.reply_to_message.message_id}`];
    if (!target) return 200;
    if (!Number.isSafeInteger(body.update_id)) return 400;
    const id = String(body.update_id);
    if (state.updates?.[id]) return 200;
    if (inFlightUpdates.has(id)) return 503;
    inFlightUpdates.add(id);
    try {
      await io.comment({ ...target, body: m.text });
      const next = copy();
      (next.updates ||= {})[id] = true;
      save(next);
      return 200;
    } catch (e) { console.error('GitHub comment failed:', e.message); return 503; }
    finally { inFlightUpdates.delete(id); }
  }
  return { receiveGithub, receiveTelegram, process };
}
module.exports = { createNotifier };
