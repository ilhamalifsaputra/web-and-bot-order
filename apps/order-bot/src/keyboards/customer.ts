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
import { formatPrice, truncLabel } from "../util/format";

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

/** Confirmation footer after a restock subscription: back to the product + menu. */
export function restockSubscribedKb(productId: number, lang: string): InlineKeyboard {
  return ik([
    [
      { text: coreT("menu.back", lang), data: cb("browse", "prod", productId) },
      { text: coreT("menu.main", lang), data: cb("menu", "main") },
    ],
  ]);
}

/** Confirmation footer after a user closes their own ticket. */
export function ticketClosedKb(lang: string): InlineKeyboard {
  return ik([
    [
      { text: coreT("menu.my_tickets", lang), data: cb("ticket", "list") },
      { text: coreT("menu.main", lang), data: cb("menu", "main") },
    ],
  ]);
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

/**
 * Persistent reply-keyboard buttons. Each action has a STABLE key (used by the
 * handler to decide what to do) mapped to a locale key (used to render the label
 * in the user's language). Because the label is localized, the keyboard text
 * differs per language — so matching typed input must go through
 * `matchPersistentLabel` (which checks BOTH languages), never a literal compare.
 */
export type PersistentAction =
  | "browse" | "orders" | "wallet" | "referral" | "language"
  | "support" | "faq" | "terms" | "tickets"
  | "back" | "main" | "prev" | "next";

const PERSISTENT_LABEL_KEYS: Record<PersistentAction, string> = {
  browse: "menu.browse",
  orders: "menu.my_orders",
  wallet: "menu.wallet",
  referral: "menu.referral",
  language: "menu.language",
  support: "menu.support",
  faq: "menu.faq",
  terms: "menu.terms",
  tickets: "menu.my_tickets",
  // "← Back" is context-aware; "🏠 Menu" always returns to the main dashboard.
  back: "menu.back",
  main: "menu.main",
  prev: "browse.nav_prev",
  next: "browse.nav_next",
};

/** Languages whose labels we accept when matching typed reply-keyboard input. */
const MATCH_LANGS = ["en", "id"] as const;

/** Localized label for a persistent button. */
export function persistentLabel(action: PersistentAction, lang: string): string {
  return coreT(PERSISTENT_LABEL_KEYS[action], lang);
}

/**
 * Resolve typed text back to a stable persistent-button action, checking the
 * label set of every supported language. Returns null when the text is not a
 * known button (e.g. a product number or free text). Language-aware so the
 * handler keeps working whichever language the keyboard was rendered in.
 */
export function matchPersistentLabel(text: string): PersistentAction | null {
  const trimmed = text.trim();
  for (const action of Object.keys(PERSISTENT_LABEL_KEYS) as PersistentAction[]) {
    for (const lang of MATCH_LANGS) {
      if (persistentLabel(action, lang) === trimmed) return action;
    }
  }
  return null;
}

/** True when the text is any persistent-keyboard label (in any language). */
export function isPersistentLabel(text: string): boolean {
  return matchPersistentLabel(text) !== null;
}

/** Compact persistent reply keyboard with all main-menu shortcuts. */
export function mainPersistentKb(lang: string): Keyboard {
  const L = (a: PersistentAction) => persistentLabel(a, lang);
  return new Keyboard()
    .text(L("browse")).text(L("orders")).text(L("wallet")).row()
    .text(L("referral")).text(L("language")).text(L("support")).row()
    .text(L("faq")).text(L("terms")).text(L("tickets"))
    .resized();
}

/**
 * Persistent reply keyboard: number buttons 1..count (rows of 5) + nav rows.
 * show_prev/show_next render a catalog pagination row; show_back adds a
 * context-aware "← Back" handled in handleProductNumber.
 */
export function productsPersistentKb(
  count: number,
  lang: string,
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
    if (opts.showPrev) kb.text(persistentLabel("prev", lang));
    if (opts.showNext) kb.text(persistentLabel("next", lang));
    kb.row();
  }

  if (opts.showBack) kb.text(persistentLabel("back", lang)).text(persistentLabel("main", lang));
  else kb.text(persistentLabel("main", lang));
  return kb.resized();
}

