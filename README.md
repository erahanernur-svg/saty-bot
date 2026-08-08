# Saty Telegram Bot

Telegram bot for the Saty marketplace — verifies sellers via phone number and
links Telegram with site accounts.

## Flow

`https://t.me/<botname>?start=<siteUserId>`
1. Saves `chatId <-> siteUserId` mapping in Firestore `telegram_links`.
2. Asks the user to share their phone number.
3. On contact, updates `users/<siteUserId>`: `phone`, `isVerified`, `telegramChatId`.

## Local development

```bash
npm install
cp .env.example .env   # then fill in TELEGRAM_BOT_TOKEN
npm start
```

Runs with long-polling — no public URL needed.

## Deployment (Render / Railway — free 24/7)

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Saty Telegram bot"
git branch -M main
git remote add origin https://github.com/<you>/saty-bot.git
git push -u origin main
```

`.env`, `node_modules`, `serviceAccountKey.json` are git-ignored — do not commit secrets.

### 2. Environment variables

Set these in Render (\`Environment\`) or Railway (\`Variables\`):

| Variable | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather (required). |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **Entire** content of `serviceAccountKey.json` as a single-line JSON string (required). |
| `WEBHOOK_URL` | Public app URL, e.g. `https://saty-bot.onrender.com` (no trailing slash; `/webhook` is added automatically). Optional — polling is used when unset. |
| `WEBHOOK_SECRET` | Random string guarding `/webhook` from fake requests (optional, e.g. `openssl rand -hex 24`). |

### 3. Start command

- **Render**: Build Command `npm install`, Start Command `npm start`
- **Railway**: Start Command `npm start`

The bot binds `process.env.PORT` (injected by the host) and serves `GET /` and `GET /health` so the platform keeps the process alive.

### Behaviour

- If `WEBHOOK_URL` is set → registers the Telegram webhook at `{WEBHOOK_URL}/webhook` with `secret_token`.
- Otherwise → falls back to long-polling (works on Railway, local dev).

On Render, free web services sleep after ~15 min of inactivity. A webhook wakes them on every message, so use `WEBHOOK_URL` there for instant responses.