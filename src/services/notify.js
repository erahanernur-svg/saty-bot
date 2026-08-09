import { db, COLLECTIONS, getAllLinks, getUser, messaging, arrayRemove } from '../db.js';
import { toPlain } from './marketplace.js';

/**
 * Real-time notification relay.
 *
 * Runs on a timer and pushes new Firestore events (orders, messages, support
 * replies, reviews, follows) to the recipient's devices over FCM and, when
 * linked, to the Telegram chat. Uses Firestore `createdAt` as a cursor so
 * nothing is sent twice; the cursor is persisted between restarts so events
 * that occurred while the process was down are still delivered.
 */

const TYPE_EMOJI = {
  order: '📦',
  message: '💬',
  review: '⭐',
  follow: '👥',
  system: '🔔',
};

// Where the watermark is persisted (Firestore doc, so it survives restarts).
const CURSOR_DOC = 'relay_state';
const CURSOR_FIELD = 'cursorMs';

let botInstance = null;
let timer = null;
let cursor = 0; // last processed createdAt (ms) — persisted watermark
let notifIdSet = new Set(); // ids seen in this process

async function loadCursor() {
  try {
    const doc = await db.collection('system').doc(CURSOR_DOC).get();
    if (doc.exists && typeof doc.data()?.cursorMs === 'number') {
      return doc.data().cursorMs;
    }
  } catch {}
  return Date.now();
}

async function persistCursor(ms) {
  try {
    await db.collection('system').doc(CURSOR_DOC).set({ cursorMs: ms, updatedAt: new Date() }, { merge: true });
  } catch {}
}

export async function startRelay(bot, { intervalMs = 5000 } = {}) {
  botInstance = bot;
  // Resume from the persisted watermark; fall back to "now" on first run so we
  // never replay months of history.
  cursor = await loadCursor();
  stopRelay();
  timer = setInterval(() => {
    pollOnce().catch((err) => console.warn('[relay] poll error:', err.message));
  }, intervalMs);
  timer.unref?.();
  console.log(`[relay] notification relay started (interval ${intervalMs}ms, cursor from storage).`);
  return stopRelay;
}

export function stopRelay() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function pollOnce() {
  // Notification relay is user-scoped, so it must run even if nobody has a
  // linked Telegram chat — FCM pushes don't depend on the bot link.
  const links = await getAllLinks();

  const q = db.collection(COLLECTIONS.notifications).orderBy('createdAt', 'desc').limit(200);
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
    if (rec.userId === rec.fromUserId) continue; // self-events only
    out.push(rec);
  }

  for (const rec of out) {
    notifIdSet.add(rec.id);

    // 1) FCM push to the recipient's registered devices (native APK).
    await pushToUser(rec.userId, {
      title: rec.title || 'Saty',
      body: rec.body || '',
      type: rec.type || '',
      link: rec.link || '',
      notifId: rec.id,
    });

    // 2) Telegram relay (existing behaviour) to the user's linked chat.
    let targetChat = null;
    for (const [chatId, link] of links.entries()) {
      if (link.uid === rec.userId) {
        targetChat = chatId;
        break;
      }
    }
    if (!targetChat) continue;
    try {
      const emoji = TYPE_EMOJI[rec.type] ?? '🔔';
      const text = [
        `${emoji} <b>${escapeHtml(rec.title || 'Уведомление')}</b>`,
        escapeHtml(rec.body || ''),
        rec.link ? `\nСайтта: ${escapeHtml(rec.link)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      await botInstance.telegram.sendMessage(targetChat, text, { parse_mode: 'HTML' });
    } catch (err) {
      console.warn(`[relay] send to ${targetChat} failed:`, err.message);
    }
  }

  // Advance the watermark past the newest doc we processed — and persist it so
  // a restart (or Render sleeping) never loses events in the gap.
  if (snap.docs.length) {
    const latest = snap.docs[0].data().createdAt;
    if (latest && typeof latest.toDate === 'function') {
      const ms = latest.toDate().getTime();
      if (ms > cursor) {
        cursor = ms;
        persistCursor(ms).catch(() => {});
      }
    }
  }
}

/**
 * Send an FCM push to every registered device of a user.
 * Uses tokens from `users/{uid}.fcmTokens` and prunes ones Firebase rejects
 * as unregistered so they don't accumulate.
 */
async function pushToUser(userId, { title, body, type, link, notifId }) {
  const user = await getUser(userId).catch(() => null);
  const tokens = Array.isArray(user?.fcmTokens) ? user.fcmTokens.filter(Boolean).slice(0, 100) : [];
  if (!tokens.length) return;

  const message = {
    data: { type, link, notifId, title, body },
    android: {
      priority: 'high',
      notification: {
        channelId: 'saty_messages',
        notificationPriority: 'high',
        sound: 'default',
        color: '#6366f1',
      },
    },
  };

  try {
    const resp = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'saty_messages',
          notificationPriority: 'high',
          sound: 'default',
          color: '#6366f1',
        },
      },
      data: message.data,
    });

    if (resp.failureCount > 0) {
      const dead = [];
      resp.responses.forEach((r, i) => {
        if (r.error) {
          const code = String(r.error.code ?? '');
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-argument') {
            dead.push(tokens[i]);
          }
        }
      });
      if (dead.length) {
        console.warn(`[relay] pruning ${dead.length} dead FCM token(s) for ${userId}`);
        await db
          .collection(COLLECTIONS.users)
          .doc(String(userId))
          .update({ fcmTokens: arrayRemove(...dead) })
          .catch(() => {});
      }
    }
  } catch (err) {
    console.warn(`[relay] FCM push to ${userId} failed:`, err.message);
  }
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}