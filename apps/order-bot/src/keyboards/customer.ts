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
import { hasSellableStock, usesLocalInventory } from "@app/core/productAvailability";
import { t as coreT } from "@app/core/i18n";
import { MAX_CART_ORDER_UNITS } from "@app/db";
import { formatPrice, formatUsdtBalance, formatIdrFor, truncLabel } from "../util/format";
import { formatDenominationLabel } from "../util/denominationLabel";
import { LIST_LABEL_MAX_CHARS, MAX_LABEL_BYTES, MAX_LABEL_WIDTH, visualWidth } from "@app/core/buttonLimits";
import type { CatalogButton } from "../util/canonicalPresenter";

export const CB_PREFIX = "v1";

/** Build a versioned callback_data string. Keep total length <= 64 bytes. */
export function cb(...parts: Array<string | number>): string {
  return [CB_PREFIX, ...parts.map(String)].join(":");
}

export interface Btn {
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
  /** With `autoDeliverySource`, gates purchasability in denominationDetailKb
   * through @app/core/productAvailability — only local-inventory SKUs ever
   * carry StockItem rows, so provider (e.g. auto + Digiflazz) and manual SKUs
   * must never be gated on stock count. Typed as `string` (not the
   * `DeliveryType` union) because it's populated straight from Prisma's
   * generated Denomination row, which types the `delivery_type` column as a
   * plain string — same as OrderLike.status above. */
  deliveryType: string;
  autoDeliverySource: string | null;
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
  ticketNumber?: string | null;
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
 * Reply keyboard shown while browsing a NUMBERED product list (Premium Apps
 * only — `usesNumberedSelection`, @app/core/services; every other service and
 * the Game Top-up edition/region pickers are inline-only): digits 1..count
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
 *
 * The last row is `[← Back, 🏠 Menu]`: Back is matched by
 * `handleProductNumber` → `handleBackButton`, which computes the target from
 * the screens really shown (handlers/customer.ts `listBackTarget`), so the list
 * gets its Back without any extra companion message.
 */
export function productsPersistentKb(count: number, lang: string): Keyboard {
  return numberedPersistentKb(count, lang);
}

/** Digits 1..count in rows of 5, then `[← Back, 🏠 Menu]`. */
function numberedPersistentKb(count: number, lang: string): Keyboard {
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
  kb.text(persistentLabel("back", lang)).text(persistentLabel("main", lang));
  return kb.resized();
}

/** Menu-only footer for error and terminal screens (no screen to go back to). */
export function backToMain(lang: string): InlineKeyboard {
  return ik([[{ text: coreT("menu.main", lang), data: MENU_MAIN }]]);
}

const MENU_MAIN = cb("menu", "main");

/**
 * The one Back row every navigation screen ends with: `← Back` to `target`
 * (the screen really above, computed by the caller), then `🏠 Menu` when
 * `withMenu`. A screen whose parent is the main menu itself passes
 * `cb("menu", "main")` and gets the single Back (a Menu button beside it would
 * be a duplicate), so Menu is never added next to a Back that already goes
 * there. Labels come only from the locale (`menu.back` / `menu.main`).
 */
export function backRow(lang: string, target: string, withMenu = true): Btn[] {
  const row: Btn[] = [{ text: coreT("menu.back", lang), data: target }];
  if (withMenu && target !== MENU_MAIN) row.push({ text: coreT("menu.main", lang), data: MENU_MAIN });
  return row;
}

/** A screen whose only navigation is the Back row (see {@link backRow}). */
export function backKb(lang: string, target: string, withMenu = true): InlineKeyboard {
  return ik([backRow(lang, target, withMenu)]);
}

/** A single Back button to the pack (denomination) screen. */
export function backToPackKb(productId: number, lang: string): InlineKeyboard {
  return ik([backRow(lang, cb("browse", "denom", productId), false)]);
}

/** Confirmation footer after a restock subscription: back to the denomination + menu. */
export function restockSubscribedKb(denominationId: number, lang: string): InlineKeyboard {
  return ik([backRow(lang, cb("browse", "denom", denominationId))]);
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
  /** Back target when no parent picker was shown (collapse / deep link):
   * the product list by default, or the search results / Popular list the
   * product was opened from (handlers/customer.ts `originBackTarget`). */
  fallbackBack: string = cb("browse", "prods"),
): InlineKeyboard {
  const rows: Btn[][] = [];
  // Stock rows only ever exist for local-inventory SKUs
  // (@app/core/productAvailability) — gating purchasability on
  // availableStock for a provider (e.g. auto + Digiflazz) or manual SKU would
  // always see 0 and permanently show "Notify me when back in stock" instead
  // of "Buy Now".
  const local = usesLocalInventory(denom);
  const purchasable = hasSellableStock(denom, availableStock);
  if (purchasable) {
    // Provider and manual SKUs never have stock rows, so the qty-stepper
    // bounds can't use availableStock (always 0) — cap against
    // MAX_CART_ORDER_UNITS instead, the same limit the storefront's cart
    // checkout applies to manual items.
    const maxQty = local ? availableStock : MAX_CART_ORDER_UNITS;
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
  const backTarget =
    parentProductId != null
      ? parentPage > 0 ? cb("browse", "pick", parentProductId, parentPage) : cb("browse", "pick", parentProductId)
      : fallbackBack;
  rows.push(backRow(lang, backTarget, false));
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

/**
 * The "1/2" page indicator placed between the Prev/Next arrows of a multi-page
 * inline list or pack picker. Its callback is the router's no-op
 * (`v1:noop`), which only answers the query: a tap changes nothing.
 */
export function pageIndicatorButton(page: number, pageCount: number): { text: string; callback_data: string } {
  return { text: `${page + 1}/${pageCount}`, callback_data: cb("noop") };
}

/** Catalog presenter owns labels and adaptive rows; callbacks stay compatible.
 * `backTarget`: the product list by default, or the search results / Popular
 * list the product was opened from. */
export function canonicalDenominationPickerKb(buttonRows: CatalogButton[][], productId: number, lang: string, page: number, pageCount: number, backTarget: string = cb("browse", "prods")): InlineKeyboard {
  // grammY's add() appends to the LAST existing row, so each group of buttons
  // below is built as its own explicit row. Product rows are copied so the
  // presenter's page.rows are never aliased/mutated by the keyboard.
  const rows: Array<Array<{ text: string; callback_data: string }>> = buttonRows
    .filter((row) => row.length > 0)
    .map((row) => row.map((button) => ({ text: button.text, callback_data: button.callback_data })));
  if (pageCount > 1) {
    // ‹ 1/2 › — the page indicator sits between the arrows (a no-op tap).
    const arrows: Array<{ text: string; callback_data: string }> = [];
    if (page > 0) arrows.push({ text: "‹", callback_data: cb("browse", "pick", productId, page - 1) });
    arrows.push(pageIndicatorButton(page, pageCount));
    if (page < pageCount - 1) arrows.push({ text: "›", callback_data: cb("browse", "pick", productId, page + 1) });
    rows.push(arrows);
  }
  rows.push([{ text: coreT("browse.refresh_btn", lang), callback_data: cb("browse", "pick", productId, page) }]);
  rows.push([{ text: coreT("menu.back", lang), callback_data: backTarget }]);
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
 * timestamp) and a Back row returns to the flat product list — or to the
 * search results / Popular list the product was opened from (`backTarget`).
 */
export function denominationPickerKb(
  denominations: DenominationLike[],
  productId: number,
  productName: string,
  lang: string,
  backTarget: string = cb("browse", "prods"),
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
  rows.push(backRow(lang, backTarget, false));
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
    // Its parent is the main menu: one Back, no duplicate Menu button.
    backRow(lang, MENU_MAIN),
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
 *
 * `backTarget` is computed by the caller (the service picker, or the main
 * menu when only one service is enabled and its picker is auto-skipped —
 * handlers/customer.ts `upToServicesTarget`). When Back already leads to the
 * main menu, the duplicate Menu button is dropped.
 */
export function categoryPickerKb(categories: CategoryLike[], lang: string, backTarget: string = cb("browse", "grps")): InlineKeyboard {
  const rows: Btn[][] = [];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(
      categories.slice(i, i + 2).map((c) => ({
        text: truncLabel(`${c.emoji ? c.emoji + " " : ""}${c.name}`, LIST_LABEL_MAX_CHARS),
        data: cb("browse", "cat", c.id),
      })),
    );
  }
  rows.push(backRow(lang, backTarget));
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
  /** `gvar` (a category's editions) or `ged` (one game's editions, the game level). */
  action: "gvar" | "ged" = "gvar",
): InlineKeyboard {
  const rows: Btn[][] = [];
  for (let i = 0; i < variants.length; i += 2) {
    rows.push(
      variants.slice(i, i + 2).map((v, j) => ({
        text: v.emoji ? `${v.emoji} ${v.label}` : v.label,
        data: cb("browse", action, categoryId, i + j),
      })),
    );
  }
  rows.push(backRow(lang, backTarget, false));
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
  /** `greg` (a category's regions) or `grg` (one game's regions, the game level). */
  action: "greg" | "grg" = "greg",
): InlineKeyboard {
  const rows: Btn[][] = [];
  for (let i = 0; i < regions.length; i += 2) {
    rows.push(
      regions.slice(i, i + 2).map((r, j) => ({
        text: r,
        data: cb("browse", action, categoryId, i + j),
      })),
    );
  }
  rows.push(backRow(lang, backTarget, false));
  return ik(rows);
}

/** Cut `text` to at most `maxCells` terminal cells (emoji/CJK = 2), ending in
 * "…" when it had to shorten. Used for a search-result name so that name plus
 * its service tag fits MAX_LABEL_WIDTH; a name that already fits is never cut. */
function clipToCells(text: string, maxCells: number): string {
  if (visualWidth(text) <= maxCells) return text;
  let out = "";
  for (const ch of Array.from(text)) {
    if (visualWidth(`${out}${ch}…`) > maxCells) break;
    out += ch;
  }
  return `${out}…`;
}

export function qtyInputCancelKb(denominationId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("browse.qty_input_cancel", lang), data: cb("qty", "cancel", denominationId) }],
  ]);
}

