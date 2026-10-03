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
import { canonicalProduct } from "@app/core/canonicalProduct";
import { presentCanonicalCatalog, boundedCanonicalName } from "../util/canonicalPresenter";
import { noteUnknownUnits } from "../util/unknownUnits";
import { gameTopUpDenomLabel } from "../util/denominationLabel";
import { ensureUtc, localize, addDays } from "@app/core/datetime";
import { UserRole, OrderStatus, OrderKind, PaymentMethod, TicketStatus, SenderType, DeliveryType, CategoryGroup, customerStatusLabel, parseDisplayCurrency } from "@app/core/enums";
import { parseAdditionalFields, parseCustomerData } from "@app/core/deliveryFields";
import { logger } from "@app/core/logger";
import { CUSTOMER_SERVICES } from "@app/core/services";
import {
  prisma,
  userTotalSpent,
  listCatalogProducts,
  listCatalogProductsByGroup,
  listActiveCategoriesByGroup,
  listCategoryGameVariants,
  countCategoryProductsWithoutGameVariant,
  listCategoryGameRegions,
  getCategory,
  soldCountsByProduct,
  getCatalogProductWithDenominations,
  getDenomination,
  getDenominationWithProduct,
  countAvailableStock,
  availableStockCountsByDenomination,
  MAX_CART_ORDER_UNITS,
  getBulkPricingForDenomination,
  countUserOrders,
  listUserOrders,
  getOrder,
  getUser,
  setUserLanguage,
  setUserPreferredCurrency,
  subscribeToRestock,
  productRating,
  soldCountForDenomination,
  soldCountForProduct,
  getSetting,
  getCanonicalRateContext,
  setSetting,
  searchCatalog,
  listUserTickets,
  activeServiceGroups,
  isServiceActive,
  getTicketWithOrder,
  TICKET_REOPEN_WINDOW_DAYS,
  listTicketMessages,
} from "@app/db";
import { BotState, type MyContext } from "../context";
import { smartEdit, renderMenu, consumeInput, menuAnchor } from "../util/chat";
import { BANNER_IMAGE_KEY, BANNER_FILEID_KEY, bannerPhotoArg } from "../util/banner";
import { productPhotoArg, cacheProductPhotoFileId } from "../util/productPhoto";
import { t } from "../util/i18n";
import { logErrorRef } from "../util/errors";
import { gameInputFieldsLabel, resolveGameInputFlags } from "../util/gameInfo";
import { esc, formatUsdtAmount, formatUsdtBalance, formatIdrFor, statusBadge, groupOrderItems, formatCountdown, formatFlashRemaining, priceIdr, ctxPriceFormatter, orderAmount, mixedAmount, renderBybitBscTrackingScreen, summarizeTicketOrder, truncLabel } from "../util/format";
import { effectiveUnitPrice, flashPrice, activeFlashPercent } from "@app/core/flash";
import { currentUsdtRate } from "../util/rate";
import * as ckb from "../keyboards/customer";
import { showFaq, showTerms } from "./static";

const PAGE_SIZE = 10;
// USDT-denominated figures only (wallet balance, commissions). Catalog prices
// are central Rupiah rendered in the buyer's display currency —
// ctxPriceFormatter(ctx, rate).price(v); order totals — orderAmount(o, decimals, lang).
// Every Rupiah/dollar figure takes the buyer's language (formatIdrFor(v, lang)).
const price = (v: Decimal.Value) => formatUsdtAmount(v);

// Bybit BSC's in-flight pre-delivery states — viewOrder() routes these
// through the live tracking screen instead of the generic order.detail path.
// Every other payment method never reaches these (Bybit BSC only).
const BSC_TRACKING_STATUSES: readonly string[] = [
  OrderStatus.PAYMENT_DETECTED,
  OrderStatus.CONFIRMING,
  OrderStatus.CONFIRMED,
];

// Rail label shown on the generic pending-payment screen (viewOrder) — reuses
// the exact copy already shown on the "pick a gateway" buttons
// (checkout.pay_*_btn / usdtMethodsKb), so the wording matches what the buyer
// tapped instead of inventing new copy. BINANCE_PAY (legacy manual transfer,
// retired for new orders) is deliberately absent — it keeps the original
// order.pending_payment_detail text below.
const PENDING_PAYMENT_METHOD_LABEL_KEYS: Partial<Record<string, string>> = {
  [PaymentMethod.BINANCE_INTERNAL]: "checkout.pay_internal_btn",
  [PaymentMethod.BYBIT]: "checkout.pay_bybit_btn",
  [PaymentMethod.BYBIT_BSC]: "checkout.pay_bybit_bsc_btn",
  [PaymentMethod.TOKOPAY]: "checkout.pay_qris_btn",
  [PaymentMethod.PAYDISINI]: "checkout.pay_paydisini_btn",
  [PaymentMethod.NOWPAYMENTS]: "checkout.pay_nowpayments_btn",
};

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
  /** Which numbered list a typed digit currently resolves against — set by
   * whichever of browseProductsFlat / the variant-picker render / the
   * region-picker render ran most recently. Each of those three clears the
   * OTHER two scratch fields (browseEntries / gameVariantEntries /
   * gameRegionEntries) at the same time it sets this, so a stale list can
   * never be read even by accident. Undefined means "products" too — an
   * in-flight session that predates this field never set it, and its only
   * possible numbered screen before this field existed was the product list. */
  activeNumberedScreen?: "products" | "gameVariant" | "gameRegion";
  /** The active Category scope for the flat product list (Products entry
   * flow's third step) — set by browseCategoryEntry, read by
   * browseProductsFlat. Undefined means no category scope (shouldn't
   * normally happen once the group/category picker is the only path into
   * browseProductsFlat, but a deep link or stale session could still land
   * here). */
  categoryId?: number;
  /** The CategoryGroup the active/last-viewed category belongs to — lets
   * handleBackButton return to the right category picker without a DB read. */
  group?: string;
  /** Snapshot of the variant options rendered by the current variant picker
   * (browseCategoryEntry) — pickGameVariant resolves its tapped index
   * against this, the same numbered-snapshot pattern browseEntries uses for
   * the flat product list. */
  gameVariantEntries?: { label: string; emoji: string | null }[];
  /** The Game Top Up variant (Product.gameVariant) resolved for the active
   * browse session — null means "this category has no variant dimension" (0
   * or 1 distinct variant, so the picker was skipped), distinct from
   * undefined (no Game Top Up navigation has happened yet this session). */
  resolvedGameVariant?: string | null;
  /** The resolved variant's emoji (Product.gameVariantEmoji), carried
   * forward from enterGameVariant so browseProduct can prefix it onto each
   * denomination's compact button label without a redundant query. */
  gameVariantEmoji?: string | null;
  /** Snapshot of the region options rendered by the current region picker —
   * pickGameRegion resolves its tapped index against this. */
  gameRegionEntries?: string[];
  /** The Game Top Up region resolved for the active browse session — same
   * null-vs-undefined contract as resolvedGameVariant. */
  resolvedGameRegion?: string | null;
  /** Set true by browseCategoryEntry when the active category is a mixed
   * GAME_TOPUP category (some products carry a gameVariant, some don't):
   * the variant/region pickers are skipped entirely and browseProductsFlat
   * must NOT apply the gameVariant/gameRegion filter, or the labelled
   * products would vanish. Deleted on every non-mixed path. */
  gameVariantDimensionSkipped?: boolean;
  productId?: number;
  /** 0-based picker page browseProduct last rendered for `productId`. */
  productPage?: number;
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

  const spent = await userTotalSpent(prisma, info.id);

  const nowStr = localize(new Date(), "cccc, dd LLLL yyyy HH:mm:ss");

  return t(ctx, "start.dashboard", {
    name,
    now: nowStr,
    tg_id: tg.id,
    username: tg.username ? `@${tg.username}` : "—",
    spent: mixedAmount(spent.idr, spent.usdt, lang),
  });
}

async function backToHome(ctx: MyContext): Promise<void> {
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
    await browseProduct(ctx, sc(ctx).productId!, sc(ctx).productPage ?? 0);
    return;
  }
  // Viewing a picker (product but no denomination) → back to the product list,
  // on the page it was opened from (same as the inline Back, browseResume);
  // browseProductsFlat clamps the page if the list has shrunk since.
  if (sc(ctx).productId != null) {
    await browseProductsFlat(ctx, sc(ctx).page ?? 0);
    return;
  }
  // Viewing a collapsed/deep-link detail (denomination but no parent picker) →
  // back to the product list, not the main menu (don't strand the user).
  if (sc(ctx).variantId != null) {
    await browseProductsFlat(ctx, sc(ctx).page ?? 0);
    return;
  }
  // Viewing a category-scoped product list (nothing deeper in scope) → back to
  // that category's group's category picker, or the group picker itself when
  // the group wasn't recorded (shouldn't normally happen — defensive only).
  if (sc(ctx).categoryId != null) {
    if (sc(ctx).group) {
      // Recomputed fresh, not trusted from a stored "was it skipped" flag
      // (mirrors enterGameRegion's own products.length===1 recheck) — stays
      // correct even if an admin adds/removes a category between screens.
      const categories = await listActiveCategoriesByGroup(prisma, sc(ctx).group!, "bot");
      if (categories.length <= 1) {
        await browseGroups(ctx);
      } else {
        await browseCategoriesInGroup(ctx, sc(ctx).group!);
      }
    } else {
      await browseGroups(ctx);
    }
    return;
  }
  // Premium Apps deliberately skips the category screen. Its flat group list
  // therefore has a group scope but no category scope; Back returns to the
  // service picker instead of treating it as an unscoped Home screen.
  if (sc(ctx).group) {
    await browseGroups(ctx);
    return;
  }
  await backToHome(ctx);
}

