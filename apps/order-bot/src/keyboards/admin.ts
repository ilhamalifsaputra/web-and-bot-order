/**
 * Admin-panel inline keyboards — port of admin_kb.py.
 *
 * Callback namespace: all admin callbacks use the `v1:adm:*` prefix to keep
 * them separate from customer callbacks (`v1:browse:*`, `v1:order:*`, ...).
 */
import { InlineKeyboard } from "grammy";
import type { Decimal } from "@app/core/money";
import { StockStatus } from "@app/core/enums";
import { t as coreT } from "@app/core/i18n";
import { cb } from "./customer";
import { formatPrice, truncLabel } from "../util/format";

interface Btn {
  text: string;
  data?: string;
}
function ik(rows: Btn[][]): InlineKeyboard {
  return InlineKeyboard.from(
    rows.map((row) => row.map((b) => InlineKeyboard.text(b.text, b.data ?? cb("noop")))),
  );
}

interface ProductLike {
  id: number;
  name: string;
  price: Decimal.Value;
}
interface OrderLike {
  id: number;
  orderCode: string;
  totalAmount: Decimal.Value;
}
interface StockItemLike {
  id: number;
  status: string;
}
interface TicketLike {
  id: number;
  status: string;
  userId: number;
}
interface UserLike {
  id: number;
  username: string | null;
  fullName: string | null;
  telegramId: bigint | string | number | null;
}

// ---------------------------------------------------------------------------
// Top-level admin menu
// ---------------------------------------------------------------------------

export function adminMenu(lang: string, pendingCount = 0): InlineKeyboard {
  return ik([
    [
      { text: coreT("admin.dashboard", lang), data: cb("adm", "dash") },
      {
        text: coreT("admin.verifications", lang, { count: pendingCount }),
        data: cb("adm", "verif", "list"),
      },
    ],
    [
      { text: coreT("admin.products", lang), data: cb("adm", "prod", "menu") },
      { text: coreT("admin.stock", lang), data: cb("adm", "stock", "menu") },
    ],
    [
      { text: coreT("admin.vouchers", lang), data: cb("adm", "vouch", "menu") },
      { text: coreT("admin.users", lang), data: cb("adm", "users", "menu") },
    ],
    [
      { text: coreT("admin.broadcast", lang), data: cb("adm", "broadcast", "start") },
      { text: coreT("admin.reports", lang), data: cb("adm", "reports", "menu") },
    ],
    [
      { text: coreT("admin.tickets", lang), data: cb("adm", "ticket", "menu") },
      { text: coreT("admin.settings", lang), data: cb("adm", "settings", "menu") },
    ],
  ]);
}

export function backToAdminKb(lang: string): InlineKeyboard {
  return ik([[{ text: coreT("menu.back", lang), data: cb("adm", "menu") }]]);
}

/** Shown to admin after approval when the buyer DM failed — one-tap retry. */
export function approvedResendKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [{ text: coreT("admin.resend_credentials", lang), data: cb("adm", "verif", "resend", orderId) }],
    [{ text: coreT("menu.back", lang), data: cb("adm", "menu") }],
  ]);
}

// ---------------------------------------------------------------------------
// Verification queue
// ---------------------------------------------------------------------------

export function verificationQueueKb(orders: OrderLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = orders.map((o) => [
    { text: `🔎 ${o.orderCode} — ${formatPrice(o.totalAmount)}`, data: cb("adm", "verif", "view", o.id) },
  ]);
  rows.push([{ text: coreT("menu.back", lang), data: cb("adm", "menu") }]);
  return ik(rows);
}

export function verificationActionsKb(orderId: number, lang: string): InlineKeyboard {
  return ik([
    [
      { text: coreT("admin.approve", lang), data: cb("adm", "verif", "approve", orderId) },
      { text: coreT("admin.reject", lang), data: cb("adm", "verif", "reject", orderId) },
    ],
    [{ text: coreT("menu.back", lang), data: cb("adm", "verif", "list") }],
  ]);
}

// ---------------------------------------------------------------------------
// Stock management
// ---------------------------------------------------------------------------

export function stockProductsKb(products: ProductLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = products.map((p) => [
    { text: `➕ ${truncLabel(p.name, 22)}`, data: cb("adm", "stock", "add", p.id) },
  ]);
  rows.push([{ text: coreT("menu.back", lang), data: cb("adm", "menu") }]);
  return ik(rows);
}