/**
 * Slim pagination keyboard for a NUMBERED Product List (§3) — Premium Apps
 * only (`usesNumberedSelection`, @app/core/services). That list is driven by
 * typed numbers (handleProductNumber resolves the caption's numbered lines),
 * so it carries no per-product tap buttons and no Menu row — the numbered
 * reply keyboard carries the digits and Menu. A Prev/Next row only when the
 * catalog spans more than one page, then a Back row carrying `backTarget`
 * (the caller's `listBackTarget`) on every page — a single page too, so Back
 * is one edit of this bubble rather than a typed reply-keyboard key. No
 * `backTarget` and a single page → undefined (no inline keyboard). Every other
 * service's list uses {@link productListKb} instead.
 */
export function productsNavKb(page: number, totalPages: number, lang: string, backTarget?: string): InlineKeyboard | undefined {
  const nav: Btn[] = [];
  if (page > 0) nav.push({ text: coreT("browse.nav_prev", lang), data: cb("browse", "page", page - 1) });
  if (page < totalPages - 1)
    nav.push({ text: coreT("browse.nav_next", lang), data: cb("browse", "page", page + 1) });
  const rows: Btn[][] = nav.length ? [nav] : [];
  if (backTarget) rows.push(backRow(lang, backTarget, false));
  return rows.length ? ik(rows) : undefined;
}

