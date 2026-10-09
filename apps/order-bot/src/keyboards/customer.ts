/**
 * Customer-facing inline and reply keyboards — port of customer_kb.py.
 *
 * Callback data convention: every callback uses the prefix `v1:` followed by a
 * colon-separated path (see customer_kb.py for the full schema). The `v1`
 * prefix lets us evolve the schema later without breaking in-flight buttons.
 */
import { InlineKeyboard, Keyboard } from "grammy";
import { getOrderFulfillment } from "@app/core/orderFulfillment";
import type { Decimal } from "@app/core/money";
import { ensureUtc } from "@app/core/datetime";
import { CategoryGroup, DeliveryType, OrderStatus, PaymentMethod, StockStatus, TicketStatus } from "@app/core/enums";
import { CUSTOMER_SERVICES, type CustomerService } from "@app/core/services";
import { t as coreT } from "@app/core/i18n";
import { MAX_CART_ORDER_UNITS } from "@app/db";
import { formatPrice, formatUsdtBalance, formatIdrFor, truncLabel } from "../util/format";
import { formatDenominationLabel } from "../util/denominationLabel";
import { LIST_LABEL_MAX_CHARS } from "@app/core/buttonLimits";
import type { CatalogButton } from "../util/canonicalPresenter";

export const CB_PREFIX = "v1";

/** Build a versioned callback_data string. Keep total length <= 64 bytes. */
export function cb(...parts: Array<string | number>): string {
  return [CB_PREFIX, ...parts.map(String)].join(":");
}

interface Btn {
  text: string;
  data?: string;
  /** When set, builds a native "copy to clipboard" button instead of a callback button. */
  copyText?: string;
}

/**
 * Build an InlineKeyboard from a 2D array of button specs. A row entry with
 * `data` builds a normal callback button (missing `data` → noop); a row
 * entry with `copyText` instead builds a native "copy to clipboard" button
 * via `InlineKeyboard.copyText`.
 */
function ik(rows: Btn[][]): InlineKeyboard {
  return InlineKeyboard.from(
    rows.map((row) =>
      row.map((b) =>
        b.copyText !== undefined
          ? InlineKeyboard.copyText(b.text, b.copyText)
          : InlineKeyboard.text(b.text, b.data ?? cb("noop")),
      ),
    ),
  );
}