/** `t.me/<bot>?start=prod_<id>` → the Denomination/SKU id (share links), or
 * undefined when the command carries no such deep link. */
function deepLinkDenomId(ctx: MyContext): number | undefined {
  const args = (ctx.match && typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/).filter(Boolean);
  if (!args.length || !args[0]!.startsWith("prod_")) return undefined;
  const denomId = parseInt(args[0]!.slice(5), 10);
  return isNaN(denomId) ? undefined : denomId;
}

/**
 * `/start` — runs the language→currency onboarding wizard (setLanguage →
 * setCurrency) only for a user who hasn't finished it yet (no
 * `preferredCurrency` set). A user who already has both goes straight to the
 * Home dashboard, same as `/menu` — re-running the full wizard on every
 * `/start` regardless of prior setup was a real reported bug (every restart
 * forced language+currency again); `/language`/`/currency` remain the
 * dedicated commands for changing either later. A `prod_<id>` deep link is
 * remembered and opened once currency is picked (only reachable for a user
 * still mid-onboarding).
 *
 * `ref_<code>` referral attribution happens in the registeredUser middleware
 * (apps/order-bot/src/middleware.ts), not here: that's what actually creates
 * the User row for a brand-new customer, and it always runs before this
 * handler — upsertUser only ever applies referredByCode on the row's initial
 * creation, so calling it again here would be a no-op every time.
 */
export async function startCommand(ctx: MyContext): Promise<void> {
  ctx.session.awaitingQtyDenomId = undefined;
  delete sc(ctx).browseEntries;
  delete sc(ctx).page;
  ctx.session.state = BotState.HOME;

  if (ctx.session.dbUser?.preferredCurrency) {
    ctx.session.onboarding = null;
    await showMainMenu(ctx);
    return;
  }

  ctx.session.pendingDeepLinkDenomId = deepLinkDenomId(ctx);
  ctx.session.onboarding = "language";
  await showLanguageMenu(ctx);
}

/** `/menu` (and /cancel's fallback) — straight to the Home dashboard. */
export async function menuCommand(ctx: MyContext): Promise<void> {
  ctx.session.awaitingQtyDenomId = undefined;

  // Deep-link: prod_<id> → open a denomination detail bubble directly.
  const denomId = deepLinkDenomId(ctx);
  if (denomId !== undefined) {
    await browseDenomination(ctx, denomId);
    return;
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
  await menuCommand(ctx);
}

// ---------------------------------------------------------------------------
// Browse — flat product list, numbered selection (type or tap)
// ---------------------------------------------------------------------------

/**
 * First step of the "🛍 Products" entry point — the two-bucket group picker
 * (Category.group). Clears any category/group/product scope left over from a
 * previous browse session so a fresh entry never resumes mid-category.
 */
export async function browseGroups(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  delete sc(ctx).categoryId;
  delete sc(ctx).group;
  delete sc(ctx).productId;
  // Finding I3 (final-review): this is the true top of the Products flow — a
  // fresh entry must never resume a leftover Game Top Up variant/region
  // navigation state from a previous browse session (wrong emoji leaking onto
  // an unrelated product, or a stale index resolving against the wrong list).
  delete sc(ctx).gameVariantEmoji;
  delete sc(ctx).gameVariantEntries;
  delete sc(ctx).gameRegionEntries;
  delete sc(ctx).resolvedGameVariant;
  delete sc(ctx).resolvedGameRegion;
  delete sc(ctx).gameVariantDimensionSkipped;
  // Finding I2 (final-review): this screen renders without going through
  // browseProductsFlat/the variant-picker-render/the region-picker-render —
  // none of which run here — so a leftover "gameVariant"/"gameRegion" from a
  // picker two screens back must be cleared here too, or a stray typed digit
  // on this screen would resolve against an emptied picker snapshot instead
  // of falling through to the product-list default.
  delete sc(ctx).activeNumberedScreen;
  const enabledGroups = await activeServiceGroups(prisma, "bot");
  const enabledServices = CUSTOMER_SERVICES.filter((service) => enabledGroups.has(service.group));
  if (enabledServices.length === 1) {
    // Mirrors browseCategoriesInGroup's own single-category skip: a lone
    // enabled service is no real choice, so don't make the customer tap it.
    await browseCategoriesInGroup(ctx, enabledServices[0]!.group);
    return;
  }
  await smartEdit(
    ctx,
    t(ctx, "browse.group_picker_title"),
    ckb.groupPickerKb(lang, enabledServices),
  );
}

/**
 * Second step — one button per active Category within the tapped group.
 * Records `group` in scratch (read back by handleBackButton) regardless of
 * whether the group turns out to be empty, so Back from the empty-state
 * screen still returns to the same category picker rather than the group
 * picker.
 */
export async function browseCategoriesInGroup(ctx: MyContext, group: string): Promise<void> {
  const lang = ctx.session.lang;
  const service = CUSTOMER_SERVICES.find((entry) => entry.group === group);
  if (!service) {
    await browseGroups(ctx);
    return;
  }
  delete sc(ctx).categoryId;
  delete sc(ctx).productId;
  // Finding I5-followup (final-review): mirrors browseGroups — a stale tap on
  // an older group-picker bubble must not let a PREVIOUS category's variant/
  // region navigation state (gameVariantEntries/gameRegionEntries/etc.)
  // survive into this group, where a subsequent pickGameVariant/
  // enterGameRegion tap could resolve against the wrong entries while
  // browseProductsFlat's group filter now points at the NEW group.
  delete sc(ctx).gameVariantEmoji;
  delete sc(ctx).gameVariantEntries;
  delete sc(ctx).gameRegionEntries;
  delete sc(ctx).resolvedGameVariant;
  delete sc(ctx).resolvedGameRegion;
  delete sc(ctx).gameVariantDimensionSkipped;
  // Finding I2 (final-review): same reasoning as browseGroups' own reset
  // above — this screen (both its empty-state and its normal category-list
  // render below) never goes through browseProductsFlat/a picker render, so
  // a leftover "gameVariant"/"gameRegion" must be cleared here too.
  delete sc(ctx).activeNumberedScreen;
  sc(ctx).group = group;

  // Premium Apps is intentionally one flat product catalog. Categories remain
  // useful admin metadata, but presenting them to customers adds a redundant
  // click and can split closely related apps across separate screens.
  if (group === CategoryGroup.PREMIUM_APPS) {
    await browseProductsFlat(ctx, 0);
    return;
  }

  const categories = await listActiveCategoriesByGroup(prisma, group, "bot");
  const groupLabel = t(ctx, service.translationKey);
  if (!categories.length) {
    await smartEdit(ctx, t(ctx, "browse.category_picker_empty"), ckb.categoryPickerKb([], lang));
    return;
  }
  if (categories.length === 1) {
    // Mirrors browseCategoryEntry's variant/region skip: a single active
    // category is no real choice, so skip this picker entirely. Back target
    // is the group picker (`grps`), not this now-never-shown screen.
    await browseCategoryEntry(ctx, categories[0]!.id, ckb.cb("browse", "grps"));
    return;
  }
  await smartEdit(ctx, t(ctx, "browse.category_picker_title", { group: groupLabel }), ckb.categoryPickerKb(categories, ctx.session.lang));
}

/**
 * Third step — a customer tapped one Category. This is the fix for the
 * long-standing bug where "🛍 Products" showed one flat list mixing every
 * category's products together (§3's original design mistakenly skipped
 * category scoping).
 *
 * A Premium Apps category (or one with no group) goes straight to the flat
 * product list (browseProductsFlat) — this half of the function is Part-1's
 * original behavior, unchanged forever. A Game Top Up category instead steps
 * through an optional variant picker then an optional region picker before
 * landing on the (now variant/region-scoped) product list — each step is
 * skipped when the category has 0 or 1 distinct value for that dimension, so
 * a category with a single edition/region never shows a pointless 1-button
 * picker.
 */
export async function browseCategoryEntry(ctx: MyContext, categoryId: number, backTarget?: string): Promise<void> {
  sc(ctx).categoryId = categoryId;
  const category = await getCategory(prisma, categoryId);
  if (!category || !category.isActive || !(await isServiceActive(prisma, category.group as CategoryGroup | null, "bot"))) {
    await browseGroups(ctx);
    return;
  }
  // Finding I4 (final-review): always trust the fresh DB value. The old
  // `category.group ?? sc(ctx).group` fallback meant a category an admin had
  // just reclassified to null/a different group, re-entered via a stale
  // `v1:browse:cat:<id>` button, would keep whatever group scratch happened
  // to have from a PREVIOUS category — silently misapplying a Game Top Up
  // variant/region filter (or skipping one) that no longer matches reality.
  sc(ctx).group = category.group ?? undefined;

  if (category.group !== CategoryGroup.GAME_TOPUP) {
    // Finding I3 (final-review): a non-GAME_TOPUP category can never have a
    // variant/region navigation state — clear every field that flow can set,
    // not just the two "resolved" ones, or a leftover gameVariantEmoji/
    // gameVariantEntries/gameRegionEntries from an EARLIER Game Top Up
    // category could still leak into this one (wrong emoji on a denomination
    // button, or a stale index resolving against the wrong list).
    delete sc(ctx).resolvedGameVariant;
    delete sc(ctx).resolvedGameRegion;
    delete sc(ctx).gameVariantEmoji;
    delete sc(ctx).gameVariantEntries;
    delete sc(ctx).gameRegionEntries;
    delete sc(ctx).gameVariantDimensionSkipped;
    await browseProductsFlat(ctx, 0);
    return;
  }

  // Guaranteed non-null: the branch above already returned for every other
  // value, so `category.group` here is exactly CategoryGroup.GAME_TOPUP.
  const group = category.group;
  // Defaults to the category picker (today's behavior for the normal "cat"
  // callback route) — but browseCategoriesInGroup's own 1-category auto-skip
  // passes the group picker's target instead, since its category picker was
  // never shown. When the caller omits backTarget entirely — both the "cat"
  // AND "gvars" callback routes do this, the latter being the region
  // picker's own Back button re-entering here — recompute fresh whether this
  // group's category picker would itself be skipped today (mirrors
  // handleBackButton's own Task-3 fix above): don't trust which path
  // originally got us here, recheck reality.
  let effectiveBackTarget = backTarget;
  if (effectiveBackTarget == null) {
    const groupCategories = await listActiveCategoriesByGroup(prisma, group, "bot");
    effectiveBackTarget = groupCategories.length <= 1 ? ckb.cb("browse", "grps") : ckb.cb("browse", "grp", group);
  }
  const [variants, unvariantedCount] = await Promise.all([
    listCategoryGameVariants(prisma, categoryId),
    countCategoryProductsWithoutGameVariant(prisma, categoryId),
  ]);

  // A genuinely MIXED category — at least one catalog-eligible product carries
  // a gameVariant AND at least one doesn't. A variant picker (or the
  // single-variant auto-resolve) would filter the flat list down to the
  // picked value and hide every unlabelled product. Show one flat list of
  // everything instead, exactly like a non-GAME_TOPUP category, and skip the
  // variant/region dimension. `variants.length > 0` is required so a
  // variant-less category that still has a region picker (listCategoryGameRegions
  // supports gameVariant: null) keeps falling through to enterGameVariant
  // below and renders its region step.
  if (variants.length > 0 && unvariantedCount > 0) {
    delete sc(ctx).resolvedGameVariant;
    delete sc(ctx).resolvedGameRegion;
    delete sc(ctx).gameVariantEmoji;
    delete sc(ctx).gameVariantEntries;
    delete sc(ctx).gameRegionEntries;
    sc(ctx).gameVariantDimensionSkipped = true;
    await browseProductsFlat(ctx, 0);
    return;
  }
  delete sc(ctx).gameVariantDimensionSkipped;

  if (variants.length > 1) {
    sc(ctx).gameVariantEntries = variants;
    sc(ctx).activeNumberedScreen = "gameVariant";
    // A typed digit must resolve against THIS picker now, not whatever the
    // flat list or the region picker last snapshotted — see
    // BrowseScratch.activeNumberedScreen.
    delete sc(ctx).browseEntries;
    delete sc(ctx).gameRegionEntries;
    // Telegram can't edit away the OLD bottom ReplyKeyboardMarkup (only a
    // fresh sendMessage can replace it) — resend it now, sized to this
    // picker's own option count, BEFORE the picker's own inline-keyboard
    // render below, so that edit/send stays the chat's most recently
    // rendered screen (its inline buttons are what a tap should act on).
    await ctx.reply(t(ctx, "browse.use_numbers"), {
      reply_markup: ckb.gamePickerPersistentKb(variants.length, ctx.session.lang),
    });
    // Back goes UP to the category picker (Finding I2/3 of the final-review)
    // — `cb("browse", "cat", categoryId)` would just re-render this SAME
    // variant picker, a no-op loop, since this category has >1 variant.
    await smartEdit(
      ctx,
      t(ctx, "browse.choose_variant"),
      ckb.gameVariantPickerKb(variants, categoryId, effectiveBackTarget, ctx.session.lang),
    );
    return;
  }
  // Variant step auto-skipped (0/1 distinct variant) — no picker was shown,
  // so if the region step DOES render, its own Back must skip straight to
  // the category picker, not re-render this same (skipped) step.
  await enterGameVariant(ctx, categoryId, variants[0]?.label ?? null, variants[0]?.emoji ?? null, effectiveBackTarget);
}

/** Shared index-resolution for the variant picker — resolves an index (tapped
 * via the inline picker's callback, or typed as a digit while it's the active
 * numbered screen, see handleProductNumber) against the gameVariantEntries
 * snapshot taken when that picker was rendered, then continues into the
 * region step. Returns false when the index doesn't match a snapshotted
 * entry (stale screen) — the caller decides how to surface that: a toast for
 * a callback tap (pickGameVariant), an inline message for a typed digit
 * (handleProductNumber). */
async function resolveGameVariantByIndex(ctx: MyContext, categoryId: number, idx: number): Promise<boolean> {
  const entry = sc(ctx).gameVariantEntries?.[idx];
  if (!entry) return false;
  // A real variant picker WAS shown for this tap — the region step's own Back
  // (if it renders) should re-open it.
  await enterGameVariant(ctx, categoryId, entry.label, entry.emoji, ckb.cb("browse", "gvars", categoryId));
  return true;
}

/** A customer tapped one entry on the variant picker rendered by
 * browseCategoryEntry — resolve the tapped index against the snapshot taken
 * when that picker was rendered (mirrors handleProductNumber's
 * browseEntries pattern), then continue into the region step. */
export async function pickGameVariant(ctx: MyContext, categoryId: number, idx: number): Promise<void> {
  if (!(await resolveGameVariantByIndex(ctx, categoryId, idx))) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
  }
}

