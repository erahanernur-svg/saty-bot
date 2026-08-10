// Saty Kaspi Pay balance top-up service.
//
// The web app cannot touch balances directly (Firestore rules forbid client
// writes), so all money movement goes through this trusted HTTP service:
//
//   POST /api/topup/create  { token, amount }
//     • Verifies the Firebase ID token of the authenticated web user.
//     • Reads the user's real profile (name/phone/telegram) from Firestore —
//       never trusts anything sent from the browser except the amount.
//     • Stores a pending `topUpRequests` doc with the Kaspi payment link.
//
//   POST /api/topup/review  { token, requestId, action, note }
//     • Verifies the caller is an admin (admins/<uid>).
//     • Atomically (transaction) marks the request approved|rejected and, on
//       approval, credits the user's balance. Double-approval is impossible
//       because the transaction re-reads the status.
//     • Writes a `transactions` history record + `balance_ops` audit row and
//       notifies the user (the relay pushes it to the linked Telegram / FCM).

import { db, COLLECTIONS, serverTimestamp, increment, getUser } from '../db.js';
import admin from 'firebase-admin';

const TOPUPS = 'topUpRequests';
const TRANSACTIONS = 'transactions';

const KASPI_LINK = (process.env.KASPI_PAYMENT_LINK || 'https://pay.kaspi.kz/pay/ygupjqip').trim();
const MIN_TOPUP = Math.max(1, Number(process.env.TOPUP_MIN_AMOUNT) || 100);
const MAX_TOPUP = Number(process.env.TOPUP_MAX_AMOUNT) || 500000;
const MAX_PENDING = Number(process.env.TOPUP_MAX_PENDING) || 10;

function isEmpty(s) {
  return s === undefined || s === null || String(s).trim() === '';
}

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

/** Newest Telegram link for a site user (chatId equals the numeric Telegram user id). */
async function getTelegramLink(uid) {
  const snap = await db
    .collection(COLLECTIONS.links)
    .where('siteUserId', '==', String(uid))
    .limit(20)
    .get();
  if (snap.empty) return null;
  const docs = snap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .sort((a, b) => {
      const ta = a.data.linkedAt && typeof a.data.linkedAt.toDate === 'function' ? a.data.linkedAt.toDate().getTime() : 0;
      const tb = b.data.linkedAt && typeof b.data.linkedAt.toDate === 'function' ? b.data.linkedAt.toDate().getTime() : 0;
      return tb - ta;
    });
  const d = docs[0];
  const data = d.data;
  const chatId = String(data.chatId ?? d.id ?? '');
  return {
    telegramUserId: chatId,
    telegramUsername: isEmpty(data.telegramUsername) ? (isEmpty(data.username) ? null : String(data.username).replace(/^@+/, '')) : String(data.telegramUsername).replace(/^@+/, ''),
    telegramFirstName: isEmpty(data.firstName) ? null : String(data.firstName).slice(0, 64),
  };
}

function makeTopUpId() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
  return `TOPUP-${rand}`;
}

function notifyDoc(userId, fromUserId, type, title, body, link = '') {
  return { userId: String(userId), fromUserId: String(fromUserId), type, title, body, link, createdAt: serverTimestamp() };
}

// ── "Админ" chat (1:1 conversation in the Messages tab) ──────────────────────
// Auto-creates/updates a conversation between the user and the primary admin,
// then posts a server-authored message as "Админ". Both sides see it in the
// site/app Messages tab; the user gets an unread badge + bell notification.

const ADMIN_NAME = 'Админ';

export async function resolvePrimaryAdmin() {
  const snap = await db.collection('admins').limit(1).get();
  return snap.docs[0]?.id || null;
}

