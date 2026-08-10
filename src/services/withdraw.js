// Saty Kaspi withdrawal service.
//
// Mirrors the top-up service: the web app CANNOT touch balances directly
// (Firestore rules forbid client writes), so all money movement goes through
// this trusted HTTP service:
//
//   POST /api/withdraw/create  { token, amount, kaspiName, kaspiPhone }
//     • Verifies the Firebase ID token of the authenticated web user.
//     • Reads the user's real profile (name/email/phone) from Firestore —
//       never trusts anything except the amount + Kaspi details.
//     • Atomically (transaction) reserves `amount` from the user's balance and
//       writes a pending `withdrawRequests` doc with the fee + net amount.
//
//   POST /api/withdraw/review  { token, requestId, action, note }
//     • Verifies the caller is an admin (admins/<uid>).
//     • Atomically (transaction) marks the request completed|rejected.
//       Double-processing is impossible because the transaction re-reads the
//       status. Rejection refunds the reserved amount back to the balance.
//     • Writes a `transactions` history record + `balance_ops` audit rows and
//       notifies the user (relay → FCM + linked Telegram + "Админ" chat).
//
// The commission is ALWAYS computed here server-side:
//   500 – 9 999 ₸     → 10%
//   10 000 ₸ and up   → 7%

import { db, COLLECTIONS, serverTimestamp, increment, getUser } from '../db.js';
import admin from 'firebase-admin';
import { postAdminChatMessage, resolvePrimaryAdmin } from './topup.js';

const WITHDRAWS = 'withdrawRequests';
const TRANSACTIONS = 'transactions';

const MIN_WITHDRAW = Math.max(1, Number(process.env.WITHDRAW_MIN_AMOUNT) || 500);
const MAX_WITHDRAW = Number(process.env.WITHDRAW_MAX_AMOUNT) || 10_000_000;
const MAX_PENDING = Number(process.env.WITHDRAW_MAX_PENDING) || 10;

/** Commission + net amount for a withdrawal. Server is the single source of truth. */
export function calcWithdrawFee(amount) {
  const pct = amount < 10000 ? 0.1 : 0.07;
  const fee = Math.floor(amount * pct);
  return { fee, netAmount: amount - fee, pct };
}

/** Normalize a Kazakh phone number to canonical +7XXXXXXXXXX form. */
export function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('7') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.length === 10) return `+7${digits}`;
  return '';
}

function makeWithdrawId() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, '0');
  return `WD-${rand}`;
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

/** Newest Telegram link for a site user (used by the relay → Telegram). */
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
    telegramUsername: data.telegramUsername || data.username || null,
    telegramFirstName: null,
  };
}

function notifyDoc(userId, fromUserId, type, title, body, link = '') {
  return { userId: String(userId), fromUserId: String(fromUserId), type, title, body, link, createdAt: serverTimestamp() };
}

/**
 * Create a pending Kaspi withdrawal request.
 * Reserves `amount` from the user's balance atomically and stores the request
 * with the server-computed fee and net amount.
 */