/** Shared by browseCategoryEntry's single-variant skip and pickGameVariant's
 * explicit tap: record the resolved variant, then render the region picker
 * or skip it the same way.
 *
 * `regionBackTarget` is the callback_data the REGION picker's Back button
 * should carry if it ends up rendering — computed by the caller, since only
 * the caller knows whether a real variant picker was actually shown for this
 * navigation (Finding I2/3 of the final-review): `browseCategoryEntry`'s
 * skip-path passes the category picker's target; `pickGameVariant` (a real
 * tap on a real picker) passes the variant picker's own target.
 */
async function enterGameVariant(
  ctx: MyContext,
  categoryId: number,
  gameVariant: string | null,
  gameVariantEmoji: string | null,
  regionBackTarget: string,
): Promise<void> {
  sc(ctx).resolvedGameVariant = gameVariant;
  // Every path here (browseCategoryEntry's pure-category tail, pickGameVariant
  // on a real picker tap) is by definition NOT the mixed-skip path — clear the
  // flag so it can't linger from an earlier category this session.
  delete sc(ctx).gameVariantDimensionSkipped;
  sc(ctx).gameVariantEmoji = gameVariantEmoji;

  const regions = await listCategoryGameRegions(prisma, categoryId, gameVariant);
  if (regions.length > 1) {
    sc(ctx).gameRegionEntries = regions;
    sc(ctx).activeNumberedScreen = "gameRegion";
    // A typed digit must resolve against THIS picker now, not whatever the
    // flat list or the variant picker last snapshotted — see
    // BrowseScratch.activeNumberedScreen.
    delete sc(ctx).browseEntries;
    delete sc(ctx).gameVariantEntries;
    // Same reasoning as the variant picker's render above — resend the
    // bottom digit keyboard, sized to this picker's own option count, before
    // the picker's own inline-keyboard render.
    await ctx.reply(t(ctx, "browse.use_numbers"), {
      reply_markup: ckb.gamePickerPersistentKb(regions.length, ctx.session.lang),
    });
    await smartEdit(ctx, t(ctx, "browse.choose_region"), ckb.gameRegionPickerKb(regions, categoryId, regionBackTarget, ctx.session.lang));
    return;
  }
  await enterGameRegion(ctx, categoryId, gameVariant, regions[0] ?? null);
}

/** Shared index-resolution for the region picker — same pattern as
 * resolveGameVariantByIndex, resolving an index (tapped via the inline
 * picker's callback, or typed as a digit while it's the active numbered
 * screen) against the gameRegionEntries snapshot. Returns false on a stale
 * index — region strings can legitimately be "" so the entry is checked with
 * `=== undefined`, not falsy. */
async function resolveGameRegionByIndex(ctx: MyContext, categoryId: number, idx: number): Promise<boolean> {
  const region = sc(ctx).gameRegionEntries?.[idx];
  if (region === undefined) return false;
  await enterGameRegion(ctx, categoryId, sc(ctx).resolvedGameVariant ?? null, region);
  return true;
}

/** A customer tapped one entry on the region picker rendered by
 * enterGameVariant — same stale-index guard as pickGameVariant. */
export async function pickGameRegion(ctx: MyContext, categoryId: number, idx: number): Promise<void> {
  if (!(await resolveGameRegionByIndex(ctx, categoryId, idx))) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
  }
}