// Minimal structural shapes (avoid coupling to generated Prisma types).
interface ProductLike {
  id: number;
  name: string;
  price: Decimal.Value;
  /** Gates purchasability in denominationDetailKb — only AUTO SKUs ever carry
   * StockItem rows, so non-AUTO SKUs must never be gated on stock count.
   * Typed as `string` (not the `DeliveryType` union) because it's populated
   * straight from Prisma's generated Denomination row, which types the
   * `delivery_type` column as a plain string — same as OrderLike.status
   * above and how checkout.ts's `product.deliveryType` is typed. */
  deliveryType: string;
}
interface OrderLike {
  id: number;
  orderCode: string;
  status: string;
  paymentMethod: string;
  totalAmount: Decimal.Value;
  fulfillmentProvider?: string | null;
  digiflazzDispatchedAt?: Date | null;
  digiflazzStatus?: string | null;
  /** Only present on the full getOrder()/listUserOrders() include shape — used
   * by orderDetailKb to gate the Edit-Info button to manual_with_info SKUs. */
  items?: Array<{ deliveryTypeSnapshot?: string | null; product: { deliveryType: string; autoDeliverySource?: string | null } }>;
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
 * Home (main menu) — a reply keyboard pinned to the bottom of the chat from
 * `/start`, so the primary navigation is one tap away while the user types
 * product/quantity numbers. Left non-`is_persistent` on purpose: Telegram
 * then leaves a grid icon in the text-input row, so a user who swipes/hides
 * the keyboard (native Android back gesture included) can still reopen it on
 * demand instead of it being forced back open. Each label is routed back to
 * its action by the typed-text guard (`matchPersistentLabel` + the switch in
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
    .resized();
}

/**
 * Reply keyboard shown while browsing the product list: digits 1..count
 * (rows of 5) so a customer can tap a number instead of typing it, plus a
 * Menu button back to `mainPersistentKb`. `count` is the number of products
 * on the entry page (always page 0 — see `browseProductsFlat`), so a small
 * catalog gets exactly that many buttons instead of a padded grid of dead
 * ones. Left non-`is_persistent` (see `mainPersistentKb`) so it can be
 * swiped/hidden and reopened from the text-input grid icon. A reply keyboard
 * can only be set via a fresh message, never an edit, so this only fires
 * once per Browse entry; Prev/Next stay on the existing inline
 * `productsNavKb` (edits in place) and never resend it, so a later page with
 * a different count won't resize this keyboard — an out-of-range tap there
 * already resolves to "browse.invalid_number" in `handleProductNumber`.
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
  return kb.resized();
}

/**
 * Reply keyboard shown while a Game Top Up variant/region picker is the
 * active numbered screen: digits 1..count (rows of 5) so a customer can tap
 * or type the same number the picker's own inline buttons carry, plus a Menu
 * button back to `mainPersistentKb`. Identical shape to
 * `productsPersistentKb`, just sized to the picker's own option count
 * instead of the product-list page size — see `BrowseScratch.activeNumberedScreen`
 * in `handlers/customer.ts` for why entering a picker needs its own fresh
 * send of this (a reply keyboard can't ride on the picker's own
 * inline-keyboard edit; only a fresh `sendMessage` can replace the bottom
 * bar). Shared by both the variant and region picker renders since their
 * reply keyboard need is identical — only the option count differs.
 */
export function gamePickerPersistentKb(count: number, lang: string): Keyboard {
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
  return kb.resized();
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
  /** Picker page (0-based) the detail was opened from; Back returns to it. */
  parentPage = 0,
): InlineKeyboard {
  const rows: Btn[][] = [];
  // Stock rows only ever exist for AUTO SKUs (manual/manual_with_info skip
  // reservation entirely) — gating purchasability on availableStock for a
  // non-AUTO SKU would always see 0 and permanently show "Notify me when back
  // in stock" instead of "Buy Now", including for the entire Digiflazz
  // catalog (every imported SKU is manual_with_info).
  const purchasable = denom.deliveryType !== DeliveryType.AUTO || availableStock > 0;
  if (purchasable) {
    // Non-AUTO SKUs never have stock rows, so the qty-stepper bounds can't use
    // availableStock (always 0) — cap against MAX_CART_ORDER_UNITS instead,
    // the same limit the storefront's cart checkout applies to manual items.
    const maxQty = denom.deliveryType === DeliveryType.AUTO ? availableStock : MAX_CART_ORDER_UNITS;
    qty = Math.max(1, Math.min(qty, maxQty));
    const dec5: Btn =
      qty > 1
        ? { text: "−5", data: cb("qty", denom.id, qty, "dec5") }
        : { text: "−5", data: cb("noop") };
    const dec: Btn =
      qty > 1
        ? { text: "−", data: cb("qty", denom.id, qty, "dec") }
        : { text: "−", data: cb("noop") };
    const inc: Btn =
      qty < maxQty
        ? { text: "+", data: cb("qty", denom.id, qty, "inc") }
        : { text: "+", data: cb("noop") };
    const inc5: Btn =
      qty < maxQty
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
      ? {
          text: coreT("menu.back", lang),
          data: parentPage > 0 ? cb("browse", "pick", parentProductId, parentPage) : cb("browse", "pick", parentProductId),
        }
      : { text: coreT("menu.back", lang), data: cb("browse", "prods") };
  rows.push([back]);
  return ik(rows);
}

interface DenominationLike {
  id: number;
  name: string;
  durationLabel: string;
  /** Precomputed compact Game Top Up label (gameTopUpDenomLabel); falls back
   * to durationLabel||name when absent. Computed by the caller, not here. */
  buttonLabel?: string;
}

/** Catalog presenter owns labels and adaptive rows; callbacks stay compatible. */
export function canonicalDenominationPickerKb(buttonRows: CatalogButton[][], productId: number, lang: string, page: number, pageCount: number): InlineKeyboard {
  // grammY's add() appends to the LAST existing row, so each group of buttons
  // below is built as its own explicit row. Product rows are copied so the
  // presenter's page.rows are never aliased/mutated by the keyboard.
  const rows: Array<Array<{ text: string; callback_data: string }>> = buttonRows
    .filter((row) => row.length > 0)
    .map((row) => row.map((button) => ({ text: button.text, callback_data: button.callback_data })));
  if (pageCount > 1) {
    const arrows: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) arrows.push({ text: "‹", callback_data: cb("browse", "pick", productId, page - 1) });
    if (page < pageCount - 1) arrows.push({ text: "›", callback_data: cb("browse", "pick", productId, page + 1) });
    if (arrows.length > 0) rows.push(arrows);
  }
  rows.push([{ text: coreT("browse.refresh_btn", lang), callback_data: cb("browse", "pick", productId, page) }]);
  rows.push([{ text: coreT("menu.back", lang), callback_data: cb("browse", "prods") }]);
  return new InlineKeyboard(rows);
}

/**
 * Denomination picker shown when a customer taps a mid-tier Product with ≥2
 * active denominations: one button per denomination (tapping opens its detail
 * bubble via `browse:denom`), laid out 2 per row. By default a button carries
 * only the plan name and price/stock live in the message body (built by
 * `browseProduct`). A Game Top Up SKU with qtyValue/qtyUnit instead arrives
 * with a precomputed `buttonLabel` carrying its own price (qty + unit +
 * price); when every button does, `browseProduct` drops the per-plan
 * price/stock lines and the body shows game info instead. A
 * `Perbarui`/Refresh row re-renders the picker (re-reads stock + the "updated"
 * timestamp) and a Back row returns to the flat product list.
 */
export function denominationPickerKb(
  denominations: DenominationLike[],
  productId: number,
  productName: string,
  lang: string,
): InlineKeyboard {
  const rows: Btn[][] = [];
  for (let i = 0; i < denominations.length; i += 2) {
    rows.push(
      denominations.slice(i, i + 2).map((d) => ({
        text: truncLabel(d.buttonLabel ?? formatDenominationLabel(productName, d.durationLabel || d.name)),
        data: cb("browse", "denom", d.id),
      })),
    );
  }
  rows.push([{ text: coreT("browse.refresh_btn", lang), data: cb("browse", "pick", productId) }]);
  rows.push([{ text: coreT("menu.back", lang), data: cb("browse", "prods") }]);
  return ik(rows);
}

// ---------------------------------------------------------------------------
// Products entry flow: group picker -> category picker
// ---------------------------------------------------------------------------

/**
 * First step of the "🛍 Products" entry point. Services, labels, and order
 * come from the shared customer-service registry.
 * Tapping a group opens `categoryPickerKb` scoped to that group.
 */
export function groupPickerKb(
  lang: string,
  services: readonly CustomerService[] = CUSTOMER_SERVICES,
): InlineKeyboard {
  return ik([
    ...(services.length ? [services.map((service) => ({
        text: coreT(service.translationKey, lang),
        data: cb("browse", "grp", service.group),
      }))] : []),
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

interface CategoryLike {
  id: number;
  name: string;
  emoji: string | null;
}

/**
 * Second step of the Products entry flow — one button per active Category
 * within the group picked by `groupPickerKb`, laid out 2 per row. Always
 * renders the trailing Back/Menu row, even for an empty `categories` array,
 * so an empty group never leaves the customer on a dead-end screen (the
 * message body carries the "no categories yet" copy in that case).
 */
export function categoryPickerKb(categories: CategoryLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = [];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(
      categories.slice(i, i + 2).map((c) => ({
        text: truncLabel(`${c.emoji ? c.emoji + " " : ""}${c.name}`, LIST_LABEL_MAX_CHARS),
        data: cb("browse", "cat", c.id),
      })),
    );
  }
  rows.push([
    { text: coreT("menu.back", lang), data: cb("browse", "grps") },
    { text: coreT("menu.main", lang), data: cb("menu", "main") },
  ]);
  return ik(rows);
}

/**
 * Game Top Up variant picker (e.g. weapon/character skin lines within a
 * Category) — one button per variant, laid out 2 per row, index-addressed via
 * `browse:gvar:<categoryId>:<index>` (the variant list itself is resolved by
 * the handler, not carried in callback_data). Button text is not HTML-parsed
 * by Telegram (unlike message bodies), so no `esc()` is needed here.
 *
 * `backTarget` is the fully-built callback_data the Back button should carry
 * — the caller (browseCategoryEntry) computes it, since only it knows the
 * category's group; it must NOT be `cb("browse", "cat", categoryId)` (that
 * would re-enter this SAME variant picker — a no-op loop, Finding I2/3 of the
 * final-review). The one level up from a variant picker is the category
 * picker (`cb("browse", "grp", group)`).
 */
export function gameVariantPickerKb(
  variants: Array<{ label: string; emoji: string | null }>,
  categoryId: number,
  backTarget: string,
  lang: string,
): InlineKeyboard {
  const rows: Btn[][] = [];
  for (let i = 0; i < variants.length; i += 2) {
    rows.push(
      variants.slice(i, i + 2).map((v, j) => ({
        text: v.emoji ? `${v.emoji} ${v.label}` : v.label,
        data: cb("browse", "gvar", categoryId, i + j),
      })),
    );
  }
  rows.push([{ text: coreT("menu.back", lang), data: backTarget }]);
  return ik(rows);
}

/**
 * Game Top Up region picker, shown after a variant is chosen — one button per
 * region string, laid out 2 per row, index-addressed the same way as
 * `gameVariantPickerKb`. Button text is not HTML-parsed by Telegram, so no
 * `esc()` is needed here either.
 *
 * `backTarget` is the fully-built callback_data the Back button should carry
 * — computed by the caller (enterGameVariant), since only it knows whether a
 * real variant picker was actually shown for this navigation. When one was
 * shown, Back re-opens it (`cb("browse", "gvars", categoryId)`); when the
 * variant step was auto-skipped (0/1 distinct variant), that picker was never
 * rendered, so Back must skip straight to the category picker
 * (`cb("browse", "grp", group)`) instead of re-rendering THIS SAME region
 * picker (Finding I2/3 of the final-review).
 */
export function gameRegionPickerKb(
  regions: string[],
  categoryId: number,
  backTarget: string,
  lang: string,
): InlineKeyboard {
  const rows: Btn[][] = [];
  for (let i = 0; i < regions.length; i += 2) {
    rows.push(
      regions.slice(i, i + 2).map((r, j) => ({
        text: r,
        data: cb("browse", "greg", categoryId, i + j),
      })),
    );
  }
  rows.push([{ text: coreT("menu.back", lang), data: backTarget }]);
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
    { text: truncLabel(p.name, LIST_LABEL_MAX_CHARS), data: cb("browse", "pick", p.id) },
  ]);
  rows.push([{ text: coreT("menu.main", lang), data: cb("menu", "main") }]);
  return ik(rows);
}

/** Inline keyboard for the Produk Populer list — one `browse:pick` button per product + Menu row. */
export function popularKb(products: Array<{ id: number; name: string }>, lang: string): InlineKeyboard {
  const rows: Btn[][] = products.map((p) => [
    { text: truncLabel(p.name, LIST_LABEL_MAX_CHARS), data: cb("browse", "pick", p.id) },
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
    // Every rail except the legacy manual Binance Pay has an on-demand
    // reconcile poller (checkout.refreshPaymentStatus already no-ops for
    // BINANCE_PAY's default case) — offer the same "🔄 Refresh Status" button
    // the wait screens show, so My Orders → Pay isn't a dead end while waiting.
    if (order.paymentMethod !== PaymentMethod.BINANCE_PAY) {
      rows.push([
        { text: coreT("checkout.refresh_status_btn", lang), data: cb("checkout", "refresh", order.id) },
      ]);
    }
    rows.push([
      { text: coreT("checkout.cancel_order", lang), data: cb("checkout", "cancel", order.id) },
    ]);
  } else if (order.status === OrderStatus.PROCESSING) {
    // Awaiting hand-fulfilment — Refresh (this is a NEW order:refresh action,
    // distinct from checkout:refresh's payment-status reconcile above) plus,
    // for a manual_with_info SKU only, an Edit-Info button so the buyer can
    // correct a submitted answer before the admin fulfils it.
    rows.push([
      { text: coreT("checkout.refresh_status_btn", lang), data: cb("order", "refresh", order.id) },
    ]);
    if (getOrderFulfillment({ ...order, items: order.items ?? [] }).can_edit_customer_data && (order.items?.[0]?.deliveryTypeSnapshot ?? order.items?.[0]?.product.deliveryType) === DeliveryType.MANUAL_WITH_INFO) {
      rows.push([
        { text: coreT("order.edit_info_btn", lang), data: cb("order", "editinfo", order.id) },
      ]);
    }
  }
  rows.push([
    { text: coreT("menu.back", lang), data: cb("order", "list") },
    { text: coreT("menu.main", lang), data: cb("menu", "main") },
  ]);
  return ik(rows);
}

/** Edit-info wizard's Cancel button — discards in-progress edits and returns
 * to the order-detail screen (re-entering the SAME order:view action a
 * "Back"/Menu tap would use, since nothing is persisted until the wizard's
 * last step). */
export function editInfoCancelKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_btn", lang), data: cb("order", "view", orderId) }],
  ]);
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
  idrBalance: Decimal | null = null,
  usdtBalance: Decimal | null = null,
  walletDeduction: { currency: "IDR" | "USDT"; amount: string } | null = null,
  fullyCovered = false,
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (fullyCovered) {
    // The active wallet credit already brings the total to zero — a gateway
    // button here would mean charging Rp0/​$0 through TokoPay/PayDisini/USDT,
    // which is meaningless. Voucher and wallet-toggle rows are equally moot at a
    // zero total, so the screen collapses to the one action that applies:
    // Complete Order. The persistent menu keyboard stays the escape hatch.
    rows.push([
      { text: coreT("checkout.complete_order_btn", lang), data: cb("walletpay", productId, qty) },
    ]);
    return ik(rows);
  }
  if (voucherCode) {
    rows.push([
      { text: coreT("checkout.voucher_remove_btn", lang), data: cb("voucher", "remove", productId, qty) },
    ]);
  } else {
    rows.push([
      { text: coreT("checkout.use_voucher", lang), data: cb("voucher", "start", productId, qty) },
    ]);
  }
  // Single entry point for both wallet-credit currencies — opens walletCreditKb
  // instead of toggling directly, so this screen doesn't grow a new row per
  // credit type (or per future payment method).
  const hasWalletBalance = (idrBalance != null && idrBalance.greaterThan(0)) || (usdtBalance != null && usdtBalance.greaterThan(0));
  if (hasWalletBalance) {
    rows.push([
      walletDeduction
        ? {
            text: coreT("checkout.wallet_active_btn", lang, { currency: walletDeduction.currency, amount: walletDeduction.amount }),
            data: cb("walletm", "open", productId, qty),
          }
        : { text: coreT("checkout.use_wallet_btn", lang), data: cb("walletm", "open", productId, qty) },
    ]);
  }
  const hasUsdt = internalEnabled || bybitEnabled || bybitBscEnabled || nowpaymentsEnabled;
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

