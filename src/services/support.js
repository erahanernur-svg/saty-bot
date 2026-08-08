import { db, serverTimestamp, COLLECTIONS } from '../db.js';
import { toPlain } from './marketplace.js';

// ── FAQ (зеркало правил сайта) ───────────────────────────────────────────────
export const FAQ = [
  {
    id: 'escrow',
    title: '💳 Сатып алу қалай қорғалады?',
    a:
      'Saty эскроумен жұмыс істейді: сатып алушы ақшаны платформаға салады, ' +
      'сатушы аккаунтты берген соң сатып алушы «алдым» деп растайды — сонда ғана ' +
      'ақша сатушыға аударылады. Екі жақ та қауіпсіз.',
  },
  {
    id: 'sell',
    title: '📤 Қалай сатуға болады?',
    a:
      'Аккаунтты сату үшін: 1) Сайтта тіркеліп, «Телеграм» арқылы телефон нөмірін ' +
      'растаңыз (бот арқылы). 2) «Сату» бөлімінде лот құрыңыз. 3) Модерациядан ' +
      'өткен соң лот сатылымда пайда болады.',
  },
  {
    id: 'commission',
    title: '🧾 Комиссия қанша?',
    a: 'Платформа комиссиясы — 5%. Ол сатып алу кезінде автоматты қосылады.',
  },
  {
    id: 'withdraw',
    title: '🏦 Қалай ақша шығаруға болады?',
    a:
      'Кошелектегі «Вывод» түймесі арқылы: соманы енгізіп, әдісті таңдаңыз ' +
      '(Kaspi / банк картасы). Өтініш админге жіберіледі және тексерістен кейін орындалады.',
  },
  {
    id: 'support',
    title: '🙋 Байланыс қызметіне қалай жазу?',
    a:
      '«Қолдау» түймесін басып тикет ашыңыз немесе сайттағы Support бөлімін қолданыңыз. ' +
      'Жаңа тикет немесе жауап келгенде біз Телеграмға хабарлама жібереміз.',
  },
  {
    id: 'verify',
    title: '✅ Верификация деген не?',
    a:
      'Телефон нөмірін растау — сату үшін міндетті. Бұл боттан басталады: ' +
      'сайттағы «Телеграмға қосу» сілтемесіннен кейін нөмірді бөлісесіз.',
  },
];

export const faqById = (id) => FAQ.find((f) => f.id === id);

// ── Real support tickets ─────────────────────────────────────────────────────
/** Create a support ticket. Returns the new ticket id. */
export async function createTicket({ userId, userName, userAvatar = '', subject }) {
  const ref = await db.collection(COLLECTIONS.tickets).add({
    userId,
    userName,
    userAvatar,
    subject,
    status: 'open',
    mode: 'bot',
    unreadUser: 0,
    unreadAdmin: 0,
    lastMessage: subject,
    lastMessageAt: serverTimestamp(),
    lastMessageSenderRole: 'user',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function myTickets(uid, n = 8) {
  const snap = await db
    .collection(COLLECTIONS.tickets)
    .where('userId', '==', uid)
    .orderBy('updatedAt', 'desc')
    .limit(n)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...toPlain(d.data()) }));
}

export async function ticketMessages(ticketId, n = 20) {
  const snap = await db
    .collection(COLLECTIONS.ticketMessages)
    .where('ticketId', '==', ticketId)
    .orderBy('createdAt', 'asc')
    .limit(n)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...toPlain(d.data()) }));
}

export async function sendTicketMessage(user, ticketId, text) {
  await db.collection(COLLECTIONS.ticketMessages).add({
    ticketId,
    senderId: user.uid ?? user.id ?? '',
    senderName: user.displayName ?? user.name ?? '—',
    senderAvatar: user.photoURL ?? user.avatar ?? '',
    senderRole: 'user',
    text,
    createdAt: serverTimestamp(),
  });
  const ticketRef = db.collection(COLLECTIONS.tickets).doc(ticketId);
  const ticketSnap = await ticketRef.get();
  if (!ticketSnap.exists) return;
  const t = ticketSnap.data();
  const updates = {
    lastMessage: text,
    lastMessageAt: serverTimestamp(),
    lastMessageSenderRole: 'user',
    updatedAt: serverTimestamp(),
    unreadAdmin: (t.unreadAdmin ?? 0) + 1,
  };
  if (t.status === 'closed') updates.status = 'open';
  await ticketRef.update(updates);
}

export async function getTicketById(ticketId) {
  const snap = await db.collection(COLLECTIONS.tickets).doc(ticketId).get();
  return snap.exists ? { id: snap.id, ...toPlain(snap.data()) } : null;
}