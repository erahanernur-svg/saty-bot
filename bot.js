// Saty marketplace Telegram bot — full-featured.
// Deep-link flow:  https://t.me/<botname>?start=<siteUserId>
//   1. Saves the Telegram chatId <-> siteUserId mapping in Firestore `telegram_links`.
//   2. Asks the user to share their phone number.
//   3. On contact, updates the site user doc (`users/<siteUserId>`): phone, isVerified, telegramChatId.
//
// Features:
//   • Main menu: orders, my listings, wallet (balance/withdraw), profile, support/FAQ, rules, settings
//   • Buyer: see orders, confirm delivery, cancel order
//   • Seller: manage active/hidden products, change price
//   • Real-time notifications relayed into Telegram
//
// Cloud-friendly: webhook when WEBHOOK_URL set, otherwise long-polling.
// Always binds PORT + health endpoint so Render/Railway keep the process alive.

import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';

import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  dotenv.config({ path: path.resolve(__dirname, '.env'), quiet: true });
} catch {
  dotenv.config({ quiet: true });
}

// Local modules (do NOT use path aliases; plain relative imports).
import { db, getUser, getLinkedUserId, getSellerStats, findUserByNickname } from './src/db.js';
import * as market from './src/services/marketplace.js';
import * as support from './src/services/support.js';
import * as notify from './src/services/notify.js';
import * as settings from './src/services/settings.js';
import { ORDER_STATUS, PRODUCT_STATUS, fmtPrice, fmtDate, esc, mainMenu } from './src/format.js';
import { r2Configured, uploadToR2 } from './src/storage.js';

const VERSION = 'v1.7.0'; // shown by /health to verify deployed code
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Create a .env file (see .env.example) or set the env var on your host.');
  process.exit(1);
}

// Backup channel: every image uploaded on the site is also forwarded here as a
// live backup copy. The token stays server-side (.env) — never in the browser.
const BACKUP_CHANNEL = (process.env.TELEGRAM_BACKUP_CHANNEL || '').trim();
const BACKUP_API_KEY = (process.env.BACKUP_API_KEY || '').trim();

const bot = new Telegraf(BOT_TOKEN);
const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_URL = (process.env.WEBHOOK_URL || '')
  .trim()
  .replace(/\/webhook\/?$/i, '')
  .replace(/\/+$/, '');

// Safeguard: never let the webhook be re-registered to a stale/old host.
// Render can keep legacy env vars; force the correct public URL instead.
const PUBLIC_URL = (() => {
  if (process.env.BOT_PUBLIC_URL) return process.env.BOT_PUBLIC_URL.trim().replace(/\/+$/, '');
  let u = WEBHOOK_URL;
  if (u && !/saty-bot\.onrender\.com/i.test(u)) u = 'https://saty-bot.onrender.com'; // legacy host fix
  return u;
})();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

// Only these Telegram user IDs can use admin commands (comma-separated, no spaces).
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
function isAdminCtx(ctx) {
  return ADMIN_IDS.has(String(ctx.from?.id));
}

// ── Tiny flow state machine (waiting for a plain-text reply) ─────────────────
const flows = new Map(); // chatId -> { step, payload }
const usernamesSeen = new Set();

function flowGet(chatId) {
  return flows.get(String(chatId));
}
function flowSet(chatId, step, payload = {}) {
  flows.set(String(chatId), { step, payload });
}
function flowClear(chatId) {
  flows.delete(String(chatId));
}
function chatIdOf(ctx) {
  return String(ctx.from?.id ?? ctx.chat?.id);
}

// ── Shared helpers ─────────────────────────────────────────────────────────────
async function requireUser(ctx) {
  const uid = await getLinkedUserId(chatIdOf(ctx));
  if (!uid) {
    await ctx.reply(
      '🔗 <b>Аккаунт байланмаған.</b>\n\nСайттағы «Телеграмға қосу» түймесін басып ботты ашыңыз.',
      { parse_mode: 'HTML' }
    );
    return null;
  }
  const user = await getUser(uid);
  return user?.uid ? user : { uid, displayName: uid };
}

async function showMenu(ctx, head = '🏠 <b>Бас мәзір:</b>') {
  await ctx.reply(head, { parse_mode: 'HTML', reply_markup: mainMenu().reply_markup });
}

/** Merge parse-mode options + a Markup keyboard into one `extra` object (telegraf reply drops the 3rd arg). */
function withKB(markup, opts = {}) {
  return { reply_markup: markup?.reply_markup, ...opts };
}

// ── Commands ───────────────────────────────────────────────────────────────────
bot.use((ctx, next) => {
  const u = ctx.update;
  if (u) {
    const who = ctx.from?.id ?? '?';
    const kind = u.message ? 'message' : u.callback_query ? 'callback' : 'update';
    const head = u.message?.text ? `「${u.message.text.slice(0, 40)}」` : u.callback_query?.data ? `cb:${u.callback_query.data}` : '';
    console.log(`[update] ${kind} from ${who} ${head}`);
  }
  // Remember the Telegram @username so an admin can credit a user by nickname.
  if (ctx.from?.username && !usernamesSeen.has(String(ctx.from.id))) {
    usernamesSeen.add(String(ctx.from.id));
    db.collection('telegram_links')
      .doc(String(ctx.from.id))
      .set({ telegramUsername: String(ctx.from.username).toLowerCase(), chatId: String(ctx.from.id) }, { merge: true })
      .catch((err) => console.warn('[link username]', err.message));
  }
  return next();
});

