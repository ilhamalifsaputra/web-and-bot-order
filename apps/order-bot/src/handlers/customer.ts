/**
 * Customer-facing navigation handlers — port of customer.py (non-conversation
 * parts; the review + ticket-reply conversations live in src/conversations/).
 *
 * In PTB these were reached either as CommandHandlers or dispatched from
 * callbacks.py. Here they are plain `(ctx) => Promise<void>` functions; the
 * callback router (callbacks.ts) and main.ts wire them up. State that used to
 * live in `context.user_data` now lives on `ctx.session` (scratch + fields).
 */
import { InputFile } from "grammy";
import { config } from "@app/core/config";
import { botUsername } from "@app/core/runtime";
import { Decimal } from "@app/core/money";
import { ensureUtc, localize } from "@app/core/datetime";
import { UserRole, OrderStatus, TicketStatus, SenderType } from "@app/core/enums";
import { logger } from "@app/core/logger";
import {
  prisma,
  upsertUser,
  botOverallStats,
  userTotalSpent,
  listCatalogProducts,
  getCatalogProductWithDenominations,
  getDenomination,
  getDenominationWithProduct,
  countAvailableStock,
  getBulkPricingForDenomination,
  countUserOrders,
  listUserOrders,
  getOrder,
  getUser,
  setUserLanguage,
  subscribeToRestock,
  productRating,
  getSetting,
  setSetting,
  searchCatalog,
  listUserTickets,
  getTicket,
  listTicketMessages,
} from "@app/db";
import { BotState, type MyContext } from "../context";
import { smartEdit, renderMenu } from "../util/chat";
import { BANNER_IMAGE_KEY, BANNER_FILEID_KEY, bannerPhotoArg } from "../util/banner";
import { t } from "../util/i18n";
import { logErrorRef } from "../util/errors";
import { esc, formatPrice, formatIdr, statusBadge, groupOrderItems, formatCountdown, priceIdr, orderAmount, mixedAmount } from "../util/format";
import { currentUsdtRate } from "../util/rate";
import * as ckb from "../keyboards/customer";
import { showFaq, showTerms } from "./static";

const PAGE_SIZE = 10;
// USDT-denominated figures only (wallet balance, commissions). Catalog prices
// are central Rupiah — use priceIdr(v, rate); order totals — orderAmount(o).
const price = (v: Decimal.Value, decimals = 2) => formatPrice(v, "USDT", decimals);

// --- session scratch accessors (mirror context.user_data keys) -------------
// browseEntries snapshots the mid-tier Product ids on the current page (the new
// flat catalog has no "group vs product" kind — every list row is a Product).
// variantId tracks which Denomination's (SKU/"variant") detail bubble is shown,
// and productId the parent Product whose picker we came from (so Back on the
// detail bubble returns to the picker, not all the way to the list). The order-
// flow fields (quantity/paymentMethod/invoiceId/orderId) mirror the single-bubble
// UX spec (botui.txt) — set when a buyNow* creates the order, source of truth for
// redraws not driven by a fresh callback (e.g. cancel→detail).
interface BrowseScratch {
  page?: number;
  browseEntries?: number[];
  productId?: number;
  variantId?: number;
  quantity?: number;
  paymentMethod?: string;
  invoiceId?: string;
  orderId?: number;
}
const sc = (ctx: MyContext) => ctx.session.scratch as BrowseScratch & Record<string, unknown>;

function requireUser(ctx: MyContext) {
  const u = ctx.session.dbUser;
  if (!u) throw new Error("customer handler reached without a registered user");
  return u;
}

// ---------------------------------------------------------------------------
// /start + dashboard
// ---------------------------------------------------------------------------

