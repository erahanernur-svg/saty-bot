import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import admin from 'firebase-admin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const COLLECTIONS = {
  links: 'telegram_links',
  users: 'users',
  orders: 'orders',
  products: 'products',
  games: 'games',
  notifications: 'notifications',
  sellerStats: 'seller_stats',
  withdraw: 'withdraw_requests',
  tickets: 'support_tickets',
  ticketMessages: 'support_messages',
};

export function loadServiceAccount() {
  const fromEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (fromEnv) return JSON.parse(fromEnv);
  const fromPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.resolve(__dirname, '..', '..', 'serviceAccountKey.json');
  return JSON.parse(readFileSync(fromPath, 'utf8'));
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
}

export const db = admin.firestore();
export const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
export const increment = (n = 1) => admin.firestore.FieldValue.increment(n);

/** Resolve siteUserId for a Telegram chatId, or null if not linked. */
export async function getLinkedUserId(chatId) {
  const snap = await db.collection(COLLECTIONS.links).doc(String(chatId)).get();
  return snap.exists ? snap.data().siteUserId : null;
}

/** Link persistence used by the real-time notification relay. */
export async function getAllLinks() {
  const snap = await db.collection(COLLECTIONS.links).get();
  const map = new Map(); // chatId -> { uid, linkedAt }
  for (const d of snap.docs) {
    const chatId = String(d.data().chatId ?? d.id);
    map.set(chatId, { uid: String(d.data().siteUserId ?? ''), linkedAt: null });
  }
  return map;
}

export async function getUser(uid) {
  if (!uid) return null;
  const snap = await db.collection(COLLECTIONS.users).doc(uid).get();
  return snap.exists ? { uid, ...snap.data() } : null;
}

export async function getSellerStats(uid) {
  const snap = await db.collection(COLLECTIONS.sellerStats).doc(uid).get();
  return snap.exists ? snap.data() : null;
}

/**
 * Find a user by their Telegram @nickname.
 * Looks up the link doc (telegram_links/<chatId>.telegramUsername → siteUserId),
 * fallback: users doc with telegramUsername field.
 */
export async function findUserByNickname(nick) {
  const n = String(nick || '').trim().replace(/^@+/, '').toLowerCase();
  if (!n) return null;
  const links = await db.collection(COLLECTIONS.links).where('telegramUsername', '==', n).limit(3).get();
  for (const d of links.docs) {
    const siteUserId = String(d.data().siteUserId || '');
    if (!siteUserId) continue;
    const u = await getUser(siteUserId);
    if (u?.uid) return u;
  }
  const users = await db.collection(COLLECTIONS.users).where('telegramUsername', '==', n).limit(3).get();
  for (const d of users.docs) {
    return { uid: String(d.id), ...d.data() };
  }
  return null;
}