/**
 * Wallet-credit submenu — reached from the "Use Wallet Credit" entry on the
 * order confirmation. Purely a credit-*picker*: one row per available currency,
 * plus a Back row. IDR and USDT credit are mutually exclusive on a single order
 * (packages/db/src/crud/orders.ts's releaseOrderHolds refunds by
 * order.currency) — the walletm callback dispatcher clears the other flag
 * whenever one is turned on, so at most one row here is ever "active" at a time.
 *
 * Picking a credit navigates straight back to the confirmation screen (which
 * carries the "Complete Order" confirm button when the credit fully covers the
 * order), so this submenu never shows the forward action itself — that would
 * double up the credit row and the confirm button on one screen.
 */
export function walletCreditKb(
  productId: number,
  qty: number,
  lang: string,
  idrBalance: Decimal,
  useWalletIdr: boolean,
  usdtBalance: Decimal,
  useWalletUsdt: boolean,
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (idrBalance.greaterThan(0)) {
    rows.push([
      useWalletIdr
        ? { text: coreT("checkout.wallet_menu_idr_active_btn", lang), data: cb("walletm", "idr", productId, qty) }
        : {
            text: coreT("checkout.wallet_menu_idr_btn", lang, { amount: formatIdrFor(idrBalance, lang) }),
            data: cb("walletm", "idr", productId, qty),
          },
    ]);
  }
  if (usdtBalance.greaterThan(0)) {
    rows.push([
      useWalletUsdt
        ? { text: coreT("checkout.wallet_menu_usdt_active_btn", lang), data: cb("walletm", "usdt", productId, qty) }
        : {
            text: coreT("checkout.wallet_menu_usdt_btn", lang, { amount: formatUsdtBalance(usdtBalance) }),
            data: cb("walletm", "usdt", productId, qty),
          },
    ]);
  }
  rows.push([{ text: coreT("menu.back", lang), data: cb("walletm", "back", productId, qty) }]);
  return ik(rows);
}