/** `text` + `suffix` within the phone budget: at most MAX_LABEL_WIDTH cells and
 * MAX_LABEL_BYTES UTF-8 bytes, `text` cut by whole code points (never a
 * split emoji) and ending in "…" when it had to shorten; `suffix` is kept. */
function fitLabel(text: string, suffix = ""): string {
  let out = clipToCells(text, MAX_LABEL_WIDTH - visualWidth(suffix));
  while (Buffer.byteLength(`${out}${suffix}`, "utf8") > MAX_LABEL_BYTES) {
    const chars = Array.from(out.endsWith("…") ? out.slice(0, -1) : out);
    chars.pop();
    out = `${chars.join("")}…`;
  }
  return `${out}${suffix}`;
}

/** At most `max` code points (never a split surrogate pair), ending in "…" when cut. */
function cutChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/**
 * The INLINE product list (every service except a numbered one —
 * `usesNumberedSelection`, @app/core/services): one button per product on the
 * page (`browse:pick:<id>`, one per row), then Prev / "1/2" page indicator /
 * Next when the list spans more than one page, then the Back row to `backTarget` (the caller's
 * `listBackTarget`) on every page, a single page too. The label is the product
 * name, cut at LIST_LABEL_MAX_CHARS characters like the popular-product
 * buttons (but by whole code points, never splitting an emoji) and then to
 * the phone budget (MAX_LABEL_WIDTH cells, MAX_LABEL_BYTES bytes); the list
 * body shows every full name, so a shortened label stays explained. Two names
 * that would read the same get " (2)", " (3)"… in list order.
 */
