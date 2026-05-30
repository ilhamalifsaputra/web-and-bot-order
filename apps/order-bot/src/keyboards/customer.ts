/**
 * Customer-facing inline and reply keyboards — port of customer_kb.py.
 *
 * Callback data convention: every callback uses the prefix `v1:` followed by a
 * colon-separated path (see customer_kb.py for the full schema). The `v1`
 * prefix lets us evolve the schema later without breaking in-flight buttons.
 */
import { InlineKeyboard, Keyboard } from "grammy";
import type { Decimal } from "@app/core/money";
import { ensureUtc } from "@app/core/datetime";
import { OrderStatus, StockStatus, TicketStatus } from "@app/core/enums";
import { t as coreT } from "@app/core/i18n";
import { formatPrice, statusBadge } from "../util/format";

export const CB_PREFIX = "v1";

/** Build a versioned callback_data string. Keep total length <= 64 bytes. */
export function cb(...parts: Array<string | number>): string {
  return [CB_PREFIX, ...parts.map(String)].join(":");
}

interface Btn {
  text: string;
  data?: string;
}

/** Build an InlineKeyboard from a 2D array of {text,data}. Missing data → noop. */
function ik(rows: Btn[][]): InlineKeyboard {
  return InlineKeyboard.from(
    rows.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data ?? cb("noop")))),
  );
}

// Minimal structural shapes (avoid coupling to generated Prisma types).
interface ProductLike {
  id: number;
  name: string;
  price: Decimal.Value;
}
interface OrderLike {
  id: number;
  orderCode: string;
  status: string;
  totalAmount: Decimal.Value;
}
interface TicketLike {
  id: number;
  status: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

export function mainMenu(lang: string): InlineKeyboard {
  return ik([
    [
      { text: coreT("menu.browse", lang), data: cb("browse", "prods") },
      { text: coreT("menu.my_orders", lang), data: cb("order", "list") },
    ],
    [
      { text: coreT("menu.referral", lang), data: cb("ref", "view") },
      { text: coreT("menu.language", lang), data: cb("lang", "menu") },
    ],
    [
      { text: coreT("menu.faq", lang), data: cb("page", "faq") },
      { text: coreT("menu.terms", lang), data: cb("page", "terms") },
    ],
    [
      { text: coreT("menu.my_tickets", lang), data: cb("ticket", "list") },
      { text: coreT("menu.support", lang), data: cb("support", "open") },
    ],
  ]);
}

export function backToMain(lang: string): InlineKeyboard {
  return ik([[{ text: coreT("menu.main", lang), data: cb("menu", "main") }]]);
}

/** Keyboard attached to push notifications (delivery, rejection, auto-cancel, warranty). */
export function notificationKb(lang: string): InlineKeyboard {
  return ik([
    [
      { text: coreT("menu.my_orders", lang), data: cb("order", "list") },
      { text: coreT("menu.main", lang), data: cb("menu", "main") },
    ],
  ]);
}

// ---------------------------------------------------------------------------
// Browse — persistent numbered reply keyboard
// ---------------------------------------------------------------------------

// Fixed labels matched literally in handleProductNumber.
export const BTN_BROWSE = "🛍 Products";
export const BTN_ORDERS = "📦 Orders";
export const BTN_WALLET = "💰 Wallet";
export const BTN_REFERRAL = "🤝 Referral";
export const BTN_LANGUAGE = "🌐 Language";
export const BTN_SUPPORT = "💬 Support";
export const BTN_FAQ = "❓ FAQ";
export const BTN_TERMS = "📄 Terms";
export const BTN_TICKETS = "📩 Tickets";
// "← Back" is context-aware; "🏠 Menu" always returns to the main dashboard.
export const BTN_BACK = "← Back";
export const BTN_MAIN = "🏠 Menu";
export const BTN_PREV = "◀️ Prev";
export const BTN_NEXT = "Next ▶️";
// Legacy alias kept for backward compatibility (download_history etc).
export const BTN_HISTORY = BTN_ORDERS;

/** Compact persistent reply keyboard with all main-menu shortcuts. */
export function mainPersistentKb(): Keyboard {
  return new Keyboard()
    .text(BTN_BROWSE).text(BTN_ORDERS).text(BTN_WALLET).row()
    .text(BTN_REFERRAL).text(BTN_LANGUAGE).text(BTN_SUPPORT).row()
    .text(BTN_FAQ).text(BTN_TERMS).text(BTN_TICKETS)
    .resized();
}

/**
 * Persistent reply keyboard: number buttons 1..count (rows of 5) + nav rows.
 * show_prev/show_next render a catalog pagination row; show_back adds a
 * context-aware "← Back" handled in handleProductNumber.
 */
export function productsPersistentKb(
  count: number,
  opts: { showPrev?: boolean; showNext?: boolean; showBack?: boolean } = {},
): Keyboard {
  const kb = new Keyboard();
  let inRow = 0;
  for (let n = 1; n <= count; n++) {
    kb.text(String(n));
    inRow++;
    if (inRow === 5) {
      kb.row();
      inRow = 0;
    }
  }
  if (inRow > 0) kb.row();

  if (opts.showPrev || opts.showNext) {
    if (opts.showPrev) kb.text(BTN_PREV);
    if (opts.showNext) kb.text(BTN_NEXT);
    kb.row();
  }

  if (opts.showBack) kb.text(BTN_BACK).text(BTN_MAIN);
  else kb.text(BTN_MAIN);
  return kb.resized();
}

/** ReplyKeyboardRemove payload. */
export function removeReplyKb(): { remove_keyboard: true } {
  return { remove_keyboard: true };
}

export function productDetailKb(
  product: ProductLike,
  availableStock: number,
  lang: string,
  qty = 1,
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (availableStock > 0) {
    qty = Math.max(1, Math.min(qty, availableStock));
    const dec: Btn =
      qty > 1
        ? { text: "−", data: cb("qty", product.id, qty, "dec") }
        : { text: "−", data: cb("noop") };
    const inc: Btn =
      qty < availableStock
        ? { text: "+", data: cb("qty", product.id, qty, "inc") }
        : { text: "+", data: cb("noop") };
    rows.push([dec, { text: String(qty), data: cb("noop") }, inc]);
    rows.push([
      { text: coreT("browse.qty_input_btn", lang), data: cb("qty", "input", product.id) },
    ]);
    rows.push([
      { text: coreT("browse.buy_now", lang), data: cb("buy", product.id, qty) },
    ]);
  } else {
    rows.push([
      { text: coreT("browse.notify_restock", lang), data: cb("restock", "sub", product.id) },
    ]);
  }
  rows.push([{ text: coreT("menu.back", lang), data: cb("browse", "prods") }]);
  return ik(rows);
}

export function qtyInputCancelKb(productId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("browse.qty_input_cancel", lang), data: cb("qty", "cancel", productId) }],
  ]);
}

