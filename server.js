const express = require('express');
const axios = require('axios');
const { App } = require('octokit');
const { createNotifier } = require('./notifier');

function createApp(notifier) {
  const app = express();
  app.get('/', (_req, res) => res.json({status:'ok'}));
  app.post('/webhook', express.raw({type:'application/json', limit:'2mb'}), (req, res) => {
    if (!Buffer.isBuffer(req.body)) return res.sendStatus(415);
    res.sendStatus(notifier.receiveGithub(req.body, {signature:req.get('x-hub-signature-256'), event:req.get('x-github-event'), delivery:req.get('x-github-delivery')}));
  });
  app.post('/telegram-webhook', express.json({limit:'1mb'}), async (req, res) => {
    try { res.sendStatus(await notifier.receiveTelegram(req.body, req.get('x-telegram-bot-api-secret-token'))); }
    catch (e) { console.error('Telegram webhook failed:', e.message); res.sendStatus(503); }
  });
  return app;
}

if (require.main === module) {
  require('dotenv').config();
  const list = name => (process.env[name] || '').split(',').map(x => x.trim()).filter(Boolean);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw Error('TELEGRAM_BOT_TOKEN is required');
  const appId = process.env.GITHUB_APP_ID, key = process.env.GITHUB_PRIVATE_KEY;
  if (!!appId !== !!key) throw Error('Set both GITHUB_APP_ID and GITHUB_PRIVATE_KEY');
  const github = appId ? new App({appId, privateKey:key.replace(/\\n/g, '\n')}) : null;
  const topics = JSON.parse(process.env.TOPIC_ROUTES || '{}');
  const notifier = createNotifier({
    webhookSecret:process.env.WEBHOOK_SECRET, telegramSecret:process.env.TELEGRAM_WEBHOOK_SECRET,
    chatId:process.env.TELEGRAM_CHAT_ID, users:list('TELEGRAM_ALLOWED_USER_IDS'), dataFile:process.env.STATE_FILE,
    repos:list('FILTER_REPOS'), events:list('FILTER_EVENTS'), actors:list('FILTER_ACTORS'), labels:list('FILTER_LABELS'), topics,
    digestMs:Number(process.env.DIGEST_MS || 0)
  }, {
    async send(payload) {
      const response = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, payload, {timeout:10000});
      if (!response.data?.ok) throw Error('Telegram rejected message');
      return response.data.result;
    },
    async comment({installation, ...params}) {
      if (!github) throw Error('GitHub App is not configured');
      const client = await github.getInstallationOctokit(installation);
      await client.rest.issues.createComment(params);
    }
  });
  createApp(notifier).listen(process.env.PORT || 3000, () => console.log('Notifier listening'));
  setInterval(() => notifier.process().catch(e => console.error('Queue error:', e.message)), 1000);
}
module.exports = { createApp };
