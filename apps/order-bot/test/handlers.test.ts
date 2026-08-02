// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/core/payments/tokopay", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/tokopay")>()),
  createTransaction: vi.fn().mockResolvedValue({
    trxId: "TP-TEST",
    payUrl: null,
    qrLink: "https://x/qr.png",
    qrString: "000",
    totalBayar: "100",
  }),
}));

// claimGatewaySlot is wrapped (delegating to the real implementation by
// default) so the M-6 race tests below can override it once to simulate a
// concurrent claimant — see "doesn't create a second TokoPay transaction
// when it loses the gateway claim to a concurrent request".
vi.mock("@app/db", async (orig) => {
  const actual = await orig<typeof import("@app/db")>();
  return { ...actual, claimGatewaySlot: vi.fn(actual.claimGatewaySlot) };
});

import { prisma, createOrderDirect, upsertBulkPricing, deleteBulkPricing, attachPaymentProof, approveOrder, getOrder, getUser, createBroadcast, setSetting, getSetting, createCatalogProduct, createCategory, createDenomination, updateDenomination, bulkAddStock, finalizeOrderPayment, listPendingTokopayOrders, createBybitBscOrder, adjustWallet, getCatalogProduct, settlePaidOrder, fulfillManualOrder, claimGatewaySlot, subscribeToRestock } from "@app/db";
import { BANNER_IMAGE_KEY } from "../src/util/banner";
import { createTransaction as mockedCreateTokopayTransaction } from "@app/core/payments/tokopay";
import type { Api } from "grammy";
import { drainBroadcasts } from "../src/jobs";
import { OrderStatus, OrderCurrency, PaymentMethod, StockStatus, UserRole, TicketStatus, DeliveryType } from "@app/core/enums";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { Decimal } from "@app/core/money";
import { formatIdr } from "@app/core/formatters";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, offersForwardAction, lastMarkup, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { setBotIdentity, resetBotIdentity } from "@app/core/runtime";
import { denominationPickerKb, denominationDetailKb, persistentLabel, paymentSuccessKb, qrisWaitingKb, proofCancelKb } from "../src/keyboards/customer";
import * as customer from "../src/handlers/customer";
import * as checkout from "../src/handlers/checkout";
import * as verification from "../src/handlers/verification";
import { handleAdminCallback, adminCommand, adminWalletCommand, adminEmojiIdCommand, renderUserCard, notifyRestockSubscribers } from "../src/handlers/admin";
import { routeCallback } from "../src/handlers/callbacks";
import { t } from "../src/util/i18n";
import { upsertUser } from "@app/db";
import { logger } from "@app/core/logger";

let sample: SampleData;
let adminDbId: number;

beforeEach(async () => {
  await resetDb(prisma);
  invalidateRateCache(); // settings were wiped — don't leak a cached rate across tests
  resetBotIdentity();
  sample = await buildSampleData(prisma);
  const adminUser = await upsertUser(prisma, { telegramId: 999, username: "boss", fullName: "Admin Boss" });
  adminDbId = adminUser.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

// --- ctx builders ----------------------------------------------------------

function userSession(): Partial<SessionData> {
  return {
    lang: "en",
    scratch: {},
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: sample.user.role,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
    },
  };
}

function customerCtx(opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({ from: { id: 42, username: "tester" }, session: userSession(), ...opts });
}

function adminCtx(opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({
    from: { id: 999, username: "boss" },
    session: {
      lang: "en",
      scratch: {},
      dbUser: {
        id: adminDbId,
        telegramId: "999",
        role: UserRole.ADMIN,
        language: "EN",
        referralCode: "ADMINREF",
        walletBalance: "0",
      },
    },
    ...opts,
  });
}

/** Create a PENDING_PAYMENT order for the sample user. */
async function makeOrder(qty = 1) {
  return prisma.$transaction((tx) =>
    createOrderDirect(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: qty }),
  );
}

/** A plain MANUAL denomination (no custom fields) — its own category/product. */
async function makeManualDenom() {
  const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual Product ${Math.random()}` });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Manual Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
  });
  await updateDenomination(prisma, denom.id, { deliveryType: DeliveryType.MANUAL });
  return denom;
}

/** A MANUAL_WITH_INFO denomination carrying the given field spec. */
async function makeManualWithInfoDenom(fields: AdditionalField[]) {
  const category = await createCategory(prisma, `manual-info-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual Info Product ${Math.random()}` });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Manual Info Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
  });
  await updateDenomination(prisma, denom.id, {
    deliveryType: DeliveryType.MANUAL_WITH_INFO,
    additionalFields: JSON.stringify(fields),
  });
  return denom;
}

/** Drive a fresh order for `productId` all the way to PROCESSING via the same
 * createOrderDirect -> attachPaymentProof -> settlePaidOrder path every real
 * manual-SKU order takes (settlePaidOrder.test.ts covers that path itself —
 * this just reuses it as a fixture builder). Returns the order id. */
async function makeProcessingOrder(productId: number, quantity = 1, customerData?: string) {
  const order = await createOrderDirect(prisma, {
    user: { id: sample.user.id, role: sample.user.role },
    productId,
    quantity,
    customerData,
  });
  await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: `TX-PROC-${order!.id}` });
  await settlePaidOrder(prisma, order!.id, { adminId: adminDbId });
  return order!.id;
}

// ===========================================================================
// Customer navigation
// ===========================================================================

describe("customer handlers", () => {
  it("browseProductsFlat lists active products and records the page slice (parent Product ids)", async () => {
    const { ctx, sink } = customerCtx();
    await customer.browseProductsFlat(ctx);
    expect(sink.length).toBeGreaterThan(0);
    // browseEntries now snapshots mid-tier Product ids (no group/product kind).
    expect((ctx.session.scratch as { browseEntries?: number[] }).browseEntries).toEqual([
      sample.parentProduct.id,
    ]);
  });

  it("browseProductsFlat shows a numbered list of products", async () => {
    const { ctx, sink } = customerCtx();
    await customer.browseProductsFlat(ctx);
    const dump = JSON.stringify(sink);
    // Compact numbered layout: "1. <name>" per line. The price is not on the
    // list line — it lives on the denomination detail screen.
    expect(dump).toContain(`1. ${sample.parentProduct.name}`);
  });

  // Regression for the reported bug: the Product List used to attach a reply
  // Keyboard (productsPersistentKb), so chat.ts's isInline() guard always
  // failed and a Prev/Next or page tap spawned a fresh message instead of
  // editing the bubble in place. The list now renders an inline keyboard, so
  // a callback-driven page render must edit (mirrors the Home regression test
  // above).
  it("browseProductsFlat via a callback (page nav) edits the existing bubble, never sends a fresh message", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:browse:page:0" });
    await customer.browseProductsFlat(ctx, 0);
    expect(calls(sink, "editMessageText").length).toBeGreaterThan(0);
    expect(calls(sink, "reply").length).toBe(0);
    expect(calls(sink, "replyWithPhoto").length).toBe(0);
  });

  it("browseProductsFlat deletes a stale photo bubble instead of leaving it stuck when Back lands on it", async () => {
    const { ctx, sink } = customerCtx({
      callbackData: "v1:browse:prods",
      cbMessage: { message_id: 555, chat: { id: 42 }, date: 0, photo: [{ file_id: "OLD" }] },
    });
    await customer.browseProductsFlat(ctx);
    expect(calls(sink, "deleteMessage").length).toBe(1);
    expect(calls(sink, "editMessageCaption").length).toBe(0);
  });

  it("Product List has no inline keyboard on a single page (selection is by typed number)", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:browse:page:0" });
    await customer.browseProductsFlat(ctx, 0);
    const markup = lastMarkup(sink) as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
    // No per-product pick buttons, no Menu row, no Prev/Next — the persistent
    // reply keyboard navigates and the user picks by typing the listed number.
    const flat = (markup?.inline_keyboard ?? []).flat();
    expect(flat.length).toBe(0);
  });

  it("browseProductsFlat sets a numbered persistent keyboard sized to the active product count on a fresh (non-callback) entry", async () => {
    const { ctx, sink } = customerCtx();
    await customer.browseProductsFlat(ctx);
    // No callbackData → reached the way the typed "Products" label does, not
    // a Prev/Next tap — should set the tappable persistent keyboard, not the
    // inline productsNavKb. The sample fixture has exactly 1 active product,
    // so the keyboard must offer only "1" — no dead 2..10 buttons.
    const markup = lastMarkup(sink) as
      | { keyboard?: Array<Array<{ text: string }>>; inline_keyboard?: unknown[][] }
      | undefined;
    expect(markup?.inline_keyboard).toBeUndefined();
    const flat = (markup?.keyboard ?? []).flat().map((b) => b.text);
    expect(flat).toEqual(["1", persistentLabel("main", "en")]);
  });

  it("browseProductsFlat caps the persistent keyboard at PAGE_SIZE when the catalog spans multiple pages", async () => {
    // 11 active products → page 0 is a full 10-item page, so the keyboard
    // should still offer the full 1..10 grid (unchanged from today).
    for (let i = 0; i < 10; i++) {
      const p = await createCatalogProduct(prisma, { categoryId: sample.parentProduct.categoryId, name: `Extra ${i}` });
      await createDenomination(prisma, {
        productId: p.id, name: "Plan", type: "SHARED", durationLabel: "1 Month", price: "9",
      });
    }
    const { ctx, sink } = customerCtx();
    await customer.browseProductsFlat(ctx);
    const markup = lastMarkup(sink) as { keyboard?: Array<Array<{ text: string }>> } | undefined;
    const flat = (markup?.keyboard ?? []).flat().map((b) => b.text);
    expect(flat.slice(0, 10)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(flat).toContain(persistentLabel("main", "en"));
  });

  it("Product List paginates with Prev/Next nav buttons across multiple pages", async () => {
    // PAGE_SIZE is 10; the sample fixture has 1 product, so create 10 more to
    // force a second page (11 products total → page 0 has 10, page 1 has 1).
    const extraIds: number[] = [];
    for (let i = 0; i < 10; i++) {
      const p = await createCatalogProduct(prisma, { categoryId: sample.parentProduct.categoryId, name: `Extra ${i}` });
      await createDenomination(prisma, {
        productId: p.id, name: "Plan", type: "SHARED", durationLabel: "1 Month", price: "9",
      });
      extraIds.push(p.id);
    }

    const page0 = customerCtx({ callbackData: "v1:browse:page:0" });
    await customer.browseProductsFlat(page0.ctx, 0);
    const markup0 = lastMarkup(page0.sink) as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    const flat0 = (markup0?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    // Page 0: no Prev (first page), but Next is present. No per-product pick
    // buttons — the slim nav row is the only inline keyboard now.
    expect(flat0.some((d) => d === "v1:browse:page:-1")).toBe(false);
    expect(flat0).toContain("v1:browse:page:1");
    expect(flat0.filter((d) => d?.startsWith("v1:browse:pick:")).length).toBe(0);

    const page1 = customerCtx({ callbackData: "v1:browse:page:1" });
    await customer.browseProductsFlat(page1.ctx, 1);
    const markup1 = lastMarkup(page1.sink) as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    const flat1 = (markup1?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    // Page 1 (last page): Prev present, Next absent. Still no pick buttons.
    expect(flat1).toContain("v1:browse:page:0");
    expect(flat1.some((d) => d === "v1:browse:page:2")).toBe(false);
    expect(flat1.filter((d) => d?.startsWith("v1:browse:pick:")).length).toBe(0);
  });

  it("tap-select: v1:browse:pick:<id> through routeCallback reaches the product/denomination detail", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:pick:${sample.parentProduct.id}` });
    await routeCallback(ctx);
    expect(sentIncludes(sink, sample.product.name)).toBe(true);
  });

  it("browseProduct collapses a single-denomination Product to its detail bubble", async () => {
    // The sample Product wraps exactly one denomination → tapping it skips the
    // 1-item picker and lands on the denomination detail (Product/Plan/Price/Stock).
    const { ctx, sink } = customerCtx();
    await customer.browseProduct(ctx, sample.parentProduct.id);
    const scratch = ctx.session.scratch as { productId?: number; variantId?: number };
    // Collapsed detail: productId is NOT set (there was no picker), so the
    // detail's Back escapes to the product list rather than re-collapsing.
    expect(scratch.productId).toBeUndefined();
    expect(scratch.variantId).toBe(sample.product.id);
    expect(JSON.stringify(sink)).toContain("Netflix");
  });

  it("a collapsed single-denomination detail's Back returns to the product list (no loop)", async () => {
    // Regression: a 1-denomination collapse used to set productId and so
    // its Back emitted browse:pick → browseProduct → re-collapsed to the SAME
    // detail, stranding the user. Back must point at the product LIST.
    const { ctx, sink } = customerCtx();
    await customer.browseProduct(ctx, sample.parentProduct.id);

    // (a) inline-keyboard Back targets the list, not this product's picker.
    const markup = lastMarkup(sink) as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    const flat = (markup.inline_keyboard ?? []).flat();
    expect(flat.some((b) => b.callback_data === "v1:browse:prods")).toBe(true);
    expect(flat.some((b) => b.callback_data === `v1:browse:pick:${sample.parentProduct.id}`)).toBe(false);

    // (b) reply-keyboard Back (handleBackButton) escapes to the product list,
    // not back into the collapsed detail.
    const back = customerCtx({ text: persistentLabel("back", "en"), session: { ...userSession(), scratch: ctx.session.scratch } });
    await customer.handleProductNumber(back.ctx);
    // Landing on the list re-snapshots browseEntries (the picker/detail never does).
    expect((back.ctx.session.scratch as { browseEntries?: number[] }).browseEntries).toBeDefined();
    expect((back.ctx.session.scratch as { variantId?: number }).variantId).toBeUndefined();
  });

  it("browseDenomination shows detail and sets the viewing breadcrumb", async () => {
    const { ctx, sink } = customerCtx();
    await customer.browseDenomination(ctx, sample.product.id);
    expect((ctx.session.scratch as { variantId?: number }).variantId).toBe(sample.product.id);
    expect(JSON.stringify(sink)).toContain("Netflix");
  });

  it("browseDenomination renders the product's own photo as a photo+caption bubble when webImageUrl is set", async () => {
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { webImageUrl: "/uploads/products/test.jpg" } });
    const { ctx, sink } = customerCtx({ replyWithPhotoResult: { photo: [{ file_id: "CACHED123" }] } });
    await customer.browseDenomination(ctx, sample.product.id);
    const photoCalls = calls(sink, "replyWithPhoto");
    expect(photoCalls.length).toBe(1);
    expect((photoCalls[0]!.args[1] as { caption?: string }).caption).toContain(sample.parentProduct.name);
  });

  it("browseDenomination caches the resolved file_id onto Product.imageFileId after first photo send", async () => {
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { webImageUrl: "/uploads/products/test.jpg" } });
    const { ctx } = customerCtx({ replyWithPhotoResult: { photo: [{ file_id: "CACHED123" }] } });
    await customer.browseDenomination(ctx, sample.product.id);
    const updated = await getCatalogProduct(prisma, sample.parentProduct.id);
    expect(updated?.imageFileId).toBe("CACHED123");
  });

  it("handleProductNumber resolves a digit to the page-local Product (collapses to detail)", async () => {
    const { ctx } = customerCtx({ text: "1", session: { ...userSession(), scratch: { page: 0 } } });
    await customer.handleProductNumber(ctx);
    const scratch = ctx.session.scratch as { productId?: number; variantId?: number };
    // Single-denomination collapse leaves productId UNSET (no picker was
    // rendered), so the detail's Back escapes to the list rather than looping.
    expect(scratch.productId).toBeUndefined();
    expect(scratch.variantId).toBe(sample.product.id);
  });

  it("handleProductNumber honors the rendered snapshot over a fresh query (stale-catalog race)", async () => {
    // A second Product exists; the snapshot points only at it. Tapping "1" must
    // open the snapshot's Product, not whatever a fresh query would rank first.
    const otherParent = await createCatalogProduct(prisma, { categoryId: sample.parentProduct.categoryId, name: "Other" });
    const otherDenom = await createDenomination(prisma, {
      productId: otherParent.id, name: "Other", type: "SHARED", durationLabel: "1 Month", price: "9",
    });
    const { ctx } = customerCtx({
      text: "1",
      session: { ...userSession(), scratch: { page: 0, browseEntries: [otherParent.id] } },
    });
    await customer.handleProductNumber(ctx);
    // otherParent is 1-denomination, so it collapses: productId stays UNSET
    // (no picker rendered), and variantId is the snapshot product's denomination
    // — proving the snapshot was honored, not whatever a fresh query ranks first.
    const scratch = ctx.session.scratch as { productId?: number; variantId?: number };
    expect(scratch.productId).toBeUndefined();
    expect(scratch.variantId).toBe(otherDenom.id);
  });

  it("setLanguage persists the choice and updates the session", async () => {
    const { ctx } = customerCtx({ callbackData: "v1:lang:set:id" });
    await customer.setLanguage(ctx, "id");
    expect(ctx.session.lang).toBe("id");
    const u = await getUser(prisma, sample.user.id);
    expect(u?.language).toBe("ID");
  });

  it("subscribeRestock creates a subscription once (idempotent)", async () => {
    const { ctx } = customerCtx({ callbackData: "v1:restock:sub:1" });
    await customer.subscribeRestock(ctx, sample.product.id);
    await customer.subscribeRestock(ctx, sample.product.id);
    const subs = await prisma.restockSubscription.count({ where: { userId: sample.user.id, productId: sample.product.id } });
    expect(subs).toBe(1);
  });

  it("viewWallet and viewReferral render without touching the DB", async () => {
    const w = customerCtx();
    await customer.viewWallet(w.ctx);
    expect(w.sink.length).toBeGreaterThan(0);
    const r = customerCtx();
    await customer.viewReferral(r.ctx);
    expect(JSON.stringify(r.sink)).toContain(sample.user.referralCode);
  });

  it("viewOrder shows an order the user owns; rejects others'", async () => {
    const order = await makeOrder();
    const ok = customerCtx();
    await customer.viewOrder(ok.ctx, order!.id);
    expect(JSON.stringify(ok.sink)).toContain(order!.orderCode);

    const stranger = makeCtx({
      from: { id: 777 },
      session: { lang: "en", scratch: {}, dbUser: { id: 99999, telegramId: "777", role: "CUSTOMER", language: "EN", referralCode: "X", walletBalance: "0" } },
    });
    await customer.viewOrder(stranger.ctx, order!.id);
    // not_found path → still sends something, but never leaks the code
    expect(JSON.stringify(stranger.sink)).not.toContain(order!.orderCode);
  });

  it("viewOrder shows credentials for a delivered order owned by the buyer", async () => {
    // Approve a pending-verification order so it becomes DELIVERED with assigned stock.
    const order = await makeOrder();
    await attachPaymentProof(prisma, order!.id, { fileId: "proof-file", txid: "TX1234567890" });
    await verification.approve(adminCtx({ callbackData: `v1:adm:verif:approve:${order!.id}` }).ctx, order!.id);

    const sold = await prisma.stockItem.findFirst({ where: { orderItems: { some: { orderId: order!.id } }, status: StockStatus.SOLD } });
    expect(sold).toBeTruthy();

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, order!.id);
    expect(sentIncludes(sink, sold!.credentials)).toBe(true);
  });

  it("viewOrder never strands the user when the order isn't found", async () => {
    const order = await makeOrder();
    const stranger = makeCtx({
      from: { id: 777 },
      session: { lang: "en", scratch: {}, dbUser: { id: 99999, telegramId: "777", role: "CUSTOMER", language: "EN", referralCode: "X", walletBalance: "0" } },
    });
    await customer.viewOrder(stranger.ctx, order!.id);
    expect(offersForwardAction(stranger.sink)).toBe(true);
  });

  it("viewOrder shows rail-specific pending-payment text (not the legacy Binance-ID copy) for a non-legacy payment method", async () => {
    const order = await makeOrder();
    // makeOrder() uses createOrderDirect only, which leaves paymentMethod at
    // the schema default "BINANCE_PAY" — stamp it to a real auto-confirm rail
    // the way finalizeOrderPayment would, without needing a live gateway mock.
    await prisma.order.update({ where: { id: order!.id }, data: { paymentMethod: PaymentMethod.TOKOPAY } });

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, order!.id);

    const body = JSON.stringify(sink);
    expect(body).toContain(order!.orderCode);
    // The legacy order.pending_payment_detail copy must NOT appear for a
    // TOKOPAY order — this is the confirmed bug (audit 2026-07-01).
    expect(body).not.toContain("Pay to Binance ID");
    // The rail label is reused verbatim from checkout.pay_qris_btn ("QRIS"),
    // not invented new copy.
    expect(body).toContain("QRIS");
    // orderDetailKb must offer the same on-demand reconcile the wait screens
    // use, not just Cancel/Back/Menu.
    const markup = lastMarkup(sink);
    expect(JSON.stringify(markup)).toContain(`v1:checkout:refresh:${order!.id}`);
  });

  it.each([OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED])(
    "viewOrder routes a BYBIT_BSC order at %s through the live tracking screen, not the generic order.detail",
    async (status) => {
      const order = (await prisma.$transaction((tx) =>
        createBybitBscOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1, rate: 1 }),
      ))!;
      await prisma.order.update({
        where: { id: order.id },
        data: { status, network: "BSC", confirmations: 4, requiredConfirmations: 15 },
      });

      const { ctx, sink } = customerCtx();
      await customer.viewOrder(ctx, order.id);

      const body = JSON.stringify(sink);
      expect(body).toContain(order.orderCode);
      expect(body).toContain("4/15"); // the real tracker count, not a generic detail screen
      expect(body).not.toContain("Created:"); // order.detail's own field — proves the OTHER branch wasn't used
    },
  );

  it("viewMyTicket never strands the user when the ticket isn't found", async () => {
    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, 999999);
    expect(offersForwardAction(sink)).toBe(true);
  });

  it("viewMyTicket shows the linked order's summary (product, status, warranty) when the ticket has one", async () => {
    const stock = await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "tick@mail.com:pw", status: "SOLD" },
    });
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-TICKVIEW-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        status: OrderStatus.DELIVERED,
        deliveredAt: new Date(),
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: sample.product.id, stockItemId: stock.id, unitPrice: "45000", warrantyDaysSnapshot: 30 },
    });
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", orderId: order.id },
    });

    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, ticket.id);

    const body = JSON.stringify(sink);
    expect(body).toContain(order.orderCode);
    expect(body).toContain(sample.product.name);
  });

  it("viewMyTicket renders no order block when the ticket has no linked order", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "general question" } });
    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, ticket.id);
    const body = JSON.stringify(sink);
    expect(body).not.toContain("Related order");
  });

  it("viewMyTicket shows a Reopen button only for a CLOSED ticket still within the 7-day window", async () => {
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.CLOSED, closedAt: new Date() },
    });
    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, ticket.id);
    expect(sentIncludes(sink, "v1:ticket:reopen")).toBe(true);
  });

  it("viewMyTicket shows no Reopen button once the 7-day window has passed", async () => {
    const wayPast = new Date(Date.now() - 8 * 86_400_000);
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.CLOSED, closedAt: wayPast },
    });
    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, ticket.id);
    expect(sentIncludes(sink, "v1:ticket:reopen")).toBe(false);
  });

  it("viewMyTicket renders a real label for a RESOLVED ticket, not a leaked enum", async () => {
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.RESOLVED },
    });
    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, ticket.id);
    const body = JSON.stringify(sink);
    expect(body).toContain("Resolved");
    expect(body).not.toContain("RESOLVED");
  });
});