/** Navigation keyboard for the paginated product list. */
export function productsPageKb(page: number, totalPages: number, lang: string): InlineKeyboard {
  const rows: Btn[][] = [];
  if (totalPages > 1) {
    const nav: Btn[] = [];
    if (page > 0)
      nav.push({ text: coreT("browse.nav_prev", lang), data: cb("browse", "page", page - 1) });
    if (page < totalPages - 1)
      nav.push({ text: coreT("browse.nav_next", lang), data: cb("browse", "page", page + 1) });
    if (nav.length) rows.push(nav);
  }
  rows.push([{ text: coreT("menu.main", lang), data: cb("menu", "main") }]);
  return ik(rows);
}

/** Inline keyboard for /search results — each product is a button. */
export function searchResultsKb(products: ProductLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = products.map((p) => [
    { text: p.name, data: cb("browse", "prod", p.id) },
  ]);
  rows.push([{ text: coreT("menu.main", lang), data: cb("menu", "main") }]);
  return ik(rows);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export function ordersListKb(
  orders: OrderLike[],
  lang: string,
  page = 0,
  totalPages = 1,
): InlineKeyboard {
  const rows: Btn[][] = orders.map((o) => [
    { text: `${o.orderCode} — ${statusBadge(o.status)}`, data: cb("order", "view", o.id) },
  ]);
  if (totalPages > 1) {
    const nav: Btn[] = [];
    if (page > 0) nav.push({ text: "◀️", data: cb("order", "page", page - 1) });
    nav.push({ text: `${page + 1}/${totalPages}`, data: cb("noop") });
    if (page < totalPages - 1) nav.push({ text: "▶️", data: cb("order", "page", page + 1) });
    rows.push(nav);
  }
  rows.push([
    { text: coreT("order.download_history_btn", lang), data: cb("order", "history") },
    { text: coreT("menu.main", lang), data: cb("menu", "main") },
  ]);
  return ik(rows);
}

export function orderDetailKb(order: OrderLike, lang: string): InlineKeyboard {
  const rows: Btn[][] = [];
  if (order.status === OrderStatus.PENDING_PAYMENT) {
    rows.push([{ text: coreT("checkout.i_paid", lang), data: cb("checkout", "proof", order.id) }]);
    rows.push([
      { text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", order.id) },
    ]);
  } else if (order.status === OrderStatus.DELIVERED) {
    rows.push([
      { text: coreT("order.leave_review", lang), data: cb("order", "review", order.id) },
      { text: coreT("order.request_replacement", lang), data: cb("order", "replace", order.id) },
    ]);
  }
  rows.push([
    { text: coreT("menu.back", lang), data: cb("order", "list") },
    { text: coreT("menu.main", lang), data: cb("menu", "main") },
  ]);
  return ik(rows);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export function orderConfirmKb(
  productId: number,
  qty: number,
  lang: string,
  voucherCode = "",
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (voucherCode) {
    rows.push([
      { text: coreT("checkout.voucher_remove_btn", lang), data: cb("voucher", "remove", productId, qty) },
    ]);
  } else {
    rows.push([
      { text: coreT("checkout.use_voucher", lang), data: cb("voucher", "start", productId, qty) },
    ]);
  }
  rows.push([{ text: coreT("checkout.confirm_btn", lang), data: cb("pay", productId, qty) }]);
  rows.push([
    { text: coreT("checkout.cancel_btn", lang), data: cb("browse", "prod", productId) },
  ]);
  return ik(rows);
}

export function voucherCancelKb(productId: number, qty: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_btn", lang), data: cb("buy", productId, qty) }],
  ]);
}

/** Single 'Cancel Order' button shown during the screenshot / TxID prompts. */
export function proofCancelKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", orderId) }],
  ]);
}