bot.command('start', async (ctx) => {
  const chatId = chatIdOf(ctx);
  const text = ctx.message?.text ?? '';
  const m = text.match(/^\/(?:start)\s+(.+)/s);
  let siteUserId = '';
  if (m) {
    siteUserId = m[1].trim();
    try {
      siteUserId = decodeURIComponent(siteUserId);
    } catch {
      /* keep raw */
    }
    siteUserId = siteUserId.trim();
  }

  if (!siteUserId) {
    const existing = await getLinkedUserId(chatId);
    if (existing) {
      const u = await getUser(existing);
      if (u && String(u.telegramChatId) === chatId) return showMenu(ctx, `🎉 Қайырлы күн! Басты мәзір:`);
    }
    return ctx.reply(
      '👋 <b>Saty ботына қош келдіңіз!</b>\n\n' +
        'Аккаунтты сату үшін сайттағы «Телеграмға қосу» түймесін басып, ботты ашыңыз — ' +
        'сілтеме автоматты түрде тіркеледі.',
      { parse_mode: 'HTML' }
    );
  }

  // Deep link — record Telegram <-> site mapping.
  await db.collection('telegram_links').doc(chatId).set(
    {
      chatId,
      siteUserId,
      linkedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  const user = await getUser(siteUserId);
  const name = user?.displayName || siteUserId;

  // Already verified & linked to this chat → straight to the main menu.
  if (user?.isVerified && String(user?.telegramChatId ?? '') === chatId) {
    return showMenu(ctx, `🎉 <b>Аккаунт байланысты!</b>\n\n👤 ${esc(name)}`);
  }

  await ctx.reply(
    `✅ <b>Аккаунт сәтті байланысты!</b>\n\n` +
      `👤 ${esc(name)}\n🆔 <code>${esc(siteUserId)}</code>\n\n` +
      `Аккаунт сату үшін телефон нөмірін растау қажет. Төмендегі батырманы басыңыз:`,
    {
      parse_mode: 'HTML',
      ...Markup.keyboard([Markup.button.contactRequest('📱 Телефон нөмірін бөлісу')]).resize().oneTime(),
    }
  );
});

bot.command('menu', async (ctx) => showMenu(ctx));
bot.command('help', async (ctx) => showMenu(ctx, '🤝 <b>Көмек</b> — мәзірді пайдаланыңыз:'));
bot.command('profile', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await showProfileCtx(ctx, user);
});
bot.command('orders', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await showOrdersIndex(ctx);
});
bot.command('wallet', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await showWallet(ctx, user);
});

async function showProfileCtx(ctx, user) {
  const stats = await getSellerStats(user.uid);
  const link = user.telegramChatId ? '✅ Телеграм-байланыс' : '—';
  await ctx.reply(
    `👤 <b>${esc(user.displayName || 'Пользователь')}</b>\n\n` +
      `📞 Телефон: ${esc(user.phone || '—')}\n` +
      `✅ Верификация: ${user.isVerified ? 'Иә' : 'Жоқ'}\n` +
      `🔗 ${link}\n` +
      (stats
        ? `\n📊 Сатушы:<em>${stats.completedOrders}</em> заказ · отзыв ${stats.responseRate ?? 0}%\n🚀 ${stats.avgDeliveryMinutes ?? 0} мин · 👥 ${stats.followers} followers`
        : ''),
    {
      parse_mode: 'HTML',
      reply_markup: mainMenu().reply_markup,
    }
  );
}

// ── Callback: main menu ─────────────────────────────────────────────────────────
bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showMenu(ctx);
});

bot.action(/^menu:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const section = ctx.match[1];
  if (section === 'orders') return showOrdersIndex(ctx);
  if (section === 'products') return showMyProducts(ctx);
  if (section === 'wallet') {
    const user = await requireUser(ctx);
    if (user) return showWallet(ctx, user);
    return null;
  }
  if (section === 'profile') {
    const user = await requireUser(ctx);
    if (user) return showProfileCtx(ctx, user);
    return null;
  }
  if (section === 'support') return showSupport(ctx);
  if (section === 'rules') return showRules(ctx);
  if (section === 'settings') return showSettings(ctx);
  return showMenu(ctx);
});

// ── Orders ─────────────────────────────────────────────────────────────────────
async function showOrdersIndex(ctx) {
  await ctx.reply(
    '📦 <b>Менің заказдарым</b>\n\nТаңдаңыз:',
    withKB(
      Markup.inlineKeyboard([
        [
          Markup.button.callback('🛒 Сатып алған', 'orders:buy'),
          Markup.button.callback('💼 Сатқандық', 'orders:sell'),
        ],
        [Markup.button.callback('‹ Бас мәзір', 'menu')],
      ]),
      { parse_mode: 'HTML' }
    )
  );
}

