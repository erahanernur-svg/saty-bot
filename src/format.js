import { Markup } from 'telegraf';

// ── Order / product status labels (Kazakh/Russian) ──────────────────────────
export const ORDER_STATUS = {
  pending: '🕘 Күтуде (Pending)',
  paid: '💰 Төленді (Paid)',
  processing: '🔄 Өңделуде (Processing)',
  completed: '✅ Аяқталды (Completed)',
  cancelled: '🚫 Бас тартылды (Cancelled)',
};

export const PRODUCT_STATUS = {
  active: '✅ Сатылымда',
  draft: '📝 Жоба (Draft)',
  sold: '🔎 Сатылды',
  hidden: '🙈 Жасырын',
  pending: '⏳ Күтілуде (модерация)',
  rejected: '❌ Қайтарылды',
};

export const fmtPrice = (n) => `${Number(n || 0).toLocaleString('kk-KZ', { maximumFractionDigits: 0 })} ₸`;

export function fmtDate(d) {
  if (!d) return '—';
  const date = d instanceof Date ? d : d.toDate ? d.toDate() : new Date(d);
  try {
    return date.toLocaleString('kk-KZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(d);
  }
}

/** Escape HTML-ish text for Markup HTML parse mode. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Main menu builders ─────────────────────────────────────────────────────
export function mainMenu(extra = []) {
  const rows = [
    [
      Markup.button.callback('📦 Менің заказдарым', 'menu:orders'),
      Markup.button.callback('🏷️ Менің лоттарым', 'menu:products'),
    ],
    [
      Markup.button.callback('👛 Кошелек / Баланс', 'menu:wallet'),
      Markup.button.callback('📊 Профиль', 'menu:profile'),
    ],
    [
      Markup.button.callback('🎧 Қолдау / FAQ', 'menu:support'),
      Markup.button.callback('📖 Правила', 'menu:rules'),
    ],
    [Markup.button.callback('⚙️ Настройка уведомлений', 'menu:settings')],
  ];
  if (extra.length) rows_PUSH(rows, extra);
  return Markup.inlineKeyboard(rows);
}

function rows_PUSH(rows, extra) {
  for (const row of extra) rows.push(row.map((b) => Markup.button.callback(b.text, b.callback)));
}