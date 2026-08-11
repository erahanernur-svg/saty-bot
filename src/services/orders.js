// Saty order auto-resolution + admin arbitration.
//
// Timeline (escrow):
//   paid  (buyer paid, await seller delivery)  → deadline = createdAt  + 36h
//                                                if seller never delivers:
//                                                refund buyer + cancel + re-list account
//   processing (seller delivered, await confirm) → deadline = deliveredAt + 36h
//                                                if buyer never confirms:
//                                                release money to seller + complete
//
// The deadline is always computed from trusted server timestamps (createdAt /
// deliveredAt), never from a client-supplied field, so a client can't shorten
// it. The auto-resolver (watchdog in bot.js) runs every minute; a human admin
// can also resolve any stuck order via POST /api/orders/resolve.

import { db, COLLECTIONS, serverTimestamp, increment } from '../db.js';
import admin from 'firebase-admin';

export const AUTO_RESOLVE_HOURS = Number(process.env.ORDER_AUTO_RESOLVE_HOURS) || 36;
const AUTO_RESOLVE_MS = AUTO_RESOLVE_HOURS * 3600 * 1000;

const ADMIN_NAME = 'Админ';
const SYS_PREFIX = '🤖';

/** Buyers/sellers automatically get the primary site admin in the dispute window. */
export async function resolvePrimaryAdmin() {
  const snap = await db.collection('admins').limit(1).get();
  return snap.docs[0]?.id || null;
}

/** Trusted deadline for the current escrow stage, or null outside escrow. */
export function orderDeadline(order) {
  if (!order) return null;
  if (order.status === 'paid' && order.createdAt) {
    const t = typeof order.createdAt.toDate === 'function' ? order.createdAt.toDate().getTime() : new Date(order.createdAt).getTime();
    return t + AUTO_RESOLVE_MS;
  }
  if (order.status === 'processing' && order.deliveredAt) {
    const t =
      typeof order.deliveredAt.toDate === 'function'
        ? order.deliveredAt.toDate().getTime()
        : new Date(order.deliveredAt).getTime();
    return t + AUTO_RESOLVE_MS;
  }
  return null;
}

const toMs = (v) =>
  v && typeof v.toDate === 'function'
    ? v.toDate().getTime()
    : v instanceof Date
      ? v.getTime()
      : typeof v === 'number'
        ? v
        : new Date(v ?? 0).getTime() || 0;

/** The order's marketplace conversation (orderId === order.id), or null. */
async function findOrderConversation(orderId) {
  if (!orderId) return null;
  const snap = await db.collection('conversations').where('orderId', '==', String(orderId)).limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
}

/**
 * Post a system message into the order conversation as the admin (or the
 * primary admin when none is present yet). Best-effort; never throws.
 */