bot.action(/^orders:(buy|sell)(?::p:(\d+))?$/, async (ctx) => {
  await ctx.answerCbQuery();
  const kind = ctx.match[1];
  const page = Number(ctx.match[2] ?? 0);
  const uid = await getLinkedUserId(chatIdOf(ctx));
  if (!uid) {
    const u = await requireUser(ctx);
    if (!u) return;
  }
  const orders =
    kind === 'buy' ? await market.getBuyerOrders(uid, 20) : await market.getSellerOrders(uid, 20);
  if (!orders.length) {
    return ctx.reply(kind === 'buy' ? '🛒 Сізде сатып алулар жоқ.' : '💼 Сіз дейн сатылым жоқ.');
  }
  const per = 5;
  const head = kind === 'buy' ? '🛒 <b>Сатып алынған</b>' : '💼 <b>Сатқандық</b>';
  const rows = orders.slice(page * per, page * per + per);
  const lines = rows.map(
    (o) => `${ORDER_STATUS[o.status] ?? ''} · <b>${esc(o.productTitle || '?')}</b> — ${fmtPrice(o.price)}`
  );
  const kb = rows.map((o) => [Markup.button.callback(`🔍 ${esc(o.productTitle || '?')}`, `ord:${o.id}`)]);
  const row = [];
  if (page > 0) row.push(Markup.button.callback('‹ Арт', `orders:${kind}:p:${page - 1}`));
  if (orders.length > (page + 1) * per) row.push(Markup.button.callback('Келесі ›', `orders:${kind}:p:${page + 1}`));
  if (row.length) kb.push(row);
  kb.push([Markup.button.callback('‹ Бас мәзір', 'menu')]);

  const mb = Markup.inlineKeyboard(kb);
  await ctx.editMessageText(`${head}\n${lines.join('\n')}`, withKB(mb, { parse_mode: 'HTML' })).catch(() =>
    ctx.reply(`${head}\n${lines.join('\n')}`, withKB(mb, { parse_mode: 'HTML' }))
  );
});

bot.action(/^ord:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const order = await market.getOrderById(ctx.match[1]);
  const uid = await getLinkedUserId(chatIdOf(ctx));
  if (!order) return ctx.reply('Заказ табылмады.');
  if (!uid) return requireUser(ctx);
  if (String(order.sellerId) !== String(uid) && String(order.buyerId) !== String(uid))
    return ctx.reply('⛔ Бұл сіздің заказыңыз емес.');
  const isSeller = order.sellerId === String(uid);
  const isBuyer = order.buyerId === String(uid);
  const st = order.status;
  const kb = [];

  if (isSeller && st === 'paid') kb.push([Markup.button.callback('🚚 Аккаунтты жеткіздім', `do:deliver:${order.id}`)]);
  if (isBuyer && st === 'processing') kb.push([Markup.button.callback('✅ Ал, мен аккаунт алдым', `do:confirm:${order.id}`)]);
  if ((st === 'paid' || st === 'pending') && (isSeller || isBuyer))
    kb.push([Markup.button.callback('⛔ Болдырма', `do:cancel:${order.id}`)]);
  kb.push([Markup.button.callback('‹ Бас мәзір', 'menu')]);

  await ctx.reply(
    `📦 <b>${esc(order.productTitle || 'Товар')}</b>\n\n` +
      `💵 ${fmtPrice(order.price)}${order.currency && order.currency !== 'KZT' ? ` ${esc(order.currency)}` : ''}\n` +
      `🎮 ${esc(order.gameName || order.gameId || '—')}\n` +
      `Статус: <b>${ORDER_STATUS[st] || esc(st)}</b>\n` +
      `👤 ${isSeller ? 'Сатып алушы' : 'Сатушы'}: ${esc(isSeller ? order.buyerName : order.sellerName)}\n` +
      `🕐 ${fmtDate(order.createdAt)}\n` +
      `🆔 <code>${esc(order.id)}</code>`,
    withKB(Markup.inlineKeyboard(kb), { parse_mode: 'HTML' })
  );
});

// Order actions
bot.action(/^do:(deliver|confirm|cancel):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const [, action, orderId] = ctx.match;
  const uid = await getLinkedUserId(chatIdOf(ctx));
  if (!uid) return requireUser(ctx);
  const order = await market.getOrderById(orderId);
  if (!order) return ctx.reply('Заказ табылмады.');

  try {
    if (action === 'deliver') {
      if (order.sellerId !== uid) return ctx.alert('⛔ Бұл тек сатушы үшін.');
      if (order.status !== 'paid') return ctx.alert('Тек «Төленді» күйде жеткізуге болады.');
      await market.deliverOrder(orderId);
      await ctx.reply('🚚 <b>Аккаунт жеткізілді!</b>\n\nСатып алушы растаған соң ақша кошелекке түседі.', { parse_mode: 'HTML' });
    } else if (action === 'confirm') {
      if (order.buyerId !== uid) return ctx.alert('⛔ Тек сатып алушы растай алады.');
      if (order.status !== 'processing') return ctx.alert('Аккаунтты сатушы жеткізгенге дейін растау мүмкін емес.');
      await market.confirmOrder(orderId);
      await ctx.reply('✅ <b>Расталды! Ақша сатушыға аударылды.</b>\n\n🌚 Заказ аяқталды.', { parse_mode: 'HTML' });
      try {
        const seller = await getUser(order.sellerId);
        if (seller?.telegramChatId) {
          await bot.telegram.sendMessage(
            seller.telegramChatId,
            `✅ <b>Заказ аяқталды.</b>\n\n📦 ${esc(order.productTitle)} — <b>${fmtPrice(order.price)}</b>\nАқша кошелекке түсті.`,
            { parse_mode: 'HTML' }
          );
        }
      } catch {}
    } else if (action === 'cancel') {
      if (order.sellerId !== uid && order.buyerId !== uid) return ctx.alert('⛔ Бұл сіздің заказыңыз емес.');
      if (order.status !== 'paid' && order.status !== 'pending')
        return ctx.alert('Бұл заказды болдыру мүмкін емес.');
      const res = await market.cancelOrder(orderId);
      await ctx.reply(
        res.cancelled
          ? `🚫 <b>Заказ болдырылды.</b>\n\n${res.refunded ? '💰 Ақша сатып алушыға қайтарылды.' : ''}`
          : 'Заказды болдыру мүмкін емес.',
        { parse_mode: 'HTML' }
      );
    }
  } catch (err) {
    console.error('[order action] error:', err.message);
    await ctx.reply('Қате орын алды. /menu арқылы жалғастырыңыз.').catch(() => {});
  }
});