export function productListKb(
  products: Array<{ id: number; name: string }>,
  page: number,
  totalPages: number,
  lang: string,
  backTarget: string,
): InlineKeyboard {
  const labels = uniqueListLabels(products.map((p) => p.name));
  const rows: Btn[][] = products.map((p, i) => [{ text: labels[i]!, data: cb("browse", "pick", p.id) }]);
  rows.push(...listNavRows(page, totalPages, lang, (target) => cb("browse", "page", target)));
  rows.push(backRow(lang, backTarget, false));
  return ik(rows);
}

/** Prev, the "1/2" page indicator, Next — one row, only for a multi-page inline list. */
function listNavRows(page: number, totalPages: number, lang: string, pageData: (page: number) => string): Btn[][] {
  if (totalPages <= 1) return [];
  const nav: Btn[] = [];
  if (page > 0) nav.push({ text: coreT("browse.nav_prev", lang), data: pageData(page - 1) });
  const indicator = pageIndicatorButton(page, totalPages);
  nav.push({ text: indicator.text, data: indicator.callback_data });
  if (page < totalPages - 1) nav.push({ text: coreT("browse.nav_next", lang), data: pageData(page + 1) });
  return [nav];
}

/** Unique, phone-sized inline labels for a list of names: each cut at
 * LIST_LABEL_MAX_CHARS code points and then to the phone budget, duplicates
 * suffixed " (2)", " (3)"… in list order. */
function uniqueListLabels(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const text = fitLabel(cutChars(name.replace(/\s+/g, " ").trim(), LIST_LABEL_MAX_CHARS));
    const count = (seen.get(text) ?? 0) + 1;
    seen.set(text, count);
    return count > 1 ? fitLabel(text, ` (${count})`) : text;
  });
}

/**
 * The Game Top-up GAME LIST (the game level of a category holding several
 * games): one inline button per game on the page, addressed by the game's
 * index in the category's game order (`browse:game:<categoryId>:<index>`; the
 * handler resolves it against the snapshot of the list it rendered, so a
 * catalog change or an old bubble can never open the wrong game), then
 * Prev / page indicator / Next (`browse:games:<categoryId>:<page>`) on a
 * multi-page list, then the Back row (the category level). Labels are the game
 * names cut like the product list's; the message body names every game in
 * full with its From price.
 */