export async function createWithdrawRequest({ token, amount, kaspiName, kaspiPhone }) {
  const decoded = await verifyToken(token);
  const uid = decoded.uid;
  const amt = Number(amount);
  const kName = String(kaspiName || '').trim().slice(0, 64);
  const phone = normalizePhone(kaspiPhone);

  if (!Number.isInteger(amt) || !(amt >= MIN_WITHDRAW) || !(amt <= MAX_WITHDRAW)) {
    throw new Error('invalid_amount');
  }
  if (!kName) throw new Error('invalid_kaspi_name');
  if (!phone) throw new Error('invalid_phone');

  const user = (await getUser(uid)) || {};

  // Atomic reserve: only proceed if the current balance covers the amount.
  const { fee, netAmount } = calcWithdrawFee(amt);
  const withdrawalId = makeWithdrawId();
  const userRef = db.collection(COLLECTIONS.users).doc(uid);
  const reqRef = db.collection(WITHDRAWS).doc();

  try {
    await db.runTransaction(async (tx) => {
      const uSnap = await tx.get(userRef);
      if (!uSnap.exists) throw new Error('user_not_found');
      const bal = Number(uSnap.data().balance ?? 0);
      if (bal < amt) throw new Error('insufficient_balance');

      const pendingSnap = await tx.get(
        db.collection(WITHDRAWS).where('userId', '==', uid)
      );
      const pendingCount = pendingSnap.docs.filter((d) => d.data().status === 'pending').length;
      if (pendingCount >= MAX_PENDING) throw new Error('too_many_pending');

      tx.update(userRef, { balance: increment(-amt) });
      tx.set(reqRef, {
        withdrawalId,
        userId: uid,
        userEmail: decoded.email || user.email || '',
        userPhone: user.phone || '',
        userName: user.displayName || user.nickname || 'Пайдаланушы',
        kaspiName: kName,
        kaspiPhone: phone,
        amount: amt,
        fee,
        pct: Math.round((fee / amt) * 100),
        netAmount,
        status: 'pending',
        reviewedAt: null,
        reviewedBy: '',
        adminNote: '',
        telegramUserId: '',
        telegramUsername: '',
        createdAt: serverTimestamp(),
      });
    });
  } catch (err) {
    if (['user_not_found', 'insufficient_balance', 'too_many_pending', 'invalid_amount'].includes(err.message)) throw err;
    throw new Error('tx_failed');
  }

  // Audit: the reservation (debit) is recorded server-side.
  await db.collection('balance_ops').add({
    uid,
    amount: amt,
    direction: 'debit',
    note: `Kaspi withdrawal reserved ${withdrawalId}`,
    createdAt: serverTimestamp(),
  });

  const link = await getTelegramLink(uid);

  // Notify the requester (relay → FCM + linked Telegram).
  await db.collection(COLLECTIONS.notifications).add(
    notifyDoc(
      uid,
      'saty_withdraw',
      'withdraw',
      'Ақша шығару өтінімі қабылданды',
      `Өтінім қабылданды. Ақшаңыз 1–2 сағат ішінде Kaspi-ге түседі. Түспесе әкімшіге жазыңыз.\n\n${kName} · ${phone}\nСома: ${amt.toLocaleString('ru-RU')} ₸\nКомиссия: ${fee.toLocaleString('ru-RU')} ₸\nKaspi-ге: ${netAmount.toLocaleString('ru-RU')} ₸\nID: ${withdrawalId}`,
      ''
    )
  );

  // Open/update the "Админ" chat with the pending state.
  const primaryAdmin = await resolvePrimaryAdmin().catch(() => null);
  if (primaryAdmin) {
    await postAdminChatMessage({
      userUid: uid,
      userName: user.displayName || user.nickname || '',
      adminUid: primaryAdmin,
      text: `⏳ Ақша шығару өтінімі келді: ${kName} · ${phone} — ${amt.toLocaleString('ru-RU')} ₸ (комиссия ${fee.toLocaleString('ru-RU')} ₸, Kaspi-ге ${netAmount.toLocaleString('ru-RU')} ₸).\nАқшаны Kaspi арқылы жіберген соң «Ақшаны жібердім» деп растаңыз.`,
    }).catch((err) => console.warn('[withdraw] admin chat message failed:', err.message));
  }

  // Notify every admin (bell + Telegram if linked).
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
          'withdraw',
          'Жаңа ақша шығару',
          `Пайдаланушы: ${user.displayName || user.nickname || '—'}\nTelegram: ${link?.telegramUsername ? `@${link.telegramUsername}` : link?.telegramUserId || '—'}\nKaspi аты: ${kName}\nKaspi нөмірі: ${phone}\nСома: ${amt.toLocaleString('ru-RU')} ₸\nКомиссия: ${fee.toLocaleString('ru-RU')} ₸\nKaspi-ге: ${netAmount.toLocaleString('ru-RU')} ₸\nID: ${withdrawalId}`,
          ''
        )
      );
    }
    await batch.commit();
  } catch (err) {
    console.warn('[withdraw] admin notification failed:', err.message);
  }

  return { ok: true, id: reqRef.id, withdrawalId, fee, netAmount, status: 'pending' };
}

/**
 * Admin completes ('complete') or rejects ('reject') a withdrawal.
 * - complete: user already received the money via Kaspi (sent manually by the
 *   admin). The reserved amount stays out of the balance.
 * - reject:   refund the reserved amount back into the user's balance.
 * Atomic + double-processing safe (transaction re-reads status).
 */