async function postOrderMessage(conv, text) {
  if (!conv) return;
  if (!conv.data.participants || conv.data.participants.length < 2) return;
  const adminUid = String(conv.data.adminId || (await resolvePrimaryAdmin()) || '');
  const senderId = adminUid || 'system';
  const senderName = adminUid ? ADMIN_NAME : SYS_PREFIX;
  const preview = String(text).slice(0, 80);
  const unreadCounts = { ...(conv.data.unreadCounts || {}) };
  for (const u of conv.data.participants) {
    if (String(u) !== senderId) unreadCounts[String(u)] = Number(unreadCounts[String(u)] || 0) + 1;
  }
  try {
    await db.collection('conversations').doc(conv.id).update({
      lastMessage: preview,
      lastMessageAt: serverTimestamp(),
      lastMessageSenderId: senderId,
      unreadCounts,
    });
    await db.collection('messages').add({
      conversationId: conv.id,
      senderId,
      senderName,
      senderAvatar: '',
      text,
      read: false,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('[orders] system message failed:', err.message);
  }
}

/** Write a bell notification for a site user (FCM + Telegram relay pick it up). */
async function notifyUser(userId, fromUserId, type, title, body) {
  try {
    await db.collection(COLLECTIONS.notifications).add({
      userId: String(userId),
      fromUserId: String(fromUserId || 'system'),
      type,
      title,
      body,
      link: '',
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('[orders] notification failed:', err.message);
  }
}

/**
 * Refund a stuck 'paid' order: money back to the buyer, order cancelled, and
 * the product re-listed so the seller can sell it again. Transaction re-reads
 * the order so it's idempotent (double-run safe).
 */
export async function refundOrder(orderId) {
  const ref = db.collection(COLLECTIONS.orders).doc(String(orderId));
  const outcome = { refunded: false, cancelled: false, productId: null };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const order = snap.data();
    // Only the awaiting-delivery stage can be auto/cancelled with a refund.
    if (order.status !== 'paid') return;
    tx.set(db.collection(COLLECTIONS.users).doc(String(order.buyerId)), { balance: increment(Number(order.price) || 0) }, { merge: true });
    tx.set(ref, { status: 'cancelled', updatedAt: serverTimestamp() }, { merge: true });
    outcome.refunded = true;
    outcome.cancelled = true;
    outcome.productId = String(order.productId || '');
  });

  // Re-list the account (if it was sold). Server write bypasses client rules.
  if (outcome.productId) {
    try {
      await db.collection(COLLECTIONS.products).doc(outcome.productId).update({
        status: 'active',
        soldOrderId: null,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('[orders] re-list product failed:', err.message);
    }
  }
  return outcome;
}

/**
 * Complete a stuck 'processing' order: release the held price to the seller.
 * Transaction re-reads the order so it's idempotent.
 */
export async function completeOrder(orderId) {
  const ref = db.collection(COLLECTIONS.orders).doc(String(orderId));
  const outcome = { completed: false };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const order = snap.data();
    if (order.status !== 'processing') return;
    tx.set(db.collection(COLLECTIONS.users).doc(String(order.sellerId)), { balance: increment(Number(order.price) || 0) }, { merge: true });
    tx.set(ref, { status: 'completed', updatedAt: serverTimestamp() }, { merge: true });
    outcome.completed = true;
  });
  return outcome;
}

/** Resolve a stuck order together with chat + notification side-effects. */
async function resolveStuckOrder(order) {
  const orderId = String(order.id ?? '');
  const conv = await findOrderConversation(orderId);

  if (order.status === 'paid') {
    const res = await refundOrder(orderId);
    if (!res.refunded) return { skipped: true };
    const price = Number(order.price) || 0;
    await postOrderMessage(
      conv,
      `🕒 36 сағат ішінде жеткізілмеді — тапсырыс автоматты түрде бұзылды, ақша сатып алушыға қайтарылды (${price.toLocaleString('ru-RU')} ₸). Сатушы аккаунтты қайта сатылымға шығара алады.`
    );
    await notifyUser(
      order.buyerId,
      order.sellerId,
      'refund',
      '⛔ Тапсырыс бұзылды',
      `Сатушы ${AUTO_RESOLVE_HOURS} сағат ішінде жеткізбегендіктен, тапсырыс автоматты түрде бұзылды. ${price.toLocaleString('ru-RU')} ₸ сатып алушыға қайтарылды.`
    );
    await notifyUser(
      order.sellerId,
      order.buyerId,
      'order_cancelled',
      'Тапсырыс бұзылды',
      `Сатып алушыға ақша қайтарылды. Аккаунтыңыз сатылымға қайта шығарылды.`
    );
    return res;
  }

  if (order.status === 'processing') {
    const res = await completeOrder(orderId);
    if (!res.completed) return { skipped: true };
    const price = Number(order.price) || 0;
    await postOrderMessage(
      conv,
      `🕒 Сатып алушы ${AUTO_RESOLVE_HOURS} сағат ішінде растамады — тапсырыс автоматты түрде аяқталды, ақша сатушыға аударылды (${price.toLocaleString('ru-RU')} ₸).`
    );
    await notifyUser(
      order.sellerId,
      order.buyerId,
      'order_completed',
      '✅ Тапсырыс аяқталды',
      `Сатып алушы ${AUTO_RESOLVE_HOURS} сағат ішінде растамады. ${price.toLocaleString('ru-RU')} ₸ сатушыға аударылды.`
    );
    await notifyUser(
      order.buyerId,
      order.sellerId,
      'order_completed',
      'Тапсырыс аяқталды',
      `Растау мерзімі өткендіктен, тапсырыс автоматты түрде аяқталды және ақша сатушыға аударылды.`
    );
    return res;
  }

  return { skipped: true };
}

/**
 * Watchdog body: scans every open escrow order and resolves the ones whose
 * stage deadline (36h) has passed. Called on an interval from bot.js.
 */
export async function autoResolveStuckOrders() {
  const now = Date.now();
  let due = [];
  for (const status of ['paid', 'processing']) {
    const snap = await db.collection(COLLECTIONS.orders).where('status', '==', status).get();
    for (const d of snap.docs) {
      const order = { id: d.id, ...d.data() };
      const deadline = orderDeadline(order);
      if (deadline && deadline <= now) due.push(order);
    }
  }
  for (const order of due) {
    try {
      const r = await resolveStuckOrder(order);
      if (!r.skipped) console.log(`[orders] auto-resolved ${order.id} (${order.status})`);
    } catch (err) {
      console.error(`[orders] auto-resolve failed ${order.id}:`, err.message);
    }
  }
  return due.length;
}

// ── Admin arbitration via HTTP ──────────────────────────────────────────────

async function verifyToken(token) {
  if (!token || typeof token !== 'string') throw new Error('token_required');
  const decoded = await admin.auth().verifyIdToken(token);
  if (!decoded?.uid) throw new Error('invalid_token');
  return decoded;
}

async function isSiteAdmin(uid) {
  const snap = await db.collection('admins').doc(String(uid)).get();
  return snap.exists === true;
}

/**
 * POST /api/orders/resolve — admin intervenes on a stuck order.
 * Body: { token, orderId, action: 'refund' | 'complete' }.
 */
export async function resolveOrderByAdmin({ token, orderId, action }) {
  const decoded = await verifyToken(token);
  const adminUid = decoded.uid;
  if (action !== 'refund' && action !== 'complete') throw new Error('invalid_action');
  if (!(await isSiteAdmin(adminUid))) throw new Error('forbidden');

  const orderRef = db.collection(COLLECTIONS.orders).doc(String(orderId));
  const snap = await orderRef.get();
  if (!snap.exists) throw new Error('not_found');
  const order = { id: orderRef.id, ...snap.data() };
  const conv = await findOrderConversation(String(orderId));
  const price = Number(order.price) || 0;
  const buyerUid = String(order.buyerId || '');
  const sellerUid = String(order.sellerId || '');

  if (action === 'refund') {
    const res = await refundOrder(String(orderId));
    if (!res.refunded) throw new Error('already_resolved');
    await postOrderMessage(
      conv,
      `🛠️ Админ араласты: тапсырыс бұзылды, ақша сатып алушыға қайтарылды (${price.toLocaleString('ru-RU')} ₸). Сатушы аккаунтты қайта сатылымға шығара алады.`
    );
    await notifyUser(buyerUid, adminUid, 'refund', '⛔ Тапсырыс бұзылды', `Админ қалып жағдайды тоқтатты. ${price.toLocaleString('ru-RU')} ₸ сатып алушыға қайтарылды.`);
    await notifyUser(sellerUid, adminUid, 'order_cancelled', 'Тапсырыс бұзылды', `Аккаунтыңыз сатылымға қайта шығарылды.`);
    return { ok: true, action, status: 'cancelled' };
  }

  const res = await completeOrder(String(orderId));
  if (!res.completed) throw new Error('already_resolved');
  await postOrderMessage(
    conv,
    `🛠️ Админ араласты: тапсырыс аяқталды, ${price.toLocaleString('ru-RU')} ₸ сатушыға аударылды.`
  );
  await notifyUser(sellerUid, adminUid, 'order_completed', '✅ Тапсырыс аяқталды', `${price.toLocaleString('ru-RU')} ₸ сатушыға аударылды.`);
  await notifyUser(buyerUid, adminUid, 'order_completed', 'Тапсырыс аяқталды', `Админ тапсырысты аяқтады, ақша сатушыға аударылды.`);
  return { ok: true, action, status: 'completed' };
}

/** Human-friendly error codes for the HTTP handler. */
export function isKnownResolveError(msg) {
  return ['token_required', 'invalid_token', 'forbidden', 'invalid_action', 'not_found', 'already_resolved'].includes(msg);
}