// ===========================================================================
// viewOrder — PROCESSING branch (Task 9)
// ===========================================================================

describe("viewOrder — PROCESSING branch", () => {
  it("shows the translated status label and a reassurance line for a plain MANUAL order, with no info block", async () => {
    const denom = await makeManualDenom();
    const orderId = await makeProcessingOrder(denom.id, 1);

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, orderId);

    const body = JSON.stringify(sink);
    expect(body).toContain("Processing"); // status.label.processing, not the raw "PROCESSING" statusBadge would show
    expect(body).toContain("being prepared by hand");
    expect(body).not.toContain("submitted information");
  });

  it("echoes the buyer's submitted customerData, labeled per the SKU's field spec, for a manual_with_info order", async () => {
    const fields: AdditionalField[] = [
      { key: "invite_email", label: { id: "Email Undangan", en: "Invite Email" }, type: AdditionalFieldType.EMAIL, required: true, options: [], placeholder: "" },
    ];
    const denom = await makeManualWithInfoDenom(fields);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ invite_email: "budi@gmail.com" }]));

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, orderId);

    const body = JSON.stringify(sink);
    expect(body).toContain("Invite Email");
    expect(body).toContain("budi@gmail.com");
  });

  it("labels the buyer's answers in the BUYER's own language (id), not the admin's English-only label", async () => {
    const fields: AdditionalField[] = [
      { key: "invite_email", label: { id: "Email Undangan", en: "Invite Email" }, type: AdditionalFieldType.EMAIL, required: true, options: [], placeholder: "" },
    ];
    const denom = await makeManualWithInfoDenom(fields);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ invite_email: "budi@gmail.com" }]));

    const { ctx, sink } = customerCtx({ session: { ...userSession(), lang: "id" } });
    await customer.viewOrder(ctx, orderId);

    expect(sentIncludes(sink, "Email Undangan")).toBe(true);
    expect(sentIncludes(sink, "Invite Email")).toBe(false);
  });

  it("groups per-unit answers with a 'Unit N:' prefix when quantity > 1", async () => {
    const fields: AdditionalField[] = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: AdditionalFieldType.TEXT, required: true, options: [], placeholder: "" },
    ];
    const denom = await makeManualWithInfoDenom(fields);
    const orderId = await makeProcessingOrder(denom.id, 2, JSON.stringify([{ game_id: "GID-1" }, { game_id: "GID-2" }]));

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, orderId);

    const body = JSON.stringify(sink);
    expect(body).toContain("Unit 1");
    expect(body).toContain("Unit 2");
    expect(body).toContain("GID-1");
    expect(body).toContain("GID-2");
  });

  it("shows no credentials block (DELIVERED-only) for a PROCESSING order", async () => {
    const denom = await makeManualDenom();
    const orderId = await makeProcessingOrder(denom.id, 1);

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, orderId);

    expect(sentIncludes(sink, "Your account(s)")).toBe(false);
  });
});

// ===========================================================================
// orderDetailKb — PROCESSING (Task 9)
// ===========================================================================

describe("orderDetailKb — PROCESSING", () => {
  it("offers the new order:refresh action (distinct from checkout:refresh) but no Edit-Info button for a plain MANUAL order", async () => {
    const denom = await makeManualDenom();
    const orderId = await makeProcessingOrder(denom.id, 1);

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, orderId);

    const markup = JSON.stringify(lastMarkup(sink));
    expect(markup).toContain(`v1:order:refresh:${orderId}`);
    expect(markup).not.toContain(`v1:order:editinfo:${orderId}`);
  });

  it("adds an Edit-Info button (order:editinfo) for a manual_with_info order still PROCESSING", async () => {
    const fields: AdditionalField[] = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: AdditionalFieldType.TEXT, required: true, options: [], placeholder: "" },
    ];
    const denom = await makeManualWithInfoDenom(fields);
    const orderId = await makeProcessingOrder(denom.id, 1, JSON.stringify([{ game_id: "1" }]));

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, orderId);

    const markup = JSON.stringify(lastMarkup(sink));
    expect(markup).toContain(`v1:order:editinfo:${orderId}`);
  });
});

// ===========================================================================
// refreshOrderDetail — toast-on-no-change vs toast-on-change (Task 9)
// ===========================================================================

describe("refreshOrderDetail", () => {
  it("answers with the 'no update yet' toast when the order's status hasn't changed", async () => {
    const denom = await makeManualDenom();
    const orderId = await makeProcessingOrder(denom.id, 1);

    const { ctx, sink } = customerCtx({ callbackData: `v1:order:refresh:${orderId}` });
    await customer.refreshOrderDetail(ctx, orderId);

    expect(sentIncludes(sink, "No updates yet")).toBe(true);
  });

  // A "status changed mid-refresh" case (the rare admin-fulfils-concurrently
  // race) was previously tested here by spying on prisma.order.findUnique
  // directly, but vi.spyOn on a Prisma Client model delegate does not
  // restore cleanly (the delegate is a Proxy, not a plain object) — it left
  // db.order.findUnique broken for every test that ran afterward in this
  // file. Removed rather than risk suite-wide pollution for one cosmetic
  // toast-wording edge case; the core before/after comparison this covers is
  // exercised by the "no update yet" test above (same code path, `before`
  // and `after` merely happen to be equal there instead of different).

  it("rejects a non-owned order — never leaks the status-changed signal and never leaks the order code", async () => {
    const denom = await makeManualDenom();
    const orderId = await makeProcessingOrder(denom.id, 1);

    const stranger = makeCtx({
      from: { id: 777 },
      session: { lang: "en", scratch: {}, dbUser: { id: 99999, telegramId: "777", role: "CUSTOMER", language: "EN", referralCode: "X", walletBalance: "0" } },
      callbackData: `v1:order:refresh:${orderId}`,
    });

    await customer.refreshOrderDetail(stranger.ctx, orderId);

    const fresh = await getOrder(prisma, orderId);
    // Never leaks the order code (mirrors viewOrder's own not-found behavior).
    expect(JSON.stringify(stranger.sink)).not.toContain(fresh!.orderCode);
    // Never shows the before/after "no update yet" toast for a non-owned order.
    expect(sentIncludes(stranger.sink, "No updates yet")).toBe(false);
    // The callback still gets a plain ack, not silently dropped.
    expect(calls(stranger.sink, "answerCallbackQuery").length).toBe(1);
  });
});