// ── My products (seller) ───────────────────────────────────────────────────────
async function showMyProducts(ctx) {
  const uid = await getLinkedUserId(chatIdOf(ctx));
  if (!uid) return requireUser(ctx);
  const products = await market.getSellerProducts_(String(uid), 15);
  if (!products.length)
    return ctx.reply(
      '🏷️ Лоттар табылмады. Сайттағы «Сату» бөлімінде лот жасаңыз.',
      withKB(Markup.inlineKeyboard([[Markup.button.callback('‹ Бас мәзір', 'menu')]]), { parse_mode: 'HTML' })
    );

  const lines = products.map((p, i) => `${i + 1}. ${PRODUCT_STATUS[p.status] || ''} · <b>${esc(p.title)}</b> — ${fmtPrice(p.price)}`);
  const kb = products.map((p) => [Markup.button.callback(`${esc(p.title).slice(0, 30)} — ${fmtPrice(p.price)}`, `prod:${p.id}`)]);
  kb.push([Markup.button.callback('⬅ Бас мәзір', 'menu')]);
  await ctx.reply(`🏷️ <b>Менің лоттарым</b>\n\n${lines.join('\n')}`, withKB(Markup.inlineKeyboard(kb), { parse_mode: 'HTML' }));
}

bot.action(/^prod:(?!price:|hide:|show:)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const product = await market.getProductById(ctx.match[1]);
  if (!product) return ctx.reply('Лот табылмады.');
  const uid = await getLinkedUserId(chatIdOf(ctx));
  if (!uid) return requireUser(ctx);
  if (product.sellerId !== String(uid)) return ctx.alert('⛔ Бұл сіздің лотыңыз емес.');

  const kb = [];
  kb.push([Markup.button.callback('💰 Бағаны өзгерту', `prod:price:${product.id}`)]);
  if (product.status === 'active') kb.push([Markup.button.callback('🙈 Жасыру', `prod:hide:${product.id}`)]);
  else if (product.status === 'hidden') kb.push([Markup.button.callback('✅ Сатылымға шығару', `prod:show:${product.id}`)]);
  kb.push([Markup.button.callback('‹ Менің лоттарым', 'menu:products')]);

  const attrs = product.attributes
    ? Object.entries(product.attributes)
        .map(([k, v]) => `• ${esc(k)}: ${Array.isArray(v) ? v.join(', ') : esc(String(v))}`)
        .join('\n')
    : '';

  await ctx.reply(
    `🏷️ <b>${esc(product.title)}</b>\n\n` +
      `Статус: <b>${PRODUCT_STATUS[product.status] || esc(product.status)}</b>\n` +
      `💰 Баға: <b>${fmtPrice(product.price)}</b>\n` +
      (attrs ? `\n📋 Сипаттама:\n${attrs}\n` : '') +
      `🕐 ${fmtDate(product.createdAt)}`,
    withKB(Markup.inlineKeyboard(kb), { parse_mode: 'HTML' })
  );
});

bot.action(/^prod:(price|hide|show):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const action = ctx.match[1];
  const productId = ctx.match[2];
  const uid = await getLinkedUserId(chatIdOf(ctx));
  if (!uid) return requireUser(ctx);
  try {
    if (action === 'hide') {
      await market.changeProductStatus(productId, 'hidden');
      await ctx.reply('🙈 Лот жасырылды.', { parse_mode: 'HTML' });
    } else if (action === 'show') {
      await market.changeProductStatus(productId, 'active');
      await ctx.reply('✅ Лот сатылымға қайта шығарылды.', { parse_mode: 'HTML' });
    } else if (action === 'price') {
      flowSet(chatIdOf(ctx), 'prod_price', { productId });
      await ctx.reply('💬 Жаңа бағанын енгізіңіз (теңгемен), мысалы: 5000', { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('[product]', err);
    await ctx.reply('Қате орын алды. Позже көріңіз.').catch(() => {});
  }
});

// ── Wallet ─────────────────────────────────────────────────────────────────────
async function showWallet(ctx, user) {
  const stats = await getSellerStats(user.uid);
  const balance = user.balance ?? 0;
  const pending = stats?.pendingBalance ?? 0;
  const available = stats?.availableBalance ?? 0;
  const revenue = stats?.totalRevenue ?? 0;
  await ctx.reply(
    `👛 <b>Кошелек</b>\n\n` +
      `💰 Баланс: <b>${fmtPrice(balance)}</b>\n` +
      `🕘 Ұсталды: ${fmtPrice(pending)}\n` +
      `✅ Қол жетімді: ${fmtPrice(available)}\n` +
      `📈 Жалпы кіріс: ${fmtPrice(revenue)}\n\n` +
      `<i>Комиссия 5%.</i>`,
    withKB(
      Markup.inlineKeyboard([
        [Markup.button.callback('🏦 Шақыру: ақша алу', 'wallet:withdraw')],
        [Markup.button.callback('⬅ Бас мәзір', 'menu')],
      ]),
      { parse_mode: 'HTML' }
    )
  );
}

bot.action('wallet:withdraw', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await requireUser(ctx);
  if (!user) return;
  if (!user.balance || user.balance < 500) return ctx.alert('⛔ Шақыру үшін баланста кем дегенде 500 ₸ болуы керек.');
  flowSet(chatIdOf(ctx), 'withdraw_amount');
  await ctx.reply(
    `🏦 <b>Ақша шығару</b>\n\nСоманы енгізіңіз (теңге).\n💰 Баланс: ${fmtPrice(user.balance)}\n\nМысалы: 10000`,
    { parse_mode: 'HTML' }
  );
});

bot.action(/^withdraw:method:(kaspi|card)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const method = ctx.match[1];
  const state = flowGet(chatIdOf(ctx));
  if (!state || state.step !== 'withdraw_method') return ctx.reply('Состояние не найдено. 😕');
  const amount = state.payload?.amount ?? 0;
  if (method === 'kaspi') {
    flowSet(chatIdOf(ctx), 'withdraw_kaspi', { amount });
    await ctx.reply(`💳 <b>Kaspi реквизиттері</b>\n\n📱 Нөмір немесе телефон енгізіңіз (мысалы +7... ):`);
    return;
  }
  flowSet(chatIdOf(ctx), 'withdraw_card', { amount });
  await ctx.reply('💳 <b>Банк картасы</b>\n\nКарта нөмірін енгізіңіз (16 цифр):');
});