// Optional banner shown above the main menu and product list. The value is a
// web-admin upload path or a legacy Telegram file_id; uploads are sent via
// InputFile and the resulting file_id is cached (util/banner.ts).
async function bannerArg(): Promise<{ photo: string | InputFile; needsCache: boolean } | undefined> {
  const [value, cached] = await Promise.all([
    getSetting(prisma, BANNER_IMAGE_KEY),
    getSetting(prisma, BANNER_FILEID_KEY),
  ]);
  return bannerPhotoArg(value, cached);
}

const cacheBannerFileId = async (fileId: string): Promise<void> => {
  await setSetting(prisma, BANNER_FILEID_KEY, fileId);
};

/** renderMenu with the configured banner (if any) + file_id caching. */
async function renderMenuBanner(
  ctx: MyContext,
  text: string,
  replyMarkup: Parameters<typeof renderMenu>[2],
): Promise<void> {
  const b = await bannerArg();
  await renderMenu(ctx, text, replyMarkup, b?.photo, b?.needsCache ? cacheBannerFileId : undefined);
}

async function buildDashboardText(ctx: MyContext): Promise<string> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const tg = ctx.from!;
  const name = esc([tg.first_name, tg.last_name].filter(Boolean).join(" ") || tg.username || "");

  const stats = await botOverallStats(prisma);
  const spent = await userTotalSpent(prisma, info.id);

  const nowStr = localize(new Date(), "cccc, dd LLLL yyyy HH:mm:ss");

  return t(ctx, "start.dashboard", {
    name,
    now: nowStr,
    tg_id: tg.id,
    username: tg.username ? `@${tg.username}` : "—",
    spent: mixedAmount(spent.idr, spent.usdt),
    items_sold: stats.items_sold,
    total_revenue: mixedAmount(stats.revenue_idr, stats.revenue_usdt),
    total_users: stats.total_users,
  });
}

async function backToMainFromPersistent(ctx: MyContext): Promise<void> {
  ctx.session.state = BotState.HOME;
  delete sc(ctx).productId;
  delete sc(ctx).variantId;
  ctx.session.awaitingQtyDenomId = undefined;
  const text = await buildDashboardText(ctx);
  await renderMenuBanner(ctx, text, ckb.mainPersistentKb(ctx.session.lang));
}

async function handleBackButton(ctx: MyContext): Promise<void> {
  const qtyDenomId = ctx.session.awaitingQtyDenomId;
  if (qtyDenomId != null) {
    ctx.session.awaitingQtyDenomId = undefined;
    await browseDenomination(ctx, qtyDenomId);
    return;
  }
  // Viewing a denomination detail → step back to its parent product's picker.
  if (sc(ctx).variantId != null && sc(ctx).productId != null) {
    await browseProduct(ctx, sc(ctx).productId!);
    return;
  }
  // Viewing a picker (product but no denomination) → back to the product list.
  if (sc(ctx).productId != null) {
    await browseProductsFlat(ctx);
    return;
  }
  // Viewing a collapsed/deep-link detail (denomination but no parent picker) →
  // back to the product list, not the main menu (don't strand the user).
  if (sc(ctx).variantId != null) {
    await browseProductsFlat(ctx);
    return;
  }
  await backToMainFromPersistent(ctx);
}

export async function startCommand(ctx: MyContext): Promise<void> {
  const tg = ctx.from!;
  ctx.session.awaitingQtyDenomId = undefined;

  const args = (ctx.match && typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/).filter(Boolean);
  if (args.length && args[0]!.startsWith("ref_")) {
    const code = args[0]!.slice(4);
    await upsertUser(prisma, {
      telegramId: tg.id,
      username: tg.username ?? null,
      fullName: [tg.first_name, tg.last_name].filter(Boolean).join(" ") || null,
      referredByCode: code,
    });
  }

  // Deep-link: t.me/<bot>?start=prod_<id> → open a denomination detail bubble
  // directly (the id is a Denomination/SKU id, as used in share links).
  if (args.length && args[0]!.startsWith("prod_")) {
    const denomId = parseInt(args[0]!.slice(5), 10);
    if (!isNaN(denomId)) {
      await browseDenomination(ctx, denomId);
      return;
    }
  }

  delete sc(ctx).browseEntries;
  delete sc(ctx).page;

  ctx.session.state = BotState.HOME;
  const text = await buildDashboardText(ctx);
  await renderMenuBanner(ctx, text, ckb.mainPersistentKb(ctx.session.lang));
}