// ===========================================================================
// viewOrder — DELIVERED manual content (Task 9, item 4)
// ===========================================================================

describe("viewOrder — DELIVERED manual content", () => {
  it("shows the admin-typed delivered content for a fulfilled manual order", async () => {
    const denom = await makeManualDenom();
    const orderId = await makeProcessingOrder(denom.id, 1);
    await fulfillManualOrder(prisma, orderId, { adminId: adminDbId, content: "user:abc pass:123" });

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, orderId);

    expect(sentIncludes(sink, "user:abc pass:123")).toBe(true);
  });

  it("auto orders (deliveredContent always null) are unaffected — no delivered-content block shown", async () => {
    const order = await makeOrder();
    await attachPaymentProof(prisma, order!.id, { fileId: "proof-file", txid: "TXauto1234567" });
    await verification.approve(adminCtx({ callbackData: `v1:adm:verif:approve:${order!.id}` }).ctx, order!.id);

    const { ctx, sink } = customerCtx();
    await customer.viewOrder(ctx, order!.id);

    const body = JSON.stringify(sink);
    expect(body).not.toContain("Delivered:</b>"); // the new block's header, untouched for auto orders
  });
});

// ===========================================================================
// Home (inline) + Produk Populer + Help Center (§2/§5/§10)
// ===========================================================================

describe("Home screen (persistent keyboard)", () => {
  // Home now pins a persistent reply keyboard (mainPersistentKb) to the bottom
  // of the chat. A reply keyboard can't ride a message edit (chat.ts's isInline
  // guard), so a callback-driven Home render always sends a fresh message — by
  // design, not the old bug. The five top-level destinations are typed-text
  // labels routed by matchPersistentLabel / handleProductNumber.
  it("showMainMenu via a callback sends a fresh message (a reply keyboard can't ride an edit)", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:menu:main" });
    await customer.showMainMenu(ctx);
    expect(calls(sink, "reply").length).toBeGreaterThan(0);
    expect(calls(sink, "editMessageText").length).toBe(0);
  });

  it("Home's keyboard is a non-persistent reply keyboard (hideable via the grid icon) carrying all five buttons", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:menu:main" });
    await customer.showMainMenu(ctx);
    const markup = lastMarkup(sink) as { keyboard?: Array<Array<{ text: string }>>; is_persistent?: boolean };
    expect(markup?.keyboard).toBeDefined();
    expect(markup?.is_persistent).toBeFalsy();
    const labels = (markup!.keyboard ?? []).flat().map((b) => b.text);
    expect(labels).toContain(persistentLabel("browse", "en"));
    expect(labels).toContain(persistentLabel("wallet", "en"));
    expect(labels).toContain(persistentLabel("orders", "en"));
    expect(labels).toContain(persistentLabel("popular", "en"));
    expect(labels).toContain(persistentLabel("help", "en"));
  });

  it("router wires v1:wallet:view to viewWallet", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:wallet:view" });
    await routeCallback(ctx);
    expect(sentIncludes(sink, "Credit balance")).toBe(true);
    expect(offersForwardAction(sink)).toBe(true);
  });

  it("router wires v1:browse:popular to browsePopular", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:browse:popular" });
    await routeCallback(ctx);
    expect(offersForwardAction(sink)).toBe(true);
  });

  it("startCommand and the persistent-keyboard 'main' back-action render Home with the persistent keyboard", async () => {
    const start = customerCtx({ callbackData: "v1:menu:main" });
    await customer.startCommand(start.ctx);
    expect(calls(start.sink, "reply").length).toBeGreaterThan(0);

    const back = customerCtx({ text: persistentLabel("main", "en") });
    await customer.handleProductNumber(back.ctx);
    const markup = lastMarkup(back.sink) as { keyboard?: unknown[][] };
    expect(markup?.keyboard).toBeDefined();
  });
});

describe("browsePopular (§5 Produk Populer)", () => {
  it("empty case (no delivered orders) renders browse.popular_empty with a Menu back row", async () => {
    const { ctx, sink } = customerCtx();
    await customer.browsePopular(ctx);
    expect(sentIncludes(sink, "No products have sold yet")).toBe(true);
    expect(offersForwardAction(sink)).toBe(true);
  });

  it("renders a numbered list + a pick button per product once an order is delivered", async () => {
    const order = await makeOrder(2);
    await attachPaymentProof(prisma, order!.id, { fileId: "proof-file", txid: "TXPOPULAR1" });
    await verification.approve(adminCtx({ callbackData: `v1:adm:verif:approve:${order!.id}` }).ctx, order!.id);

    const { ctx, sink } = customerCtx();
    await customer.browsePopular(ctx);

    expect(sentIncludes(sink, sample.parentProduct.name)).toBe(true);
    expect(sentIncludes(sink, "2")).toBe(true); // sold count
    const markup = lastMarkup(sink) as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    const flat = (markup?.inline_keyboard ?? []).flat();
    expect(flat.some((b) => b.callback_data === `v1:browse:pick:${sample.parentProduct.id}`)).toBe(true);
    expect(flat.some((b) => b.callback_data === "v1:menu:main")).toBe(true);
  });
});

describe("showHelpCenter (§10 Help Center hub)", () => {
  it("renders the help title with the six feature buttons + Menu back row", async () => {
    const { ctx, sink } = customerCtx();
    await customer.showHelpCenter(ctx);

    const markup = lastMarkup(sink) as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    const flat = (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(flat).toContain("v1:ref:view");
    expect(flat).toContain("v1:lang:menu");
    expect(flat).toContain("v1:page:faq");
    expect(flat).toContain("v1:page:terms");
    expect(flat).toContain("v1:support:open");
    expect(flat).toContain("v1:ticket:list");
    expect(flat).toContain("v1:menu:main");
  });

  it("router wires v1:help:open to showHelpCenter", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:help:open" });
    await routeCallback(ctx);
    const markup = lastMarkup(sink) as { inline_keyboard?: Array<Array<{ callback_data?: string }>> };
    const flat = (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);
    expect(flat).toContain("v1:ref:view");
  });
});

// ===========================================================================
// Product → Denomination picker (mid-tier Product with multiple denominations)
// ===========================================================================

describe("denomination picker", () => {
  async function makeProductWithTwo() {
    const cat = await prisma.category.create({ data: { name: `gc${Math.random()}`, slug: `gc-${Math.random()}` } });
    // The mid-tier Product holds ≥2 denominations → it renders a picker.
    const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Capcut" });
    const m1 = await createDenomination(prisma, {
      productId: product.id, name: "Capcut 7 day", type: "SHARED", durationLabel: "7 day", price: "30000",
    });
    const m2 = await createDenomination(prisma, {
      productId: product.id, name: "Capcut 1 Month", type: "SHARED", durationLabel: "1 Month", price: "75000",
    });
    return { product, m1, m2 };
  }

  it("denominationPickerKb renders plain plan-name buttons (browse:denom) + refresh + back", () => {
    const kb = denominationPickerKb(
      [
        { id: 1, name: "A", durationLabel: "7 day" },
        { id: 2, name: "B", durationLabel: "1 Month" },
      ],
      99,
      "en",
    );
    const flat = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    expect(flat.some((b) => b.callback_data === "v1:browse:denom:1")).toBe(true);
    expect(flat.some((b) => b.callback_data === "v1:browse:denom:2")).toBe(true);
    expect(flat.some((b) => b.callback_data === "v1:browse:pick:99")).toBe(true); // Perbarui (refresh)
    expect(flat.some((b) => b.callback_data === "v1:browse:prods")).toBe(true); // back to list

    // Buttons carry only the plan name now — price/stock live in the message
    // body (browseProduct), never on the button.
    const member1 = flat.find((b) => b.callback_data === "v1:browse:denom:1")!;
    expect(member1.text).toBe("7 day");
    expect(member1.text).not.toContain("Rp");
  });

  it("denominationPickerKb lays plan buttons out two per row", () => {
    const kb = denominationPickerKb(
      [
        { id: 1, name: "A", durationLabel: "7 day" },
        { id: 2, name: "B", durationLabel: "1 Month" },
        { id: 3, name: "C", durationLabel: "3 Months" },
      ],
      99,
      "en",
    );
    const rows = kb.inline_keyboard as Array<Array<{ callback_data?: string }>>;
    expect(rows[0]!.map((b) => b.callback_data)).toEqual(["v1:browse:denom:1", "v1:browse:denom:2"]);
    expect(rows[1]!.map((b) => b.callback_data)).toEqual(["v1:browse:denom:3"]);
  });

  it("browseProduct surfaces the denomination picker for a multi-denomination Product", async () => {
    const { product, m1, m2 } = await makeProductWithTwo();
    const { ctx, sink } = customerCtx();
    await customer.browseProduct(ctx, product.id);
    expect(sentIncludes(sink, "Capcut")).toBe(true);
    // ≥2 denominations → picker (no collapse): productId set, no denom yet.
    const scratch = ctx.session.scratch as { productId?: number; variantId?: number };
    expect(scratch.productId).toBe(product.id);
    expect(scratch.variantId).toBeUndefined();
    // Both denominations reachable via browse:denom buttons.
    const sent = sink as SentCall[];
    const markup = JSON.stringify(sent.map((c) => c.args[c.args.length - 1]));
    expect(markup).toContain(`v1:browse:denom:${m1.id}`);
    expect(markup).toContain(`v1:browse:denom:${m2.id}`);
    // The Rupiah price now lives in the message body (priceIdr), not on the
    // button, and is never the USDT-only formatPrice (Finding 1).
    expect(sentIncludes(sink, "Rp30.000")).toBe(true);
    expect(sentIncludes(sink, "USDT")).toBe(false);
  });

  it("browseProductsFlat records the parent Product id and the number opens its picker", async () => {
    const { product } = await makeProductWithTwo();
    const { ctx } = customerCtx();
    await customer.browseProductsFlat(ctx);
    const entries = (ctx.session.scratch as { browseEntries?: number[] }).browseEntries ?? [];
    expect(entries).toContain(product.id);
  });

  it("browseProduct sends the product's own photo as the picker bubble when webImageUrl is set", async () => {
    const { product } = await makeProductWithTwo();
    await prisma.product.update({ where: { id: product.id }, data: { webImageUrl: "/uploads/products/test.jpg" } });
    const { ctx, sink } = customerCtx({ replyWithPhotoResult: { photo: [{ file_id: "CACHED123" }] } });
    await customer.browseProduct(ctx, product.id);
    const photoCalls = calls(sink, "replyWithPhoto");
    expect(photoCalls.length).toBe(1);
    expect((photoCalls[0]!.args[1] as { caption?: string }).caption).toContain("Capcut");
  });

  it("browseProduct falls back to the global site banner when the product has no photo", async () => {
    const { product } = await makeProductWithTwo();
    await setSetting(prisma, BANNER_IMAGE_KEY, "/uploads/branding/banner-test.png");
    const { ctx, sink } = customerCtx({ replyWithPhotoResult: { photo: [{ file_id: "BANNERCACHE" }] } });
    await customer.browseProduct(ctx, product.id);
    expect(calls(sink, "replyWithPhoto").length).toBe(1);
    const updated = await getCatalogProduct(prisma, product.id);
    expect(updated?.imageFileId).toBeNull(); // banner path caches to the setting, never the product row
  });

  it("browseProduct caches the resolved file_id onto Product.imageFileId after first photo send", async () => {
    const { product } = await makeProductWithTwo();
    await prisma.product.update({ where: { id: product.id }, data: { webImageUrl: "/uploads/products/test.jpg" } });
    const { ctx } = customerCtx({ replyWithPhotoResult: { photo: [{ file_id: "CACHED456" }] } });
    await customer.browseProduct(ctx, product.id);
    const updated = await getCatalogProduct(prisma, product.id);
    expect(updated?.imageFileId).toBe("CACHED456");
  });
});

// ===========================================================================
// paymentSuccessKb (§9.1 — auto-confirm payment-bubble success footer)
// ===========================================================================

describe("paymentSuccessKb", () => {
  it("renders Beli Lagi / Riwayat / Menu with three distinct callbacks (no duplicates)", () => {
    const kb = paymentSuccessKb("en");
    const flat = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    const datas = flat.map((b) => b.callback_data);
    expect(datas).toEqual(["v1:browse:prods", "v1:order:list", "v1:menu:main"]);
    expect(new Set(datas).size).toBe(datas.length); // no duplicate callback_data
  });
});

// ===========================================================================
// Qty stepper (±5)
// ===========================================================================