/** Shared by enterGameVariant's single-region skip and pickGameRegion's
 * explicit tap: record the resolved region, then either collapse straight
 * to the single matching product's detail (mirrors browseProduct's own
 * single-denomination collapse) or fall into the scoped flat list. */
async function enterGameRegion(
  ctx: MyContext,
  categoryId: number,
  gameVariant: string | null,
  gameRegion: string | null,
): Promise<void> {
  sc(ctx).resolvedGameRegion = gameRegion;
  // Finding I5 (final-review): the variant/region navigation chain threads
  // `categoryId` from the TAPPED CALLBACK, not from scratch — but
  // `browseProductsFlat` (the fallback below, when more than one product
  // matches) reads `sc(ctx).categoryId`. Without this sync, a stale
  // cross-category tap could make the single-product collapse check above
  // use one category while the rendered fallback list shows a different
  // one's products. This is the single place every call chain
  // (pickGameVariant/pickGameRegion, and browseCategoryEntry's own skip
  // paths) funnels through before falling through to browseProductsFlat, so
  // syncing it here (once) covers every caller.
  sc(ctx).categoryId = categoryId;
  const products = await listCatalogProducts(prisma, "bot", categoryId, { gameVariant, gameRegion });
  if (products.length === 1) {
    await browseProduct(ctx, products[0]!.id);
    return;
  }
  await browseProductsFlat(ctx, 0);
}

/**
 * Re-enter the browse flow at whatever depth the session was last left at —
 * the category-scoped list if one was active, else the group picker. Used by
 * the "prods"/refresh-style re-entry points that used to always land on the
 * flat cross-category list.
 */
export async function browseResume(ctx: MyContext): Promise<void> {
  if (sc(ctx).categoryId != null) {
    await browseProductsFlat(ctx, sc(ctx).page ?? 0);
    return;
  }
  if (sc(ctx).group === CategoryGroup.PREMIUM_APPS) {
    await browseProductsFlat(ctx, sc(ctx).page ?? 0);
    return;
  }
  await browseGroups(ctx);
}