export async function showMainMenu(ctx: MyContext): Promise<void> {
  ctx.session.state = BotState.HOME;
  const text = await buildDashboardText(ctx);
  await renderMenuBanner(ctx, text, ckb.mainPersistentKb(ctx.session.lang));
}

// Universal /cancel when no conversation is active.
export async function cancelCommand(ctx: MyContext): Promise<void> {
  ctx.session.scratch = {};
  ctx.session.awaitingQtyDenomId = undefined;
  await ctx.reply(t(ctx, "conv.cancelled_idle"));
  await startCommand(ctx);
}

// ---------------------------------------------------------------------------
// Browse — flat product list with persistent reply keyboard
// ---------------------------------------------------------------------------

export async function browseProductsFlat(ctx: MyContext, page = 0): Promise<void> {
  const lang = ctx.session.lang;

  // Flat list of mid-tier Products (each with ≥1 active denomination). No
  // category browsing and no group/product collapse — every row is a Product.
  const products = await listCatalogProducts(prisma);
  if (!products.length) {
    await smartEdit(ctx, t(ctx, "browse.no_products"), ckb.backToMain(lang));
    return;
  }

  const totalPages = Math.max(1, Math.ceil(products.length / PAGE_SIZE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const start = page * PAGE_SIZE;
  const pageProducts = products.slice(start, start + PAGE_SIZE);

  ctx.session.state = BotState.PRODUCT_LIST;
  sc(ctx).page = page;
  sc(ctx).browseEntries = pageProducts.map((p) => p.id);
  delete sc(ctx).productId;
  delete sc(ctx).variantId;

  // Selection is resolved against the browseEntries snapshot (see handleProductNumber).
  const itemLines = pageProducts.map((p, i) => `${i + 1}. ${esc(p.name)}`);

  const text = t(ctx, "browse.list_decorated", {
    page: page + 1,
    total: totalPages,
    items: itemLines.join("\n"),
  });

  // The numbered keyboard is a reply keyboard; renderMenu sends a fresh message
  // carrying it (an edit can't bear a reply keyboard). The banner (if set) rides
  // on top as a photo+caption, unless the list is too long for a caption.
  await renderMenuBanner(
    ctx,
    text,
    ckb.productsPersistentKb(pageProducts.length, lang, {
      showPrev: page > 0,
      showNext: page < totalPages - 1,
      showBack: false,
    }),
  );
}

export async function handleProductNumber(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const text = (ctx.message?.text ?? "").trim();

  // Resolve the tapped reply-keyboard label to a stable action, checking the
  // label set of every supported language (the keyboard is localized, so a
  // literal English compare would miss Indonesian labels). null → not a button.
  const action = ckb.matchPersistentLabel(text);

  // Manual quantity input mode — only divert free text, never a menu button.
  const qtyDenomId = ctx.session.awaitingQtyDenomId;
  if (qtyDenomId != null && action === null) {
    await handleQtyTextInput(ctx, qtyDenomId, text);
    return;
  }

  if (action === "back") {
    await handleBackButton(ctx);
    return;
  }

  if (action !== null) {
    ctx.session.awaitingQtyDenomId = undefined;
    delete sc(ctx).productId;
    delete sc(ctx).variantId;
  }

  switch (action) {
    case "prev":
      return void (await browseProductsFlat(ctx, Math.max(0, (sc(ctx).page ?? 0) - 1)));
    case "next":
      return void (await browseProductsFlat(ctx, (sc(ctx).page ?? 0) + 1));
    case "browse":
      return void (await browseProductsFlat(ctx));
    case "orders":
      return void (await listMyOrders(ctx));
    case "wallet":
      return void (await viewWallet(ctx));
    case "referral":
      return void (await viewReferral(ctx));
    case "language":
      return void (await showLanguageMenu(ctx));
    case "faq":
      return void (await showFaq(ctx));
    case "terms":
      return void (await showTerms(ctx));
    case "tickets":
      return void (await listMyTickets(ctx));
    case "main":
      return void (await backToMainFromPersistent(ctx));
    case "support":
      // Support is entered via the conversation `hears` trigger in main.ts, not
      // here; if it ever reaches this handler, ignore it (no number selection).
      return;
  }

  // Number buttons — entry selection. Only short digit strings.
  if (!/^\d+$/.test(text) || text.length > 4) return;

  // Resolve against the SNAPSHOT captured when the list was rendered, so a
  // catalog change between render and tap can't shift the numbering. Each entry
  // is a mid-tier Product id.
  let entries = sc(ctx).browseEntries ?? [];
  if (!entries.length) {
    const all = await listCatalogProducts(prisma);
    const page = sc(ctx).page ?? 0;
    const startIdx = page * PAGE_SIZE;
    entries = all.slice(startIdx, startIdx + PAGE_SIZE).map((p) => p.id);
    sc(ctx).browseEntries = entries;
  }

  if (!entries.length) {
    await smartEdit(ctx, t(ctx, "browse.no_products"), ckb.backToMain(lang));
    return;
  }

  const idx = parseInt(text, 10);
  if (idx < 1 || idx > entries.length) {
    await smartEdit(ctx, t(ctx, "browse.invalid_number", { max: entries.length }), ckb.backToMain(lang));
    return;
  }

  const productId = entries[idx - 1]!;
  logger.debug(`handle_product_number: user selected idx=${idx} product=${productId}`);
  await browseProduct(ctx, productId);
}

/**
 * Tap a mid-tier Product → its Denomination picker. A Product with exactly ONE
 * active denomination collapses straight to that denomination's detail bubble
 * (skip a pointless 1-item picker, mirroring the old single-member group
 * collapse); ≥2 active denominations render the picker.
 */
export async function browseProduct(ctx: MyContext, productId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const product = await getCatalogProductWithDenominations(prisma, productId);
  const active = (product?.denominations ?? []).filter((d) => d.isActive);
  if (!product || active.length === 0) {
    // Product emptied/deactivated between render and tap — don't strand the user.
    await smartEdit(ctx, t(ctx, "browse.no_products"), ckb.backToMain(lang));
    return;
  }

  // Single-denomination collapse threshold: exactly 1 active denomination skips
  // the picker and lands on the detail bubble. Leave viewingProductId UNSET —
  // no picker was rendered, so the detail's Back must escape to the product list
  // (a browse:pick Back would re-collapse to this same detail and strand the user).
  if (active.length === 1) {
    delete sc(ctx).productId;
    await browseDenomination(ctx, active[0]!.id);
    return;
  }

  sc(ctx).productId = productId;
  delete sc(ctx).variantId;
  const isReseller = info.role === UserRole.RESELLER;
  const rate = await currentUsdtRate();
  const text = t(ctx, "browse.choose_denomination", { name: esc(product.name) });
  await smartEdit(ctx, text, ckb.denominationPickerKb(active, lang, rate, isReseller));
}

/**
 * Denomination detail bubble (the leaf SKU): Product / Plan / Price / Stock +
 * qty stepper + Buy + Back. Back returns to the parent Product's picker when we
 * came from one (`viewingProductId`), else to the flat product list. The `buy`,
 * `qty` and `restock` callbacks all key off the denomination id (= the SKU the
 * money/stock flow uses).
 */
export async function browseDenomination(ctx: MyContext, denominationId: number, qty = 1): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  let d: Awaited<ReturnType<typeof getDenominationWithProduct>>;
  let stock: number;
  let ratingStr: string;
  let bulkRule: Awaited<ReturnType<typeof getBulkPricingForDenomination>>;
  try {
    d = await getDenominationWithProduct(prisma, denominationId);
    if (d === null) {
      logger.warn(`browse_denomination: denomination_id=${denominationId} not found`);
      // Expected-but-rare (denomination deleted/deactivated between render and
      // tap) — transient copy, no ref. Forward action so it isn't a dead end.
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.try_again"), show_alert: true });
      else await smartEdit(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
      return;
    }
    stock = await countAvailableStock(prisma, d.id);
    const { avg, count } = await productRating(prisma, d.id);
    ratingStr = avg ? `${avg.toFixed(1)}/5 (${count})` : "—";
    bulkRule = await getBulkPricingForDenomination(prisma, d.id);
  } catch (err) {
    // Hard failure (unexpected DB error) — log under a ref and quote it so a
    // customer report maps to the stack trace (§8.6). Forward action (§8.7).
    const ref = logErrorRef(err, `browse_denomination: DB error for denomination_id=${denominationId}`);
    const text = t(ctx, "error.generic_ref", { ref });
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text, show_alert: true });
    else await smartEdit(ctx, text, ckb.backToMain(lang));
    return;
  }

  const isReseller = info.role === UserRole.RESELLER;
  const unit = isReseller && d.resellerPrice != null ? d.resellerPrice : d.price;

  let text = t(ctx, "browse.denomination_detail", {
    product: esc(d.product.name),
    plan: esc(d.name),
    price: priceIdr(unit, await currentUsdtRate()),
    duration: esc(d.durationLabel),
    type: d.type.toLowerCase(),
    warranty: d.warrantyDays,
    stock,
    rating: ratingStr,
  });
  if (bulkRule) {
    text +=
      "\n\n" +
      t(ctx, "browse.bulk_deal", {
        min_qty: bulkRule.minQuantity,
        percent: bulkRule.discountPercent,
      });
  }

  // Parent product for Back navigation: the picker we came from, or null when no
  // picker was shown (collapse / deep-link) so Back falls through to the flat
  // product list per denominationDetailKb's contract — never to a product that
  // would immediately re-collapse to this same detail.
  const parentProductId = sc(ctx).productId ?? null;
  await smartEdit(ctx, text, ckb.denominationDetailKb(d, stock, lang, qty, parentProductId));
  ctx.session.state = BotState.PRODUCT_DETAIL;
  sc(ctx).variantId = denominationId;
  sc(ctx).quantity = qty;
}