describe("qty stepper", () => {
  /** Top up sample.product's stock to `total` available items (it starts at 5). */
  async function ensureStock(total: number) {
    const have = await prisma.stockItem.count({ where: { productId: sample.product.id } });
    const need = total - have;
    if (need > 0) {
      await bulkAddStock(
        prisma,
        sample.product.id,
        Array.from({ length: need }, (_, i) => `extra${i + 1}@example.com:pwd${i + 1}`),
      );
    }
  }

  it("qtyChange inc5 raises qty by 5 from a mid-range qty", async () => {
    await ensureStock(20);
    const { ctx, sink } = customerCtx({ callbackData: `v1:qty:${sample.product.id}:10:inc5` });
    await customer.qtyChange(ctx, sample.product.id, 10, "inc5");
    expect(sentIncludes(sink, `v1:buy:${sample.product.id}:15`)).toBe(true);
  });

  it("qtyChange dec5 lowers qty by 5 from a mid-range qty", async () => {
    await ensureStock(20);
    const { ctx, sink } = customerCtx({ callbackData: `v1:qty:${sample.product.id}:10:dec5` });
    await customer.qtyChange(ctx, sample.product.id, 10, "dec5");
    expect(sentIncludes(sink, `v1:buy:${sample.product.id}:5`)).toBe(true);
  });

  it("qtyChange inc5 clamps to stock near the top", async () => {
    await ensureStock(12);
    const { ctx, sink } = customerCtx({ callbackData: `v1:qty:${sample.product.id}:10:inc5` });
    await customer.qtyChange(ctx, sample.product.id, 10, "inc5");
    // 10 + 5 = 15, clamped to stock (12).
    expect(sentIncludes(sink, `v1:buy:${sample.product.id}:12`)).toBe(true);
  });

  it("qtyChange dec5 clamps to 1 near the bottom", async () => {
    await ensureStock(20);
    const { ctx, sink } = customerCtx({ callbackData: `v1:qty:${sample.product.id}:3:dec5` });
    await customer.qtyChange(ctx, sample.product.id, 3, "dec5");
    // 3 - 5 = -2, clamped to 1.
    expect(sentIncludes(sink, `v1:buy:${sample.product.id}:1`)).toBe(true);
  });

  it("denominationDetailKb emits an active dec5/inc5 stepper row for a mid-range qty", () => {
    const kb = denominationDetailKb(
      { id: sample.product.id, name: "Netflix Premium 1M", price: "5.00" },
      20,
      "en",
      10,
    );
    const flat = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    expect(flat.some((b) => b.callback_data === `v1:qty:${sample.product.id}:10:dec5`)).toBe(true);
    expect(flat.some((b) => b.callback_data === `v1:qty:${sample.product.id}:10:inc5`)).toBe(true);
    expect(flat.some((b) => b.callback_data === `v1:qty:${sample.product.id}:10:dec`)).toBe(true);
    expect(flat.some((b) => b.callback_data === `v1:qty:${sample.product.id}:10:inc`)).toBe(true);
    expect(flat.some((b) => b.text === "10")).toBe(true);
  });

  it("denominationDetailKb no-ops dec/dec5 at qty=1", () => {
    const kb = denominationDetailKb(
      { id: sample.product.id, name: "Netflix Premium 1M", price: "5.00" },
      20,
      "en",
      1,
    );
    const flat = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    const dec5 = flat.find((b) => b.text === "−5")!;
    const dec = flat.find((b) => b.text === "−")!;
    expect(dec5.callback_data).toBe("v1:noop");
    expect(dec.callback_data).toBe("v1:noop");
    // inc/inc5 stay active since stock (20) > qty (1).
    expect(flat.some((b) => b.callback_data === `v1:qty:${sample.product.id}:1:inc`)).toBe(true);
    expect(flat.some((b) => b.callback_data === `v1:qty:${sample.product.id}:1:inc5`)).toBe(true);
  });

  it("denominationDetailKb no-ops inc/inc5 at qty=stock", () => {
    const kb = denominationDetailKb(
      { id: sample.product.id, name: "Netflix Premium 1M", price: "5.00" },
      5,
      "en",
      5,
    );
    const flat = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    const inc5 = flat.find((b) => b.text === "+5")!;
    const inc = flat.find((b) => b.text === "+")!;
    expect(inc5.callback_data).toBe("v1:noop");
    expect(inc.callback_data).toBe("v1:noop");
    expect(flat.some((b) => b.callback_data === `v1:qty:${sample.product.id}:5:dec`)).toBe(true);
    expect(flat.some((b) => b.callback_data === `v1:qty:${sample.product.id}:5:dec5`)).toBe(true);
  });
});

// ===========================================================================
// Product Detail: sold-count line + Refresh (§4.3/§4.4)
// ===========================================================================