export async function postAdminChatMessage({ userUid, userName, adminUid, text }) {
  if (!userUid || !adminUid) return;
  const participants = [String(userUid), String(adminUid)].sort();
  const convId = `conv_${participants.join('_')}`;
  const convRef = db.collection('conversations').doc(convId);
  const preview = String(text).slice(0, 80);

  const convSnap = await convRef.get().catch(() => null);
  if (!convSnap || !convSnap.exists) {
    await convRef.set({
      participants,
      participantNames: { [userUid]: String(userName || 'Пайдаланушы').slice(0, 64), [adminUid]: ADMIN_NAME },
      participantAvatars: { [userUid]: '', [adminUid]: '' },
      productId: '',
      productName: '',
      orderId: '',
      lastMessage: preview,
      lastMessageAt: serverTimestamp(),
      lastMessageSenderId: adminUid,
      unreadCounts: { [userUid]: 1, [adminUid]: 0 },
      createdAt: serverTimestamp(),
    });
  } else {
    const conv = convSnap.data() || {};
    const unreadCounts = { ...(conv.unreadCounts || {}) };
    unreadCounts[userUid] = Number(unreadCounts[userUid] || 0) + 1;
    await convRef.update({
      lastMessage: preview,
      lastMessageAt: serverTimestamp(),
      lastMessageSenderId: adminUid,
      unreadCounts,
    });
  }

  await db.collection('messages').add({
    conversationId: convId,
    senderId: adminUid,
    senderName: ADMIN_NAME,
    senderAvatar: '',
    text,
    read: false,
    createdAt: serverTimestamp(),
  });
}

/** Create a pending Kaspi Pay top-up request for an authenticated site user. */
export async function createTopUpRequest({ token, amount, kaspiName }) {
  const decoded = await verifyToken(token);
  const uid = decoded.uid;
  const amt = Number(amount);
  const kName = String(kaspiName || '').trim().slice(0, 64);

  if (!Number.isInteger(amt) || !(amt >= MIN_TOPUP) || !(amt <= MAX_TOPUP)) {
    throw new Error('invalid_amount');
  }

  const user = (await getUser(uid)) || {};
  const pending = await db
    .collection(TOPUPS)
    .where('userId', '==', uid)
    .where('status', '==', 'pending')
    .get();
  if (pending.size >= MAX_PENDING) throw new Error('too_many_pending');

  const link = await getTelegramLink(uid);
  const topUpId = makeTopUpId();
  const primaryAdmin = await resolvePrimaryAdmin().catch(() => null);

  const payload = {
    topUpId,
    userId: uid,
    userEmail: decoded.email || user.email || '',
    userPhone: user.phone || '',
    userName: user.displayName || user.nickname || 'Пайдаланушы',
    kaspiName: kName,
    assignedAdmin: primaryAdmin || '',
    amount: amt,
    currency: 'KZT',
    paymentMethod: 'kaspi_pay',
    kaspiPaymentLink: KASPI_LINK,
    status: 'pending',
    reviewedAt: null,
    reviewedBy: '',
    adminNote: '',
    telegramUserId: link?.telegramUserId || '',
    telegramUsername: link?.telegramUsername || null,
    telegramFirstName: link?.telegramFirstName || null,
    createdAt: serverTimestamp(),
  };
  const ref = await db.collection(TOPUPS).add(payload);

  // Notify the requester (relay → FCM + linked Telegram).
  await db.collection(COLLECTIONS.notifications).add(
    notifyDoc(
      uid,
      'saty_topup',
      'topup',
      '⏳ Толтыру тексеруді күтіп тұр',
      `Kaspi Pay арқылы ${amt.toLocaleString('ru-RU')} ₸ толтыру сұранысы қабылданды және әкімші растауын күтіп тұр.\n\nID: ${topUpId}`,
      ''
    )
  );

  // Open/update the "Админ" chat with the pending state.
  if (primaryAdmin) {
    await postAdminChatMessage({
      userUid: uid,
      userName: user.displayName || user.nickname || '',
      adminUid: primaryAdmin,
      text: `⏳ Толтыру сұранысы қабылданды: ${kName || 'Каспидегі аты көрсетілмеді'} — ${amt.toLocaleString('ru-RU')} ₸ (${topUpId}).\nKaspi арқылы төлеген соң әкімші растайды.`,
    }).catch((err) => console.warn('[topup] admin chat message failed:', err.message));
  }

  // Notify every admin so they can verify the payment in the Kaspi app.
  try {
    const admins = await db.collection('admins').get();
    const batch = db.batch();
    for (const a of admins.docs) {
      if (String(a.id) === uid) continue;
      batch.set(
        db.collection(COLLECTIONS.notifications).doc(),
        notifyDoc(
          a.id,
          uid,
          'topup',
          'Жаңа толтыру',
          `Пайдаланушы: ${payload.userName}\nKaspi аты: ${kName || '—'}\nСома: ${amt.toLocaleString('ru-RU')} ₸\nТелефон: ${payload.userPhone || '—'}\nID: ${topUpId}`,
          ''
        )
      );
    }
    await batch.commit();
  } catch (err) {
    console.warn('[topup] admin notification failed:', err.message);
  }

  return { ok: true, id: ref.id, topUpId, link: KASPI_LINK, status: 'pending' };
}