// ---------------------------------------------------------------------------
// Product management
// ---------------------------------------------------------------------------

export function productsAdminKb(products: ProductLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = [[{ text: "➕ New product", data: cb("adm", "prod", "new") }]];
  for (const p of products) {
    const priceStr = formatPrice(p.price);
    // Keep total label ≤ 32 chars: reserve space for " (Rp…)" suffix (~12 chars).
    rows.push([
      { text: `${truncLabel(p.name, 20)} (${priceStr})`, data: cb("adm", "prod", "edit", p.id) },
    ]);
  }
  rows.push([{ text: coreT("menu.back", lang), data: cb("adm", "menu") }]);
  return ik(rows);
}

// ---------------------------------------------------------------------------
// Voucher management
// ---------------------------------------------------------------------------

export function vouchersAdminKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: "➕ New voucher", data: cb("adm", "vouch", "new") }],
    [{ text: "📋 List vouchers", data: cb("adm", "vouch", "list") }],
    [{ text: coreT("menu.back", lang), data: cb("adm", "menu") }],
  ]);
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function usersAdminKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: "🔎 Search user", data: cb("adm", "users", "search") }],
    [{ text: coreT("menu.back", lang), data: cb("adm", "menu") }],
  ]);
}

/** List of matched users — each row opens that user's card. */
export function usersSearchResultsKb(users: UserLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = users.map((u) => {
    const label = u.username ? `@${u.username}` : u.fullName || `#${u.id}`;
    return [
      { text: `👤 ${label} (TG ${u.telegramId ?? "web"})`, data: cb("adm", "users", "view", u.id) },
    ];
  });
  rows.push([{ text: coreT("menu.back", lang), data: cb("adm", "menu") }]);
  return ik(rows);
}

export function userActionsKb(
  userId: number,
  opts: { banned: boolean; isReseller: boolean; lang: string },
): InlineKeyboard {
  const { banned, isReseller, lang } = opts;
  return ik([
    [
      {
        text: banned ? "🚫 Unban" : "🚫 Ban",
        data: cb("adm", "users", banned ? "unban" : "ban", userId),
      },
      {
        text: isReseller ? "🛒 Unset reseller" : "🛒 Set reseller",
        data: cb("adm", "users", "reseller", userId, isReseller ? 0 : 1),
      },
    ],
    [{ text: "💰 Adjust wallet", data: cb("adm", "users", "wallet", userId) }],
    [{ text: coreT("menu.back", lang), data: cb("adm", "menu") }],
  ]);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function reportsKb(lang: string): InlineKeyboard {
  return ik([
    [
      { text: "📅 Today", data: cb("adm", "reports", "csv", "today") },
      { text: "📆 7 days", data: cb("adm", "reports", "csv", "week") },
    ],
    [{ text: "🗓 30 days", data: cb("adm", "reports", "csv", "month") }],
    [{ text: coreT("menu.back", lang), data: cb("adm", "menu") }],
  ]);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function settingsKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: "💳 Binance Pay ID", data: cb("adm", "settings", "set", "binance_pay_id") }],
    [{ text: "🖼 QR image", data: cb("adm", "settings", "set", "qr") }],
    [{ text: "📢 Banner image", data: cb("adm", "settings", "set", "banner_image") }],
    [{ text: "👋 Welcome message", data: cb("adm", "settings", "set", "welcome") }],
    [{ text: "📞 Support contact", data: cb("adm", "settings", "set", "support_contact") }],
    [{ text: coreT("menu.back", lang), data: cb("adm", "menu") }],
  ]);
}

// ---------------------------------------------------------------------------
// Generic cancel button (shown while waiting for text input in conversations)
// ---------------------------------------------------------------------------

/** One-button keyboard shown below all text-input prompts so admin can abort. */
export function cancelInputKb(): InlineKeyboard {
  return ik([[{ text: "❌ Cancel", data: cb("adm", "cancel") }]]);
}

/** Shown after banner is removed — one tap undoes it within 30 seconds. */
export function bannerRemovedUndoKb(lang: string): InlineKeyboard {
  return ik([
    [{ text: "↩️ Undo", data: cb("adm", "settings", "undo", "banner_image") }],
    [{ text: coreT("menu.back", lang), data: cb("adm", "menu") }],
  ]);
}

