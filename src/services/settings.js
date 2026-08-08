import { db, COLLECTIONS } from '../db.js';

/**
 * User notification settings stored on the user doc (`notify` map).
 * fields: { telegram: boolean }
 */
export async function setTelegramNotify(uid, enabled) {
  await db.collection(COLLECTIONS.users).doc(String(uid)).update({ telegramNotify: Boolean(enabled) });
}

export async function getTelegramNotify(uid) {
  const { getUser } = await import('../db.js');
  const user = await getUser(uid);
  return Boolean(user?.telegramNotify);
}