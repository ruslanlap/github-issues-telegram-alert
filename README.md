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
| `STATE_FILE` | Absolute path to the state file on persistent storage |
| `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY` | Both required for replies; key may contain literal `\n` line breaks |
| `PORT` | HTTP port, default 3000 |

Create a GitHub App webhook at `https://your-host/webhook` with content type JSON and the configured secret. Subscribe to the event types you need, including Pull request review, Check run and Workflow run for review and CI notifications. Install the App on the relevant repositories. For replies grant Issues write permission (and Pull requests permission for PRs). Repository webhooks without App installation IDs can notify but cannot map replies.

Set `TELEGRAM_WEBHOOK_URL=https://your-host/telegram-webhook` and run `node setup-telegram-webhook.js`. This sends the secret to Telegram as `secret_token`; use HTTPS. Telegram sends it in `X-Telegram-Bot-Api-Secret-Token`. Add the bot to the destination chat and allow the specified user IDs. Start with `npm start`.

Optional comma-separated allowlists `FILTER_REPOS` (e.g. `owner/repo`), `FILTER_EVENTS` (GitHub webhook names), `FILTER_ACTORS` (sender login) and `FILTER_LABELS` (at least one matching issue/PR label) restrict notifications; empty means unrestricted. Label filtering excludes events without matching labels. `TOPIC_ROUTES` is a JSON object mapping repository names or event names to Telegram topic IDs; repository takes precedence. `DIGEST_MS` enables delayed batching by topic; batched messages cannot be replied to as a specific issue. A batch respects Telegram's 4000-character limit.

## Render migration

The included Render blueprint uses a **paid Starter** service and a separately billed 1 GB persistent disk. Free services cannot use persistent disks. Review current Render pricing and disk/plan availability before upgrading. Do not apply the blueprint until you have backed up any existing state and are ready for downtime: adding a disk or changing plans may restart the service. Keep exactly one instance. Mount the disk at `/var/data`, set `STATE_FILE=/var/data/state.json`, and configure all required secrets and allowed user IDs before starting this version. Stop the old process before copying an existing state file to the disk; preserve its permissions, start the new version, and verify queued deliveries and replies. If migrating from a version without a state file, old notification reply mappings and delivery IDs cannot be recovered. Monitor GitHub deliveries and manually redeliver failures after migration. The blueprint is not deployed automatically by these instructions; review changes in Render before applying them. Configure GitHub App credentials when replies are needed.

## Reliability and operations

**A persistent, writable filesystem is required.** Use one process and one instance only: the state file is not safe for multiple writers. Set `STATE_FILE` on a persistent volume; Render's ephemeral filesystem is not sufficient. Back up this file securely: it contains delivery payloads and message mappings. Disk-full or persistence errors return 503 rather than acknowledging a new GitHub delivery. GitHub does **not** automatically redeliver failed webhook deliveries; monitor deliveries and manually redeliver failures. Successful delivery IDs are retained indefinitely for deduplication, so storage grows and needs monitoring; do not delete state while pending work or reply mappings matter.

Queued notifications retry with backoff after Telegram errors and survive restarts. This is at-least-once, not exactly-once: a crash or timeout after Telegram accepts a message but before state is saved can cause duplicates, and the original message may not have a reply mapping. Successful Telegram update IDs are persisted and deduplicated, but a GitHub comment may still be duplicated if the API accepts it and the response or subsequent state save fails. Update IDs grow indefinitely. GitHub signs the body, not the delivery ID or event header: someone possessing a captured signed request can replay its body under a new ID or change the event header. Identical bodies can be legitimate distinct events, so body-based deduplication would silently discard valid notifications; this service does not claim replay protection across delivery IDs. Protect webhook traffic and logs, rotate a compromised secret, and restrict network access where feasible. Digest batches have no reply target. Telegram replies are authenticated by webhook secret, chat and user ID, and mapped by the bot's stored message ID and GitHub installation, not message text.

## Tests

`npm test` runs isolated tests using local HTTP and fake external clients; it does not call Telegram or GitHub. `test-webhook.js` and `test-render.js` are manual network scripts, not part of the automated suite; do not run against a deployment unintentionally.

ISC license.
