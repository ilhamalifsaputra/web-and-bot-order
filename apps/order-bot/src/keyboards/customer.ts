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

/**
 * Home (main menu) — a PERSISTENT reply keyboard pinned to the bottom of the
 * chat from `/start`, so the primary navigation is always one tap away while the
 * user types product/quantity numbers. Each label is routed back to its action
 * by the typed-text guard (`matchPersistentLabel` + the switch in
 * `handleProductNumber`). The Saldo label is intentionally static (no balance)
 * — a reply keyboard is set once and can't auto-update, and the live balance is
 * shown in the dashboard text; a static label also keeps typed-text matching
 * exact. Layout mirrors the inline menu it replaces.
 */
export function mainPersistentKb(lang: string): Keyboard {
  return new Keyboard()
    .text(coreT("menu.browse", lang))
    .row()
    .text(coreT("menu.wallet", lang))
    .row()
    .text(coreT("menu.my_orders", lang))
    .row()
    .text(coreT("menu.popular", lang))
    .text(coreT("menu.help_center", lang))
    .resized()
    .persistent();
}

/**
 * Persistent reply keyboard shown while browsing the product list: digits
 * 1..count (rows of 5) so a customer can tap a number instead of typing it,
 * plus a Menu button back to `mainPersistentKb`. `count` is the number of
 * products on the entry page (always page 0 — see `browseProductsFlat`), so
 * a small catalog gets exactly that many buttons instead of a padded grid of
 * dead ones. A reply keyboard can only be set via a fresh message, never an
 * edit, so this only fires once per Browse entry; Prev/Next stay on the
 * existing inline `productsNavKb` (edits in place) and never resend it, so a
 * later page with a different count won't resize this keyboard — an
 * out-of-range tap there already resolves to "browse.invalid_number" in
 * `handleProductNumber`.
 */
export function productsPersistentKb(count: number, lang: string): Keyboard {
  const kb = new Keyboard();
  let inRow = 0;
  for (let n = 1; n <= count; n++) {
    kb.text(String(n));
    if (++inRow === 5) {
      kb.row();
      inRow = 0;
    }
  }
  if (inRow > 0) kb.row();
  kb.text(persistentLabel("main", lang));
  return kb.resized().persistent();
}

export function backToMain(lang: string): InlineKeyboard {
  return ik([[{ text: coreT("menu.main", lang), data: cb("menu", "main") }]]);
}