// ---------------------------------------------------------------------------
// Manual quantity input
// ---------------------------------------------------------------------------

export async function qtyInputStart(ctx: MyContext, denominationId: number): Promise<void> {
  const lang = ctx.session.lang;
  const d = await getDenomination(prisma, denominationId);
  if (d === null) {
    await smartEdit(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
    return;
  }
  const stock = await countAvailableStock(prisma, d.id);
  if (stock <= 0) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "browse.out_of_stock"), show_alert: true });
    return;
  }
  await smartEdit(ctx, t(ctx, "browse.qty_input_prompt", { max: stock }), ckb.qtyInputCancelKb(denominationId, lang));
  ctx.session.awaitingQtyDenomId = denominationId;
}

export async function qtyInputCancel(ctx: MyContext, denominationId: number): Promise<void> {
  ctx.session.awaitingQtyDenomId = undefined;
  await browseDenomination(ctx, denominationId);
}

async function handleQtyTextInput(ctx: MyContext, denominationId: number, rawText: string): Promise<void> {
  const lang = ctx.session.lang;
  const d = await getDenomination(prisma, denominationId);
  if (d === null) {
    ctx.session.awaitingQtyDenomId = undefined;
    await smartEdit(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
    return;
  }
  const stock = await countAvailableStock(prisma, d.id);

  const isValid = /^\d+$/.test(rawText) && parseInt(rawText, 10) >= 1;
  if (!isValid || parseInt(rawText, 10) > stock) {
    await smartEdit(ctx, t(ctx, "browse.qty_input_invalid", { max: stock }), ckb.qtyInputCancelKb(denominationId, lang));
    ctx.session.awaitingQtyDenomId = denominationId;
    return;
  }

  ctx.session.awaitingQtyDenomId = undefined;
  await browseDenomination(ctx, denominationId, parseInt(rawText, 10));
}

export async function qtyChange(
  ctx: MyContext,
  denominationId: number,
  qty: number,
  action: string,
): Promise<void> {
  const d = await getDenomination(prisma, denominationId);
  if (d === null) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
    return;
  }
  const stock = await countAvailableStock(prisma, d.id);
  const newQty = action === "inc" ? Math.min(qty + 1, stock) : Math.max(qty - 1, 1);
  await browseDenomination(ctx, denominationId, newQty);
}