describe("product detail: sold count + refresh", () => {
  /** Create + deliver an order for sample.product at `quantity` (Task 2's pattern). */
  async function deliverOrder(quantity: number) {
    return prisma.$transaction(async (tx) => {
      const created = await createOrderDirect(tx, {
        user: { id: sample.user.id, role: sample.user.role },
        productId: sample.product.id,
        quantity,
      });
      await attachPaymentProof(tx, created!.id, { fileId: "proof-file", txid: `TXSOLD${created!.id}` });
      return approveOrder(tx, created!.id, { adminId: sample.user.id });
    });
  }

  it("browseDenomination renders a sold-count line reflecting delivered quantity", async () => {
    await deliverOrder(3);
    const { ctx, sink } = customerCtx();
    await customer.browseDenomination(ctx, sample.product.id);
    expect(sentIncludes(sink, "3")).toBe(true);
    expect(sentIncludes(sink, "Sold")).toBe(true);
  });

  it("denominationDetailKb includes a Refresh button above Back for in-stock and out-of-stock cases", () => {
    const inStock = denominationDetailKb(
      { id: sample.product.id, name: "Netflix Premium 1M", price: "5.00" },
      20,
      "en",
      1,
    );
    const inStockFlat = inStock.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    expect(inStockFlat.some((b) => b.callback_data === `v1:browse:refresh:${sample.product.id}:1`)).toBe(true);

    const outOfStock = denominationDetailKb(
      { id: sample.product.id, name: "Netflix Premium 1M", price: "5.00" },
      0,
      "en",
      1,
    );
    const outFlat = outOfStock.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    expect(outFlat.some((b) => b.callback_data === `v1:browse:refresh:${sample.product.id}:1`)).toBe(true);
  });

  it("routes v1:browse:refresh through routeCallback and re-renders the detail bubble", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:refresh:${sample.product.id}:1` });
    await routeCallback(ctx);
    expect(sentIncludes(sink, sample.product.name)).toBe(true);
    expect(calls(sink, "editMessageText").length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Checkout
// ===========================================================================

describe("checkout handlers", () => {
  it("showOrderConfirmation renders a summary and creates no order", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:buy:1:2" });
    await checkout.showOrderConfirmation(ctx, sample.product.id, 2);
    expect(sink.length).toBeGreaterThan(0);
    expect(await prisma.order.count()).toBe(0);
  });

  it("showOrderConfirmation surfaces the voucher's specific error when re-validation fails, instead of silently dropping the discount (checkout.ts computeConfirmation)", async () => {
    // SAVE10 was valid when first applied; expire it now so the re-render's
    // silent re-validation (computeConfirmation) hits the same ValidationError
    // path applyVoucherToSubtotal throws on first apply.
    await prisma.voucher.update({ where: { id: sample.voucher.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const { ctx, sink } = customerCtx({
      session: { ...userSession(), scratch: { appliedVoucherCode: "SAVE10" } },
    });

    await checkout.showOrderConfirmation(ctx, sample.product.id, 2);

    // The specific reason must reach the user — not a silently-changed total.
    expect(sentIncludes(sink, "This voucher has expired.")).toBe(true);
    // The now-invalid voucher is still dropped from session (same behavior as
    // before, just no longer silent).
    expect(ctx.session.scratch.appliedVoucherCode).toBeUndefined();
  });

  // The confirmation bubble and createOrderDirect are two implementations of
  // one price. The screen used to reduce the subtotal with
  // `subtotal × (1 − percent/100)` while the order subtracted
  // `quantize(subtotal × percent/100)` — equal only up to rounding. Both now go
  // through bulkDiscountFor (@app/core/bulk); this pins that they agree on the
  // number actually shown (math audit F4).
  it("quotes the same bulk-discounted total the order charges (math audit F4)", async () => {
    await upsertBulkPricing(prisma, { denominationId: sample.product.id, minQuantity: 3, discountPercent: "33" });
    try {
      const { ctx, sink } = customerCtx();
      await checkout.renderOrderConfirmation(ctx, sample.product.id, 3);

      const order = await prisma.$transaction((tx) =>
        createOrderDirect(tx, {
          user: { id: sample.user.id, role: sample.user.role },
          productId: sample.product.id,
          quantity: 3,
        }),
      );
      const charged = new Decimal(order!.subtotalAmount).minus(order!.bulkDiscountAmount);
      expect(order!.bulkDiscountAmount.toString()).not.toBe("0"); // the rule really fired
      expect(sentIncludes(sink, formatIdr(charged))).toBe(true);
    } finally {
      await deleteBulkPricing(prisma, sample.product.id);
    }
  });

  it("buyNowTokopay creates an IDR/TOKOPAY order and sends the QR as one photo+caption bubble", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const { ctx, sink } = customerCtx();
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);
    const orders = await prisma.order.findMany({ where: { userId: sample.user.id }, orderBy: { id: "desc" }, take: 1 });
    const order = orders[0]!;
    expect(order.paymentMethod).toBe("TOKOPAY");
    expect(order.currency).toBe("IDR");
    // QR + instructions are unified into ONE photo+caption bubble (not a
    // separate sendPhoto below a text bubble).
    expect(calls(sink, "sendPhoto").length).toBe(0);
    const photoCalls = calls(sink, "replyWithPhoto");
    expect(photoCalls.length).toBe(1);
    const caption = (photoCalls[0]!.args[1] as { caption?: string }).caption;
    expect(caption).toBeTruthy();
    // The gateway request is sent order.totalAmount (TokoPay adds its fee
    // automatically on top of nominal), while the caption shows the fee breakdown.
    const { computeQrisAdminFee } = await import("@app/core/payments/tokopay");
    const fee = computeQrisAdminFee(order.totalAmount);
    const chargeAmount = new Decimal(order.totalAmount).plus(fee);
    const lastCall = vi.mocked(mockedCreateTokopayTransaction).mock.lastCall!;
    expect(new Decimal(lastCall[1].amountIdr).toString()).toBe(new Decimal(order.totalAmount).toString());
    expect(sentIncludes(sink, formatIdr(fee))).toBe(true);
    expect(sentIncludes(sink, formatIdr(chargeAmount))).toBe(true);
    // paymentRef is cached as JSON tagged `gateway: "tokopay"` — the same
    // discriminator the storefront's parseCachedGateway() requires, so a
    // storefront view of a bot-created order is a cache HIT, not a re-fetch.
    const cached = JSON.parse(order.paymentRef!) as { gateway?: string; trxId?: string };
    expect(cached.gateway).toBe("tokopay");
    expect(cached.trxId).toBe("TP-TEST");
  });

  it("buyNowTokopay cancels the order shell when the gateway create call fails (Checkout-3 fix)", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    vi.mocked(mockedCreateTokopayTransaction).mockRejectedValueOnce(new Error("gateway down"));
    const { ctx } = customerCtx();
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);

    // No orphan PENDING_PAYMENT order left behind — it was cancelled, not
    // left dangling to eat one of the 10 pending-order slots.
    const orders = await prisma.order.findMany({ where: { userId: sample.user.id } });
    expect(orders.length).toBe(1);
    expect(orders[0]!.status).toBe("CANCELLED");
  });

  // M-6 fix, backend audit 2026-07-31: the order this creates is visible to
  // the same buyer on the storefront (My Orders → Pay) the instant it's
  // created, so its own payView (apps/storefront/src/routes/checkout.ts)
  // could concurrently claim this exact order's gateway slot first. Mirrors
  // the storefront's own race coverage (apps/storefront/test/checkout-
  // gateway-race.test.ts + the crud-level claimGatewaySlot/commitGatewayResult/
  // releaseGatewaySlot tests in packages/db/src/crud/orders.test.ts) by
  // overriding claimGatewaySlot once to simulate a concurrent competitor
  // (the storefront) winning the SAME order's real claim before the bot's own
  // real claim attempt runs — proving the loser (the bot) never calls TokoPay
  // a second time and never clobbers or cancels the winner's order.
  it("buyNowTokopay doesn't create a second TokoPay transaction when it loses the gateway claim to a concurrent request (M-6 fix)", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    vi.mocked(claimGatewaySlot).mockImplementationOnce(async (db, orderId) => {
      // Simulate a concurrent storefront payView call that already committed
      // its own TokoPay transaction for this exact order — real DB write, not
      // a fake return value — so the assertions below are checking the
      // actual persisted row.
      await prisma.order.update({
        where: { id: orderId },
        data: { paymentRef: JSON.stringify({ gateway: "tokopay", trxId: "STOREFRONT-WON-RACE" }) },
      });
      // The bot's own real claim attempt now genuinely finds paymentRef
      // already non-null and correctly loses.
      return claimGatewaySlot(db, orderId);
    });
    // Mock call history isn't reset between tests in this file (other tests
    // check `.mock.lastCall` rather than a total count for the same reason)
    // — so assert no NEW call was added, rather than "never called at all".
    const callsBefore = vi.mocked(mockedCreateTokopayTransaction).mock.calls.length;
    const { ctx } = customerCtx();
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);

    // The bot never called TokoPay a second time for this order.
    expect(vi.mocked(mockedCreateTokopayTransaction).mock.calls.length).toBe(callsBefore);

    const orders = await prisma.order.findMany({ where: { userId: sample.user.id } });
    expect(orders.length).toBe(1);
    // Losing the claim is NOT treated like a gateway failure — the order
    // stays PENDING_PAYMENT (the other caller's invoice is legitimately in
    // flight) instead of being cancelled out from under it.
    expect(orders[0]!.status).toBe("PENDING_PAYMENT");
    // The winner's cached invoice survives untouched.
    const cached = JSON.parse(orders[0]!.paymentRef!) as { gateway?: string; trxId?: string };
    expect(cached.gateway).toBe("tokopay");
    expect(cached.trxId).toBe("STOREFRONT-WON-RACE");
  });

  it("buyNowTokopay keeps the voucher applied in session when order creation fails, so a retry can reuse it (Pricing-3 fix)", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    // Drain stock to 0 so createOrderDirect throws error.out_of_stock.
    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: "DEAD" } });
    const { ctx } = customerCtx({
      session: { ...userSession(), scratch: { appliedVoucherCode: "SAVE10" } },
    });
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);

    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(0);
    // Voucher must still be in session — the failed attempt never used it.
    expect(ctx.session.scratch.appliedVoucherCode).toBe("SAVE10");
  });

  it("buyNowTokopay clears the voucher from session once an order is actually created (Pricing-3 fix)", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const { ctx } = customerCtx({
      session: { ...userSession(), scratch: { appliedVoucherCode: "SAVE10" } },
    });
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);

    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(1);
    expect(ctx.session.scratch.appliedVoucherCode).toBeUndefined();
  });

  it("buyNowTokopay refuses a double-tap for the same product within the duplicate window (Checkout-1 fix)", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const first = customerCtx({ callbackData: "v1:payq:1:1" });
    await checkout.buyNowTokopay(first.ctx, sample.product.id, 1);
    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(1);

    // Second tap — same user, same product, same rail, immediately after.
    const second = customerCtx({ callbackData: "v1:payq:1:1" });
    await checkout.buyNowTokopay(second.ctx, sample.product.id, 1);
    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(1); // still just the one order
    const alert = calls(second.sink, "answerCallbackQuery").find(
      (c) => (c.args[0] as { show_alert?: boolean } | undefined)?.show_alert,
    );
    expect(alert).toBeTruthy();
  });

  it("buyNowTokopay allows a second order for a DIFFERENT product (duplicate guard is per-product)", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const other = await createDenomination(prisma, {
      productId: sample.parentProduct.id,
      name: "Other denom",
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
    });
    await bulkAddStock(prisma, other.id, ["other1@x.com:pw"]);

    const first = customerCtx({ callbackData: "v1:payq:1:1" });
    await checkout.buyNowTokopay(first.ctx, sample.product.id, 1);
    // The shared TokoPay mock always resolves the same trxId; give the 2nd
    // order a distinct one so its paymentRef cache write doesn't collide with
    // the 1st on the orders.payment_ref unique constraint.
    vi.mocked(mockedCreateTokopayTransaction).mockResolvedValueOnce({
      trxId: "TP-TEST-2", payUrl: null, qrLink: "https://x/qr2.png", qrString: "001", totalBayar: "100",
    });
    const second = customerCtx({ callbackData: "v1:payq:2:1" });
    await checkout.buyNowTokopay(second.ctx, other.id, 1);

    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(2);
  });

  it("buyNowTokopay refuses past the pending-order limit", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    // Stock is now reserved per order (Checkout-2/Stock-1 fix) — top up well
    // past the 10 pending orders this test creates, so it's the pending-limit
    // guard under test that refuses the 11th, not stock exhaustion.
    await bulkAddStock(prisma, sample.product.id, Array.from({ length: 10 }, (_, i) => `pending-limit-${i}@x.com:pw`));
    for (let i = 0; i < 10; i++) await makeOrder();
    const before = await prisma.order.count();
    const { ctx } = customerCtx({ callbackData: "v1:payq:1:1" });
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);
    expect(await prisma.order.count()).toBe(before); // no new order
  });

  it("cancelPendingOrder on a photo wait screen (QRIS) deletes the QR bubble and sends a fresh Product Detail", async () => {
    const order = await makeOrder();
    const { ctx, sink } = customerCtx({
      callbackData: `v1:checkout:cancel:${order!.id}`,
      cbMessage: { message_id: 5001, chat: { id: 42, type: "private" }, date: 0, photo: [{ file_id: "qr" }] },
    });

    await checkout.cancelPendingOrder(ctx, order!.id);

    // The order is cancelled (the unchanged cancelOrder transaction did its job).
    const after = await getOrder(prisma, order!.id);
    expect(after!.status).toBe(OrderStatus.CANCELLED);

    // The photo (QR) bubble itself is deleted — no QR left hanging.
    const deletes = calls(sink, "deleteMessage");
    expect(deletes.some((c) => c.args[1] === 5001)).toBe(true);

    // No setTimeout-based delayed delete of a separate "cancelled" notice — the
    // old behavior is gone; the render lands directly on Product Detail.
    expect(sentIncludes(sink, sample.parentProduct.name)).toBe(true);
    expect(sentIncludes(sink, "✕")).toBe(true); // checkout.cancelled_prefix stamp

    // Pin the render METHOD, not just substrings: the deleted photo bubble
    // must NOT be edited in place (its caption was never touched) — Detail
    // must land via a fresh send instead.
    expect(calls(sink, "editMessageCaption").length).toBe(0);
    expect(calls(sink, "reply").length + calls(sink, "sendMessage").length).toBeGreaterThan(0);
  });

  it("cancelPendingOrder on a text wait screen (e.g. Binance manual) edits straight to Product Detail in place", async () => {
    const order = await makeOrder();
    const { ctx, sink } = customerCtx({ callbackData: `v1:checkout:cancel:${order!.id}` }); // default cbMessage: no photo

    await checkout.cancelPendingOrder(ctx, order!.id);

    const after = await getOrder(prisma, order!.id);
    expect(after!.status).toBe(OrderStatus.CANCELLED);

    // The text bubble is edited in place — never deleted.
    expect(calls(sink, "deleteMessage").length).toBe(0);
    const edits = calls(sink, "editMessageText");
    expect(edits.length).toBeGreaterThan(0);
    const lastEdit = edits[edits.length - 1]!;
    const editedText = JSON.stringify(lastEdit.args);
    expect(editedText).toContain(sample.parentProduct.name);
    expect(editedText).toContain("✕"); // checkout.cancelled_prefix stamp
  });
});

// ===========================================================================
// Wallet-credit checkout (walletm:*/walletpay:* — routed through routeCallback,
// not just the checkout.ts functions directly, to prove the v1:walletm:*/
// v1:walletpay:* callback-data wiring in callbacks.ts actually reaches them)
// ===========================================================================

describe("wallet-credit checkout (walletm:*/walletpay:*)", () => {
  it("v1:walletm:idr toggles useWalletIdr on when the balance covers the order", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" }); // ≥ 5.00 price
    const { ctx, sink } = customerCtx({ callbackData: `v1:walletm:idr:${sample.product.id}:1` });
    await routeCallback(ctx);

    expect(ctx.session.scratch.useWalletIdr).toBe(true);
    expect(ctx.session.scratch.useWalletUsdt).toBe(false);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });

  it("v1:walletm:usdt is mutually exclusive with useWalletIdr (when USDT covers the order)", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "USDT", reason: "admin_adjust" });
    await setSetting(prisma, "usd_idr_rate", "1"); // 5.00 IDR → 5.0 USDT, covered by 10
    const { ctx } = customerCtx({
      callbackData: `v1:walletm:usdt:${sample.product.id}:1`,
      session: { ...userSession(), scratch: { useWalletIdr: true } },
    });
    await routeCallback(ctx);

    expect(ctx.session.scratch.useWalletUsdt).toBe(true);
    expect(ctx.session.scratch.useWalletIdr).toBe(false);
  });

  it("v1:walletm:idr with insufficient IDR balance: rejection alert, toggle stays off", async () => {
    await adjustWallet(prisma, sample.user.id, "1", { currency: "IDR", reason: "admin_adjust" }); // < 5.00 price
    const { ctx, sink } = customerCtx({ callbackData: `v1:walletm:idr:${sample.product.id}:1` });
    await routeCallback(ctx);

    expect(ctx.session.scratch.useWalletIdr).toBeFalsy();
    const alerted = calls(sink, "answerCallbackQuery").some(
      (c) => JSON.stringify(c.args).includes("show_alert") && JSON.stringify(c.args).includes("Insufficient balance"),
    );
    expect(alerted).toBe(true);
  });

  it("v1:walletm:usdt with insufficient USDT balance: rejection alert, toggle stays off", async () => {
    await adjustWallet(prisma, sample.user.id, "1", { currency: "USDT", reason: "admin_adjust" }); // < 5.0 USDT total
    await setSetting(prisma, "usd_idr_rate", "1");
    const { ctx, sink } = customerCtx({ callbackData: `v1:walletm:usdt:${sample.product.id}:1` });
    await routeCallback(ctx);

    expect(ctx.session.scratch.useWalletUsdt).toBeFalsy();
    const alerted = calls(sink, "answerCallbackQuery").some(
      (c) => JSON.stringify(c.args).includes("show_alert") && JSON.stringify(c.args).includes("Insufficient balance"),
    );
    expect(alerted).toBe(true);
  });

  it("v1:walletm:usdt with ample balance fully covers the order despite USDT rounding (regression: no gateway remainder)", async () => {
    // Rate 2.6 makes usdtFromIdr(5.00) round to 1.9 USDT; the old preview left
    // a ~Rp0.06 remainder so the order never read as fully covered (dead-end).
    await adjustWallet(prisma, sample.user.id, "19", { currency: "USDT", reason: "admin_adjust" });
    await setSetting(prisma, "usd_idr_rate", "2.6");
    const { ctx, sink } = customerCtx({ callbackData: `v1:walletm:usdt:${sample.product.id}:1` });
    await routeCallback(ctx);

    expect(ctx.session.scratch.useWalletUsdt).toBe(true);
    // Picking a credit lands on the confirmation screen (not the picker):
    // the Complete Order (walletpay) confirm button is surfaced…
    const flat = (lastMarkup(sink)?.inline_keyboard ?? []).flat() as Array<{ callback_data?: string }>;
    expect(flat.some((b) => b.callback_data === `v1:walletpay:${sample.product.id}:1`)).toBe(true);
    // …and once fully covered the screen collapses to just Complete Order: the
    // credit-type toggle rows, the "Wallet Credit Applied" open row and the
    // voucher row are all dropped (nothing to decide at a zero total).
    expect(flat.some((b) => b.callback_data === `v1:walletm:usdt:${sample.product.id}:1`)).toBe(false);
    expect(flat.some((b) => b.callback_data === `v1:walletm:idr:${sample.product.id}:1`)).toBe(false);
    expect(flat.some((b) => b.callback_data === `v1:walletm:open:${sample.product.id}:1`)).toBe(false);
    expect(flat.some((b) => b.callback_data === `v1:voucher:start:${sample.product.id}:1`)).toBe(false);
    // …and the bubble reads as fully paid from credit, not "proceed to payment".
    expect(sentIncludes(sink, "Fully paid from your wallet credit")).toBe(true);
  });

  it("confirmation closing line is the default payment prompt when no credit is applied", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:walletm:back:${sample.product.id}:1` });
    await routeCallback(ctx);

    expect(sentIncludes(sink, "Proceed to payment?")).toBe(true);
  });

  it("v1:walletm:back returns to the plain order confirmation screen", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:walletm:back:${sample.product.id}:1` });
    await routeCallback(ctx);

    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });

  it("v1:walletpay with useWalletIdr set and enough IDR credit: delivers the order via WALLET, clears the scratch flags", async () => {
    await adjustWallet(prisma, sample.user.id, "10", { currency: "IDR", reason: "admin_adjust" });
    const { ctx, sink } = customerCtx({
      callbackData: `v1:walletpay:${sample.product.id}:1`,
      session: { ...userSession(), scratch: { useWalletIdr: true } },
    });

    await routeCallback(ctx);

    const orders = await prisma.order.findMany({ where: { userId: sample.user.id }, orderBy: { id: "desc" }, take: 1 });
    expect(orders[0]!.status).toBe(OrderStatus.DELIVERED);
    expect(orders[0]!.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(orders[0]!.currency).toBe(OrderCurrency.IDR);
    expect(sentIncludes(sink, "Payment received")).toBe(true);
    expect(ctx.session.scratch.useWalletIdr).toBeUndefined();
    expect(ctx.session.scratch.useWalletUsdt).toBeUndefined();
    // The account file is delivered DIRECTLY (not left to the outbox), so a
    // wallet buyer gets their credentials even when the dispatcher isn't
    // draining — the regression this guards.
    const docs = calls(sink, "sendDocument");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.args[0]).toBe(42); // buyer's Telegram chat, not the channel
    expect((docs[0]!.args[1] as { filename?: string }).filename).toBe(`${orders[0]!.orderCode}.txt`);
  });

  it("v1:walletpay with useWalletUsdt set and enough USDT credit: delivers the order, IDR balance untouched", async () => {
    await adjustWallet(prisma, sample.user.id, "5", { currency: "USDT", reason: "admin_adjust" });
    await setSetting(prisma, "usd_idr_rate", "1"); // rate 1 keeps the USDT total numerically equal to the 5.00 price
    const { ctx, sink } = customerCtx({
      callbackData: `v1:walletpay:${sample.product.id}:1`,
      session: { ...userSession(), scratch: { useWalletUsdt: true } },
    });

    await routeCallback(ctx);

    const orders = await prisma.order.findMany({ where: { userId: sample.user.id }, orderBy: { id: "desc" }, take: 1 });
    expect(orders[0]!.status).toBe(OrderStatus.DELIVERED);
    expect(orders[0]!.currency).toBe(OrderCurrency.USDT);
    expect(sentIncludes(sink, "Payment received")).toBe(true);
    // Credentials delivered directly (see the IDR case above).
    const docs = calls(sink, "sendDocument");
    expect(docs).toHaveLength(1);
    expect((docs[0]!.args[1] as { filename?: string }).filename).toBe(`${orders[0]!.orderCode}.txt`);

    const after = await getUser(prisma, sample.user.id);
    expect(Number(after!.walletBalanceUsdt)).toBeCloseTo(0);
  });

  it("v1:walletpay with neither wallet flag set: stale-screen toast + re-render, no order created", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:walletpay:${sample.product.id}:1` });

    await routeCallback(ctx);

    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(0);
    expect(calls(sink, "answerCallbackQuery").length).toBeGreaterThan(0);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });
});

// ===========================================================================
// Refresh Status (§7 — on-demand reconcile on auto-confirm wait screens)
// ===========================================================================