export async function browseProductsFlat(ctx: MyContext, page = 0): Promise<void> {
  const lang = ctx.session.lang;

  // A product's own photo (browseProduct/browseDenomination) may still be
  // showing when Back lands here — this screen is always plain text, and
  // Telegram can't strip a photo via editMessageCaption (the stale photo
  // would stay stuck behind the "Product List" caption forever). Delete that
  // bubble and clear the anchor so the render below sends a fresh message.
  const chatId = ctx.chat?.id;
  const cqMsg = ctx.callbackQuery?.message;
  if (chatId !== undefined && cqMsg && "photo" in cqMsg && cqMsg.photo) {
    try {
      await ctx.api.deleteMessage(chatId, cqMsg.message_id);
    } catch {
      /* gone/too old */
    }
    ctx.session.menuMsgId = undefined;
  }

  // Flat list of mid-tier Products (each with ≥1 active denomination), scoped
  // to the active Category (set by browseCategoryEntry) — no more mixing
  // every category's products into one list. No group/product collapse
  // within the category — every row is a Product.
  //
  // A Game Top Up category additionally scopes to whatever variant/region
  // browseCategoryEntry's picker flow resolved (undefined scratch fields
  // read back as `?? null`, matching listCatalogProducts's "no variant/
  // region dimension" filter value) — sc(ctx).group already carries the
  // active category's group (set alongside categoryId by every entry point
  // into this function), so no extra category query is needed here.
  //
  // Exception: a MIXED Game Top Up category (browseCategoryEntry set
  // gameVariantDimensionSkipped because some products carry a gameVariant
  // and some don't). There the picker flow never ran, so applying a
  // `{ gameVariant: null, gameRegion: null }` filter would hide every
  // labelled product — skip the filter entirely and show one flat list of
  // everything, exactly like a non-GAME_TOPUP category.
  const categoryId = sc(ctx).categoryId;
  const filter =
    sc(ctx).group === CategoryGroup.GAME_TOPUP && !sc(ctx).gameVariantDimensionSkipped
      ? { gameVariant: sc(ctx).resolvedGameVariant ?? null, gameRegion: sc(ctx).resolvedGameRegion ?? null }
      : undefined;
  // Finding I2 (final-review): captured BEFORE it's overwritten below (and
  // before the empty-products early return), so both this function's own
  // early return and its normal render path can tell whether a variant/
  // region picker was actually on screen a moment ago — a screen that never
  // touches browseEntries/activeNumberedScreen itself, so a leftover
  // "gameVariant"/"gameRegion" value here would otherwise survive into
  // whatever screen a typed digit is next checked against.
  const previousActiveScreen = sc(ctx).activeNumberedScreen;
  const products =
    categoryId == null && sc(ctx).group === CategoryGroup.PREMIUM_APPS
      ? await listCatalogProductsByGroup(prisma, CategoryGroup.PREMIUM_APPS, "bot")
      : await listCatalogProducts(prisma, "bot", categoryId, filter);
  if (!products.length) {
    // Finding I2 (final-review): a picker's activeNumberedScreen must not
    // survive into this empty-list screen either — an empty gameVariant/
    // gameRegion snapshot left in place would make a stray typed digit here
    // resolve against 0 entries ("Enter a number between 1 and 0") instead of
    // falling through to this screen's own (numberless) contract.
    delete sc(ctx).activeNumberedScreen;
    // The catalog may have become empty while the customer was viewing a
    // product. An explicit empty snapshot prevents a digit from falling back
    // to an older list (or to the legacy unscoped catalog lookup below).
    sc(ctx).browseEntries = [];
    delete sc(ctx).page;
    delete sc(ctx).productId;
    delete sc(ctx).variantId;
    delete sc(ctx).gameVariantEntries;
    delete sc(ctx).gameRegionEntries;
    const emptyKeyboard =
      categoryId == null && sc(ctx).group === CategoryGroup.PREMIUM_APPS
        ? ckb.categoryPickerKb([], lang)
        : ckb.backToMain(lang);
    await smartEdit(ctx, t(ctx, "browse.no_products"), emptyKeyboard);
    return;
  }

  const totalPages = Math.max(1, Math.ceil(products.length / PAGE_SIZE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const start = page * PAGE_SIZE;
  const pageProducts = products.slice(start, start + PAGE_SIZE);

  ctx.session.state = BotState.PRODUCT_LIST;
  sc(ctx).page = page;
  sc(ctx).browseEntries = pageProducts.map((p) => p.id);
  sc(ctx).activeNumberedScreen = "products";
  // A typed digit must resolve against THIS list now, not whatever a
  // variant/region picker last snapshotted — see
  // BrowseScratch.activeNumberedScreen.
  delete sc(ctx).gameVariantEntries;
  delete sc(ctx).gameRegionEntries;
  delete sc(ctx).productId;
  delete sc(ctx).variantId;

  // Selection is resolved against the browseEntries snapshot (see handleProductNumber).
  const itemLines = pageProducts.map((p, i) => `${i + 1}. ${esc(p.name)}`);

  const text = t(ctx, "browse.list_decorated", {
    page: page + 1,
    total: totalPages,
    items: itemLines.join("\n"),
  });

  // No per-product inline buttons: the user picks the number shown in the
  // caption (handleProductNumber resolves it against browseEntries), either
  // by typing it or by tapping it on the persistent keyboard below. Prev/Next
  // stay on the existing inline productsNavKb — reached only via that inline
  // tap (a callback), so it keeps editing the bubble in place. A fresh entry
  // (the typed "Products" label, a deep link, etc. — no callback) instead sets
  // the numbered persistent keyboard, sized to this page's product count so a
  // small catalog doesn't get padded with dead buttons; a reply keyboard can
  // only be set via a fresh send, which happens once per Browse entry, not on
  // every page turn. The banner (if set) rides on top as a photo+caption,
  // unless the list is too long.
  //
  // Finding I1 (final-review): a variant/region picker tap (pickGameVariant/
  // pickGameRegion) that lands here IS a callback — the picker's own bottom
  // keyboard (gamePickerPersistentKb, sized to ITS OWN option count) is still
  // showing, and Telegram can only replace a ReplyKeyboardMarkup via a fresh
  // send, not an edit.
  //
  // Finding (final-review round 2): the first fix for I1 made THIS list's own
  // message use `productsPersistentKb` (no Prev/Next) whenever it landed here
  // from a picker tap, so a >10-product variant/region-scoped list became
  // unreachable past page 1 — a real pagination regression. Fixed the same
  // way the variant/region pickers above already solve this exact problem
  // (enterGameVariant/enterGameRegion): the resized digit reply-keyboard is
  // sent as a SEPARATE companion message via `ctx.reply` (a fresh send can
  // always carry a new ReplyKeyboardMarkup), while the actual list message
  // keeps using the inline `productsNavKb` — so it stays tap-friendly and
  // keeps working Prev/Next AND the bottom digit keyboard ends up correctly
  // sized either way.
  //
  // Reported bug (post-merge): the resend only fired for
  // previousActiveScreen === "gameVariant"/"gameRegion", so any OTHER
  // callback-driven route into this same list — the ordinary group→category
  // picker chain (browseGroups/browseCategoriesInGroup, both inline/callback
  // and both clearing activeNumberedScreen entirely, per Finding I2) — left
  // whatever reply keyboard was showing before (Home's mainPersistentKb, most
  // commonly) stuck on screen, since the inline productsNavKb branch below
  // never touches the ReplyKeyboardMarkup at all. The real invariant is "the
  // bottom digit keyboard is stale unless the immediately-previous screen was
  // THIS SAME list" — which is exactly what "previousActiveScreen ===
  // 'products'" alone would mean (a genuine same-list Prev/Next page-turn
  // re-enters with the flag already set to "products" from the prior call,
  // since it's written unconditionally below on every render) — so the fix is
  // the inverse of that, not an allowlist of specific prior screens.
  const needsKeyboardResend = previousActiveScreen !== "products";
  if (needsKeyboardResend) {
    await ctx.reply(t(ctx, "browse.use_numbers"), {
      reply_markup: ckb.productsPersistentKb(pageProducts.length, lang),
    });
  }
  const replyMarkup = ctx.callbackQuery
    ? ckb.productsNavKb(page, totalPages, lang)
    : ckb.productsPersistentKb(pageProducts.length, lang);
  await renderMenuBanner(ctx, text, replyMarkup);
}

/**
 * §5 — Produk Populer: top-10 best-selling mid-tier Products (by delivered
 * units), reached from Home. Reuses the Product List's BotState since it's a
 * picker-style list of Products, not a distinct nav state.
 */
export async function browsePopular(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  ctx.session.state = BotState.PRODUCT_LIST;

  const rows = await soldCountsByProduct(prisma, "bot", 10);
  if (!rows.length) {
    await smartEdit(ctx, t(ctx, "browse.popular_empty"), ckb.backToMain(lang));
    return;
  }

  const itemLines = rows.map(
    (r, i) => `${i + 1}. ${esc(r.product.name)} — ${t(ctx, "browse.sold_count", { count: r.sold })}`,
  );
  const text = `${t(ctx, "browse.popular_title")}\n\n${itemLines.join("\n")}`;
  await smartEdit(ctx, text, ckb.popularKb(rows.map((r) => r.product), lang));
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
      return void (await browseGroups(ctx));
    case "orders":
      return void (await listMyOrders(ctx));
    case "wallet":
      return void (await viewWallet(ctx));
    case "popular":
      return void (await browsePopular(ctx));
    case "help":
      return void (await showHelpCenter(ctx));
    case "referral":
      return void (await viewReferral(ctx));
    case "language":
      return void (await openLanguageMenu(ctx));
    case "faq":
      return void (await showFaq(ctx));
    case "terms":
      return void (await showTerms(ctx));
    case "tickets":
      return void (await listMyTickets(ctx));
    case "main":
      return void (await backToHome(ctx));
    case "support":
      // Support is entered via the conversation `hears` trigger in main.ts, not
      // here; if it ever reaches this handler, ignore it (no number selection).
      return;
  }

  // Number buttons — entry selection. Only short digit strings.
  if (!/^\d+$/.test(text) || text.length > 4) return;
  const idx = parseInt(text, 10);

  // A variant/region picker is the active numbered screen — resolve the
  // typed digit against ITS OWN snapshot instead of falling through to the
  // product-list logic below, which would otherwise silently resolve against
  // a stale or unscoped browseEntries (see BrowseScratch.activeNumberedScreen
  // for why exactly one of these three fields is ever populated at a time).
  // "products", or undefined (an in-flight session that predates this
  // field), falls through unchanged to the existing browseEntries logic.
  const activeScreen = sc(ctx).activeNumberedScreen;
  if (activeScreen === "gameVariant" || activeScreen === "gameRegion") {
    const pickerEntries = activeScreen === "gameVariant" ? sc(ctx).gameVariantEntries : sc(ctx).gameRegionEntries;
    const count = pickerEntries?.length ?? 0;
    const categoryId = sc(ctx).categoryId;
    // categoryId is always set alongside these entries by browseCategoryEntry/
    // enterGameVariant — shouldn't normally be missing. Bounds-check first
    // (matching the existing browseEntries out-of-range message below
    // exactly), so a missing categoryId on an otherwise-valid index also
    // degrades to that same message rather than a silent no-op.
    if (idx < 1 || idx > count || categoryId == null) {
      await smartEdit(ctx, t(ctx, "browse.invalid_number", { max: count }), ckb.backToMain(lang));
      return;
    }
    if (activeScreen === "gameVariant") {
      await resolveGameVariantByIndex(ctx, categoryId, idx - 1);
    } else {
      await resolveGameRegionByIndex(ctx, categoryId, idx - 1);
    }
    return;
  }

  // Resolve against the SNAPSHOT captured when the list was rendered, so a
  // catalog change between render and tap can't shift the numbering. Each entry
  // is a mid-tier Product id.
  let entries = sc(ctx).browseEntries;
  if (entries == null) {
    const all = await listCatalogProducts(prisma, "bot");
    const page = sc(ctx).page ?? 0;
    const startIdx = page * PAGE_SIZE;
    entries = all.slice(startIdx, startIdx + PAGE_SIZE).map((p) => p.id);
    sc(ctx).browseEntries = entries;
  }

  if (!entries.length) {
    const emptyKeyboard =
      sc(ctx).categoryId == null && sc(ctx).group === CategoryGroup.PREMIUM_APPS
        ? ckb.categoryPickerKb([], lang)
        : ckb.backToMain(lang);
    await smartEdit(ctx, t(ctx, "browse.no_products"), emptyKeyboard);
    return;
  }

  if (idx < 1 || idx > entries.length) {
    await smartEdit(ctx, t(ctx, "browse.invalid_number", { max: entries.length }), ckb.backToMain(lang));
    return;
  }

  const productId = entries[idx - 1]!;
  logger.debug(`Customer selected product #${idx} (product ${productId}) by typing its list number`);
  await browseProduct(ctx, productId);
}

/** "🎮 Data needed at checkout: User ID, Server ID" for a Game Top Up SKU
 * set, or null when checkout won't run the nickname-check wizard for any of
 * them (see resolveGameInputFlags). */
async function gameInputHint(
  ctx: MyContext,
  denominations: Parameters<typeof resolveGameInputFlags>[0],
): Promise<string | null> {
  const flags = await resolveGameInputFlags(denominations);
  if (!flags) return null;
  return t(ctx, "browse.game_input_hint", { fields: gameInputFieldsLabel((key) => t(ctx, key), flags) });
}

/**
 * Tap a mid-tier Product → its Denomination picker. A Product with exactly ONE
 * active denomination collapses straight to that denomination's detail bubble
 * (skip a pointless 1-item picker, mirroring the old single-member group
 * collapse); ≥2 active denominations render the picker.
 */
export async function browseProduct(ctx: MyContext, productId: number, requestedPage = 0): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const product = await getCatalogProductWithDenominations(prisma, productId);
  const active = (product?.denominations ?? []).filter((d) => d.isActive);
  if (!product || !product.isActive || product.isArchived || !product.category.isActive || active.length === 0 || !(await isServiceActive(prisma, product.category.group as CategoryGroup | null, "bot"))) {
    await smartEdit(ctx, t(ctx, "browse.no_products"), ckb.backToMain(lang));
    return;
  }
  if (active.length === 1) {
    delete sc(ctx).productId;
    delete sc(ctx).productPage;
    await browseDenomination(ctx, active[0]!.id);
    return;
  }
  sc(ctx).productId = productId;
  delete sc(ctx).variantId;
  const rateContext = await getCanonicalRateContext(prisma);
  const prices = ctxPriceFormatter(ctx, rateContext.rate ? new Decimal(rateContext.rate) : null);
  const sold = await soldCountForProduct(prisma, productId);
  const isGame = product.category.group === CategoryGroup.GAME_TOPUP;
  const photoArg = productPhotoArg(product);
  const render = async (text: string, keyboard: ReturnType<typeof ckb.denominationPickerKb>) => {
    if (photoArg) {
      await renderMenu(ctx, text, keyboard, photoArg.photo, photoArg.needsCache ? cacheProductPhotoFileId(productId) : undefined);
    } else {
      await renderMenuBanner(ctx, text, keyboard);
    }
  };

  if (!isGame) {
    // Premium Apps (and any null/unclassified group): the original per-plan body lines (price + stock) with
    // plan-name-only buttons. This picker has no pages, so drop any page index left over from a paged picker
    // so the detail's Back returns to this plain picker.
    delete sc(ctx).productPage;
    const isReseller = info.role === UserRole.RESELLER;
    const stocks = await availableStockCountsByDenomination(prisma, active.map((d) => d.id));
    const planLines: string[] = [];
    const buttonLabels = new Map<number, string | undefined>();
    for (const d of active) {
      const unitPrice = effectiveUnitPrice(d, isReseller);
      // A flash sale shows the old price struck through next to the new one, but only when this buyer is
      // actually paying the sale price — a reseller whose standing price still wins sees the plain line.
      const sale = flashPrice(d);
      const priceText = sale && unitPrice.equals(sale)
        ? t(ctx, "browse.flash_price", { old: prices.price(d.price), new: prices.price(unitPrice) })
        : prices.price(unitPrice);
      // Stock rows only exist for AUTO SKUs; a manual plan has none by design, so show a dash, not a "0".
      const stockDisplay = d.deliveryType === DeliveryType.AUTO ? (stocks.get(d.id) ?? 0) : "—";
      planLines.push(t(ctx, "browse.denomination_line", { duration: esc(d.durationLabel || d.name), price: priceText, stock: stockDisplay }));
      // The original rule: a compact quantity button only when the admin set qtyValue + qtyUnit; otherwise the
      // picker falls back to the plan name (formatDenominationLabel).
      buttonLabels.set(d.id, d.qtyValue != null && d.qtyUnit
        ? gameTopUpDenomLabel(d, unitPrice, product.gameVariantEmoji ?? sc(ctx).gameVariantEmoji, prices)
        : undefined);
    }
    let text = t(ctx, "browse.choose_denomination", {
      name: esc(product.name),
      sold: t(ctx, "browse.sold_count", { count: sold }),
      plans: planLines.join("\n"),
    });
    if (product.description) {
      text += "\n\n" + t(ctx, "browse.description", { description: esc(product.description) });
    }
    // A USD buyer whose rate is unavailable saw Rp prices above — say so, once.
    text += prices.rateNotice(lang);
    await render(text, ckb.denominationPickerKb(active.map((d) => ({ ...d, buttonLabel: buttonLabels.get(d.id) })), productId, product.name, lang));
    return;
  }

  // Game Top Up keeps the canonical presenter; the stock read only feeds each SKU's availability flag.
  const gameStocks = await availableStockCountsByDenomination(prisma, active.map((d) => d.id));
  const products = active.map((d) => canonicalProduct({
    denomination: { ...d, createdAt: d.createdAt.toISOString() }, product, category: product.category,
    stockAvailable: d.deliveryType !== DeliveryType.AUTO || (gameStocks.get(d.id) ?? 0) > 0,
  }, { ...rateContext, effectivePriceIDR: effectiveUnitPrice(d, info.role === UserRole.RESELLER).toString(), preferredCurrency: parseDisplayCurrency(ctx.session.dbUser?.preferredCurrency) ?? "IDR", locale: lang }));
  noteUnknownUnits(products);
  const hint = await gameInputHint(ctx, active.map((d) => ({ ...d, product })));
  const title = t(ctx, "browse.choose_denomination_game", {
    name: "__CANONICAL_NAME__", sold: t(ctx, "browse.sold_count", { count: sold }), info: "", plans: "",
  }).replace(/<[^>]*>/g, "").replace("__CANONICAL_NAME__", product.name);
  const intro = [title, product.description, hint?.replace(/<[^>]*>/g, "")].filter(Boolean).join("\n\n");
  const { pages } = presentCanonicalCatalog(products, { locale: lang, intro });
  const pageIndex = Math.min(Math.max(0, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0), pages.length - 1);
  const page = pages[pageIndex]!;
  const text = page.text + prices.rateNotice(lang) + (pages.length > 1 ? `\n${pageIndex + 1}/${pages.length}` : "");
  // Remembered so the denomination detail's Back returns to this same page.
  sc(ctx).productPage = pageIndex;
  await render(text, ckb.canonicalDenominationPickerKb(page.rows, productId, lang, pageIndex, pages.length));
}