// ---------------------------------------------------------------------------
// My orders
// ---------------------------------------------------------------------------

export async function listMyOrders(ctx: MyContext): Promise<void> {
  ctx.session.state = BotState.HISTORY;
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const orders = await listUserOrders(prisma, info.id, 10, 0);

  if (!orders.length) {
    await smartEdit(ctx, t(ctx, "order.list_empty"), ckb.backToMain(lang));
    return;
  }

  const lines = [t(ctx, "order.list_title", { count: orders.length }), ""];
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]!;
    const groups = groupOrderItems(o.items);
    const g = groups[0];
    lines.push(
      t(ctx, "order.list_entry", {
        n: i + 1,
        code: o.orderCode,
        status: statusBadge(o.status),
        product: g ? esc(g.product.name) : "-",
        duration: g ? esc(g.product.durationLabel) : "-",
        type: g ? esc(g.product.type) : "-",
        qty: g ? String(g.quantity) : "-",
        total: orderAmount(o),
        time: ensureUtc(o.createdAt).toFormat("dd/LL/yyyy HH:mm"),
      }),
    );
    lines.push("");
  }
  await smartEdit(ctx, lines.join("\n"), ckb.ordersListKb(orders, lang));
}

export async function allOrderHistory(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const orders = await listUserOrders(prisma, info.id, 100, 0);

  if (!orders.length) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "order.history_empty"), show_alert: true });
    return;
  }

  const lines: string[] = [`=== ${t(ctx, "order.history_file_header")} ===`, t(ctx, "order.history_file_count", { count: orders.length }), ""];
  for (const o of orders) {
    lines.push(`${t(ctx, "order.history_file_order")}: ${o.orderCode}`);
    lines.push(`Status: ${o.status}`);
    lines.push(`${t(ctx, "order.history_file_date")}: ${ensureUtc(o.createdAt).toFormat("dd/LL/yyyy HH:mm")}`);
    lines.push(`${t(ctx, "order.history_file_amount")}: ${orderAmount(o)}`);
    lines.push(`${t(ctx, "order.history_file_items")}:`);
    for (const g of groupOrderItems(o.items)) {
      lines.push(`  - ${g.product.name} × ${g.quantity}  ${formatIdr(g.lineTotal)}`);
    }
    lines.push("-".repeat(36));
  }

  const buf = Buffer.from(lines.join("\n"), "utf-8");
  if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  await ctx.api.sendDocument(ctx.chat!.id, new InputFile(buf, "riwayat_order.txt"), {
    caption: t(ctx, "order.all_history_caption", { count: orders.length }),
  });
}