/** Support-button labels across all languages — for the startup `hears` trigger. */
export function supportLabels(): string[] {
  return MATCH_LANGS.map((lang) => persistentLabel("support", lang));
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

interface DenominationLike {
  id: number;
  name: string;
  durationLabel: string;
  price: Decimal.Value;
}

/** Picker shown when a customer taps a product group: one button per member. */
export function groupDenominationsKb(members: DenominationLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = members.map((m) => [
    {
      text: coreT("browse.denomination_btn", lang, {
        duration: m.durationLabel || m.name,
        price: formatPrice(m.price),
      }),
      data: cb("browse", "prod", m.id),
    },
  ]);
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
    { text: truncLabel(p.name, 30), data: cb("browse", "prod", p.id) },
  ]);
  rows.push([{ text: coreT("menu.main", lang), data: cb("menu", "main") }]);
  return ik(rows);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export function ordersListKb(orders: OrderLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = [];
  // The order details live as plain text in the message body. Only an unpaid
  // order keeps a tappable row — it is the sole way back to finish (or cancel)
  // the payment, so dropping it would strand the order. Delivered/cancelled
  // orders need no action and stay button-free (matches the simplified design).
  for (const o of orders) {
    if (o.status === OrderStatus.PENDING_PAYMENT) {
      rows.push([
        { text: coreT("order.pay_btn", lang, { code: o.orderCode }), data: cb("order", "view", o.id) },
      ]);
    }
  }
  rows.push([
    { text: coreT("order.all_history_btn", lang), data: cb("order", "allhistory") },
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
  internalEnabled = false,
  bybitEnabled = false,
  tokopayEnabled = false,
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
  const hasUsdt = internalEnabled || bybitEnabled;
  if (tokopayEnabled || hasUsdt) {
    // Top-level methods: QRIS first, then a single USDT entry that opens a
    // submenu (Binance / Bybit). The legacy manual Binance Pay method is retired.
    if (tokopayEnabled) rows.push([{ text: coreT("checkout.pay_qris_btn", lang), data: cb("payq", productId, qty) }]);
    if (hasUsdt) rows.push([{ text: coreT("checkout.pay_usdt_btn", lang), data: cb("usdt", productId, qty) }]);
  } else {
    // No payment method configured at all — fall back to a plain confirm.
    rows.push([{ text: coreT("checkout.confirm_btn", lang), data: cb("pay", productId, qty) }]);
  }
  rows.push([
    { text: coreT("checkout.cancel_btn", lang), data: cb("browse", "prod", productId) },
  ]);
  return ik(rows);
}

/**
 * USDT payment submenu — reached from the "USDT" entry on the order confirmation.
 * Lists the configured auto-confirm USDT rails (Binance Transfer, Bybit/BSC) and
 * a Back action that returns to the confirmation screen.
 */
export function usdtMethodsKb(
  productId: number,
  qty: number,
  lang: string,
  internalEnabled = false,
  bybitEnabled = false,
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (internalEnabled) rows.push([{ text: coreT("checkout.pay_internal_btn", lang), data: cb("payx", productId, qty) }]);
  if (bybitEnabled) rows.push([{ text: coreT("checkout.pay_bybit_btn", lang), data: cb("payb", productId, qty) }]);
  rows.push([{ text: coreT("menu.back", lang), data: cb("buy", productId, qty) }]);
  return ik(rows);
}

export function voucherCancelKb(productId: number, qty: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_btn", lang), data: cb("buy", productId, qty) }],
  ]);
}

/**
 * Shown during the screenshot / TxID prompts. 'Cancel Order' is the only
 * destructive action; '🏠 Menu' is a non-destructive escape that leaves the
 * order pending (it stays reachable under My Orders), so the user is never
 * stranded on a cancel-or-nothing screen.
 */
export function proofCancelKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", orderId) }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

export function paymentInstructionsKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.i_paid", lang), data: cb("checkout", "proof", orderId) }],
    [{ text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", orderId) }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

/** QRIS payment screen: auto-confirm via webhook, so only Cancel + Menu (no proof). */
export function qrisWaitingKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", orderId) }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------

/** Shown to user under admin reply — lets them mark the issue as resolved. */
export function ticketResolvedKb(ticketId: number, lang = "en"): InlineKeyboard {
  return ik([[{ text: coreT("support.btn_resolve", lang), data: cb("ticket", "close", ticketId) }]]);
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
      { text: coreT("support.btn_reply", lang), data: cb("ticket", "reply", ticketId) },
      { text: coreT("support.btn_close", lang), data: cb("ticket", "close", ticketId) },
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
  const label =
    photoCount > 0
      ? coreT("support.btn_submit_photos", lang, { count: photoCount })
      : coreT("support.btn_submit_no_photos", lang);
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