// ── Admin: credit balance to a user by @nickname ─────────────────────────────
bot.command('admin', async (ctx) => {
  if (!isAdminCtx(ctx)) return ctx.reply('⛔ Рұқсат жоқ.');
  await ctx.reply(
    `🛠 <b>Админ панелі</b>\n\nПайдаланушының @никнеймі арқылы балансқа ақша қосу:`,
    withKB(
      Markup.inlineKeyboard([
        [Markup.button.callback('💰 Ақша қосу', 'admin:credit')],
        [Markup.button.callback('⬅ Бас мәзір', 'menu')],
      ]),
      { parse_mode: 'HTML' }
    )
  );
});

bot.action('admin:credit', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdminCtx(ctx)) return;
  flowSet(chatIdOf(ctx), 'admin_credit_nick');
  await ctx.reply('👤 <b>Ақша қосатын пайдаланушының @никнеймін жазыңыз</b>\n\nМысалы: <code>@satykz</code>', { parse_mode: 'HTML' });
});

// Text flow: admin credit steps (nick → amount)

// Text flow: withdraw amount entered
bot.on('text', async (ctx) => {
  const chatId = chatIdOf(ctx);
  const state = flowGet(chatId);
  if (!state) {
    return ctx.reply('💡 Команда аныталмады. Мәзір /menu ашыңыз.');
  }
  const text = (ctx.message?.text ?? '').trim();
  const user = await requireUser(ctx);
  if (!user) return;

  try {
    if (state.step === 'prod_price') {
      const price = Number(text.replace(/[^\d]/g, ''));
      if (!price || price <= 0) return ctx.reply('⚠️ Дұрыс сан енгізіңіз.');
      await market.changeProductPrice(state.payload.productId, price);
      flowClear(chatId);
      await ctx.reply(
        `✅ Баға өзгерді: <b>${fmtPrice(price)}</b>`,
        withKB(Markup.inlineKeyboard([[Markup.button.callback('‹ Менің лоттарым', 'menu:products')]]), { parse_mode: 'HTML' })
      );
    } else if (state.step === 'withdraw_amount') {
      const amount = Number(text.replace(/[^\d]/g, ''));
      if (!amount || amount <= 0) return ctx.reply('⚠️ Дұрыс сан енгізіңіз.');
      if (amount > (user.balance ?? 0)) return ctx.reply(`⚠️ Баланста жеткіліксіз (${fmtPrice(user.balance)}).`);
      flowSet(chatId, 'withdraw_method', { amount });
      await ctx.reply(
        `🏦 Сома: <b>${fmtPrice(amount)}</b>\n\nШығаратын әдісті таңда:`,
        withKB(
          Markup.inlineKeyboard([
            [Markup.button.callback('☕ Kaspi Gold', 'withdraw:method:kaspi'), Markup.button.callback('💳 Банк картасы', 'withdraw:method:card')],
          ]),
          { parse_mode: 'HTML' }
        )
      );
    } else if (state.step === 'withdraw_kaspi') {
      if (!/^\+?[\d\s-]{9,}$/.test(text)) return ctx.reply('⚠️ Дұрыс нөмір енгізіңіз.');
      await market.createWithdraw(user.uid, { amount: state.payload.amount, method: 'kaspi', details: text });
      flowClear(chatId);
      await ctx.reply(`✅ Өтініш жіберілді (${fmtPrice(state.payload.amount)} → Kaspi ${esc(text)}). Админ тексерген соң төленеді.`, { parse_mode: 'HTML' });
    } else if (state.step === 'withdraw_card') {
      if (!/^\d{12,19}$/.test(text.replace(/\s/g, ''))) return ctx.reply('⚠️ Карта номерін (16 цифр) енгізіңіз.');
      await market.createWithdraw(user.uid, { amount: state.payload.amount, method: 'card', details: text.replace(/\s/g, '') });
      flowClear(chatId);
      await ctx.reply(`✅ Өтініш жіберілді (${fmtPrice(state.payload.amount)} → 🏦 карта). Админ тексеріп төлейді.`, { parse_mode: 'HTML' });
    } else if (state.step === 'ticket_subject') {
      const subject = text.slice(0, 120);
      if (!subject) return ctx.reply('⚠️ Тақырыпты енгізіңіз.');
      const ticketId = await support.createTicket({ userId: String(user.uid), userName: user.displayName || user.uid, userAvatar: user.photoURL ?? '', subject });
      flowClear(chatId);
      await ctx.reply(`🆗 <b>Тикет ашылды:</b> <code>${ticketId}</code>\n\nЖақында админ жауап береді.`, { parse_mode: 'HTML' });
    } else if (state.step === 'ticket_reply') {
      if (!text) return ctx.reply('⚠️ Хабарды енгізіңіз.');
      await support.sendTicketMessage(user, state.payload.ticketId, text);
      flowClear(chatId);
      await ctx.reply('✉️ Жауап жіберілді. Админ көреді.', { parse_mode: 'HTML' });
    } else if (state.step === 'admin_credit_nick') {
      if (!isAdminCtx(ctx)) return ctx.reply('⛔ Рұқсат жоқ.');
      const target = await findUserByNickname(text);
      if (!target) return ctx.reply('⚠️ Пайдаланушы табылмады. @никнеймін дұрыс жазыңыз немесе пайдаланушы ботқа жалғанбаған.');
      flowSet(chatId, 'admin_credit_amount', { uid: target.uid, name: target.displayName || target.uid });
      await ctx.reply(
        `👤 <b>${esc(target.displayName || target.uid)}</b>\n💰 Баланс: <b>${fmtPrice(target.balance ?? 0)}</b>\n\nҚанша теңге қосу керек?`,
        { parse_mode: 'HTML' }
      );
    } else if (state.step === 'admin_credit_amount') {
      if (!isAdminCtx(ctx)) return ctx.reply('⛔ Рұқсат жоқ.');
      const amount = Number((text || '').replace(/[^\d]/g, ''));
      if (!amount || amount <= 0) return ctx.reply('⚠️ Дұрыс сома енгізіңіз.');
      const newBalance = await market.adminCredit(state.payload.uid, amount, `tg:${user.uid}`);
      flowClear(chatId);
      await ctx.reply(
        `✅ <b>${esc(state.payload.name)}</b> балансына <b>${fmtPrice(amount)}</b> қосылды.\n💰 Жаңа баланс: <b>${fmtPrice(newBalance)}</b>`,
        { parse_mode: 'HTML' }
      );
    } else {
      flowClear(chatId);
    }
  } catch (err) {
    console.error('[flow]', err);
    flowClear(chatId);
    await ctx.reply('Ошибка. /menu ').catch(() => {});
  }
});