export function gameListKb(
  games: Array<{ name: string; index: number }>,
  categoryId: number,
  page: number,
  totalPages: number,
  lang: string,
  backTarget: string,
): InlineKeyboard {
  const labels = uniqueListLabels(games.map((g) => g.name));
  const rows: Btn[][] = games.map((g, i) => [{ text: labels[i]!, data: cb("browse", "game", categoryId, g.index) }]);
  rows.push(...listNavRows(page, totalPages, lang, (target) => cb("browse", "games", categoryId, target)));
  rows.push(backRow(lang, backTarget, false));
  return ik(rows);
}

/** One /search hit as stored in the session snapshot: `serviceKey` is the service's locale key (its short tag). */
export interface SearchHit {
  id: number;
  name: string;
  serviceKey: string;
}

/**
 * Game Top Up search results: `<name> · <service tag>` per hit, the
 * name cut so the whole label stays within MAX_LABEL_WIDTH, then Prev/Next
 * (`search:page:<n>`), Search again and Back, each on its own row. `hits` is the
 * current page's slice of the snapshot. The results are a top-level screen, so
 * Back goes to the main menu (no duplicate Menu button).
 */
export function gameSearchResultsKb(hits: SearchHit[], page: number, totalPages: number, lang: string): InlineKeyboard {
  const rows: Btn[][] = hits.map((h) => {
    const tag = coreT(h.serviceKey, lang);
    const suffix = ` · ${tag}`;
    return [{ text: `${clipToCells(h.name, MAX_LABEL_WIDTH - visualWidth(suffix))}${suffix}`, data: cb("browse", "pick", h.id) }];
  });
  if (totalPages > 1) {
    const nav: Btn[] = [];
    if (page > 0) nav.push({ text: coreT("browse.nav_prev", lang), data: cb("search", "page", page - 1) });
    if (page < totalPages - 1) nav.push({ text: coreT("browse.nav_next", lang), data: cb("search", "page", page + 1) });
    rows.push(nav);
  }
  rows.push([{ text: coreT("search.again_btn", lang), data: cb("search", "again") }]);
  rows.push(backRow(lang, MENU_MAIN));
  return ik(rows);
}

/** No-results screen: Search again (re-arms the prompt) and Back to the main
 * menu (the empty search keeps no results page to return to). */
export function gameSearchEmptyKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("search.again_btn", lang), data: cb("search", "again") }],
    backRow(lang, MENU_MAIN),
  ]);
}

/** Inline keyboard for the Produk Populer list — one `browse:pick` button per
 * product, then Back to the main menu (its parent; no duplicate Menu). */