export async function viewOrder(ctx: MyContext, orderId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const order = await getOrder(prisma, orderId);
  if (order === null || order.userId !== info.id) {
    await smartEdit(ctx, t(ctx, "error.order_not_found"), ckb.backToMain(lang));
    return;
  }

  // Item lines show the central-IDR snapshot (+ USDT info); the charged total
  // renders in the order's own transaction currency.
  const rate = await currentUsdtRate();
  const itemLines = groupOrderItems(order.items).map(
    (g) => `• ${esc(g.product.name)} × ${g.quantity} — ${priceIdr(g.lineTotal, rate)}`,
  );

  let text: string;
  if (order.status === OrderStatus.PENDING_PAYMENT) {
    const binanceId = (await getSetting(prisma, "binance_pay_id")) || config.BINANCE_PAY_ID;
    const countdown = order.expiresAt ? formatCountdown(order.expiresAt) : `${config.PAYMENT_WINDOW_MINUTES}:00`;
    text = t(ctx, "order.pending_payment_detail", {
      code: order.orderCode,
      lines: itemLines.join("\n"),
      total: orderAmount(order, 4),
      binance_id: esc(binanceId),
      countdown,
    });
  } else {
    let credentialsBlock = "";
    if (order.status === OrderStatus.DELIVERED) {
      const groups: Array<[string, string[]]> = [];
      const idx = new Map<number, number>();
      for (const it of order.items) {
        if (!it.stockItem) continue;
        if (!idx.has(it.productId)) {
          idx.set(it.productId, groups.length);
          groups.push([it.product.name, []]);
        }
        groups[idx.get(it.productId)!]![1].push(it.stockItem.credentials);
      }
      if (groups.length) {
        const blocks = groups
          .map(([name, creds]) => `${esc(name)}\n<pre>${esc(creds.join("\n"))}</pre>`)
          .join("\n\n");
        credentialsBlock = `\n\n${t(ctx, "order.detail_credentials", { credentials: blocks })}`;
      }
    }
    text =
      t(ctx, "order.detail", {
        code: order.orderCode,
        status: statusBadge(order.status),
        total: orderAmount(order),
        created: ensureUtc(order.createdAt).toFormat("yyyy-LL-dd HH:mm 'UTC'"),
        lines: itemLines.join("\n"),
      }) + credentialsBlock;
  }
  await smartEdit(ctx, text, ckb.orderDetailKb(order, lang));
}