// ── Support / FAQ / Rules ─────────────────────────────────────────────────────
async function showSupport(ctx) {
  const user = await requireUser(ctx);
  if (!user) return;
  await ctx.reply(
    '🎧 <b>Қолдау</b>\n\nНе істеу керек?',
    withKB(
      Markup.inlineKeyboard([
        [Markup.button.callback('🆕 Жаңа тикет', 'sup:new')],
        [Markup.button.callback('📋 Менің тикеттерім', 'sup:list')],
        [Markup.button.callback('❓ FAQ', 'sup:faq')],
        [Markup.button.callback('⬅ Бас мәзір', 'menu')],
      ]),
      { parse_mode: 'HTML' }
    )
  );
}

bot.action(/^sup:(new|list|faq)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const what = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user) return;
  if (what === 'faq') {
    const kb = support.FAQ.map((f) => [Markup.button.callback(f.title || f.q, `faq:${f.id}`)]);
    kb.push([Markup.button.callback('⬅ Қолдау', 'menu:support')]);
    await ctx.reply('❓ <b>Жиі қойылатын сұрақтар</b>', withKB(Markup.inlineKeyboard(kb), { parse_mode: 'HTML' }));
  } else if (what === 'list') {
    const tickets = await support.myTickets(String(user.uid));
    if (!tickets.length)
      return ctx.reply('Тикет табылмады. 🆕 Жаңа тикет ашып көріңіз.', {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('🆕 Ашу', 'sup:new'), Markup.button.callback('⬅ Мәзір', 'menu')],
        ]).reply_markup,
      });
    const kb = tickets.map((t) => [Markup.button.callback(`${t.status === 'closed' ? '🔒' : '🎫'} ${esc(t.subject || t.id)}`, `ticket:${t.id}`)]);
    kb.push([Markup.button.callback('⬅ Қолдау', 'menu:support')]);
    await ctx.reply(`📋 <b>Менің тикеттерім</b>`, withKB(Markup.inlineKeyboard(kb), { parse_mode: 'HTML' }));
  } else if (what === 'new') {
    flowSet(chatIdOf(ctx), 'ticket_subject');
    await ctx.reply(`🆕 <b>Жаңа тикет</b>\n\nМәселенің тақырыбын жазыңыз:`, { parse_mode: 'HTML' });
  }
});

bot.action(/^faq:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const f = support.FAQ.find((x) => x.id === ctx.match[1]);
  if (!f) return;
  const title = f.title || f.q;
  const answer = f.a || '';
  await ctx.reply(`❓ <b>${esc(title)}</b>\n\n${esc(answer)}`, withKB(Markup.inlineKeyboard([[Markup.button.callback('‹ FAQ', 'sup:faq')]]), { parse_mode: 'HTML' }));
});