export function voucherCancelKb(productId: number, qty: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_btn", lang), data: cb("buy", productId, qty) }],
  ]);
}

/** Shown after nicknameCheck.ts's lookup finds an account: 'Yes, that's me'
 * locks in the buyer's typed target + confirmed nickname (the conversation
 * writes scratch.customerData and re-renders confirmation); 'Try Again'
 * resets the wizard back to the target-id prompt (a typo fix); 'Cancel'
 * abandons exactly like voucherCancelKb (routes to v1:buy, same re-entry
 * contract as every other checkout wizard). */
export function nicknameConfirmKb(productId: number, qty: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.nickname_confirm_btn", lang), data: cb("nick", "confirm") }],
    [{ text: coreT("checkout.nickname_retry_btn", lang), data: cb("nick", "retry") }],
    [{ text: coreT("checkout.cancel_btn", lang), data: cb("buy", productId, qty) }],
  ]);
}

/** Shown by nicknameCheck.ts after a DEFINITIVE "account not found" answer
 * (final-review Important #2). 'Try Again' re-asks the ID fields in the same
 * wizard bubble (as on nicknameConfirmKb); 'Continue anyway' proceeds to
 * confirm/pay with the last-typed target stored unverified, matching the
 * storefront's own non-blocking degrade posture instead of hard-stopping the
 * checkout on a possibly-misconfigured product. 'Cancel' abandons exactly
 * like voucherCancelKb/nicknameConfirmKb. */