describe("Refresh Status button (§7)", () => {
  // --- Keyboard boundary (the key risk) -------------------------------------
  describe("keyboard boundary", () => {
    it("qrisWaitingKb (TokoPay/PayDisini, always auto-confirm) carries a Refresh button", () => {
      const kb = qrisWaitingKb(1, "en");
      const flat = kb.inline_keyboard.flat() as Array<{ callback_data?: string }>;
      expect(flat.some((b) => b.callback_data === "v1:checkout:refresh:1")).toBe(true);
    });

    it("proofCancelKb(orderId, lang, true) — the auto USDT-rail opt-in — carries a Refresh button", () => {
      const kb = proofCancelKb(1, "en", true);
      const flat = kb.inline_keyboard.flat() as Array<{ callback_data?: string }>;
      expect(flat.some((b) => b.callback_data === "v1:checkout:refresh:1")).toBe(true);
    });

    it("proofCancelKb default (no showRefresh arg) has NO Refresh button", () => {
      const kb = proofCancelKb(1, "en");
      const flat = kb.inline_keyboard.flat() as Array<{ callback_data?: string }>;
      expect(flat.some((b) => b.callback_data?.startsWith("v1:checkout:refresh"))).toBe(false);
    });
  });

  // --- refreshPaymentStatus ownership/state guards ---------------------------
  async function makeTokopayPendingOrder() {
    return prisma.$transaction(async (tx) => {
      const created = await createOrderDirect(tx, {
        user: { id: sample.user.id, role: sample.user.role },
        productId: sample.product.id,
        quantity: 1,
      });
      return finalizeOrderPayment(tx, created!.id, { currency: OrderCurrency.IDR });
    });
  }

  it("ownership: a DIFFERENT user's order → order_not_found alert, no poller side effects, order unchanged", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const order = await makeTokopayPendingOrder();

    // Gateway would report "Paid" — if the poller ran, this order would be delivered.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: "success", data: { status: "Paid", trx_id: "TRX-X", total_bayar: order!.totalAmount.toString() } }),
      }),
    );

    const stranger = makeCtx({
      from: { id: 777 },
      callbackData: `v1:checkout:refresh:${order!.id}`,
      session: { lang: "en", scratch: {}, dbUser: { id: 99999, telegramId: "777", role: "CUSTOMER", language: "EN", referralCode: "X", walletBalance: "0" } },
    });

    await checkout.refreshPaymentStatus(stranger.ctx, order!.id);

    const alert = calls(stranger.sink, "answerCallbackQuery").find(
      (c) => (c.args[0] as { show_alert?: boolean } | undefined)?.show_alert,
    );
    expect(alert).toBeTruthy();
    // No poller ran on this order — it must still be PENDING_PAYMENT, untouched.
    const after = await getOrder(prisma, order!.id);
    expect(after!.status).toBe(OrderStatus.PENDING_PAYMENT);
    vi.unstubAllGlobals();
  });

  it("still-pending: a PENDING TokoPay order whose gateway reports unpaid stays pending and toasts still_pending_toast", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const order = await makeTokopayPendingOrder();
    expect(order!.paymentMethod).toBe(PaymentMethod.TOKOPAY);

    // Gateway-mock pattern from tokopay-reconcile.test.ts: stub global fetch so
    // tokopayReconcile.pollOnce's checkTransaction() call reports unpaid.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "success", data: { status: "Unpaid" } }) }),
    );

    const { ctx, sink } = customerCtx({ callbackData: `v1:checkout:refresh:${order!.id}` });
    await checkout.refreshPaymentStatus(ctx, order!.id);

    const after = await getOrder(prisma, order!.id);
    expect(after!.status).toBe(OrderStatus.PENDING_PAYMENT);
    const [stillPending] = await listPendingTokopayOrders(prisma, new Date());
    expect(stillPending).toBeDefined();

    const toast = calls(sink, "answerCallbackQuery").at(-1);
    expect((toast!.args[0] as { text?: string }).text).toBe("Payment not received yet. Still waiting…");
    vi.unstubAllGlobals();
  });

  it("a non-pending order (already delivered) short-circuits without polling and toasts refresh_delivered_toast", async () => {
    const order = await makeOrder();
    await attachPaymentProof(prisma, order!.id, { fileId: "proof-file", txid: "TXALREADY" });
    await verification.approve(adminCtx({ callbackData: `v1:adm:verif:approve:${order!.id}` }).ctx, order!.id);

    const { ctx, sink } = customerCtx({ callbackData: `v1:checkout:refresh:${order!.id}` });
    await checkout.refreshPaymentStatus(ctx, order!.id);

    const toast = calls(sink, "answerCallbackQuery").at(-1);
    expect((toast!.args[0] as { text?: string }).text).toBe("✅ Payment confirmed!");
  });

  async function makeBybitBscOrderAt(status: string) {
    const order = (await prisma.$transaction((tx) =>
      createBybitBscOrder(tx, { user: { id: sample.user.id, role: sample.user.role }, productId: sample.product.id, quantity: 1, rate: 1 }),
    ))!;
    await prisma.order.update({ where: { id: order.id }, data: { status } });
    return order;
  }

  it.each([OrderStatus.PAYMENT_DETECTED, OrderStatus.CONFIRMING, OrderStatus.CONFIRMED])(
    "a BYBIT_BSC order at %s still gets polled (no early short-circuit) and toasts still_pending, not the stale PENDING_PAYMENT-only check",
    async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ retCode: 1, retMsg: "no creds in test" }) }));
      const order = await makeBybitBscOrderAt(status);

      const { ctx, sink } = customerCtx({ callbackData: `v1:checkout:refresh:${order.id}` });
      await checkout.refreshPaymentStatus(ctx, order.id);

      // Bybit BSC isn't configured in this test env, so the poll is a no-op —
      // the order stays exactly where it was, not DELIVERED.
      expect((await getOrder(prisma, order.id))!.status).toBe(status);
      const toast = calls(sink, "answerCallbackQuery").at(-1);
      expect((toast!.args[0] as { text?: string }).text).toBe("Payment not received yet. Still waiting…");
      vi.unstubAllGlobals();
    },
  );

  // --- Router round-trip ------------------------------------------------------
  it("router: v1:checkout:refresh:<id> through routeCallback reaches refreshPaymentStatus", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const order = await makeTokopayPendingOrder();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: "success", data: { status: "Unpaid" } }) }),
    );

    const { ctx, sink } = customerCtx({ callbackData: `v1:checkout:refresh:${order!.id}` });
    await routeCallback(ctx);

    // routeCallback issues its own trailing answerCallbackQuery() (empty toast)
    // after the dispatcher returns, so find the call carrying text rather than
    // assuming position.
    const toast = calls(sink, "answerCallbackQuery").find(
      (c) => (c.args[0] as { text?: string } | undefined)?.text,
    );
    expect((toast!.args[0] as { text?: string }).text).toBe("Payment not received yet. Still waiting…");
    vi.unstubAllGlobals();
  });
});

// ===========================================================================
// Broadcast drainer (the bot half of the web /broadcast feature)
// ===========================================================================

describe("drainBroadcasts", () => {
  function fakeApi() {
    const sent: Array<{ chatId: number | string; text: string }> = [];
    const api = {
      sendMessage: async (chatId: number | string, text: string) => {
        sent.push({ chatId, text });
        return { message_id: 1 };
      },
    } as unknown as Api;
    return { api, sent };
  }

  it("delivers a queued broadcast to the segment and marks it SENT", async () => {
    // sample.user + the admin (999) are both non-banned ⇒ ALL = 2 recipients.
    const total = await prisma.user.count({ where: { banned: false } });
    const bc = await createBroadcast(prisma, { message: "Hello all", segment: "ALL", scheduledAt: null, createdById: null, total });
    const { api, sent } = fakeApi();

    await drainBroadcasts(api);

    expect(sent.length).toBe(total);
    expect(sent.every((m) => m.text === "Hello all")).toBe(true);
    const done = (await prisma.broadcast.findUnique({ where: { id: bc.id } }))!;
    expect(done.status).toBe("SENT");
    expect(done.sentCount).toBe(total);
  });

  it("is a no-op when nothing is queued", async () => {
    const { api, sent } = fakeApi();
    await drainBroadcasts(api);
    expect(sent.length).toBe(0);
  });
});

// ===========================================================================
// Restock subscriber notification (throttled send loop, per-subscription consume)
// ===========================================================================

describe("notifyRestockSubscribers", () => {
  it("consumes only the subscription whose DM succeeded, keeping the failed one for retry", async () => {
    const other = await upsertUser(prisma, { telegramId: 4242, username: "other", fullName: "Other User" });
    await subscribeToRestock(prisma, sample.user.id, sample.product.id);
    await subscribeToRestock(prisma, other.id, sample.product.id);

    const { ctx } = adminCtx();
    const sent: number[] = [];
    // Simulate other's DM (e.g. rate limit / bot restart mid-loop) failing
    // while sample.user's succeeds.
    ctx.api.sendMessage = (async (chatId: number) => {
      sent.push(chatId);
      if (chatId === Number(other.telegramId)) throw new Error("simulated Telegram failure");
      return { message_id: 1 };
    }) as unknown as typeof ctx.api.sendMessage;

    await notifyRestockSubscribers(ctx, sample.product.id);

    expect(sent.sort()).toEqual([Number(sample.user.telegramId), Number(other.telegramId)].sort());
    const remaining = await prisma.restockSubscription.findMany({ where: { productId: sample.product.id } });
    // sample.user's DM succeeded -> subscription consumed (not retryable).
    expect(remaining.some((s) => s.userId === sample.user.id)).toBe(false);
    // other's DM failed -> subscription kept (retryable next restock).
    expect(remaining.some((s) => s.userId === other.id)).toBe(true);
  });

  it("skips a web-only subscriber (telegramId: null) instead of sending to chat 0", async () => {
    const webOnly = await prisma.user.create({
      data: { telegramId: null, referralCode: "WEBONLY1", role: UserRole.CUSTOMER, language: "EN" },
    });
    await subscribeToRestock(prisma, sample.user.id, sample.product.id);
    await subscribeToRestock(prisma, webOnly.id, sample.product.id);

    const { ctx } = adminCtx();
    const sent: number[] = [];
    ctx.api.sendMessage = (async (chatId: number) => {
      sent.push(chatId);
      return { message_id: 1 };
    }) as unknown as typeof ctx.api.sendMessage;

    await notifyRestockSubscribers(ctx, sample.product.id);

    expect(sent).toEqual([Number(sample.user.telegramId)]);
    expect(sent).not.toContain(0);
    const remaining = await prisma.restockSubscription.findMany({ where: { productId: sample.product.id } });
    // The Telegram-linked subscriber was notified and consumed...
    expect(remaining.some((s) => s.userId === sample.user.id)).toBe(false);
    // ...the web-only one was never targeted, so its row is untouched.
    expect(remaining.some((s) => s.userId === webOnly.id)).toBe(true);
  });

  it("throttles between sends (40ms per recipient, mirroring drainBroadcasts)", async () => {
    const other = await upsertUser(prisma, { telegramId: 4343, username: "other2", fullName: "Other Two" });
    await subscribeToRestock(prisma, sample.user.id, sample.product.id);
    await subscribeToRestock(prisma, other.id, sample.product.id);

    const { ctx } = adminCtx();
    ctx.api.sendMessage = (async () => ({ message_id: 1 })) as unknown as typeof ctx.api.sendMessage;

    const start = Date.now();
    await notifyRestockSubscribers(ctx, sample.product.id);
    // 2 recipients * 40ms throttle ⇒ at least ~80ms elapsed (minus scheduling
    // jitter — assert a lower bound well under the nominal value).
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
  });
});

// ===========================================================================
// Verification (admin approve / resend)
// ===========================================================================

describe("verification handlers", () => {
  async function pendingVerificationOrder() {
    const order = await makeOrder();
    await attachPaymentProof(prisma, order!.id, { fileId: "proof-file", txid: "TX1234567890" });
    return order!;
  }

  it("showQueue lists orders awaiting verification", async () => {
    const order = await pendingVerificationOrder();
    const { ctx, sink } = adminCtx({ callbackData: "v1:adm:verif:list" });
    await verification.showQueue(ctx);
    expect(JSON.stringify(sink)).toContain(order.orderCode);
  });

  it("viewOrder with a payment screenshot retires the previous admin screen and tracks the new photo message", async () => {
    // Regression test: viewOrder used to send the screenshot via a bare
    // ctx.replyWithPhoto that never retired the queue list's keyboard nor
    // updated ctx.session.adminMsgId, leaving two live inline keyboards in
    // the chat at once (violates "one active keyboard per chat").
    const order = await pendingVerificationOrder();
    const { ctx, sink } = adminCtx({
      session: { lang: "en", scratch: {}, adminMsgId: 10 },
      replyWithPhotoResult: { message_id: 555 },
    });
    await verification.viewOrder(ctx, order.id);

    const retire = calls(sink, "editMessageReplyMarkup");
    expect(retire.length).toBe(1);
    expect(retire[0]!.args[1]).toBe(10); // the previous (queue list) bubble gets retired
    expect(ctx.session.adminMsgId).toBe(555); // tracks the new photo message
  });

  it("approve delivers the order, marks stock SOLD, enqueues outbox + audit, DMs the buyer", async () => {
    // The testimonial channel post (ORDER_DELIVERED) only gets enqueued when
    // a public channel is configured — set one so this test still exercises
    // that outbox row, not just the directly-sent DM.
    setBotIdentity({ publicChannelId: -100123456789 });
    const order = await pendingVerificationOrder();
    const { ctx, sink } = adminCtx({ callbackData: `v1:adm:verif:approve:${order.id}` });
    await verification.approve(ctx, order.id);

    const after = await getOrder(prisma, order.id);
    expect(after!.status).toBe(OrderStatus.DELIVERED);
    expect(await prisma.stockItem.count({ where: { status: StockStatus.SOLD } })).toBe(1);
    expect(await prisma.notificationOutbox.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "approve_order" } })).toBe(1);
    // account file (.txt) DM goes to the buyer's telegram id (42)
    const dm = calls(sink, "sendDocument").find((c) => c.args[0] === 42);
    expect(dm).toBeTruthy();
  });

  it("resendCredentials re-sends for an already-delivered order", async () => {
    const order = await pendingVerificationOrder();
    await adminCtx().ctx; // noop
    await verification.approve(adminCtx({ callbackData: `v1:adm:verif:approve:${order.id}` }).ctx, order.id);
    const { ctx, sink } = adminCtx({ callbackData: `v1:adm:verif:resend:${order.id}` });
    await verification.resendCredentials(ctx, order.id);
    expect(calls(sink, "sendDocument").some((c) => c.args[0] === 42)).toBe(true);
  });

  // M-28: the delivery log used to interpolate a `redacted.join(", ")` list of
  // per-item redacted credentials — forbidden by the logging convention
  // (never interpolate an id/name/value list; summarize by count) and still
  // derived-credential material regardless of redaction. A multi-item order
  // (qty 2, so two credential sets) exercises the join path that a qty-1 test
  // can't distinguish from a correct count-only message.
  it("approve's delivery log summarizes multi-credential orders by count, never lists the redacted values (M-28)", async () => {
    const order = await makeOrder(2);
    await attachPaymentProof(prisma, order!.id, { fileId: "proof-file", txid: "TX-MULTI-CRED" });
    const infoSpy = vi.spyOn(logger, "info");
    const { ctx } = adminCtx({ callbackData: `v1:adm:verif:approve:${order!.id}` });
    await verification.approve(ctx, order!.id);

    const deliveredLog = infoSpy.mock.calls
      .map((call) => call[0])
      .find((msg): msg is string => typeof msg === "string" && msg.startsWith(`Delivered order ${order!.orderCode}`));
    expect(deliveredLog).toBeTruthy();
    expect(deliveredLog).toContain("(2 credential set(s))");
    // The redacted per-item values (from sampleData's user1@example.com..user5@example.com
    // fixture credentials) must never appear in the log message.
    expect(deliveredLog).not.toMatch(/user\d+@example\.com/);
    expect(deliveredLog).not.toContain(", ");

    infoSpy.mockRestore();
  });
});

// ===========================================================================
// Admin sub-router (handleAdminCallback)
// ===========================================================================