bot.action(/^ticket:(?!reply:)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ticket = await support.getTicketById(ctx.match[1]);
  if (!ticket) return ctx.reply('Тикет табылмады.');
  const user = await requireUser(ctx);
  if (!ticket.userId || !user || ticket.userId !== String(user.uid)) return ctx.reply('⛔ Бұл сіздің тикетіңыз емес.');
  const msgs = await support.ticketMessages(ticket.id);
  const history = msgs.length ? msgs.map((m) => `${m.senderRole === 'admin' ? '🛠️' : m.senderRole === 'bot' ? '🤖' : '👤'} ${esc(m.senderName || '—')}:\n${esc(m.text)}`).join('\n\n') : '';
  const kb = [
    [Markup.button.callback('✉️ Жауаптау', `ticket:reply:${ticket.id}`)],
    [Markup.button.callback('‹ Менің тикеттерім', 'sup:list')],
  ];
  await ctx.reply(
    `📎 <b>${esc(ticket.subject)}</b>\n\n` +
      `Статус: <b>${ticket.status === 'open' ? '🟢 ашық' : ticket.status === 'pending' ? '🟡 қарауда' : '🔴 жабылды'}</b>\n\n` +
      `${history || '🕳️ Әзірге хабарламалар жоқ.'}`,
    withKB(Markup.inlineKeyboard(kb), { parse_mode: 'HTML' })
  );
});

bot.action(/^ticket:reply:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const ticket = await support.getTicketById(ctx.match[1]);
  const user = await requireUser(ctx);
  if (!ticket || ticket.userId !== String(user?.uid)) return;
  flowSet(chatIdOf(ctx), 'ticket_reply', { ticketId: ticket.id });
  await ctx.reply('✉️ Жауапты енгізіңіз:', { parse_mode: 'HTML' });
});

async function showRules(ctx) {
await ctx.reply(
    '📖 <b>Правила Saty</b>\n\n' +
      '1️⃣ Эскроу: сатып алушы ақыны платформаға салады, сатып растайды.\n' +
      '2️⃣ Сату: лот жариялап, модерациядан (24сағ) өтесіз.\n' +
      '3️⃣ Комиссия: 5%.\n' +
      '4️⃣ Қауіпсіздік: тек платформаның ішінде сауда жасаңыз.\n\n' +
      '<i>Толық ереже — сайт «Правила» бөлімінде.</i>',
    withKB(Markup.inlineKeyboard([[Markup.button.callback('⬅ Бас мәзір', 'menu')]]), { parse_mode: 'HTML' })
  );
}

// ── Settings / notifications ─────────────────────────────────────────────────
async function showSettings(ctx) {
  const user = await requireUser(ctx);
  if (!user) return;
  const enabled = await settings.getTelegramNotify(user.uid);
  await ctx.reply(
    `⚙️ <b>Хабарландырулар</b>\n\n` +
      `Телеграмда қабылдау: ${enabled ? '🟢 қосылған' : '⛔ өшірілген'}\n\n` +
      `<i>Хабарландыру: жаңа заказ, статус, тикет.</i>`,
    withKB(
      Markup.inlineKeyboard([
        [
          Markup.button.callback(enabled ? '⛔ Өшіру' : '✅ Қосу', 'notif:toggle'),
          Markup.button.callback('⬅ Мәзір', 'menu'),
        ],
      ]),
      { parse_mode: 'HTML' }
    )
  );
}

bot.action('notif:toggle', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await requireUser(ctx);
  if (!user) return;
  const cur = await settings.getTelegramNotify(user.uid);
  await settings.setTelegramNotify(user.uid, !cur);
  await ctx.reply(!cur ? '🔔 <b>Хабарландырулар қосы.</b>' : '🔕 Хабарландырулар өшірілді.', { parse_mode: 'HTML' });
});

