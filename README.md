# GitHub → Telegram notifier

Receives signed GitHub events and queues Telegram notifications. Authorized users can reply to individual issue/PR notifications. Supports issues, issue comments, pull requests including review requests, submitted PR reviews, pushes, stars, failed check runs and failed workflow runs.

## Setup

Node 20+ required. Run `npm ci`, then configure these environment variables (for local use put them in an untracked `.env`):

| Variable | Purpose |
|---|---|
| `WEBHOOK_SECRET` | Random GitHub webhook secret; use the identical value on GitHub |
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `TELEGRAM_CHAT_ID` | Destination chat ID |
| `TELEGRAM_WEBHOOK_SECRET` | Independent random secret, 1–256 letters, digits, `_` or `-` |
| `TELEGRAM_ALLOWED_USER_IDS` | Comma-separated numeric Telegram user IDs permitted to reply |
| `STATE_FILE` | Absolute path to a writable state file; Render Free uses `/tmp/notifier-state.json` |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY` | Both required for replies; key may contain literal `\n` line breaks |
| `PORT` | HTTP port, default 3000 |

Create a GitHub App webhook at `https://your-host/webhook` with content type JSON and the configured secret. Subscribe to the event types you need, including Pull request review, Check run and Workflow run for review and CI notifications. Install the App on the relevant repositories. For replies grant Issues write permission (and Pull requests permission for PRs). Repository webhooks without App installation IDs can notify but cannot map replies.

Set `TELEGRAM_WEBHOOK_URL=https://your-host/telegram-webhook` and run `node setup-telegram-webhook.js`. This sends the secret to Telegram as `secret_token`; use HTTPS. Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`. Add the bot to the destination chat and allow the specified user IDs. Start with `npm start`.

Optional comma-separated allowlists `FILTER_REPOS` (e.g. `owner/repo`), `FILTER_EVENTS` (GitHub webhook names), `FILTER_ACTORS` (sender login) and `FILTER_LABELS` (at least one matching issue/PR label) restrict notifications; empty means unrestricted. Label filtering excludes events without matching labels. `TOPIC_ROUTES` is a JSON object mapping repository names or event names to Telegram topic IDs; repository takes precedence. `DIGEST_MS` enables delayed batching by topic; batched messages cannot be replied to as a specific issue. A batch respects Telegram's 4000-character limit.

## Cloudflare Workers migration (not deployed)

`worker-entry.mjs`, `worker.js`, `format.js`, `schema.sql` and `wrangler.toml` provide an alternative to Render. Create a D1 database and Queue, replace the database ID in `wrangler.toml`, apply `schema.sql` to that D1 database, and configure the same webhook, Telegram, filtering, topic, and GitHub App settings above as Worker secrets/variables. The Worker requires `WEBHOOK_SECRET`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `TELEGRAM_ALLOWED_USER_IDS`; GitHub App credentials are needed for replies. Do not configure `STATE_FILE`. Set webhooks only after the Worker and schema are ready; this repository does not automate migration or deploy anything.

D1 stores each authenticated delivery before Queue publication; a one-minute cron republishes due work if publication fails or a consumer crashes. Leases prevent concurrent processing, and failed sends retry with backoff. Cron processes at most 100 due entries per invocation. D1 and external API calls are not transactional: Telegram messages or GitHub comments can be duplicated after an uncertain response/crash, and a sent Telegram message may lack a reply mapping. Monitor failures, backlog, and D1 storage. Existing file state and message mappings are **not imported**. `DIGEST_MS` delays individual messages in Workers but does **not batch** them; use Render if batching is required. Worker tests use local SQLite and mocked Queue/network, not an actual Cloudflare runtime. Provisioning, deployment, and live verification remain necessary.

## Render migration

The included blueprint uses **Render Free** and `/tmp/notifier-state.json`, without a persistent disk. Configure all required secrets and allowed user IDs, and GitHub App credentials when replies are needed. Keep exactly one instance. Review the blueprint and back up any existing state before applying it; deploying may restart the service and lose existing state. Render Free can spin down when idle, so the next request may incur a cold-start delay. Monitor GitHub deliveries and manually redeliver failures. These instructions do not deploy the blueprint automatically.

## Reliability and operations

**Render Free state is volatile.** A restart, redeploy, or instance replacement may erase the queue, delivery and update deduplication records, and reply mappings. Pending notifications can be lost, duplicate deliveries can be processed again, and replies to old messages may no longer work. Use one process and one instance only: the state file is not safe for multiple writers. Protect any backups: state contains delivery payloads and message mappings. Disk-full or state-write errors return 503 rather than acknowledging a new GitHub delivery. GitHub does **not** automatically redeliver failed webhook deliveries; monitor deliveries and manually redeliver failures. Successful delivery IDs are retained while state exists, so storage grows and needs monitoring.

Queued notifications retry with backoff after Telegram errors while state remains available. Delivery is not exactly-once: a crash or timeout after Telegram accepts a message but before state is saved can cause duplicates, and the original message may not have a reply mapping. Successful Telegram update IDs are stored and deduplicated while state remains available, but a GitHub comment may still be duplicated if the API accepts it and the response or subsequent state save fails. Update IDs grow indefinitely. GitHub signs the body, not the delivery ID or event header: someone possessing a captured signed request can replay its body under a new ID or change the event header. Identical bodies can be legitimate distinct events, so body-based deduplication would silently discard valid notifications; this service does not claim replay protection across delivery IDs. Protect webhook traffic and logs, rotate a compromised secret, and restrict network access where feasible. Digest batches have no reply target. Telegram replies are authenticated by webhook secret, chat and user ID, and mapped by the bot's stored message ID and GitHub installation, not message text.

## Tests

`npm test` runs isolated tests using local HTTP and fake external clients; it does not call Telegram or GitHub. `test-webhook.js` and `test-render.js` are manual network scripts, not part of the automated suite; do not run against a deployment unintentionally.

ISC license.
