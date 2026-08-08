import { doc, updateDoc } from 'firebase-admin/firestore';
import { db, COLLECTIONS } from '../db.js';

/**
 * User notification settings stored on the user doc (`notify` map).
 * fields: { telegram: boolean }
 */
export async function setTelegramNotify(uid, enabled) {
  await updateDoc(doc(db, COLLECTIONS.users, uid), { telegramNotify: Boolean(enabled) });
}

export async function getTelegramNotify(uid) {
  const { getUser } = await import('../db.js');
  const user = await getUser(uid);
  return Boolean(user?.telegramNotify);
}