/** Confirm/cancel keyboard shown after admin composes a broadcast. */
export function broadcastConfirmKb(lang: string): InlineKeyboard {
  return ik([
    [
      { text: coreT("admin.broadcast_confirm_btn", lang), data: cb("adm", "broadcast", "confirm") },
      { text: coreT("admin.broadcast_cancel_btn", lang), data: cb("adm", "broadcast", "cancel") },
    ],
  ]);
}

// ---------------------------------------------------------------------------
// Product creation pickers
// ---------------------------------------------------------------------------

/** Shown at product-create entry when an unfinished draft exists. */
export function productDraftResumeKb(): InlineKeyboard {
  return ik([
    [{ text: "▶️ Resume draft", data: cb("adm", "prod", "draft", "resume") }],
    [{ text: "🆕 Start fresh", data: cb("adm", "prod", "draft", "fresh") }],
    [{ text: "❌ Cancel", data: cb("adm", "cancel") }],
  ]);
}

/** Used during product creation to pick shared vs private. */
export function productTypePickerKb(): InlineKeyboard {
  return ik([
    [
      { text: "👥 Shared", data: cb("adm", "prod", "type", "shared") },
      { text: "🔒 Private", data: cb("adm", "prod", "type", "private") },
    ],
    [{ text: "❌ Cancel", data: cb("adm", "prod", "cancel") }],
  ]);
}

/** Single product view with toggle + edit + bulk pricing + stock + back. */
export function productViewKb(productId: number, isActive: boolean, lang: string): InlineKeyboard {
  const toggleLabel = isActive ? "⚪ Deactivate" : "🟢 Activate";
  return ik([
    [
      { text: toggleLabel, data: cb("adm", "prod", "toggle", productId) },
      { text: "✏️ Rename", data: cb("adm", "prod", "rename", productId) },
    ],
    [{ text: "💲 Edit Price", data: cb("adm", "prod", "price", productId) }],
    [
      { text: "💰 Bulk Pricing", data: cb("adm", "bulk", "menu", productId) },
      { text: "📦 Stock Items", data: cb("adm", "prod", "stock", productId) },
    ],
    [{ text: coreT("menu.back", lang), data: cb("adm", "prod", "menu") }],
  ]);
}

/** Stock items list: one 'Mark Dead' button per available/reserved item, then back. */
export function stockItemsKb(
  items: StockItemLike[],
  productId: number,
  lang: string,
): InlineKeyboard {
  const rows: Btn[][] = [];
  for (const it of items) {
    if (it.status === StockStatus.AVAILABLE || it.status === StockStatus.RESERVED) {
      rows.push([
        { text: `💀 Dead #${it.id}`, data: cb("adm", "stockitem", "dead", it.id, productId) },
      ]);
    }
  }
  rows.push([
    { text: coreT("menu.back", lang), data: cb("adm", "prod", "edit", productId) },
  ]);
  return ik(rows);
}

/** Bulk pricing management keyboard for a single product. */
export function bulkPricingKb(productId: number, hasRule: boolean, lang: string): InlineKeyboard {
  const rows: Btn[][] = [
    [{ text: hasRule ? "✏️ Update Rule" : "➕ Add Rule", data: cb("adm", "bulk", "new", productId) }],
  ];
  if (hasRule) {
    rows.push([{ text: "🗑 Delete Rule", data: cb("adm", "bulk", "del", productId) }]);
  }
  rows.push([{ text: coreT("menu.back", lang), data: cb("adm", "prod", "edit", productId) }]);
  return ik(rows);
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------

/** Attached to admin ticket notifications so they can reply or close inline. */
export function ticketReplyKb(ticketId: number, lang: string): InlineKeyboard {
  return ik([
    [
      { text: "💬 Reply", data: cb("adm", "ticket", "reply", ticketId) },
      { text: "🔒 Close", data: cb("adm", "ticket", "close", ticketId) },
    ],
  ]);
}

const ADM_TICKET_ICONS: Record<string, string> = {
  OPEN: "🔴",
  REPLIED: "🟡",
  CLOSED: "⚫",
};

export function ticketsListKb(tickets: TicketLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = tickets.map((tk) => {
    const icon = ADM_TICKET_ICONS[tk.status] ?? "⚪";
    return [
      { text: `${icon} #${tk.id} — user ${tk.userId}`, data: cb("adm", "ticket", "reply", tk.id) },
    ];
  });
  rows.push([{ text: coreT("menu.back", lang), data: cb("adm", "menu") }]);
  return ik(rows);
}