/**
 * Denomination detail bubble (the leaf SKU): Product / Plan / Price / Stock +
 * qty stepper + Buy + Back. Back returns to the parent Product's picker when we
 * came from one (`viewingProductId`), else to the flat product list. The `buy`,
 * `qty` and `restock` callbacks all key off the denomination id (= the SKU the
 * money/stock flow uses).
 */
export async function browseDenomination(
  ctx: MyContext,
  denominationId: number,
  qty = 1,
  opts?: { noticePrefix?: string },
): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  let d: Awaited<ReturnType<typeof getDenominationWithProduct>>;
  let stock: number;
  let ratingStr: string;
  let sold: number;
  let bulkRule: Awaited<ReturnType<typeof getBulkPricingForDenomination>>;
  try {
    d = await getDenominationWithProduct(prisma, denominationId);
    if (d === null || !d.isActive || !d.product.isActive || d.product.isArchived || !d.product.category.isActive || !(await isServiceActive(prisma, d.product.category.group as CategoryGroup | null, "bot"))) {
      logger.warn(`Denomination ${denominationId} not found — likely deleted/deactivated between render and tap, showing a try-again screen instead of a crash`);
      // Expected-but-rare (denomination deleted/deactivated between render and
      // tap) — transient copy, no ref. Forward action so it isn't a dead end.
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.try_again"), show_alert: true });
      else await smartEdit(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
      return;
    }
    stock = await countAvailableStock(prisma, d.id);
    const { avg, count } = await productRating(prisma, d.id);
    ratingStr = avg ? `${avg.toFixed(1)}/5 (${count})` : "—";
    sold = await soldCountForDenomination(prisma, d.id);
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
  const unit = effectiveUnitPrice(d, isReseller);
  const rateContext = await getCanonicalRateContext(prisma);
  const rate = rateContext.rate ? new Decimal(rateContext.rate) : null;
  const prices = ctxPriceFormatter(ctx, rate);
  const canonical = canonicalProduct({ denomination: { ...d, createdAt: d.createdAt.toISOString() }, product: d.product, category: d.product.category, stockAvailable: d.deliveryType !== DeliveryType.AUTO || stock > 0 }, { ...rateContext, effectivePriceIDR: unit.toString(), preferredCurrency: parseDisplayCurrency(ctx.session.dbUser?.preferredCurrency) ?? "IDR", locale: lang });
  const plan = await boundedCanonicalName(canonical, (html) => ctx.api.sendMessage(ctx.chat!.id, html, { parse_mode: "HTML" }));
  const sale = flashPrice(d);
  const onSale = sale !== null && unit.equals(sale);

  // Stock rows only ever exist for AUTO SKUs — a manual/manual_with_info SKU
  // has none by design, so this screen's own "In stock" line would otherwise
  // read as sold out directly beside the (correctly) purchasable Buy button
  // below. `stock` itself stays the raw count for denominationDetailKb's
  // gating/stepper-bound logic further down; only the displayed text changes.
  // This template reaches every non-GAME_TOPUP category now — Premium Apps
  // and any as-yet-unclassified null-group category (the compact detail
  // template below drops the stock line entirely, GAME_TOPUP only) — so an
  // AUTO denomination always shows the raw number here.
  const stockDisplay = d.deliveryType === DeliveryType.AUTO ? stock : "—";

  const priceText = onSale
    ? t(ctx, "browse.flash_price", { old: prices.price(d.price), new: canonical.formattedPrice })
    : canonical.formattedPrice;
  // Game Top Up SKUs (diamonds, UC, …) have no meaningful Duration/Type/
  // Warranty (those are Premium Apps account attributes) and no meaningful
  // stock line either (the one Premium Apps keeps is the one real, buyer-
  // meaningful local inventory count), so this compact variant of the
  // bubble keeps only Price/Sold/Rating. An as-yet-unclassified null-group
  // category is NOT included here (Finding I3, final-review, user decision)
  // — it mirrors `serviceForCategoryGroup(null)` in
  // packages/core/src/services.ts, which already treats null as
  // PREMIUM_APPS-equivalent, so it keeps the full Duration/Type/Warranty +
  // stock template like Premium Apps.
  const isGame = d.product.category.group === CategoryGroup.GAME_TOPUP;
  let text = isGame
    ? t(ctx, "browse.denomination_detail_game", {
        product: esc(d.product.name),
        plan: esc(plan),
        price: priceText,
        sold,
        rating: ratingStr,
      })
    : t(ctx, "browse.denomination_detail", {
        product: esc(d.product.name),
        plan: esc(plan),
        price: priceText,
        duration: esc(d.durationLabel.length > 1200 ? `#${d.id}` : d.durationLabel),
        type: d.type.toLowerCase(),
        warranty: d.warrantyDays,
        stock: stockDisplay,
        sold,
        rating: ratingStr,
      });
  if (onSale) {
    text +=
      "\n\n" +
      t(ctx, "browse.flash_deal", {
        percent: activeFlashPercent(d)!.toString(),
        remaining: formatFlashRemaining(d.flashEndsAt!),
      });
  }
  if (bulkRule) {
    text +=
      "\n\n" +
      t(ctx, "browse.bulk_deal", {
        min_qty: bulkRule.minQuantity,
        percent: bulkRule.discountPercent,
      });
  }
  if (d.product.description) {
    text += "\n\n" + t(ctx, "browse.description", { description: esc(d.product.description) });
  }
  if (isGame) {
    // Also reached directly via the single-denomination collapse, which
    // skips the picker's game-info block entirely — so show the hint here too.
    const hint = await gameInputHint(ctx, [d]);
    if (hint) text += "\n\n" + hint;
  }
  text += prices.rateNotice(lang);

  if (opts?.noticePrefix) {
    text = opts.noticePrefix + "\n\n" + text;
  }

  // Parent product for Back navigation: the picker we came from, or null when no
  // picker was shown (collapse / deep-link) so Back falls through to the flat
  // product list per denominationDetailKb's contract — never to a product that
  // would immediately re-collapse to this same detail.
  const parentProductId = sc(ctx).productId ?? null;
  const parentPage = parentProductId != null ? (sc(ctx).productPage ?? 0) : 0;
  const photoArg = productPhotoArg(d.product);
  if (photoArg) {
    await renderMenu(
      ctx,
      text,
      ckb.denominationDetailKb(d, stock, lang, qty, parentProductId, parentPage),
      photoArg.photo,
      photoArg.needsCache ? cacheProductPhotoFileId(d.product.id) : undefined,
    );
  } else {
    await smartEdit(ctx, text, ckb.denominationDetailKb(d, stock, lang, qty, parentProductId, parentPage));
  }
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
  // Stock rows only ever exist for AUTO SKUs (Task 2 skips reservation
  // entirely for manual/manual_with_info) — running this check for a
  // non-auto product would always see 0 available and falsely reject every
  // manual-delivery purchase before the qty prompt even opens. Cap the
  // effective max at MAX_CART_ORDER_UNITS instead, the same limit the
  // storefront's cart checkout applies to manual items.
  let effectiveMax = MAX_CART_ORDER_UNITS;
  if (d.deliveryType === DeliveryType.AUTO) {
    const stock = await countAvailableStock(prisma, d.id);
    if (stock <= 0) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "browse.out_of_stock"), show_alert: true });
      return;
    }
    effectiveMax = stock;
  }
  await smartEdit(ctx, t(ctx, "browse.qty_input_prompt", { max: effectiveMax }), ckb.qtyInputCancelKb(denominationId, lang));
  ctx.session.awaitingQtyDenomId = denominationId;
}