// Removed: per-order review, replacement, and the old delivered-only history
// download. The single "Lihat Semua Riwayat" button now drives allOrderHistory.

// ---------------------------------------------------------------------------
// Wallet / Referral / Language / Restock
// ---------------------------------------------------------------------------

export async function viewWallet(ctx: MyContext): Promise<void> {
  ctx.session.state = BotState.BALANCE;
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const user = await getUser(prisma, info.id);
  const idrBalance = user ? user.walletBalance : new Decimal(0);
  const usdtBalance = user ? user.walletBalanceUsdt : new Decimal(0);
  let text = t(ctx, "wallet.credit_balances", {
    idr: formatIdr(idrBalance),
    usdt: price(usdtBalance),
  });
  text += "\n\n" + t(ctx, "wallet.topup_info");
  await smartEdit(ctx, text, ckb.backToMain(lang));
}

export async function viewReferral(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const code = info.referralCode ?? "";
  const link = `https://t.me/${botUsername() ?? ""}?start=ref_${code}`;

  const agg = await prisma.referral.aggregate({
    where: { referrerId: info.id },
    _count: { id: true },
    _sum: { commission: true },
  });

  const text = t(ctx, "referral.info", {
    percent: String(config.REFERRAL_COMMISSION_PERCENT),
    link,
    count: agg._count.id ?? 0,
    earned: price(new Decimal(agg._sum.commission ?? 0)),
  });
  await smartEdit(ctx, text, ckb.backToMain(lang));
}

export async function showLanguageMenu(ctx: MyContext): Promise<void> {
  await smartEdit(ctx, t(ctx, "language.choose"), ckb.languageKb());
}

export async function setLanguage(ctx: MyContext, code: string): Promise<void> {
  const info = requireUser(ctx);
  await setUserLanguage(prisma, info.id, code);
  info.language = code.toUpperCase();
  ctx.session.lang = code.toLowerCase();
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "language.set") });
  await showMainMenu(ctx);
}