export function popularKb(products: Array<{ id: number; name: string }>, lang: string): InlineKeyboard {
  const rows: Btn[][] = products.map((p) => [
    { text: truncLabel(p.name, LIST_LABEL_MAX_CHARS), data: cb("browse", "pick", p.id) },
  ]);
  rows.push(backRow(lang, MENU_MAIN));
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
  rows.push([{ text: coreT("order.all_history_btn", lang), data: cb("order", "allhistory") }]);
  // My Orders hangs off the main menu: one Back on its own row, no duplicate Menu.
  rows.push(backRow(lang, MENU_MAIN));
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
  rows.push([{ text: coreT("help.support_btn", lang), data: cb("support", "open", order.id) }]);
  rows.push(backRow(lang, cb("order", "list")));
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

/**
 * A pay button's callback: `v1:<domain>:<pid>:<qty>:<quoteNonce>`. The nonce is
 * the one the render stored with its quote (`quoteConfirmation`,
 * handlers/checkout.ts); a pay handler charges only a tap whose nonce is the
 * stored one, so a button from an older render, or one built without a nonce,
 * re-renders the screen instead of paying.
 */
function payCb(domain: string, productId: number, qty: number, quoteNonce: string): string {
  return cb(domain, productId, qty, quoteNonce);
}

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
  quoteNonce: string,
): InlineKeyboard {
  const rows: Btn[][] = [];
  const pay = (domain: string) => payCb(domain, productId, qty, quoteNonce);
  if (fullyCovered) {
    // The active wallet credit already brings the total to zero — a gateway
    // button here would mean charging Rp0/​$0 through TokoPay/PayDisini/USDT,
    // which is meaningless. Voucher and wallet-toggle rows are equally moot at a
    // zero total, so the screen collapses to the one action that applies:
    // Complete Order, plus a Back row to the pack (the same target the
    // non-covered screen's Cancel uses) so the customer is never stranded.
    rows.push([
      { text: coreT("checkout.complete_order_btn", lang), data: pay("walletpay") },
    ]);
    rows.push(backRow(lang, cb("browse", "denom", productId), false));
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
  if (tokopayEnabled) rows.push([{ text: coreT("checkout.pay_qris_btn", lang), data: pay("payq") }]);
  if (paydisiniEnabled) rows.push([{ text: coreT("checkout.pay_paydisini_btn", lang), data: pay("payd") }]);
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
  quoteNonce: string,
): InlineKeyboard {
  const rows: Btn[][] = [];
  const pay = (domain: string) => payCb(domain, productId, qty, quoteNonce);
  if (internalEnabled) rows.push([{ text: coreT("checkout.pay_internal_btn", lang), data: pay("payx") }]);
  if (bybitEnabled) rows.push([{ text: coreT("checkout.pay_bybit_btn", lang), data: pay("payb") }]);
  if (bybitBscEnabled) rows.push([{ text: coreT("checkout.pay_bybit_bsc_btn", lang), data: pay("paybc") }]);
  if (nowpaymentsEnabled) rows.push([{ text: coreT("checkout.pay_nowpayments_btn", lang), data: pay("payn") }]);
  rows.push(backRow(lang, cb("buy", productId, qty), false));
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
  rows.push(backRow(lang, cb("walletm", "back", productId, qty), false));
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

/** Game Top-up review screen (checkout.ts renderAccountReview). Continue
 * renders the payment screen; Change details asks for the account data again;
 * Back returns to the pack. It carries no pay button: only the payment screen
 * does, bound to its own quote. */
export function accountReviewKb(productId: number, qty: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.review_continue_btn", lang), data: cb("rev", "go", productId, qty) }],
    [{ text: coreT("checkout.review_change_btn", lang), data: cb("rev", "chg", productId, qty) }],
    backRow(lang, cb("browse", "denom", productId), false),
  ]);
}

/** The review screen when the review is too large to show: Change details and
 * Back only, never a Continue next to account data the buyer could not see. */
export function accountReviewTooLargeKb(productId: number, qty: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("checkout.review_change_btn", lang), data: cb("rev", "chg", productId, qty) }],
    backRow(lang, cb("browse", "denom", productId), false),
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

/** Top-up receipt footer (settledPaymentKb): another Top Up + the Menu escape.
 * A receipt is a terminal screen, so it keeps Menu instead of a Back. */
export function walletKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("wallet.topup_btn", lang), data: cb("topup", "open") }],
    [{ text: coreT("menu.main", lang), data: MENU_MAIN }],
  ]);
}

/** The Wallet screen (a main-menu section): Top Up, then one Back to the main menu. */
export function walletViewKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("wallet.topup_btn", lang), data: cb("topup", "open") }],
    backRow(lang, MENU_MAIN),
  ]);
}

