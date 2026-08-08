import { db, COLLECTIONS, getAllLinks } from '../db.js';
import { toPlain } from './marketplace.js';

/**
 * Real-time notification relay.
 *
 * Runs on a timer and pushes new Firestore events (orders, messages, support
 * replies, reviews, follows) to the linked Telegram chat. Uses Firestore
 * `createdAt` as a cursor so nothing is sent twice.
 */

const TYPE_EMOJI = {
  order: '📦',
  message: '💬',
  review: '⭐',
  follow: '👥',
  system: '🔔',
};

let botInstance = null;
let timer = null;
let cursor = 0; // last processed createdAt (ms) — in-memory watermark
let notifIdSet = new Set(); // ids seen in this process

export function startRelay(bot, { intervalMs = 15000 } = {}) {
  botInstance = bot;
  // Start from the current time so we never replay old history.
  cursor = Date.now();
  stopRelay();
  timer = setInterval(() => {
    pollOnce().catch((err) => console.warn('[relay] poll error:', err.message));
  }, intervalMs);
  timer.unref?.();
  console.log('[relay] notification relay started.');
  return stopRelay;
}

export function stopRelay() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function pollOnce() {
  const links = await getAllLinks();
  if (!links.size) return;

  const q = db.collection(COLLECTIONS.notifications).orderBy('createdAt', 'desc').limit(60);
  const snap = await q.get();
  if (snap.empty) return;

  const out = [];
  for (const d of snap.docs) {
    const raw = d.data();
    const t = raw.createdAt && typeof raw.createdAt.toDate === 'function' ? raw.createdAt.toDate() : null;
    const rec = { id: d.id, ...toPlain(raw), createdAt: t };
    if (!rec.createdAt) continue;
    if (rec.createdAt.getTime() < cursor - 60000) continue; // skip everything before watermark
    if (notifIdSet.has(rec.id)) continue;

    // Find a chat for this user.
    let targetChat = null;
    for (const [chatId, link] of links.entries()) {
      if (link.uid === rec.userId) {
        targetChat = chatId;
        break;
      }
    }
    if (!targetChat) continue;
    if (rec.userId === rec.fromUserId) continue; // self-events only
    out.push({ chatId: targetChat, rec });
  }

  for (const { chatId, rec } of out) {
    notifIdSet.add(rec.id);
    try {
      const emoji = TYPE_EMOJI[rec.type] ?? '🔔';
      const text = [
        `${emoji} <b>${escapeHtml(rec.title || 'Уведомление')}</b>`,
        escapeHtml(rec.body || ''),
        rec.link ? `\nСайтта: ${escapeHtml(rec.link)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      await botInstance.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      console.warn(`[relay] send to ${chatId} failed:`, err.message);
    }
  }

  // Advance the watermark past the newest doc we processed.
  if (snap.docs.length) {
    const latest = snap.docs[0].data().createdAt;
    if (latest && typeof latest.toDate === 'function') {
      const ms = latest.toDate().getTime();
      if (ms > cursor) cursor = ms;
    }
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}