export function nicknameNotFoundKb(productId: number, qty: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.nickname_retry_btn", lang), data: cb("nick", "retry") }],
    [{ text: coreT("checkout.nickname_continue_btn", lang), data: cb("nick", "continue") }],
    [{ text: coreT("checkout.cancel_btn", lang), data: cb("buy", productId, qty) }],
  ]);
}

/**
 * Auto USDT rails' waiting screen (Binance Internal, Bybit). 'Cancel Order' is
 * the only destructive action; '🏠 Menu' is a non-destructive escape that leaves
 * the order pending (it stays reachable under My Orders), so the user is never
 * stranded on a cancel-or-nothing screen. `showRefresh` adds the on-demand
 * reconcile button the auto rails pass `true` for. `copy` optionally adds
 * native "copy to clipboard" buttons for the Binance UID and/or the unique
 * payment code (memo/paymentRef) — pass the RAW, un-escaped values: Telegram's
 * `copy_text` field is not HTML-parsed, so running them through `esc(...)`
 * (as the surrounding message text does) would copy literal escape
 * sequences instead of the real value. A value that's empty or over
 * Telegram's 256-char `copy_text` limit is silently omitted rather than
 * sent, since Telegram's API rejects the whole request otherwise.
 */
export function proofCancelKb(
  orderId: number,
  lang: string,
  showRefresh = false,
  copy?: { uid?: string; note?: string },
): InlineKeyboard {
  return ik([
    ...(copy?.uid && copy.uid.length <= 256
      ? [[{ text: coreT("checkout.copy_uid_btn", lang), copyText: copy.uid }]]
      : []),
    ...(copy?.note && copy.note.length <= 256
      ? [[{ text: coreT("checkout.copy_note_btn", lang), copyText: copy.note }]]
      : []),
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
// Wallet top-up
// ---------------------------------------------------------------------------

/** Wallet screen footer: a Top Up entry point + the usual Menu escape. */
export function walletKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("wallet.topup_btn", lang), data: cb("topup", "open") }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

/** Currency choice — the first step of the top-up flow. Back returns to the wallet screen. */
export function topupCurrencyKb(lang: string): InlineKeyboard {
  return ik([
    [
      { text: coreT("wallet.topup_currency_idr_btn", lang), data: cb("topup", "currency", "idr") },
      { text: coreT("wallet.topup_currency_usdt_btn", lang), data: cb("topup", "currency", "usdt") },
    ],
    [{ text: coreT("menu.back", lang), data: cb("wallet", "view") }],
  ]);
}

/** Shown while awaiting the typed top-up amount. Cancel returns to the currency choice. */
export function topupAmountCancelKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.cancel_btn", lang), data: cb("topup", "open") }],
  ]);
}