export async function reviewWithdrawRequest({ token, requestId, action, note }) {
  const decoded = await verifyToken(token);
  const adminUid = decoded.uid;
  if (action !== 'complete' && action !== 'reject') throw new Error('invalid_action');
  if (!(await isSiteAdmin(adminUid))) throw new Error('forbidden');

  const ref = db.collection(WITHDRAWS).doc(String(requestId));
  let req = null;
  let finalized = false;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('not_found');
      req = snap.data();
      if (req.status !== 'pending') throw new Error('already_reviewed');

      const updates = {
        status: action === 'complete' ? 'completed' : 'rejected',
        reviewedAt: serverTimestamp(),
        reviewedBy: adminUid,
        adminNote: String(note || '').slice(0, 500),
      };
      tx.update(ref, updates);

      if (action === 'reject') {
        // Refund the reserved amount back into the balance.
        tx.update(db.collection(COLLECTIONS.users).doc(String(req.userId)), {
          balance: increment(Number(req.amount) || 0),
        });
      }
      finalized = true;
    });
  } catch (err) {
    if (['not_found', 'already_reviewed'].includes(err.message)) throw err;
    throw new Error('tx_failed');
  }

  const outcome = req.withdrawalId || req.id || String(requestId);
  const amt = Number(req.amount) || 0;
  const fee = Number(req.fee) || 0;
  const net = Number(req.netAmount) || 0;
  const userRef = db.collection(COLLECTIONS.users).doc(String(req.userId));
  const chatAdmin = req.assignedAdmin || adminUid;

  if (finalized && action === 'complete') {
    await db.collection(TRANSACTIONS).add({
      userId: String(req.userId),
      amount: net,
      type: 'withdrawal',
      method: 'kaspi',
      status: 'completed',
      refId: outcome,
      reviewer: adminUid,
      note: String(note || '').slice(0, 500),
      createdAt: serverTimestamp(),
    });
    await db.collection(COLLECTIONS.notifications).add(
      notifyDoc(
        req.userId,
        adminUid,
        'withdraw',
        'Ақша жіберілді',
        `✅ Ақшаңыз жіберілді. Kaspi шотыңызды тексеріңіз.\n\n${req.kaspiName || ''} · ${req.kaspiPhone || ''}\nKaspi-ге: ${net.toLocaleString('ru-RU')} ₸\nID: ${outcome}`,
        ''
      )
    );
    await postAdminChatMessage({
      userUid: req.userId,
      userName: req.userName || '',
      adminUid: chatAdmin,
      text: `✅ Ақшаңыз жіберілді: ${net.toLocaleString('ru-RU')} ₸ Kaspi-ге (${outcome}). Шотыңызды тексеріңіз.`,
    }).catch((err) => console.warn('[withdraw] admin chat message failed:', err.message));
  } else if (finalized && action === 'reject') {
    await db.collection('balance_ops').add({
      uid: String(req.userId),
      amount: amt,
      direction: 'credit',
      note: `Kaspi withdrawal refund ${outcome}`,
      createdAt: serverTimestamp(),
    });
    await db.collection(COLLECTIONS.notifications).add(
      notifyDoc(
        req.userId,
        adminUid,
        'withdraw',
        'Ақша шығару расталмады',
        `Ақша шығару өтінімі расталмады (${outcome}). Резервтелген ${amt.toLocaleString('ru-RU')} ₸ балансқа қайтарылды.${note ? `\nСебебі: ${String(note).slice(0, 500)}` : ''}`,
        ''
      )
    );
    await postAdminChatMessage({
      userUid: req.userId,
      userName: req.userName || '',
      adminUid: chatAdmin,
      text: `❌ Ақша шығару расталмады (${outcome}). ${amt.toLocaleString('ru-RU')} ₸ балансқа қайтарылды.${note ? `\nСебебі: ${String(note).slice(0, 500)}` : ''}`,
    }).catch((err) => console.warn('[withdraw] admin chat message failed:', err.message));
  }

  return { ok: true, id: ref.id, status: action === 'complete' ? 'completed' : 'rejected', refunded: action === 'reject' ? amt : 0 };
}