/** Confirmation footer after a restock subscription: back to the denomination + menu. */
export function restockSubscribedKb(denominationId: number, lang: string): InlineKeyboard {
  return ik([
    [
      { text: coreT("menu.back", lang), data: cb("browse", "denom", denominationId) },
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

/** Success-screen footer after an auto-confirmed payment: shop again / history / home. */
export function paymentSuccessKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.buy_again_btn", lang), data: cb("browse", "prods") }],
    [{ text: coreT("order.all_history_btn", lang), data: cb("order", "list") }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

// ---------------------------------------------------------------------------
// Persistent-label typed-text guards
// ---------------------------------------------------------------------------

/**
 * Stable action keys for the bot's main-menu shortcuts, each mapped to a locale
 * key. The reply keyboard that once rendered these was retired in favour of inline
 * keyboards; the machinery survives only as a *typed-text guard* — conversations
 * (checkout / support / review) call `isPersistentLabel` to detect when a user
 * types a former menu label instead of answering a prompt, and bail out to the
 * navigation handler. Matching is language-aware (checks BOTH languages) because
 * the labels are localized, so a literal compare would miss the other language.
 */
export type PersistentAction =
  | "browse" | "orders" | "wallet" | "popular" | "help" | "referral" | "language"
  | "support" | "faq" | "terms" | "tickets"
  | "back" | "main" | "prev" | "next";

const PERSISTENT_LABEL_KEYS: Record<PersistentAction, string> = {
  browse: "menu.browse",
  orders: "menu.my_orders",
  wallet: "menu.wallet",
  popular: "menu.popular",
  help: "menu.help_center",
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

/**
 * Detail bubble for a single Denomination (leaf SKU): qty stepper, Buy, Back.
 * `denom` is the Denomination (carries the SKU id used by the qty/buy/restock
 * callbacks); `parentProductId` is its mid-tier Product so Back returns to that
 * product's picker, not all the way to the flat list. Pass `parentProductId`
 * null only when the detail was reached outside a picker (e.g. a deep-link),
 * where Back falls through to the product list.
 */
export function denominationDetailKb(
  denom: ProductLike,
  availableStock: number,
  lang: string,
  qty = 1,
  parentProductId: number | null = null,
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (availableStock > 0) {
    qty = Math.max(1, Math.min(qty, availableStock));
    const dec5: Btn =
      qty > 1
        ? { text: "−5", data: cb("qty", denom.id, qty, "dec5") }
        : { text: "−5", data: cb("noop") };
    const dec: Btn =
      qty > 1
        ? { text: "−", data: cb("qty", denom.id, qty, "dec") }
        : { text: "−", data: cb("noop") };
    const inc: Btn =
      qty < availableStock
        ? { text: "+", data: cb("qty", denom.id, qty, "inc") }
        : { text: "+", data: cb("noop") };
    const inc5: Btn =
      qty < availableStock
        ? { text: "+5", data: cb("qty", denom.id, qty, "inc5") }
        : { text: "+5", data: cb("noop") };
    rows.push([dec5, dec, { text: String(qty), data: cb("noop") }, inc, inc5]);
    rows.push([
      { text: coreT("browse.qty_input_btn", lang), data: cb("qty", "input", denom.id) },
    ]);
    rows.push([
      { text: coreT("browse.buy_now", lang), data: cb("buy", denom.id, qty) },
    ]);
  } else {
    rows.push([
      { text: coreT("browse.notify_restock", lang), data: cb("restock", "sub", denom.id) },
    ]);
  }
  rows.push([
    { text: coreT("browse.refresh_btn", lang), data: cb("browse", "refresh", denom.id, qty) },
  ]);
  const back: Btn =
    parentProductId != null
      ? { text: coreT("menu.back", lang), data: cb("browse", "pick", parentProductId) }
      : { text: coreT("menu.back", lang), data: cb("browse", "prods") };
  rows.push([back]);
  return ik(rows);
}

interface DenominationLike {
  id: number;
  name: string;
  durationLabel: string;
}

/**
 * Denomination picker shown when a customer taps a mid-tier Product with ≥2
 * active denominations: one button per denomination (tapping opens its detail
 * bubble via `browse:denom`), laid out 2 per row. The buttons carry only the
 * plan name — price and stock live in the message body (built by
 * `browseProduct`), so the keyboard stays a clean list of plan types. A
 * `Perbarui`/Refresh row re-renders the picker (re-reads stock + the "updated"
 * timestamp) and a Back row returns to the flat product list.
 */
export function denominationPickerKb(
  denominations: DenominationLike[],
  productId: number,
  lang: string,
): InlineKeyboard {
  const rows: Btn[][] = [];
  for (let i = 0; i < denominations.length; i += 2) {
    rows.push(
      denominations.slice(i, i + 2).map((d) => ({
        text: d.durationLabel || d.name,
        data: cb("browse", "denom", d.id),
      })),
    );
  }
  rows.push([{ text: coreT("browse.refresh_btn", lang), data: cb("browse", "pick", productId) }]);
  rows.push([{ text: coreT("menu.back", lang), data: cb("browse", "prods") }]);
  return ik(rows);
}

export function qtyInputCancelKb(denominationId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("browse.qty_input_cancel", lang), data: cb("qty", "cancel", denominationId) }],
  ]);
}

/**
 * Slim pagination keyboard for the Product List (§3). The list itself is now
 * driven by typed numbers (handleProductNumber resolves the caption's numbered
 * lines), so the per-product tap buttons and the Menu row were dropped — the
 * persistent reply keyboard carries navigation. Only a Prev/Next row remains,
 * and only when the catalog spans more than one page; a single page renders no
 * inline keyboard at all (returns undefined).
 */
export function productsNavKb(page: number, totalPages: number, lang: string): InlineKeyboard | undefined {
  if (totalPages <= 1) return undefined;
  const nav: Btn[] = [];
  if (page > 0) nav.push({ text: coreT("browse.nav_prev", lang), data: cb("browse", "page", page - 1) });
  if (page < totalPages - 1)
    nav.push({ text: coreT("browse.nav_next", lang), data: cb("browse", "page", page + 1) });
  return nav.length ? ik([nav]) : undefined;
}

/** Inline keyboard for /search results — each mid-tier Product opens its picker. */
export function searchResultsKb(products: Array<{ id: number; name: string }>, lang: string): InlineKeyboard {
  const rows: Btn[][] = products.map((p) => [
    { text: truncLabel(p.name, 30), data: cb("browse", "pick", p.id) },
  ]);
  rows.push([{ text: coreT("menu.main", lang), data: cb("menu", "main") }]);
  return ik(rows);
}

/** Inline keyboard for the Produk Populer list — one `browse:pick` button per product + Menu row. */
export function popularKb(products: Array<{ id: number; name: string }>, lang: string): InlineKeyboard {
  const rows: Btn[][] = products.map((p) => [
    { text: truncLabel(p.name, 30), data: cb("browse", "pick", p.id) },
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
  paydisiniEnabled = false,
  nowpaymentsEnabled = false,
  bybitBscEnabled = false,
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
  const hasUsdt = internalEnabled || bybitEnabled || bybitBscEnabled || nowpaymentsEnabled;
  // Top-level methods: QRIS first, then PayDisini (second IDR rail), then a
  // single USDT entry that opens a submenu (Binance / Bybit / NOWPayments). The
  // legacy manual Binance Pay method is retired, so an unconfigured shop offers
  // no payable action here (voucher + cancel only) until an admin enables a
  // gateway in Settings.
  if (tokopayEnabled) rows.push([{ text: coreT("checkout.pay_qris_btn", lang), data: cb("payq", productId, qty) }]);
  if (paydisiniEnabled) rows.push([{ text: coreT("checkout.pay_paydisini_btn", lang), data: cb("payd", productId, qty) }]);
  if (hasUsdt) rows.push([{ text: coreT("checkout.pay_usdt_btn", lang), data: cb("usdt", productId, qty) }]);
  rows.push([
    { text: coreT("checkout.cancel_btn", lang), data: cb("browse", "denom", productId) },
  ]);
  return ik(rows);
}

/**
 * USDT payment submenu — reached from the "USDT" entry on the order confirmation.
 * Lists the configured auto-confirm USDT rails (Binance Transfer, Bybit/BSC,
 * NOWPayments hosted invoice) and a Back action that returns to the
 * confirmation screen.
 */
export function usdtMethodsKb(
  productId: number,
  qty: number,
  lang: string,
  internalEnabled = false,
  bybitEnabled = false,
  nowpaymentsEnabled = false,
  bybitBscEnabled = false,
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (internalEnabled) rows.push([{ text: coreT("checkout.pay_internal_btn", lang), data: cb("payx", productId, qty) }]);
  if (bybitEnabled) rows.push([{ text: coreT("checkout.pay_bybit_btn", lang), data: cb("payb", productId, qty) }]);
  if (bybitBscEnabled) rows.push([{ text: coreT("checkout.pay_bybit_bsc_btn", lang), data: cb("paybc", productId, qty) }]);
  if (nowpaymentsEnabled) rows.push([{ text: coreT("checkout.pay_nowpayments_btn", lang), data: cb("payn", productId, qty) }]);
  rows.push([{ text: coreT("menu.back", lang), data: cb("buy", productId, qty) }]);
  return ik(rows);
}

export function voucherCancelKb(productId: number, qty: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_btn", lang), data: cb("buy", productId, qty) }],
  ]);
}

/**
 * Auto USDT rails' waiting screen (Binance Internal, Bybit). 'Cancel Order' is
 * the only destructive action; '🏠 Menu' is a non-destructive escape that leaves
 * the order pending (it stays reachable under My Orders), so the user is never
 * stranded on a cancel-or-nothing screen. `showRefresh` adds the on-demand
 * reconcile button the auto rails pass `true` for.
 */
export function proofCancelKb(orderId: number, lang: string, showRefresh = false): InlineKeyboard {
  return ik([
    ...(showRefresh
      ? [[{ text: coreT("checkout.refresh_status_btn", lang), data: cb("checkout", "refresh", orderId) }]]
      : []),
    [{ text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", orderId) }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

/** QRIS payment screen: auto-confirm via webhook, so Refresh (on-demand reconcile) + Cancel + Menu (no proof). */
export function qrisWaitingKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.refresh_status_btn", lang), data: cb("checkout", "refresh", orderId) }],
    [{ text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", orderId) }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

/**
 * Bybit BSC live tracking screen's keyboard (PAYMENT_DETECTED/CONFIRMING/
 * CONFIRMED). Refresh always; Cancel only while still PENDING_PAYMENT —
 * which this screen is never actually shown for in practice (it has its own
 * earlier render path), but kept consistent with cancelOrder's own
 * anti-abuse guard rather than hardcoding "no Cancel ever" here.
 */
export function bybitBscTrackingKb(order: { id: number; status: string }, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.refresh_status_btn", lang), data: cb("checkout", "refresh", order.id) }],
    ...(order.status === OrderStatus.PENDING_PAYMENT
      ? [[{ text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", order.id) }]]
      : []),
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

// ---------------------------------------------------------------------------
// Help Center hub
// ---------------------------------------------------------------------------

/** Help Center hub keyboard — one feature button per row + a Menu back row. */
export function helpCenterKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("help.referral_btn", lang), data: cb("ref", "view") }],
    [{ text: coreT("help.language_btn", lang), data: cb("lang", "menu") }],
    [{ text: coreT("help.faq_btn", lang), data: cb("page", "faq") }],
    [{ text: coreT("help.terms_btn", lang), data: cb("page", "terms") }],
    [{ text: coreT("help.support_btn", lang), data: cb("support", "open") }],
    [{ text: coreT("help.tickets_btn", lang), data: cb("ticket", "list") }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

// formatPrice re-exported so handlers/keyboards share one import site.
export { formatPrice };
