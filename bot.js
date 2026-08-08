// Saty marketplace Telegram bot.
// Deep-link flow:  https://t.me/<botname>?start=<siteUserId>
//   1. Saves the Telegram chatId <-> siteUserId mapping in Firestore `telegram_links`.
//   2. Asks the user to share their phone number.
//   3. On contact, updates the site user doc (`users/<siteUserId>`): phone, isVerified, telegramChatId.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { Telegraf, Markup } from 'telegraf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load secrets from the bot's .env file (TELEGRAM_BOT_TOKEN, etc.).
// Missing file (e.g. on Render/Railway) is fine — env vars are used instead.
try {
  dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });
} catch {
  // .env is optional in the cloud — env vars are injected by the platform.
  dotenv.config({ quiet: true });
}

// ── Config ───────────────────────────────────────────────────────────────────
// Token is read from the environment (see .env). The bot refuses to start
// without it rather than shipping a hardcoded secret.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Create a .env file (see .env.example) or set the env var on your host.');
  process.exit(1);
}

// serviceAccountKey.json lives in the workspace root.
// On cloud hosts (Render/Railway) it's injected as either
//   GOOGLE_APPLICATION_CREDENTIALS (path) or FIREBASE_SERVICE_ACCOUNT_JSON (full JSON string).
const SERVICE_ACCOUNT_PATH =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  path.resolve(__dirname, '..', '..', 'serviceAccountKey.json');

function loadServiceAccount() {
  // 1. Full JSON blob passed as an env var — the recommended way on Render/Railway.
  const fromEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (fromEnv) return JSON.parse(fromEnv);
  // 2. Path to a credentials file.
  return JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
}

// ── Firebase Admin ───────────────────────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
}

const db = admin.firestore();

const COLLECTIONS = {
  links: 'telegram_links',
  users: 'users',
};

// ── Bot ──────────────────────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

function normalizePhone(raw) {
  let phone = String(raw || '').replace(/[^\d+]/g, '');
  if (phone.startsWith('+')) return phone;
  if (phone.startsWith('8') && phone.length === 11) return '+7' + phone.slice(1);
  if (phone.length === 10) return '+7' + phone;
  return phone;
}

// /start <siteUserId> — opened from the website (deep link).
bot.start(async (ctx) => {
  const chatId = String(ctx.chat.id);

  // telegraf v4.16 has no ctx.payload — parse the deep-link argument from the command text.
  const text = ctx.message?.text ?? '';
  let siteUserId = '';
  const match = text.match(/^\/(?:start)\s+(.+)/s);
  if (match) siteUserId = match[1].trim();
  try {
    siteUserId = decodeURIComponent(siteUserId);
  } catch {
    // keep raw payload if it isn't valid encoding
  }
  siteUserId = siteUserId.trim();

  if (!siteUserId) {
    return ctx.reply(
      'Сайттағы «Телеграмға қосу» түймесі арқылы ботты ашыңыз. Бұл сілтеме жарамсыз.'
    );
  }

  // Save the Telegram <-> site mapping (doc id = chatId for fast lookup).
  await db.collection(COLLECTIONS.links).doc(chatId).set(
    {
      chatId,
      siteUserId,
      linkedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await ctx.reply(
    'Аккаунт сату үшін телефон нөміріңізді растау қажет. Төмендегі батырманы басыңыз:',
    Markup.keyboard([Markup.button.contactRequest('📱 Телефон нөмірін бөлісу')])
      .resize()
      .oneTime()
  );
});

// Incoming contact message — phone number shared by the user.
bot.on('contact', async (ctx) => {
  try {
    const contact = ctx.message.contact;
    const chatId = String(ctx.chat.id);

    if (!contact || !contact.phone_number) {
      return ctx.reply('Телефон нөмірі алынбады. Қайталап көріңіз.');
    }

    // Resolve the site user from the stored mapping.
    const linkSnap = await db.collection(COLLECTIONS.links).doc(chatId).get();
    if (!linkSnap.exists) {
      return ctx.reply(
        'Байланыс табылмады. Сайттан «Телеграмға қосу» түймесін басып қайта бастаңыз.'
      );
    }

    const siteUserId = linkSnap.data().siteUserId;
    const phone = normalizePhone(contact.phone_number);

    // Update the site user document: verified seller.
    await db.collection(COLLECTIONS.users).doc(siteUserId).set(
      {
        phone,
        isVerified: true,
        telegramChatId: chatId,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await ctx.reply(
      '✅ Телефон нөміріңіз сәтті расталды! Енді сайтқа қайта оралып, аккаунт сатуға шығара аласыз.',
      Markup.removeKeyboard()
    );
  } catch (err) {
    console.error('contact handler error:', err);
    await ctx.reply('Қате орын алды. Қайталап көріңіз немесе қолдау қызметіне хабарласыңыз.').catch(() => {});
  }
});

// Any other text — gentle nudge back to the flow.
bot.on('text', (ctx) =>
  ctx.reply('Телефон нөмірін растау үшін төмендегі батырманы басыңыз 📱')
);

// ── Launch ───────────────────────────────────────────────────────────────────
// Cloud-friendly startup:
//   * A port is always bound (process.env.PORT) so Render/Railway don't kill the
//     process for being "idle" and health checks succeed.
//   * Defaults to long-polling (works everywhere, free).
//   * If WEBHOOK_URL is set (e.g. https://<app>.onrender.com), switches to a real
//     Telegram webhook (must also have a public URL), which is the most reliable
//     mode on Render (they can send POST events to you whenever a message arrives).
const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '')
  .trim()
  .replace(/\/webhook\/?$/i, '') // tolerate a URL that already ends with /webhook
  .replace(/\/+$/, '');          // then normalize any other trailing slash
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const server = createServer((req, res) => {
  // Health-check endpoint: Render/Railway hit this to confirm the app is alive.
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  // Real Telegram webhook handler (only registered when WEBHOOK_URL is set).
  if (WEBHOOK_URL && req.url === '/webhook' && req.method === 'POST') {
    bot.webhookCallback('/webhook')(req, res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

async function start() {
  server.listen(PORT, () => {
    console.log(`Saty Telegram bot HTTP server listening on :${PORT}`);
  });

  if (WEBHOOK_URL) {
    // Webhook mode: tell Telegram where to deliver updates.
    // The SECRET_TOKEN guards the endpoint against random POST requests.
    const webhookUrl = `${WEBHOOK_URL}/webhook`;
    await bot.telegram.setWebhook(webhookUrl, {
      secret_token: WEBHOOK_SECRET || undefined,
      drop_pending_updates: true,
    });
    console.log(`Telegram webhook registered → ${webhookUrl}`);
    return;
  }

  // Polling mode (default, works on any free host without a public URL).
  await bot.launch();
  console.log('Saty Telegram bot started (polling).');
}

launch();
async function launch() {
  try {
    await start();
  } catch (err) {
    console.error('Failed to launch bot:', err.message);
    process.exit(1);
  }
}

// Enable graceful stop on Ctrl+C / process termination.
async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully…`);
  try {
    await bot.stop(signal);
  } catch {
    // ignore stop errors during shutdown
  }
  server.close(() => process.exit(0));
  // Safety net: force exit if graceful close hangs.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