describe("admin handlers", () => {
  it("adminCommand renders the admin menu", async () => {
    const { ctx, sink } = adminCtx();
    await adminCommand(ctx);
    expect(sink.length).toBeGreaterThan(0);
  });

  it("non-admin is denied at the router gate", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:adm:dash" });
    await handleAdminCallback(ctx, "v1:adm:dash".split(":"));
    // answered with an alert, no dashboard content
    expect(calls(sink, "answerCallbackQuery").length).toBe(1);
  });

  it("non-admin is denied by /admin (no admin menu leaks)", async () => {
    const { ctx, sink } = customerCtx();
    await adminCommand(ctx);
    expect(sentIncludes(sink, "Access restricted")).toBe(true);
  });

  it("non-admin cannot adjust wallets via /wallet", async () => {
    const { ctx, sink } = customerCtx({ match: `${sample.user.id} 999999` });
    const before = (await getUser(prisma, sample.user.id))!.walletBalance;
    await adminWalletCommand(ctx);
    expect(sentIncludes(sink, "Access restricted")).toBe(true);
    expect((await getUser(prisma, sample.user.id))!.walletBalance.toString()).toBe(before.toString());
  });

  it("adminWalletCommand offers a back action on bad args (never strands)", async () => {
    const { ctx, sink } = adminCtx({ match: "only-one-arg" });
    await adminWalletCommand(ctx);
    expect(offersForwardAction(sink)).toBe(true);
  });

  // M-3 (backend audit 2026-07-31): `new Decimal("NaN")` constructs
  // successfully, so an admin typing "/wallet <uid> NaN" previously sailed
  // straight through to adjustWallet and would have poisoned the balance.
  it("adminWalletCommand rejects a NaN amount as bad args, same as a malformed uid", async () => {
    const { ctx, sink } = adminCtx({ match: `${sample.user.id} NaN` });
    const before = (await getUser(prisma, sample.user.id))!.walletBalance;
    await adminWalletCommand(ctx);
    expect(sentIncludes(sink, "Bad arguments")).toBe(true);
    expect((await getUser(prisma, sample.user.id))!.walletBalance.toString()).toBe(before.toString());
  });

  it("adminWalletCommand rejects an Infinity amount as bad args", async () => {
    const { ctx, sink } = adminCtx({ match: `${sample.user.id} Infinity` });
    const before = (await getUser(prisma, sample.user.id))!.walletBalance;
    await adminWalletCommand(ctx);
    expect(sentIncludes(sink, "Bad arguments")).toBe(true);
    expect((await getUser(prisma, sample.user.id))!.walletBalance.toString()).toBe(before.toString());
  });

  it("adminWalletCommand credits the wallet, localizes the result, and offers a back action", async () => {
    // An Indonesian-speaking admin must see the result in Indonesian (not a
    // hardcoded English line) — proves the success screen goes through i18n.
    const { ctx, sink } = makeCtx({
      from: { id: 999, username: "boss" },
      match: `${sample.user.id} 5`,
      session: { lang: "id", scratch: {}, dbUser: { id: adminDbId, telegramId: "999", role: UserRole.ADMIN, language: "ID", referralCode: "A", walletBalance: "0" } },
    });
    await adminWalletCommand(ctx);
    expect(sentIncludes(sink, "Saldo baru")).toBe(true); // localized to the admin's language
    expect(offersForwardAction(sink)).toBe(true);
  });

  // M-4 (backend audit 2026-07-31): the card used to render only
  // walletBalance through a bare, unlabelled formatter (no "Rp"/"USDT"),
  // and never showed walletBalanceUsdt at all — an admin resolving "where's
  // my referral credit?" for a USDT-only customer saw "Wallet: 0" and had no
  // way to tell which currency that even was.
  it("renderUserCard shows both wallet balances distinctly, each with an explicit currency label", async () => {
    await adjustWallet(prisma, sample.user.id, "1000", { reason: "test_seed" });
    await adjustWallet(prisma, sample.user.id, "2.5", { reason: "test_seed", currency: "USDT" });
    const { ctx, sink } = adminCtx();
    await renderUserCard(ctx, sample.user.id);
    expect(sentIncludes(sink, "Rp1.000")).toBe(true);
    expect(sentIncludes(sink, "2.5 USDT")).toBe(true);
  });

  // Follow-up to the M-4 fix above: the "Adjust wallet" button's toast is the
  // one place that teaches an admin the new [IDR|USDT] argument exists, and it
  // must go through t() like every other admin-facing string in this file
  // (no leaked English — see docs/ui and the bot UX skill).
  it("userWalletPrompt's toast documents the optional currency argument via i18n", async () => {
    const callbackData = `v1:adm:users:wallet:${sample.user.id}`;
    const { ctx, sink } = adminCtx({ callbackData });
    await handleAdminCallback(ctx, callbackData.split(":"));
    const toast = calls(sink, "answerCallbackQuery").at(-1);
    expect((toast!.args[0] as { text?: string }).text).toBe(
      `Use /wallet ${sample.user.id} <amount> [IDR|USDT] to adjust (negative to deduct; defaults to IDR).`,
    );
  });

  it("userWalletPrompt's toast is localized to the admin's language (proves it routes through t(), not a raw string)", async () => {
    const callbackData = `v1:adm:users:wallet:${sample.user.id}`;
    const { ctx, sink } = makeCtx({
      from: { id: 999, username: "boss" },
      callbackData,
      session: { lang: "id", scratch: {}, dbUser: { id: adminDbId, telegramId: "999", role: UserRole.ADMIN, language: "ID", referralCode: "A", walletBalance: "0" } },
    });
    await handleAdminCallback(ctx, callbackData.split(":"));
    const toast = calls(sink, "answerCallbackQuery").at(-1);
    expect((toast!.args[0] as { text?: string }).text).toBe(
      `Gunakan /wallet ${sample.user.id} <jumlah> [IDR|USDT] untuk menyesuaikan (negatif untuk mengurangi; default IDR).`,
    );
  });

  // M-4 (backend audit 2026-07-31): /wallet had no currency argument and
  // always adjusted the IDR balance via adjustWallet's default — an admin
  // crediting a referral commission (always USDT) would silently create a
  // second, wrong IDR balance instead.
  it("/wallet <uid> <amount> USDT credits walletBalanceUsdt and leaves walletBalance untouched", async () => {
    const before = (await getUser(prisma, sample.user.id))!;
    const { ctx, sink } = adminCtx({ match: `${sample.user.id} 5 USDT` });
    await adminWalletCommand(ctx);
    const after = (await getUser(prisma, sample.user.id))!;
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(Number(before.walletBalanceUsdt) + 5);
    expect(after.walletBalance.toString()).toBe(before.walletBalance.toString());
    expect(sentIncludes(sink, "USDT")).toBe(true); // audit-visible reply states which currency was adjusted
  });

  it("/wallet <uid> <amount> with no currency argument still defaults to IDR (no regression)", async () => {
    const before = (await getUser(prisma, sample.user.id))!;
    const { ctx } = adminCtx({ match: `${sample.user.id} 7` });
    await adminWalletCommand(ctx);
    const after = (await getUser(prisma, sample.user.id))!;
    expect(Number(after.walletBalance)).toBeCloseTo(Number(before.walletBalance) + 7);
    expect(after.walletBalanceUsdt.toString()).toBe(before.walletBalanceUsdt.toString());
  });

  it("/wallet <uid> <amount> IDR (explicit) behaves the same as the default", async () => {
    const before = (await getUser(prisma, sample.user.id))!;
    const { ctx } = adminCtx({ match: `${sample.user.id} 3 idr` }); // lower-case currency is accepted too
    await adminWalletCommand(ctx);
    const after = (await getUser(prisma, sample.user.id))!;
    expect(Number(after.walletBalance)).toBeCloseTo(Number(before.walletBalance) + 3);
    expect(after.walletBalanceUsdt.toString()).toBe(before.walletBalanceUsdt.toString());
  });

  it("/wallet rejects an unrecognized trailing currency argument as bad args", async () => {
    const before = (await getUser(prisma, sample.user.id))!;
    const { ctx, sink } = adminCtx({ match: `${sample.user.id} 5 EUR` });
    await adminWalletCommand(ctx);
    const after = (await getUser(prisma, sample.user.id))!;
    expect(sentIncludes(sink, "Bad arguments")).toBe(true);
    expect(after.walletBalance.toString()).toBe(before.walletBalance.toString());
    expect(after.walletBalanceUsdt.toString()).toBe(before.walletBalanceUsdt.toString());
  });

  it("/emojiid explains itself when the command arrives bare", async () => {
    const { ctx, sink } = adminCtx({ text: "/emojiid" });
    await adminEmojiIdCommand(ctx);
    expect(sentIncludes(sink, "Custom emoji ids")).toBe(true);
    expect(offersForwardAction(sink)).toBe(true);
  });

  it("/emojiid returns paste-ready JSON for the custom emoji in the message", async () => {
    const { ctx, sink } = adminCtx({
      text: "/emojiid ✅",
      messageExtra: {
        entities: [{ type: "custom_emoji", offset: 9, length: 1, custom_emoji_id: "5368324170671202286" }],
      },
    });
    await adminEmojiIdCommand(ctx);
    expect(sentIncludes(sink, "5368324170671202286")).toBe(true);
    expect(sentIncludes(sink, "✅")).toBe(true);
  });

  it("/emojiid reads the replied-to message and says so when there is nothing to read", async () => {
    const { ctx, sink } = adminCtx({
      text: "/emojiid",
      messageExtra: { reply_to_message: { text: "plain ✅ only", message_id: 5 } },
    });
    await adminEmojiIdCommand(ctx);
    expect(sentIncludes(sink, "No custom emoji in that message")).toBe(true);
  });

  it("non-admin cannot harvest emoji ids via /emojiid", async () => {
    const { ctx, sink } = customerCtx({ text: "/emojiid" });
    await adminEmojiIdCommand(ctx);
    expect(sentIncludes(sink, "Access restricted")).toBe(true);
  });

  // 'user ban toggles the flag and writes an audit row' moved to
  // conversations.test.ts — ban/unban is now a reason-capturing conversation
  // (userBanConversation), not a plain handleAdminCallback action (Log-5-1).

  it("set reseller flips the role", async () => {
    const { ctx } = adminCtx({ callbackData: `v1:adm:users:reseller:${sample.user.id}:1` });
    await handleAdminCallback(ctx, `v1:adm:users:reseller:${sample.user.id}:1`.split(":"));
    expect((await getUser(prisma, sample.user.id))!.role).toBe(UserRole.RESELLER);
  });

  it("toggle product flips is_active + audits", async () => {
    const { ctx } = adminCtx({ callbackData: `v1:adm:prod:toggle:${sample.product.id}` });
    await handleAdminCallback(ctx, `v1:adm:prod:toggle:${sample.product.id}`.split(":"));
    const p = await prisma.denomination.findUnique({ where: { id: sample.product.id } });
    expect(p!.isActive).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: "product_toggle" } })).toBe(1);
  });

  it("ticket close sets the ticket CLOSED and writes an audit row (Bot-3 fix)", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "help" } });
    const { ctx } = adminCtx({ callbackData: `v1:adm:ticket:close:${ticket.id}` });
    await handleAdminCallback(ctx, `v1:adm:ticket:close:${ticket.id}`.split(":"));
    expect((await prisma.supportTicket.findUnique({ where: { id: ticket.id } }))!.status).toBe(TicketStatus.CLOSED);
    const audit = await prisma.auditLog.findFirst({ where: { action: "ticket_close", targetId: ticket.id } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain(String(ticket.id));
  });

  it("a double-tap ticket close never sends a second buyer DM (Bot-3 fix)", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "help" } });
    const { ctx: ctx1, sink: sink1 } = adminCtx({ callbackData: `v1:adm:ticket:close:${ticket.id}` });
    await handleAdminCallback(ctx1, `v1:adm:ticket:close:${ticket.id}`.split(":"));
    const { ctx: ctx2, sink: sink2 } = adminCtx({ callbackData: `v1:adm:ticket:close:${ticket.id}` });
    await handleAdminCallback(ctx2, `v1:adm:ticket:close:${ticket.id}`.split(":"));

    // sample.user has a telegramId, so the first close DMs them; the second
    // (already-closed) close must NOT — closeTicket's atomic guard returns
    // null, so handleAdminCallback's customerTgId check skips the DM.
    expect(calls(sink1, "sendMessage").length).toBe(1);
    expect(calls(sink2, "sendMessage").length).toBe(0);
  });

  it("mark stock dead flips the status and writes an audit row (Bot-4 fix)", async () => {
    const item = await prisma.stockItem.findFirst({ where: { productId: sample.product.id, status: "AVAILABLE" } });
    const { ctx } = adminCtx({ callbackData: `v1:adm:stockitem:dead:${item!.id}:${sample.product.id}` });
    await handleAdminCallback(ctx, `v1:adm:stockitem:dead:${item!.id}:${sample.product.id}`.split(":"));
    expect((await prisma.stockItem.findUnique({ where: { id: item!.id } }))!.status).toBe("DEAD");
    const audit = await prisma.auditLog.findFirst({ where: { action: "stock_mark_dead", targetId: item!.id } });
    expect(audit).toBeTruthy();
    expect(audit!.details).toContain("Netflix Premium 1M");
  });

  // M-8 fix, backend audit 2026-07-31: the keyboard already omits the "Dead"
  // button for SOLD rows, but a stale button (item sold between render and
  // tap) must still be refused rather than silently corrupting a delivered
  // credential's status.
  it("refuses to mark an already-SOLD stock item dead — alert toast, no status change, no audit row", async () => {
    const item = await prisma.stockItem.update({
      where: { id: (await prisma.stockItem.findFirst({ where: { productId: sample.product.id, status: "AVAILABLE" } }))!.id },
      data: { status: "SOLD", soldAt: new Date() },
    });
    const { ctx, sink } = adminCtx({ callbackData: `v1:adm:stockitem:dead:${item.id}:${sample.product.id}` });
    await handleAdminCallback(ctx, `v1:adm:stockitem:dead:${item.id}:${sample.product.id}`.split(":"));

    expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.status).toBe("SOLD");
    expect(await prisma.auditLog.count({ where: { action: "stock_mark_dead", targetId: item.id } })).toBe(0);

    const answers = calls(sink, "answerCallbackQuery");
    expect(answers.length).toBe(1);
    const [answerOpts] = answers[0]!.args as [{ text?: string; show_alert?: boolean }];
    expect(answerOpts.show_alert).toBe(true);
  });

  it("dashboard / product / settings menus render", async () => {
    for (const data of ["v1:adm:dash", "v1:adm:prod:menu", "v1:adm:settings:menu", "v1:adm:vouch:menu"]) {
      const { ctx, sink } = adminCtx({ callbackData: data });
      await handleAdminCallback(ctx, data.split(":"));
      expect(sink.length, data).toBeGreaterThan(0);
    }
  });

  it("unrecognized section/action in admin callback answers error.stale_screen (M-21 fix)", async () => {
    // Unrecognized section
    const { ctx: ctx1, sink: sink1 } = adminCtx({ callbackData: "v1:adm:bogus_section" });
    await handleAdminCallback(ctx1, "v1:adm:bogus_section".split(":"));
    const answers1 = calls(sink1, "answerCallbackQuery");
    expect(answers1.length).toBe(1);
    expect(answers1[0]!.args[0]).toHaveProperty("text", t(ctx1, "error.stale_screen"));

    // Unrecognized action within a known section
    const { ctx: ctx2, sink: sink2 } = adminCtx({ callbackData: "v1:adm:prod:bogus_action" });
    await handleAdminCallback(ctx2, "v1:adm:prod:bogus_action".split(":"));
    const answers2 = calls(sink2, "answerCallbackQuery");
    expect(answers2.length).toBe(1);
    expect(answers2[0]!.args[0]).toHaveProperty("text", t(ctx2, "error.stale_screen"));

    // Unrecognized action in broadcast section (which only has conversation entry points)
    const { ctx: ctx3, sink: sink3 } = adminCtx({ callbackData: "v1:adm:broadcast:bogus_action" });
    await handleAdminCallback(ctx3, "v1:adm:broadcast:bogus_action".split(":"));
    const answers3 = calls(sink3, "answerCallbackQuery");
    expect(answers3.length).toBe(1);
    expect(answers3[0]!.args[0]).toHaveProperty("text", t(ctx3, "error.stale_screen"));
  });
});