export function paymentInstructionsKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.i_paid", lang), data: cb("checkout", "proof", orderId) }],
    [{ text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", orderId) }],
  ]);
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export function reviewRatingKb(orderId: number, productId: number): InlineKeyboard {
  const row: Btn[] = [];
  for (let n = 1; n <= 5; n++) {
    row.push({ text: "⭐".repeat(n), data: cb("review", "rate", orderId, productId, n) });
  }
  return ik([row]);
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------

/** Shown to user under admin reply — lets them mark the issue as resolved. */
export function ticketResolvedKb(ticketId: number): InlineKeyboard {
  return ik([[{ text: "✅ Mark as Resolved", data: cb("ticket", "close", ticketId) }]]);
}

const TICKET_ICONS: Record<string, string> = {
  [TicketStatus.OPEN]: "🔴",
  [TicketStatus.REPLIED]: "🟡",
  [TicketStatus.CLOSED]: "⚫",
};

/** User's ticket list with status icons. */
export function myTicketsKb(tickets: TicketLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = tickets.map((tk) => {
    const icon = TICKET_ICONS[tk.status] ?? "⚪";
    const label = `${icon} #${tk.id} — ${ensureUtc(tk.createdAt).toFormat("yyyy-LL-dd")}`;
    return [{ text: label, data: cb("ticket", "view", tk.id) }];
  });
  rows.push([{ text: coreT("menu.main", lang), data: cb("menu", "main") }]);
  return ik(rows);
}

/** Ticket detail view keyboard: Reply, Close (if open), Back. */
export function ticketViewKb(ticketId: number, statusValue: string, lang: string): InlineKeyboard {
  const rows: Btn[][] = [];
  if (statusValue !== TicketStatus.CLOSED) {
    rows.push([
      { text: "💬 Reply", data: cb("ticket", "reply", ticketId) },
      { text: "🔒 Close", data: cb("ticket", "close", ticketId) },
    ]);
  }
  rows.push([
    { text: coreT("menu.back", lang), data: cb("ticket", "list") },
    { text: coreT("menu.main", lang), data: cb("menu", "main") },
  ]);
  return ik(rows);
}

/** Shown while user is in AWAITING_PHOTOS state. */
export function supportPhotoPromptKb(photoCount: number, lang = "en"): InlineKeyboard {
  let label: string;
  if (photoCount > 0) {
    label =
      lang === "id"
        ? `✅ Submit (${photoCount}/3 foto)`
        : `✅ Submit (${photoCount}/3 photos)`;
  } else {
    label = lang === "id" ? "✅ Submit tanpa foto" : "✅ Submit without photos";
  }
  return ik([[{ text: label, data: cb("support", "photos", "done") }]]);
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

export function languageKb(): InlineKeyboard {
  return ik([
    [
      { text: "🇬🇧 English", data: cb("lang", "set", "en") },
      { text: "🇮🇩 Indonesia", data: cb("lang", "set", "id") },
    ],
  ]);
}

// formatPrice re-exported so handlers/keyboards share one import site.
export { formatPrice };
