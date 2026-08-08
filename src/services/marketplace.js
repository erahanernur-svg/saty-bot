import {
  query,
  where,
  orderBy,
  limit as qlimit,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  addDoc,
  runTransaction,
} from 'firebase-admin/firestore';
import { db, serverTimestamp, increment, COLLECTIONS } from '../db.js';

/** Deep-copy Firestore snapshots into plain JS (dates → Date). */
export function toPlain(data) {
  const out = {};
  for (const [k, v] of Object.entries(data ?? {})) {
    if (v && typeof v.toDate === 'function') out[k] = v.toDate();
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = toPlain(v);
    else out[k] = v;
  }
  return out;
}

export async function getBuyerOrders(uid, n = 10) {
  const q = query(
    db.collection(COLLECTIONS.orders),
    where('buyerId', '==', uid),
    orderBy('createdAt', 'desc'),
    qlimit(n)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...toPlain(d.data()) }));
}

export async function getSellerOrders(uid, n = 10) {
  const q = query(
    db.collection(COLLECTIONS.orders),
    where('sellerId', '==', uid),
    orderBy('createdAt', 'desc'),
    qlimit(n)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...toPlain(d.data()) }));
}

export async function getOrderById(orderId) {
  const snap = await getDoc(doc(db, COLLECTIONS.orders, orderId));
  return snap.exists ? { id: snap.id, ...toPlain(snap.data()) } : null;
}

/** Seller delivers the account → status 'processing'. */
export async function deliverOrder(orderId) {
  await updateDoc(doc(db, COLLECTIONS.orders, orderId), {
    status: 'processing',
    updatedAt: serverTimestamp(),
  });
}

/** Buyer confirms receipt → money released to seller, status 'completed'. */
export async function confirmOrder(orderId) {
  const ref = doc(db, COLLECTIONS.orders, orderId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const order = snap.data();
    if (order.status !== 'processing') return;
    // Release the held money to the seller atomically with the status change.
    tx.set(doc(db, COLLECTIONS.users, order.sellerId), { balance: increment(order.price) }, { merge: true });
    tx.set(ref, { status: 'completed', updatedAt: serverTimestamp() }, { merge: true });
  });
}

/**
 * Cancel an order: refund the buyer (if paid) and re-list the product.
 * Returns a human-readable result for the chat.
 */
export async function cancelOrder(orderId) {
  const ref = doc(db, COLLECTIONS.orders, orderId);
  let refunded = false;
  let productId = null;
  let cancelledAllowed = false;

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const order = snap.data();
    if (order.status === 'completed' || order.status === 'cancelled') return;
    if (order.status !== 'paid' && order.status !== 'pending') return;

    if (order.status === 'paid') {
      // Money was debited at checkout — refund the buyer.
      tx.set(doc(db, COLLECTIONS.users, order.buyerId), { balance: increment(order.price) }, { merge: true });
      refunded = true;
    }
    productId = order.productId;
    cancelledAllowed = true;
    tx.set(ref, { status: 'cancelled', updatedAt: serverTimestamp() }, { merge: true });
  });

  // Re-list the account only if it was actually sold (paid).
  if (productId && refunded) {
    try {
      await updateDoc(doc(db, COLLECTIONS.products, productId), {
        status: 'active',
        soldOrderId: null,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn('[cancelOrder] restore product failed:', err.message);
    }
  }

  return { cancelled: cancelledAllowed, refunded };
}

/** Seller creates a withdraw request. */
export async function createWithdraw(sellerId, { amount, method, details }) {
  await addDoc(db.collection(COLLECTIONS.withdraw), {
    sellerId,
    amount: Number(amount),
    method,
    methodDetails: details,
    status: 'pending',
    createdAt: serverTimestamp(),
  });
  return true;
}

/** Seller's own products (any status). */
export async function getSellerProducts_(uid, n = 20) {
  const q = query(
    db.collection(COLLECTIONS.products),
    where('sellerId', '==', uid),
    orderBy('createdAt', 'desc'),
    qlimit(n)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...toPlain(d.data()) }));
}

export async function changeProductPrice(productId, price) {
  await updateDoc(doc(db, COLLECTIONS.products, productId), {
    price: Number(price),
    updatedAt: serverTimestamp(),
  });
}

/** Hide / show a listing (seller action). active ↔ hidden. */
export async function changeProductStatus(productId, status) {
  await updateDoc(doc(db, COLLECTIONS.products, productId), {
    status,
    updatedAt: serverTimestamp(),
  });
}

export async function getGameById(gameId) {
  const snap = await getDoc(doc(db, COLLECTIONS.games, gameId));
  return snap.exists ? { id: snap.id, ...toPlain(snap.data()) } : null;
}

export async function listGames() {
  const snap = await getDocs(db.collection(COLLECTIONS.games));
  return snap.docs.map((d) => ({ id: d.id, ...toPlain(d.data()) }));
}

export async function getProductById(productId) {
  const snap = await getDoc(doc(db, COLLECTIONS.products, productId));
  return snap.exists ? { id: snap.id, ...toPlain(snap.data()) } : null;
}