export async function qtyInputCancel(ctx: MyContext, denominationId: number): Promise<void> {
  ctx.session.awaitingQtyDenomId = undefined;
  await browseDenomination(ctx, denominationId);
}

async function handleQtyTextInput(ctx: MyContext, denominationId: number, rawText: string): Promise<void> {
  await consumeInput(ctx);
  const lang = ctx.session.lang;
  const d = await getDenomination(prisma, denominationId);
  if (d === null) {
    ctx.session.awaitingQtyDenomId = undefined;
    await menuAnchor(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
    return;
  }
  // Stock rows only ever exist for AUTO SKUs — see the comment in
  // qtyInputStart. Non-AUTO SKUs are capped at MAX_CART_ORDER_UNITS instead
  // of the always-zero stock count.
  const effectiveMax =
    d.deliveryType === DeliveryType.AUTO ? await countAvailableStock(prisma, d.id) : MAX_CART_ORDER_UNITS;

  const isValid = /^\d+$/.test(rawText) && parseInt(rawText, 10) >= 1;
  if (!isValid || parseInt(rawText, 10) > effectiveMax) {
    await menuAnchor(ctx, t(ctx, "browse.qty_input_invalid", { max: effectiveMax }), ckb.qtyInputCancelKb(denominationId, lang));
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
  // Stock rows only ever exist for AUTO SKUs — see the comment in
  // qtyInputStart. Non-AUTO SKUs are clamped against MAX_CART_ORDER_UNITS
  // instead of the always-zero stock count, which would otherwise floor
  // every manual-SKU qty change back down to 1.
  const effectiveMax =
    d.deliveryType === DeliveryType.AUTO ? await countAvailableStock(prisma, d.id) : MAX_CART_ORDER_UNITS;
  const delta =
    action === "inc" ? 1 : action === "dec" ? -1 : action === "inc5" ? 5 : action === "dec5" ? -5 : 0;
  const newQty = Math.max(1, Math.min(qty + delta, effectiveMax));
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
        total: orderAmount(o, 2, lang),
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
    lines.push(`${t(ctx, "order.history_file_amount")}: ${orderAmount(o, 2, ctx.session.lang)}`);
    lines.push(`${t(ctx, "order.history_file_items")}:`);
    for (const g of groupOrderItems(o.items)) {
      lines.push(`  - ${g.product.name} × ${g.quantity}  ${formatIdrFor(g.lineTotal, ctx.session.lang)}`);
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
  // Ownership check, plus WALLET_TOPUP exclusion: a top-up isn't a "My
  // Orders" purchase (it's already visible via the wallet ledger), so it's
  // not reachable through this per-order-id view either — same exclusion
  // listUserOrders applies to the list this screen is normally opened from.
  if (order === null || order.userId !== info.id || order.kind !== OrderKind.PRODUCT) {
    await smartEdit(ctx, t(ctx, "error.order_not_found"), ckb.backToMain(lang));
    return;
  }

  // Item lines show the central-IDR snapshot (+ USDT info); the charged total
  // renders in the order's own transaction currency. A USDT total is always
  // written with a decimal point, so the "≈ $" hint stays in that style there
  // rather than switching to the buyer's decimal comma on the same screen.
  const rate = await currentUsdtRate();
  const hintLang = order.currency === "IDR" ? lang : "en";
  const itemLines = groupOrderItems(order.items).map(
    (g) => `• ${esc(g.product.name)} × ${g.quantity} — ${priceIdr(g.lineTotal, rate, lang, hintLang)}`,
  );

  let text: string;
  if (order.status === OrderStatus.PENDING_PAYMENT) {
    const countdown = order.expiresAt ? formatCountdown(order.expiresAt) : `${config.PAYMENT_WINDOW_MINUTES}:00`;
    if (order.paymentMethod === PaymentMethod.BINANCE_PAY) {
      // Legacy manual-transfer rail (retired for new orders, but existing
      // rows can still carry it) — the only method this Binance-ID copy is
      // actually correct for.
      const binanceId = (await getSetting(prisma, "binance_pay_id")) || config.BINANCE_PAY_ID;
      text = t(ctx, "order.pending_payment_detail", {
        code: order.orderCode,
        lines: itemLines.join("\n"),
        total: orderAmount(order, 4, lang),
        binance_id: esc(binanceId),
        countdown,
      });
    } else {
      // Every auto-confirm rail (Internal/Bybit/BybitBSC/Tokopay/Paydisini/
      // NOWPayments) — was wrongly shown the Binance-ID text above (audit
      // 2026-07-01). Show a generic rail-labeled notice instead; the
      // "🔄 Refresh Status" button orderDetailKb adds below reuses the same
      // on-demand reconcile (checkout.refreshPaymentStatus) the wait screens
      // already use, rather than duplicating each rail's full instructions.
      const methodKey = PENDING_PAYMENT_METHOD_LABEL_KEYS[order.paymentMethod];
      text = t(ctx, "order.pending_payment_rail", {
        code: order.orderCode,
        method: methodKey ? t(ctx, methodKey) : order.paymentMethod,
        lines: itemLines.join("\n"),
        total: orderAmount(order, 4, lang),
        countdown,
      });
    }
  } else if (
    order.paymentMethod === PaymentMethod.BYBIT_BSC &&
    BSC_TRACKING_STATUSES.includes(order.status)
  ) {
    await smartEdit(ctx, renderBybitBscTrackingScreen(order, lang), ckb.bybitBscTrackingKb(order, lang));
    return;
  } else if (order.status === OrderStatus.PROCESSING) {
    // Payment received for a manual/manual_with_info SKU — awaiting hand
    // fulfilment. Deliberately no ETA/SLA promise (matches the outbox
    // dispatcher's ORDER_PROCESSING_DM wording, Task 4). Uses the translated
    // customerStatusLabel here (NOT statusBadge, which stays English-derived
    // everywhere else in this file) as a deliberate upgrade for this one branch.
    text = t(ctx, "order.detail", {
      code: order.orderCode,
      status: t(ctx, customerStatusLabel(order.status)),
      total: orderAmount(order, 2, lang),
      created: ensureUtc(order.createdAt).toFormat("yyyy-LL-dd HH:mm 'UTC'"),
      lines: itemLines.join("\n"),
    });
    text += `\n\n${t(ctx, "order.processing_reassurance")}`;

    if (order.items[0]?.product.deliveryType === DeliveryType.MANUAL_WITH_INFO) {
      const fields = parseAdditionalFields(order.items[0]?.product.additionalFields ?? null);
      const answers = parseCustomerData(order.customerData);
      if (fields.length && answers.length) {
        const qty = order.items.length;
        const infoLines = answers
          .map((unitAnswers, unitIdx) =>
            fields
              .map((f) => {
                const label = esc((f.label as Record<string, string>)[lang] ?? f.label.en);
                const value = esc(unitAnswers[f.key] ?? "");
                return qty > 1
                  ? t(ctx, "order.processing_info_unit_line", { unit: unitIdx + 1, label, value })
                  : t(ctx, "order.processing_info_line", { label, value });
              })
              .join("\n"),
          )
          .join("\n");
        text += `\n\n${t(ctx, "order.processing_info_header")}\n${infoLines}`;
      }
    }
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
      // Manual/manual_with_info delivery — stockItem.credentials is always
      // empty (manual SKUs never reserve stock), so the block above never
      // fires for them. deliveredContent carries the admin-typed account
      // instead (fulfillManualOrder, Task 2). Auto orders never set this
      // field, so this is a no-op for every non-manual order.
      if (order.deliveredContent) {
        credentialsBlock += `\n\n${t(ctx, "order.detail_delivered_content", { content: `<pre>${esc(order.deliveredContent)}</pre>` })}`;
      }
    }
    text =
      t(ctx, "order.detail", {
        code: order.orderCode,
        status: statusBadge(order.status),
        total: orderAmount(order, 2, lang),
        created: ensureUtc(order.createdAt).toFormat("yyyy-LL-dd HH:mm 'UTC'"),
        lines: itemLines.join("\n"),
      }) + credentialsBlock;
  }
  await smartEdit(ctx, text, ckb.orderDetailKb(order, lang));
}

/**
 * Refresh Status button on a PROCESSING order's detail screen (order:refresh —
 * distinct from checkout:refresh's payment-status reconcile). Re-renders the
 * bubble from a fresh DB read via viewOrder itself (already no-op-safe on an
 * identical render, chat.ts's smartEdit), then compares status before/after to
 * decide the toast: "no update yet" when nothing changed, a plain ack otherwise
 * (viewOrder's own re-render already shows whatever DID change). Two extra
 * reads on a user-initiated, low-frequency tap is an acceptable cost.
 *
 * The before/after probe checks ownership the same way viewOrder does — a
 * crafted v1:order:refresh:<foreign-order-id> callback must not be able to
 * infer whether a non-owned order's status just changed. When the order
 * doesn't exist or isn't owned by the caller, skip the comparison entirely
 * and let viewOrder render its own error.order_not_found screen; the callback
 * still gets answered (a plain ack, not the no-update toast).
 */
export async function refreshOrderDetail(ctx: MyContext, orderId: number): Promise<void> {
  const info = requireUser(ctx);
  const beforeRaw = await getOrder(prisma, orderId);
  const before = beforeRaw && beforeRaw.userId === info.id ? beforeRaw : null;
  await viewOrder(ctx, orderId);
  if (!before) {
    await ctx.answerCallbackQuery();
    return;
  }
  const afterRaw = await getOrder(prisma, orderId);
  const after = afterRaw && afterRaw.userId === info.id ? afterRaw : null;
  if (after && before.status === after.status) {
    await ctx.answerCallbackQuery({ text: t(ctx, "order.no_update_toast") });
  } else {
    await ctx.answerCallbackQuery();
  }
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
  const text = t(ctx, "wallet.credit_balances", {
    idr: formatIdrFor(idrBalance, lang),
    usdt: formatUsdtBalance(usdtBalance),
  });
  await smartEdit(ctx, text, ckb.walletKb(lang));
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

/**
 * §10 — Help Center hub ("Pusat Bantuan"): a Home destination that fans out to
 * every support/info screen (referral, language, FAQ, terms, support, my
 * tickets) without crowding Home itself with six buttons.
 */
export async function showHelpCenter(ctx: MyContext): Promise<void> {
  ctx.session.state = BotState.HELP;
  await smartEdit(ctx, t(ctx, "help.title"), ckb.helpCenterKb(ctx.session.lang));
}

export async function setLanguage(ctx: MyContext, code: string): Promise<void> {
  const info = requireUser(ctx);
  await setUserLanguage(prisma, info.id, code);
  info.language = code.toUpperCase();
  ctx.session.lang = code.toLowerCase();
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "language.set") });
  if (ctx.session.onboarding === "language" || ctx.session.onboarding === "currency" || !info.preferredCurrency) {
    // /start onboarding: language done, currency next (never derived from it).
    // A duplicate/stale lang:set tap while already on the currency step just
    // re-shows the currency picker and stays there.
    // A user with no currency yet goes to the picker too even when onboarding
    // was never started: /language (and the Help Center / persistent-keyboard
    // Language entry) is exempt from requireCurrency, so without this they
    // would land on the main menu having never chosen a currency.
    ctx.session.onboarding = "currency";
    await showCurrencyMenu(ctx);
    return;
  }
  await showMainMenu(ctx);
}