// ── Phone contact (verification) ────────────────────────────────────────────
bot.on('contact', async (ctx) => {
  try {
    const contact = ctx.message.contact;
    const chatId = chatIdOf(ctx);
    if (!contact?.phone_number) return ctx.reply('Телефон нөмірі алынбады. Қайта көріңіз.');
    const linkSnap = await db.collection('telegram_links').doc(chatId).get();
    if (!linkSnap.exists)
      return ctx.reply('Байланыс табылмады. Сайттағы «Телеграмға қосу» түймесін басып бастаңыз.');
    const siteUserId = linkSnap.data().siteUserId;
    const phone = normalizePhone(contact.phone_number);
    await db.collection('users').doc(siteUserId).set(
      {
        phone,
        isVerified: true,
        telegramChatId: chatId,
        telegramNotify: true,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await ctx.reply('✅ <b>Телефон нөмірі сәтті расталды!</b>', { parse_mode: 'HTML' });
    await showMenu(ctx, '🎉 <b>Бас мәзір:</b>');
  } catch (err) {
    console.error('contact handler error:', err);
    await ctx.reply('Қате орын алды. Қайта көріңіз.').catch(() => {});
  }
});

function normalizePhone(raw) {
  let phone = String(raw || '').replace(/[^\d+]/g, '');
  if (phone.startsWith('+')) return phone;
  if (phone.startsWith('8') && phone.length === 11) return '+7' + phone.slice(1);
  if (phone.length === 10) return '+7' + phone;
  return phone;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── HTTP server; webhook or polling ─────────────────────────────────────
const server = createServer((req, res) => {
  // CORS for /api/* endpoints called by the web app from a browser origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, X-Caption');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`ok ${VERSION}`);
    return;
  }
  if (PUBLIC_URL && req.url === '/webhook' && req.method === 'POST') {
    bot.webhookCallback('/webhook')(req, res);
    return;
  }
  if (req.url === '/api/upload' && req.method === 'POST') {
    handleUpload(req, res).catch((err) => {
      console.error('[upload] error:', err?.message || err);
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'internal' }));
      }
    });
    return;
  }
  if (req.url === '/api/image-backup' && req.method === 'POST') {
    handleImageBackup(req, res).catch((err) => {
      console.warn('[backup] handler error:', err.message);
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sent: false, error: 'internal' }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB per image

async function readRawBody(req, limit = MAX_UPLOAD_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const err = new Error('file_too_large');
      err.name = 'FileTooLarge';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * POST /api/upload — primary image upload for the site.
 * Body: raw image bytes (Content-Type set by the client).
 * Returns: { ok:true, url, key } where `url` is the public Cloudflare-Cache
 * delivery link stored in Firestore. Forwards a backup copy to the configured
 * Telegram channel when available. R2/Telegram credentials never leave the
 * server environment.
 */
async function handleUpload(req, res) {
  const sendJson = (payload, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const contentType = req.headers['content-type'] || 'image/jpeg';
  const name = String(req.headers['x-file-name'] || '').slice(0, 255);
  const caption = String(req.headers['x-caption'] || '').slice(0, 1024);

  let buffer;
  try {
    buffer = await readRawBody(req);
  } catch (err) {
    return sendJson({ ok: false, error: err.name === 'FileTooLarge' ? 'file_too_large' : 'read_failed' });
  }
  if (!buffer.length) {
    return sendJson({ ok: false, error: 'empty_body' });
  }

  if (!r2Configured()) {
    console.warn('[upload] R2 is not configured on this server');
    return sendJson({ ok: false, error: 'storage_not_configured' }, 503);
  }

  let uploaded;
  try {
    uploaded = await uploadToR2({ buffer, name, contentType });
  } catch (err) {
    console.error('[upload] R2 put failed:', err?.name, err?.message);
    // Diagnostic: AWS SDK errors leak no credentials (bucket/endpoint hints only).
    return sendJson({ ok: false, error: 'r2_put_failed', detail: String(err?.message ?? err).slice(0, 300) });
  }
  console.log(`[upload] stored → ${uploaded.key}`);

  // Backup copy to Telegram (best-effort; never breaks the site).
  if (BACKUP_CHANNEL) {
    try {
      await bot.telegram.sendPhoto(BACKUP_CHANNEL, {
        source: Buffer.from(buffer),
        filename: name || `backup_${Date.now()}.jpg`,
      }, {
        caption: caption ? escapeHtml(caption) : undefined,
        parse_mode: caption ? 'HTML' : undefined,
      });
      console.log(`[upload] backup photo → ${BACKUP_CHANNEL}`);
    } catch (err) {
      console.warn(`[upload] telegram backup failed:`, err.message);
    }
  }

  return sendJson({ ok: true, url: uploaded.url, key: uploaded.key });
}

/**
 * POST /api/image-backup — receives { url, caption } from the site and forwards
 * the image to the backup Telegram channel. The Telegram bot token is never
 * exposed to the client; the bot simply downloads the Cloudinary URL and posts
 * it to the channel. Always answers 200 so a Telegram failure never breaks the
 * site's upload flow.
 */
async function handleImageBackup(req, res) {
  const sendJson = (payload) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const data = await readJsonBody(req);
  const url = typeof data?.url === 'string' ? data.url.trim() : '';
  const caption = typeof data?.caption === 'string' ? data.caption.slice(0, 1024) : '';

  if (!/^https?:\/\//i.test(url)) {
    return sendJson({ ok: false, sent: false, error: 'bad_url' });
  }
  if (!BACKUP_CHANNEL) {
    return sendJson({ ok: true, sent: false, error: 'no_channel' });
  }

  try {
    // Send the image to the channel. Downstream (input) always ignoring:
    // if this fails we simply log and still report ok:true to the caller.
    await bot.telegram.sendPhoto(BACKUP_CHANNEL, url, {
      caption: caption ? escapeHtml(caption) : undefined,
      parse_mode: caption ? 'HTML' : undefined,
    });
    console.log(`[backup] photo forwarded → ${BACKUP_CHANNEL}: ${caption || url}`);
    sendJson({ ok: true, sent: true });
  } catch (err) {
    console.warn(`[backup] sendPhoto failed:`, err.message);
    sendJson({ ok: true, sent: false, error: 'telegram' });
  }
}

async function start() {
  // Startup diagnostics — make it obvious in Render logs what is running.
  console.log(`[boot] mode=${PUBLIC_URL ? 'webhook' : 'polling'} port=${PORT} publicUrl=${PUBLIC_URL || '(none)'}`);
  console.log(
    `[boot] firebase=${process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? 'env:FIREBASE_SERVICE_ACCOUNT_JSON' : process.env.GOOGLE_APPLICATION_CREDENTIALS ? `env:GOOGLE_APPLICATION_CREDENTIALS=${process.env.GOOGLE_APPLICATION_CREDENTIALS}` : 'serviceAccountKey.json (project root)'}`
  );

  server.listen(PORT, () => console.log(`Saty Telegram bot HTTP server listening on :${PORT}`));

  notify.stopRelay();
  notify.startRelay(bot);

  if (PUBLIC_URL) {
    const webhookUrl = `${PUBLIC_URL}/webhook`;
    await bot.telegram.setWebhook(webhookUrl, { secret_token: WEBHOOK_SECRET || undefined, drop_pending_updates: true });
    console.log(`Telegram webhook registered → ${webhookUrl}`);
    return;
  }
  await bot.launch();
  console.log('Saty Telegram bot started (polling).');
}

// Never let a handler error go silently — always log it.
bot.catch((err) => {
  console.error('[bot] unhandled update error:', err?.stack || err);
});

start().catch((err) => {
  console.error('Failed to start bot:', err.message);
  process.exit(1);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully…`);
  notify.stopRelay();
  try {
    await bot.stop(signal);
  } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));