/**
 * Gateway picker for the top-up flow — structurally identical to
 * {@link usdtMethodsKb}/orderConfirmKb's QRIS/PayDisini rows, just scoped to
 * the currency the buyer already chose: IDR gets TokoPay/PayDisini, USDT gets
 * the four USDT auto-confirm rails. One button per gateway actually enabled
 * (per web-admin Settings); Back re-opens the amount prompt for the same
 * currency so the buyer can change the figure without re-picking currency.
 */
export function topupMethodsKb(
  currency: "IDR" | "USDT",
  lang: string,
  tokopayEnabled = false,
  paydisiniEnabled = false,
  internalEnabled = false,
  bybitEnabled = false,
  bybitBscEnabled = false,
  nowpaymentsEnabled = false,
): InlineKeyboard {
  const rows: Btn[][] = [];
  if (currency === "IDR") {
    if (tokopayEnabled) rows.push([{ text: coreT("checkout.pay_qris_btn", lang), data: cb("topup", "pay", "tokopay") }]);
    if (paydisiniEnabled) rows.push([{ text: coreT("checkout.pay_paydisini_btn", lang), data: cb("topup", "pay", "paydisini") }]);
  } else {
    if (internalEnabled) rows.push([{ text: coreT("checkout.pay_internal_btn", lang), data: cb("topup", "pay", "internal") }]);
    if (bybitEnabled) rows.push([{ text: coreT("checkout.pay_bybit_btn", lang), data: cb("topup", "pay", "bybit") }]);
    if (bybitBscEnabled) rows.push([{ text: coreT("checkout.pay_bybit_bsc_btn", lang), data: cb("topup", "pay", "bybitbsc") }]);
    if (nowpaymentsEnabled) rows.push([{ text: coreT("checkout.pay_nowpayments_btn", lang), data: cb("topup", "pay", "nowpayments") }]);
  }
  rows.push([{ text: coreT("menu.back", lang), data: cb("topup", "currency", currency.toLowerCase()) }]);
  return ik(rows);
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------

/** Shown to user under admin reply — lets them mark the issue as resolved. */
export function ticketResolvedKb(ticketId: number, lang = "en"): InlineKeyboard {
  return ik([[{ text: coreT("support.btn_resolve", lang), data: cb("ticket", "close", ticketId) }]]);
}

// Task 1 fix: WAITING_ADMIN/WAITING_CUSTOMER are now live values (see
// TicketStatus's own doc comment, @app/core/enums) — same icon as their
// OPEN/REPLIED counterpart.
const TICKET_ICONS: Record<string, string> = {
  [TicketStatus.OPEN]: "🔴",
  [TicketStatus.WAITING_ADMIN]: "🔴",
  [TicketStatus.REPLIED]: "🟡",
  [TicketStatus.WAITING_CUSTOMER]: "🟡",
  [TicketStatus.RESOLVED]: "🟢",
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

/** Ticket detail view keyboard: Reply/Close if open, Reopen if closed-and-still-in-window, always Back/Main. */
export function ticketViewKb(ticketId: number, statusValue: string, lang: string, reopenable = false): InlineKeyboard {
  const rows: Btn[][] = [];
  if (statusValue !== TicketStatus.CLOSED) {
    rows.push([
      { text: coreT("support.btn_reply", lang), data: cb("ticket", "reply", ticketId) },
      { text: coreT("support.btn_close", lang), data: cb("ticket", "close", ticketId) },
    ]);
  } else if (reopenable) {
    rows.push([{ text: coreT("ticket.btn_reopen", lang), data: cb("ticket", "reopen", ticketId) }]);
  }
  rows.push([
    { text: coreT("menu.back", lang), data: cb("ticket", "list") },
    { text: coreT("menu.main", lang), data: cb("menu", "main") },
  ]);
  return ik(rows);
}

interface OrderPickerLike {
  id: number;
  orderCode: string;
  items?: Array<{ product: { name: string } }>;
}

/** One button per recent order (+ a skip/general-question row) for the
 * /support conversation's optional order-linking step. Deliberately a
 * separate function from ordersListKb — that one only makes PENDING_PAYMENT
 * rows tappable (order details render as plain text there); this needs
 * EVERY order tappable regardless of status, for a "pick which order"
 * wizard step, not a status list. */
export function orderPickerKb(orders: OrderPickerLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = orders.map((o) => {
    const productName = o.items?.[0]?.product.name ?? "";
    return [{ text: truncLabel(`#${o.orderCode} — ${productName}`, 30), data: cb("support", "order", o.id) }];
  });
  rows.push([{ text: coreT("support.order_picker_skip", lang), data: cb("support", "order", "skip") }]);
  return ik(rows);
}

/** Shown when a customer tries to link a new ticket to an order that
 * already has one open — "view the existing ticket" instead of filing a
 * duplicate. */
export function ticketDuplicateKb(ticketId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("support.duplicate_open_ticket_view_btn", lang), data: cb("ticket", "view", ticketId) }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
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
// Display currency (/start onboarding, after language)
// ---------------------------------------------------------------------------

export function currencyKb(lang = "en"): InlineKeyboard {
  return ik([
    [
      { text: `🇺🇸 ${coreT("currency.usd", lang)}`, data: cb("cur", "set", "USD") },
      { text: `🇮🇩 ${coreT("currency.idr", lang)}`, data: cb("cur", "set", "IDR") },
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
    [{ text: coreT("help.currency_btn", lang), data: cb("cur", "menu") }],
    [{ text: coreT("help.faq_btn", lang), data: cb("page", "faq") }],
    [{ text: coreT("help.terms_btn", lang), data: cb("page", "terms") }],
    [{ text: coreT("help.support_btn", lang), data: cb("support", "open") }],
    [{ text: coreT("help.tickets_btn", lang), data: cb("ticket", "list") }],
    [{ text: coreT("menu.main", lang), data: cb("menu", "main") }],
  ]);
}

// formatPrice re-exported so handlers/keyboards share one import site.
export { formatPrice };