/**
 * Language settings entry points outside /start (/language, the Help Center
 * button, the persistent-keyboard label). A user who already has a currency
 * and is sitting on a leftover, unfinished /start onboarding abandons it
 * here, so their language pick ends at the main menu and a remembered deep
 * link can never pop up later. A user with no currency keeps their
 * onboarding (they still have to pick one).
 */
export async function openLanguageMenu(ctx: MyContext): Promise<void> {
  if (ctx.session.dbUser?.preferredCurrency) {
    ctx.session.onboarding = null;
    ctx.session.pendingDeepLinkDenomId = undefined;
  }
  await showLanguageMenu(ctx);
}

export async function showCurrencyMenu(ctx: MyContext): Promise<void> {
  await smartEdit(ctx, t(ctx, "currency.choose"), ckb.currencyKb(ctx.session.lang));
}

/**
 * `v1:cur:set:<USD|IDR>` — store the display-currency preference. An unknown
 * or wrong-case code is treated as a stale/forged button: toast and change
 * nothing. Idempotent (a double tap re-writes the same value). Finishes
 * onboarding if it was in progress (opening a remembered deep link), and
 * otherwise just re-renders the main menu.
 */
export async function setCurrency(ctx: MyContext, code: string): Promise<void> {
  const currency = parseDisplayCurrency(code);
  if (!currency) {
    logger.warn({ code }, "A currency button carried an unsupported currency code, so it was treated as a stale screen and nothing was changed.");
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
    return;
  }
  const info = requireUser(ctx);
  await setUserPreferredCurrency(prisma, info.id, currency);
  info.preferredCurrency = currency;
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "currency.set") });

  // A remembered deep link only ever resumes the onboarding that stored it;
  // it is cleared either way so a later currency tap can't open it.
  const wasOnboarding = ctx.session.onboarding != null;
  ctx.session.onboarding = null;
  const pendingDenomId = ctx.session.pendingDeepLinkDenomId;
  ctx.session.pendingDeepLinkDenomId = undefined;
  if (wasOnboarding && pendingDenomId !== undefined) {
    await browseDenomination(ctx, pendingDenomId);
    return;
  }
  await showMainMenu(ctx);
}

export async function subscribeRestock(ctx: MyContext, denominationId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const denomination = await getDenominationWithProduct(prisma, denominationId);
  if (!denomination || !(await isServiceActive(prisma, denomination.product.category.group as CategoryGroup | null, "bot"))) {
    const msg = t(ctx, denomination ? "error.service_unavailable" : "error.try_again");
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg, show_alert: true });
    await smartEdit(ctx, msg, ckb.backToMain(lang));
    return;
  }
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

  const ticket = await getTicketWithOrder(prisma, ticketId);
  if (ticket === null || ticket.userId !== info.id) {
    await smartEdit(ctx, t(ctx, "error.ticket_not_found"), ckb.backToMain(lang));
    return;
  }
  const messages = await listTicketMessages(prisma, ticketId, 10);

  // Task 1 fix: WAITING_ADMIN/WAITING_CUSTOMER are now live values (see
  // TicketStatus's own doc comment, @app/core/enums) — labeled under the
  // same bucket as their OPEN/REPLIED counterpart so a ticket doesn't show
  // a raw enum string once it's been replied to more than once.
  const statusLabels: Record<string, string> = {
    [TicketStatus.OPEN]: "Open",
    [TicketStatus.WAITING_ADMIN]: "Open",
    [TicketStatus.REPLIED]: "Replied",
    [TicketStatus.WAITING_CUSTOMER]: "Replied",
    [TicketStatus.RESOLVED]: "Resolved",
    [TicketStatus.CLOSED]: "Closed",
  };
  const header = t(ctx, "ticket.view_title", {
    id: ticketId,
    status: statusLabels[ticket.status] ?? ticket.status,
    date: ensureUtc(ticket.createdAt).toFormat("yyyy-LL-dd HH:mm"),
  });

  const parts = [header];
  if (ticket.order) {
    const s = summarizeTicketOrder(ticket.order);
    const warrantyLine = s.warranty
      ? s.warranty.active
        ? `\n${t(ctx, "ticket.order_warranty_until", { date: s.warranty.untilDisplay })}`
        : `\n${t(ctx, "ticket.order_warranty_expired")}`
      : "";
    parts.push(
      t(ctx, "ticket.order_summary", {
        code: ticket.order.orderCode,
        status: s.statusBadge,
        product: s.productLine,
        warranty: warrantyLine,
      }),
    );
  }
  parts.push("");

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

  const reopenable =
    ticket.status === TicketStatus.CLOSED && ticket.closedAt != null
      ? addDays(ticket.closedAt, TICKET_REOPEN_WINDOW_DAYS).getTime() >= Date.now()
      : false;

  await smartEdit(ctx, parts.join("\n\n"), ckb.ticketViewKb(ticketId, ticket.status, lang, reopenable));
}

// ---------------------------------------------------------------------------
// Shortcut commands
// ---------------------------------------------------------------------------

export async function listprodukCommand(ctx: MyContext): Promise<void> {
  ctx.session.awaitingQtyDenomId = undefined;
  await browseGroups(ctx);
}

export async function languageCommand(ctx: MyContext): Promise<void> {
  ctx.session.awaitingQtyDenomId = undefined;
  await openLanguageMenu(ctx);
}

export async function currencyCommand(ctx: MyContext): Promise<void> {
  ctx.session.awaitingQtyDenomId = undefined;
  await showCurrencyMenu(ctx);
}

export async function searchCommand(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const query = (typeof ctx.match === "string" ? ctx.match : "").trim();
  if (!query) {
    await smartEdit(ctx, t(ctx, "search.no_query"), ckb.backToMain(lang));
    return;
  }
  const products = await searchCatalog(prisma, query, "bot");
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