export async function subscribeRestock(ctx: MyContext, denominationId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const isNew = await subscribeToRestock(prisma, info.id, denominationId);
  const msg = t(ctx, isNew ? "browse.subscribed_restock" : "browse.already_subscribed");
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg });
  // Edit the denomination bubble into a confirmation so the tap leaves a visible
  // trace, instead of an ephemeral toast that vanishes on the next interaction.
  await smartEdit(ctx, msg, ckb.restockSubscribedKb(denominationId, lang));
}

// ---------------------------------------------------------------------------
// My Tickets (user-side ticket history)
// ---------------------------------------------------------------------------

export async function listMyTickets(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const tickets = await listUserTickets(prisma, info.id);
  if (!tickets.length) {
    await smartEdit(ctx, t(ctx, "ticket.list_empty"), ckb.backToMain(lang));
    return;
  }
  await smartEdit(ctx, t(ctx, "ticket.list_title"), ckb.myTicketsKb(tickets, lang));
}

export async function viewMyTicket(ctx: MyContext, ticketId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const ticket = await getTicket(prisma, ticketId);
  if (ticket === null || ticket.userId !== info.id) {
    await smartEdit(ctx, t(ctx, "error.ticket_not_found"), ckb.backToMain(lang));
    return;
  }
  const messages = await listTicketMessages(prisma, ticketId, 10);

  const statusLabels: Record<string, string> = {
    [TicketStatus.OPEN]: "Open",
    [TicketStatus.REPLIED]: "Replied",
    [TicketStatus.CLOSED]: "Closed",
  };
  const header = t(ctx, "ticket.view_title", {
    id: ticketId,
    status: statusLabels[ticket.status] ?? ticket.status,
    date: ensureUtc(ticket.createdAt).toFormat("yyyy-LL-dd HH:mm"),
  });

  const parts = [header, ""];
  if (messages.length) {
    for (const msg of messages) {
      const timeStr = ensureUtc(msg.createdAt).toFormat("HH:mm dd/LL");
      const key = msg.senderType === SenderType.USER ? "ticket.message_user" : "ticket.message_admin";
      parts.push(t(ctx, key, { time: timeStr, content: esc(msg.content) }));
    }
  } else {
    parts.push(
      t(ctx, "ticket.message_user", {
        time: ensureUtc(ticket.createdAt).toFormat("HH:mm dd/LL"),
        content: esc(ticket.message),
      }),
    );
    if (ticket.adminReply) {
      const replyTime = ticket.repliedAt ? ensureUtc(ticket.repliedAt).toFormat("HH:mm dd/LL") : "—";
      parts.push(t(ctx, "ticket.message_admin", { time: replyTime, content: esc(ticket.adminReply) }));
    }
  }

  await smartEdit(ctx, parts.join("\n\n"), ckb.ticketViewKb(ticketId, ticket.status, lang));
}

// ---------------------------------------------------------------------------
// Shortcut commands
// ---------------------------------------------------------------------------

export async function listprodukCommand(ctx: MyContext): Promise<void> {
  ctx.session.awaitingQtyDenomId = undefined;
  await browseProductsFlat(ctx, 0);
}

export async function languageCommand(ctx: MyContext): Promise<void> {
  ctx.session.awaitingQtyDenomId = undefined;
  await showLanguageMenu(ctx);
}

export async function searchCommand(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const query = (typeof ctx.match === "string" ? ctx.match : "").trim();
  if (!query) {
    await smartEdit(ctx, t(ctx, "search.no_query"), ckb.backToMain(lang));
    return;
  }
  const products = await searchCatalog(prisma, query);
  if (!products.length) {
    await smartEdit(ctx, t(ctx, "search.no_results", { query: esc(query) }), ckb.backToMain(lang));
    return;
  }
  await smartEdit(
    ctx,
    t(ctx, "search.results", { query: esc(query), count: products.length }),
    ckb.searchResultsKb(products, lang),
  );
}