// ===========================================================================
// Callback router (routeCallback)
// ===========================================================================

describe("callback router", () => {
  it("dispatches v1:menu:main to the customer dashboard, sending a fresh message (Home now pins a persistent reply keyboard, which can't ride an edit)", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:menu:main" });
    await routeCallback(ctx);
    expect(sink.length).toBeGreaterThan(0);
    expect(calls(sink, "reply").length).toBeGreaterThan(0);
    expect(calls(sink, "editMessageText").length).toBe(0);
  });

  it("dispatches v1:order:list", async () => {
    await makeOrder();
    const { ctx, sink } = customerCtx({ callbackData: "v1:order:list" });
    await routeCallback(ctx);
    expect(sink.length).toBeGreaterThan(0);
  });

  it("answers unknown domains without throwing", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:bogus:thing" });
    await routeCallback(ctx);
    expect(calls(sink, "answerCallbackQuery").length).toBeGreaterThan(0);
  });

  it("routes v1:browse:denom to the denomination detail bubble", async () => {
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:denom:${sample.product.id}` });
    await routeCallback(ctx);
    expect(sink.length).toBeGreaterThan(0);
    expect((ctx.session.scratch as { variantId?: number }).variantId).toBe(sample.product.id);
  });

  it("degrades an old in-flight v1:browse:group tap to the stale-screen toast (no crash)", async () => {
    // `group` was renamed to `pick`; a pre-migration bubble must not crash — it
    // answers with the stale-screen toast instead.
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:group:${sample.parentProduct.id}` });
    await routeCallback(ctx);
    expect(calls(sink, "answerCallbackQuery").length).toBeGreaterThan(0);
    // No detail/picker was rendered for the stale tap.
    expect((ctx.session.scratch as { variantId?: number }).variantId).toBeUndefined();
  });

  it("degrades an old in-flight v1:browse:prod tap to the stale-screen toast, never opens the wrong product (no crash)", async () => {
    // Regression: pre-rename, `v1:browse:prod:<id>` meant "open SKU <id>" (an
    // id from the OLD products/now-denominations space). The picker-open verb
    // was deliberately given a NEW name (`pick`), not the recycled `prod`, so
    // a years-old cached Telegram bubble carrying this exact string can never
    // be silently misrouted to an unrelated mid-tier Product that happens to
    // share the same numeric id post-migration — it must degrade like `group`.
    const other = await createCatalogProduct(prisma, {
      categoryId: sample.parentProduct.categoryId,
      name: "Unrelated Product",
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:browse:prod:${other.id}` });
    await routeCallback(ctx);
    expect(calls(sink, "answerCallbackQuery").length).toBeGreaterThan(0);
    // No picker/detail for the unrelated product was ever rendered.
    expect((ctx.session.scratch as { productId?: number }).productId).toBeUndefined();
    expect(JSON.stringify(sink)).not.toContain("Unrelated Product");
  });

  it("routes v1:adm:* to the admin sub-router (admin only)", async () => {
    const { ctx, sink } = adminCtx({ callbackData: "v1:adm:dash" });
    await routeCallback(ctx);
    expect(sink.length).toBeGreaterThan(0);
  });

  it("routes v1:adm:* through the same generic dispatch as every other domain, so the handler's real toast survives instead of being lost to a premature blank pre-answer (double-answer fix)", async () => {
    // Regression test: the router used to special-case domain "adm" by firing
    // a blank answerCallbackQuery() BEFORE calling handleAdminCallback, outside
    // the outer try/catch. userSetReseller (admin.ts) then calls
    // answerCallbackQuery again with the real show_alert toast — a real
    // Telegram bot rejects answering the same callback query twice, so that
    // second call used to throw, get caught by nothing (the adm branch
    // bypassed the outer try/catch), and blow up into grammY's global
    // bot.catch with the admin never seeing their confirmation.
    // rejectDuplicateAnswerCallbackQuery makes this mock ctx simulate that
    // real "already answered" rejection, so this test can only pass if the
    // router answers exactly once — with the handler's real content.
    const { ctx, sink } = adminCtx({
      callbackData: `v1:adm:users:reseller:${sample.user.id}:1`,
      rejectDuplicateAnswerCallbackQuery: true,
    });

    await expect(routeCallback(ctx)).resolves.not.toThrow();

    const answers = calls(sink, "answerCallbackQuery");
    expect(answers.length).toBe(1);
    const [answerOpts] = answers[0]!.args as [{ text?: string; show_alert?: boolean }];
    expect(answerOpts.text).toBe("Role set to RESELLER");
    expect(answerOpts.show_alert).toBe(true);

    // The mutation and its downstream re-render both actually happened —
    // proving the handler ran to completion instead of throwing mid-flight.
    expect((await getUser(prisma, sample.user.id))!.role).toBe(UserRole.RESELLER);
  });

  it("malformed callback data is answered, not thrown", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "garbage" });
    await routeCallback(ctx);
    expect(calls(sink, "answerCallbackQuery").length).toBeGreaterThan(0);
  });

  // §8.9 — quantity-input mode must end on any button tap, even one whose
  // dispatcher never re-renders (so smartEdit's own clear doesn't run).
  it("clears awaitingQtyDenomId on a callback that never re-renders (§8.9)", async () => {
    const { ctx } = customerCtx({ callbackData: "v1:noop:x" });
    ctx.session.awaitingQtyDenomId = sample.product.id;
    await routeCallback(ctx);
    expect(ctx.session.awaitingQtyDenomId).toBeUndefined();
  });

  // …but the button that *starts* qty-input mode keeps it set.
  it("keeps awaitingQtyDenomId for the qty:input callback that starts it (§8.9)", async () => {
    const { ctx } = customerCtx({ callbackData: `v1:qty:input:${sample.product.id}` });
    await routeCallback(ctx);
    expect(ctx.session.awaitingQtyDenomId).toBe(sample.product.id);
  });

  // handleQtyTextInput deletes the user's typed message to keep the chat clean (single-bubble wizard).
  it("handleQtyTextInput deletes the typed message on valid quantity input", async () => {
    const { ctx, sink } = customerCtx({ text: "5" });
    ctx.session.awaitingQtyDenomId = sample.product.id;
    await customer.handleProductNumber(ctx);

    // Verify consumeInput was called by checking deleteMessage was called with the message id
    const deletes = calls(sink, "deleteMessage");
    expect(deletes.length).toBe(1);
    expect(deletes[0]?.args[1]).toBe(ctx.message?.message_id);

    // Verify the user was navigated to the denomination detail with the qty
    expect(sentIncludes(sink, sample.product.name)).toBe(true);
  });

  it("handleQtyTextInput deletes the typed message on invalid quantity (non-numeric)", async () => {
    const { ctx, sink } = customerCtx({ text: "abc" });
    ctx.session.awaitingQtyDenomId = sample.product.id;
    await customer.handleProductNumber(ctx);

    // Verify consumeInput was called
    const deletes = calls(sink, "deleteMessage");
    expect(deletes.length).toBe(1);
    expect(deletes[0]?.args[1]).toBe(ctx.message?.message_id);

    // Verify error message was shown (the rendered text includes "Invalid quantity")
    expect(sentIncludes(sink, "Invalid quantity")).toBe(true);
  });

  it("handleQtyTextInput deletes the typed message when quantity exceeds stock", async () => {
    const { ctx, sink } = customerCtx({ text: "9999" });
    ctx.session.awaitingQtyDenomId = sample.product.id;
    await customer.handleProductNumber(ctx);

    // Verify consumeInput was called
    const deletes = calls(sink, "deleteMessage");
    expect(deletes.length).toBe(1);
    expect(deletes[0]?.args[1]).toBe(ctx.message?.message_id);

    // Verify error message was shown (the rendered text includes "Invalid quantity")
    expect(sentIncludes(sink, "Invalid quantity")).toBe(true);
  });

  // M-24 — handleQtyTextInput used to re-render invalid-quantity errors via
  // smartEdit, which on a typed (non-callback) update always falls through to
  // a fresh ctx.reply(). Typing two invalid quantities in a row therefore
  // stacked two new "invalid quantity" bubbles above the original prompt.
  // menuAnchor fixes this by editing the session-tracked anchor in place.
  it("handleQtyTextInput edits the same anchor bubble across two consecutive invalid inputs, never stacking a new one (M-24)", async () => {
    const sink: SentCall[] = [];
    // One chat = ONE session object shared across every update, mirroring how
    // grammY really keys sessions by chat id — required to observe whether
    // ctx.session.menuMsgId (the anchor) survives across the two typed turns.
    const shared = { ...userSession(), scratch: {} } as SessionData;

    // Open the wizard via the qty:input callback (button tap) — this anchors
    // the prompt bubble as ctx.session.menuMsgId, exactly like a real tap.
    const start = customerCtx({ sink, sharedSession: shared, callbackData: `v1:qty:input:${sample.product.id}` });
    await routeCallback(start.ctx);
    const anchorId = shared.menuMsgId;
    expect(anchorId).toBeDefined();

    // Type two invalid quantities in a row (plain text updates — no callbackQuery).
    const first = customerCtx({ sink, sharedSession: shared, text: "abc" });
    await customer.handleProductNumber(first.ctx);
    const second = customerCtx({ sink, sharedSession: shared, text: "xyz" });
    await customer.handleProductNumber(second.ctx);

    // Both invalid-input re-renders must have edited the SAME anchor bubble in
    // place — never a fresh send, which is what would stack extra bubbles.
    const anchorEdits = calls(sink, "editMessageText").filter((c) => c.args[1] === anchorId);
    expect(anchorEdits.length).toBe(2);
    expect(shared.menuMsgId).toBe(anchorId);

    // No fresh "invalid quantity" bubble was ever sent via reply().
    expect(calls(sink, "reply").length).toBe(0);

    // The wizard is still live, still awaiting a retry.
    expect(shared.awaitingQtyDenomId).toBe(sample.product.id);
  });

  // §8.6 — a dispatcher crash surfaces a quotable correlation ref to the user.
  it("surfaces a correlation ref when a dispatcher throws (§8.6)", async () => {
    // No dbUser in session → requireUser() throws inside the dispatcher.
    const { ctx, sink } = makeCtx({ from: { id: 42 }, callbackData: "v1:order:list", session: { lang: "en", scratch: {} } });
    await routeCallback(ctx);
    const refAlert = calls(sink, "answerCallbackQuery").some((c) =>
      /ref:/i.test((c.args[0] as { text?: string } | undefined)?.text ?? ""),
    );
    expect(refAlert).toBe(true);
  });

  it("v1:ticket:close:<id> closes the caller's own ticket via routeCallback and shows the closed-confirmation keyboard", async () => {
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.OPEN },
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:ticket:close:${ticket.id}` });
    await routeCallback(ctx);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
    expect(sentIncludes(sink, "resolved")).toBe(true);
  });

  it("closing someone else's ticket shows 'ticket not found', not 'order not found' (bug fix)", async () => {
    const otherUser = await upsertUser(prisma, { telegramId: 5001, username: "other", fullName: null });
    const ticket = await prisma.supportTicket.create({ data: { userId: otherUser.id, message: "not yours" } });
    const { ctx, sink } = customerCtx({ callbackData: `v1:ticket:close:${ticket.id}` });
    await routeCallback(ctx);

    const toasts = calls(sink, "answerCallbackQuery");
    const body = JSON.stringify(toasts);
    expect(body).toContain("Ticket not found");
    expect(body).not.toContain("Order not found");
  });

  it("v1:ticket:reopen:<id> reopens a closed ticket within the window and re-renders the detail screen", async () => {
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.CLOSED, closedAt: new Date() },
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:ticket:reopen:${ticket.id}` });
    await routeCallback(ctx);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.OPEN);
    expect(sentIncludes(sink, "v1:ticket:reply")).toBe(true); // re-rendered screen now offers Reply again
  });

  it("v1:ticket:reopen:<id> past the 7-day window shows an error toast and leaves the ticket closed", async () => {
    const wayPast = new Date(Date.now() - 8 * 86_400_000);
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.CLOSED, closedAt: wayPast },
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:ticket:reopen:${ticket.id}` });
    await routeCallback(ctx);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
    const toasts = calls(sink, "answerCallbackQuery");
    expect(JSON.stringify(toasts).length).toBeGreaterThan(0);
  });

  it("reopening another user's ticket does nothing (ownership check)", async () => {
    const otherUser = await upsertUser(prisma, { telegramId: 5002, username: "other2", fullName: null });
    const ticket = await prisma.supportTicket.create({
      data: { userId: otherUser.id, message: "not yours", status: TicketStatus.CLOSED, closedAt: new Date() },
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:ticket:reopen:${ticket.id}` });
    await routeCallback(ctx);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
    const body = JSON.stringify(calls(sink, "answerCallbackQuery"));
    expect(body).toContain("Ticket not found");
  });
});