/** Admin approves or rejects a top-up request. Atomic, double-payment safe.
 *  `amount` (optional, approve only) lets the admin correct the credited sum
 *  to what actually arrived in the Kaspi app (e.g. user wrote 1000, sent 100). */
export async function reviewTopUpRequest({ token, requestId, action, note, amount }) {
  const decoded = await verifyToken(token);
  const adminUid = decoded.uid;
  if (action !== 'approve' && action !== 'reject') throw new Error('invalid_action');
  if (!(await isSiteAdmin(adminUid))) throw new Error('forbidden');

  let override = null;
  if (action === 'approve' && amount !== undefined && amount !== null && amount !== '') {
    override = Number(amount);
    if (!Number.isInteger(override) || override <= 0 || override > MAX_TOPUP) throw new Error('invalid_amount');
  }

  const ref = db.collection(TOPUPS).doc(String(requestId));
  let approved = false;
  let req = null;
  let outcome = '';
  let credited = 0;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('not_found');
      req = snap.data();
      if (req.status !== 'pending') throw new Error('already_reviewed');

      credited = override !== null ? override : Number(req.amount) || 0;
      outcome = req.topUpId || req.id || String(requestId);

      const updates = {
        status: action,
        reviewedAt: serverTimestamp(),
        reviewedBy: adminUid,
        adminNote: String(note || '').slice(0, 500),
      };
      if (action === 'approve' && override !== null) {
        updates.creditedAmount = credited;
        updates.requestedAmount = Number(req.amount) || 0;
      }
      tx.update(ref, updates);

      if (action === 'approve') {
        approved = true;
        tx.set(db.collection(COLLECTIONS.users).doc(String(req.userId)), { balance: increment(credited) }, { merge: true });
      }
    });
  } catch (err) {
    if (err.message === 'already_reviewed' || err.message === 'not_found' || err.message === 'invalid_amount') throw err;
    throw new Error('tx_failed');
  }

  const chatAdmin = req.assignedAdmin || adminUid;
  if (approved) {
    await db.collection(TRANSACTIONS).add({
      userId: String(req.userId),
      amount: credited,
      type: 'deposit',
      method: 'kaspi_pay',
      status: 'completed',
      refId: outcome,
      reviewer: adminUid,
      note: String(note || '').slice(0, 500),
      createdAt: serverTimestamp(),
    });
    await db.collection('balance_ops').add({
      uid: String(req.userId),
      amount: credited,
      direction: 'credit',
      note: `Kaspi Pay top-up ${outcome} by ${adminUid}`,
      createdAt: serverTimestamp(),
    });
    await db.collection(COLLECTIONS.notifications).add(
      notifyDoc(
        req.userId,
        adminUid,
        'topup',
        'Толтыру расталды',
        `Сұранысыңыз ${outcome} расталды. Балансқа ${credited.toLocaleString('ru-RU')} ₸ қосылды.`,
        ''
      )
    );
    await postAdminChatMessage({
      userUid: req.userId,
      userName: req.userName || '',
      adminUid: chatAdmin,
      text: `✅ Толтыру расталды: ${credited.toLocaleString('ru-RU')} ₸ (${outcome}). Балансқа қосылды.`,
    }).catch((err) => console.warn('[topup] admin chat message failed:', err.message));
  } else {
    await db.collection(COLLECTIONS.notifications).add(
      notifyDoc(
        req.userId,
        adminUid,
        'topup',
        'Толтыру расталмады',
        `Сұранысыңыз ${outcome} расталмады${note ? `.\nСебебі: ${String(note).slice(0, 500)}` : ''}.`,
        ''
      )
    );
    await postAdminChatMessage({
      userUid: req.userId,
      userName: req.userName || '',
      adminUid: chatAdmin,
      text: `❌ Толтыру расталмады (${outcome}).${note ? `\nСебебі: ${String(note).slice(0, 500)}` : ''}`,
    }).catch((err) => console.warn('[topup] admin chat message failed:', err.message));
  }

  return { ok: true, id: ref.id, status: action, credited: approved ? credited : 0 };
}