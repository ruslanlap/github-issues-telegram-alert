const axios = require('axios');
require('dotenv').config();
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_WEBHOOK_URL: url } = process.env;
if (!token || !secret || !url || !/^https:\/\//.test(url) || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  console.error('Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and HTTPS TELEGRAM_WEBHOOK_URL');
  process.exit(1);
}
axios.post(`https://api.telegram.org/bot${token}/setWebhook`, {url, secret_token:secret}, {timeout:10000})
  .then(({data}) => { if (!data.ok) throw Error('Telegram rejected webhook'); console.log('Webhook configured'); })
  .catch(() => { console.error('Webhook setup failed'); process.exitCode = 1; });