/** Currency choice — the first step of the top-up flow. Back returns to the wallet screen. */
export function topupCurrencyKb(lang: string): InlineKeyboard {
  return ik([
    [
      { text: coreT("wallet.topup_currency_idr_btn", lang), data: cb("topup", "currency", "idr") },
      { text: coreT("wallet.topup_currency_usdt_btn", lang), data: cb("topup", "currency", "usdt") },
    ],
    backRow(lang, cb("wallet", "view"), false),
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
  rows.push(backRow(lang, cb("topup", "currency", currency.toLowerCase()), false));
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
  [TicketStatus.IN_PROGRESS]: "\u23f3",
  [TicketStatus.OPEN]: "🔴",
  [TicketStatus.WAITING_ADMIN]: "🔴",
  [TicketStatus.REPLIED]: "🟡",
  [TicketStatus.WAITING_CUSTOMER]: "🟡",
  [TicketStatus.RESOLVED]: "🟢",
  [TicketStatus.CLOSED]: "⚫",
};

/** User's ticket list with status icons; Back to the Help Center it is opened from. */
export function myTicketsKb(tickets: TicketLike[], lang: string, page = 1, total = tickets.length): InlineKeyboard {
  const rows: Btn[][] = tickets.map((tk) => {
    const icon = TICKET_ICONS[tk.status] ?? "⚪";
    const label = `${icon} ${tk.ticketNumber ?? `#${tk.id}`} — ${ensureUtc(tk.createdAt).toFormat("yyyy-LL-dd")}`;
    return [{ text: label, data: cb("ticket", "view", tk.id) }];
  });
  const navigation: Btn[] = [];
  if (page > 1) navigation.push({ text: coreT("helpdesk.previous", lang), data: cb("ticket", "list", page - 1) });
  if (page * 6 < total) navigation.push({ text: coreT("helpdesk.next", lang), data: cb("ticket", "list", page + 1) });
  if (navigation.length) rows.push(navigation);
  rows.push(backRow(lang, cb("help", "open")));
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
  rows.push(backRow(lang, cb("ticket", "list")));
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
 * duplicate. Back goes to My Tickets (the support wizard has ended). */
export function ticketDuplicateKb(ticketId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("support.duplicate_open_ticket_view_btn", lang), data: cb("ticket", "view", ticketId) }],
    backRow(lang, cb("ticket", "list")),
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

/** Language picker. `backTarget` adds the `[← Back, 🏠 Menu]` row; the caller
 * omits it during onboarding (handlers/customer.ts settingsBackTarget), so the
 * first-run flow never offers a way around the currency choice. */
export function languageKb(lang = "en", backTarget?: string): InlineKeyboard {
  return ik([
    [
      { text: "🇬🇧 English", data: cb("lang", "set", "en") },
      { text: "🇮🇩 Indonesia", data: cb("lang", "set", "id") },
    ],
    ...(backTarget ? [backRow(lang, backTarget)] : []),
  ]);
}

// ---------------------------------------------------------------------------
// Display currency (/start onboarding, after language)
// ---------------------------------------------------------------------------

/** Display-currency picker; `backTarget` as for {@link languageKb}. */
export function currencyKb(lang = "en", backTarget?: string): InlineKeyboard {
  return ik([
    [
      { text: `🇺🇸 ${coreT("currency.usd", lang)}`, data: cb("cur", "set", "USD") },
      { text: `🇮🇩 ${coreT("currency.idr", lang)}`, data: cb("cur", "set", "IDR") },
    ],
    ...(backTarget ? [backRow(lang, backTarget)] : []),
  ]);
}

// ---------------------------------------------------------------------------
// Help Center hub
// ---------------------------------------------------------------------------

/** Help Center hub keyboard — one feature button per row, then one Back to the
 * main menu (its parent; no duplicate Menu button). */
export function helpCenterKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("help.referral_btn", lang), data: cb("ref", "view") }],
    [{ text: coreT("help.language_btn", lang), data: cb("lang", "menu") }],
    [{ text: coreT("help.currency_btn", lang), data: cb("cur", "menu") }],
    [{ text: coreT("help.faq_btn", lang), data: cb("page", "faq") }],
    [{ text: coreT("help.terms_btn", lang), data: cb("page", "terms") }],
    [{ text: coreT("help.support_btn", lang), data: cb("support", "open") }],
    [{ text: coreT("help.tickets_btn", lang), data: cb("ticket", "list") }],
    backRow(lang, MENU_MAIN),
  ]);
}

// formatPrice re-exported so handlers/keyboards share one import site.
export { formatPrice };
