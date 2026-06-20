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

import { prisma, createOrderDirect, attachPaymentProof, getOrder, getUser, createBroadcast, setSetting, getSetting, createCatalogProduct, createDenomination } from "@app/db";
import type { Api } from "grammy";
import { drainBroadcasts } from "../src/jobs";
import { OrderStatus, StockStatus, UserRole, TicketStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, offersForwardAction, lastMarkup, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { denominationPickerKb, persistentLabel } from "../src/keyboards/customer";
import * as customer from "../src/handlers/customer";
import * as checkout from "../src/handlers/checkout";
import * as verification from "../src/handlers/verification";
import { handleAdminCallback, adminCommand, adminWalletCommand } from "../src/handlers/admin";
import { routeCallback } from "../src/handlers/callbacks";
import { upsertUser } from "@app/db";

let sample: SampleData;
let adminDbId: number;

beforeEach(async () => {
  await resetDb(prisma);
  invalidateRateCache(); // settings were wiped — don't leak a cached rate across tests
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

  it("viewMyTicket never strands the user when the ticket isn't found", async () => {
    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, 999999);
    expect(offersForwardAction(sink)).toBe(true);
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

  it("denominationPickerKb renders one button per denomination (browse:denom) + back", () => {
    const kb = denominationPickerKb(
      [
        { id: 1, name: "A", durationLabel: "7 day", price: "30000" },
        { id: 2, name: "B", durationLabel: "1 Month", price: "75000" },
      ],
      "en",
    );
    const flat = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    expect(flat.some((b) => b.callback_data === "v1:browse:denom:1")).toBe(true);
    expect(flat.some((b) => b.callback_data === "v1:browse:denom:2")).toBe(true);
    expect(flat.some((b) => b.callback_data === "v1:browse:prods")).toBe(true); // back to list

    // Catalog prices are central Rupiah — the button text must render IDR
    // (priceIdr), never the USDT-only formatPrice (Finding 1).
    const member1 = flat.find((b) => b.callback_data === "v1:browse:denom:1")!;
    expect(member1.text).toContain("Rp30.000");
    expect(member1.text).not.toContain("USDT");
    const member2 = flat.find((b) => b.callback_data === "v1:browse:denom:2")!;
    expect(member2.text).toContain("Rp75.000");
    expect(member2.text).not.toContain("USDT");
  });

  it("denominationPickerKb uses resellerPrice for reseller users when present", () => {
    const kb = denominationPickerKb(
      [{ id: 1, name: "A", durationLabel: "7 day", price: "30000", resellerPrice: "20000" }],
      "en",
      null,
      true,
    );
    const flat = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
    const member1 = flat.find((b) => b.callback_data === "v1:browse:denom:1")!;
    expect(member1.text).toContain("Rp20.000");
    expect(member1.text).not.toContain("Rp30.000");
    expect(member1.text).not.toContain("USDT");
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
    // Picker buttons render the Rupiah price (Finding 1), never USDT.
    expect(markup).toContain("Rp30.000");
    expect(markup).not.toContain("USDT");
  });

  it("browseProductsFlat records the parent Product id and the number opens its picker", async () => {
    const { product } = await makeProductWithTwo();
    const { ctx } = customerCtx();
    await customer.browseProductsFlat(ctx);
    const entries = (ctx.session.scratch as { browseEntries?: number[] }).browseEntries ?? [];
    expect(entries).toContain(product.id);
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

  it("buyNow creates a PENDING_PAYMENT order and shows payment instructions", async () => {
    // The USDT/Binance path needs the admin-set rate; 1 keeps the USDT total
    // equal to the fixture's central-IDR price.
    await setSetting(prisma, "usd_idr_rate", "1");
    const { ctx, sink } = customerCtx({ callbackData: "v1:pay:1:1" });
    await checkout.buyNow(ctx, sample.product.id, 1);
    const orders = await prisma.order.findMany();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe(OrderStatus.PENDING_PAYMENT);
    // payment instructions now EDIT the confirm bubble (callback path) rather
    // than posting a new message.
    expect(
      calls(sink, "editMessageText").length + calls(sink, "sendMessage").length + calls(sink, "reply").length,
    ).toBeGreaterThan(0);
    checkout.cancelPaymentJobs(orders[0]!.id); // clear the countdown timer
  });

  it("buying a denomination creates an order at its price keyed off the denomination id", async () => {
    // The whole point of the rename: `buy`/`pay` callbacks carry the DENOMINATION
    // id (= the SKU the money/stock flow keys off). Buying it must create an order
    // whose line points at that denomination and prices it at the denomination price.
    await setSetting(prisma, "usd_idr_rate", "1");
    const { ctx } = customerCtx({ callbackData: `v1:pay:${sample.product.id}:2` });
    await checkout.buyNow(ctx, sample.product.id, 2);

    const order = (await prisma.order.findFirst({ include: { items: true } }))!;
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    // One order item per unit, each pointing at the denomination (physical
    // product_id column) and priced at the denomination unit price ("5.00").
    expect(order.items).toHaveLength(2);
    expect(order.items.every((i) => i.productId === sample.product.id)).toBe(true);
    expect(order.items.every((i) => new Decimal(i.unitPrice).toString() === "5")).toBe(true);
    // Subtotal reflects 2 × 5 before any unique-cents/total finalization.
    expect(new Decimal(order.subtotalAmount).toString()).toBe("10");
    // Stock is only reserved at approval — buying must not exceed availability
    // (5 units), so the order is allowed and the units remain AVAILABLE for now.
    expect(
      await prisma.stockItem.count({ where: { productId: sample.product.id, status: StockStatus.AVAILABLE } }),
    ).toBe(5);
    checkout.cancelPaymentJobs(order.id);
  });

  it("buyNow unifies the Binance QR + instructions into one photo+caption bubble when a QR is set", async () => {
    await setSetting(prisma, "usd_idr_rate", "1");
    await setSetting(prisma, "qr", "QR_FILE_ID"); // stored QR file_id
    const { ctx, sink } = customerCtx({ callbackData: "v1:pay:1:1" });
    await checkout.buyNow(ctx, sample.product.id, 1);
    const orders = await prisma.order.findMany();
    expect(orders).toHaveLength(1);
    // QR + instructions ride in ONE photo+caption bubble — no separate sendPhoto.
    expect(calls(sink, "sendPhoto").length).toBe(0);
    const photoCalls = calls(sink, "replyWithPhoto");
    expect(photoCalls.length).toBe(1);
    expect((photoCalls[0]!.args[1] as { caption?: string }).caption).toBeTruthy();
    checkout.cancelPaymentJobs(orders[0]!.id); // clear the countdown timer
  });

  it("buyNow sends an uploaded QR via InputFile and caches the resulting file_id once", async () => {
    await setSetting(prisma, "usd_idr_rate", "1");
    await setSetting(prisma, "qr", "/uploads/qr/qr-test.png"); // web upload, no cache yet
    const { ctx, sink } = customerCtx({
      callbackData: "v1:pay:1:1",
      replyWithPhotoResult: { photo: [{ file_id: "CACHED_FROM_UPLOAD" }] },
    });
    await checkout.buyNow(ctx, sample.product.id, 1);
    const orders = await prisma.order.findMany();
    expect(orders).toHaveLength(1);
    const photoCalls = calls(sink, "replyWithPhoto");
    expect(photoCalls.length).toBe(1);
    // Cached after the first send so a re-render won't re-upload the same file.
    expect(await getSetting(prisma, "qr_fileid")).toBe("CACHED_FROM_UPLOAD");
    checkout.cancelPaymentJobs(orders[0]!.id); // clear the countdown timer
  });

  it("buyNowTokopay creates an IDR/TOKOPAY order and sends the QR as one photo+caption bubble", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const { ctx, sink } = customerCtx();
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);
    const orders = await prisma.order.findMany({ where: { userId: sample.user.id }, orderBy: { id: "desc" }, take: 1 });
    expect(orders[0]!.paymentMethod).toBe("TOKOPAY");
    expect(orders[0]!.currency).toBe("IDR");
    // QR + instructions are unified into ONE photo+caption bubble (not a
    // separate sendPhoto below a text bubble).
    expect(calls(sink, "sendPhoto").length).toBe(0);
    const photoCalls = calls(sink, "replyWithPhoto");
    expect(photoCalls.length).toBe(1);
    expect((photoCalls[0]!.args[1] as { caption?: string }).caption).toBeTruthy();
    // paymentRef is cached as JSON tagged `gateway: "tokopay"` — the same
    // discriminator the storefront's parseCachedGateway() requires, so a
    // storefront view of a bot-created order is a cache HIT, not a re-fetch.
    const cached = JSON.parse(orders[0]!.paymentRef!) as { gateway?: string; trxId?: string };
    expect(cached.gateway).toBe("tokopay");
    expect(cached.trxId).toBe("TP-TEST");
  });

  it("buyNow refuses past the pending-order limit", async () => {
    for (let i = 0; i < 10; i++) await makeOrder();
    const before = await prisma.order.count();
    const { ctx } = customerCtx({ callbackData: "v1:pay:1:1" });
    await checkout.buyNow(ctx, sample.product.id, 1);
    expect(await prisma.order.count()).toBe(before); // no new order
  });

  it("cancelPendingOrder cancels the order and removes the lingering bubble after a beat", async () => {
    const order = await makeOrder();
    const { ctx, sink } = customerCtx({ callbackData: `v1:checkout:cancel:${order!.id}` });

    vi.useFakeTimers();
    try {
      await checkout.cancelPendingOrder(ctx, order!.id);
      // A confirmation is shown immediately, but the bubble must not vanish yet.
      expect(calls(sink, "deleteMessage").length).toBe(0);
      // After the notice window the whole payment/QR bubble is deleted so it
      // doesn't stay stuck on screen under the "cancelled" text.
      await vi.advanceTimersByTimeAsync(2000);
      expect(calls(sink, "deleteMessage").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }

    const after = await getOrder(prisma, order!.id);
    expect(after!.status).toBe(OrderStatus.CANCELLED);
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

  it("approve delivers the order, marks stock SOLD, enqueues outbox + audit, DMs the buyer", async () => {
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

  it("adminWalletCommand offers a back action on bad args (never strands)", async () => {
    const { ctx, sink } = adminCtx({ match: "only-one-arg" });
    await adminWalletCommand(ctx);
    expect(offersForwardAction(sink)).toBe(true);
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

  it("user ban toggles the flag and writes an audit row", async () => {
    const { ctx } = adminCtx({ callbackData: `v1:adm:users:ban:${sample.user.id}` });
    await handleAdminCallback(ctx, `v1:adm:users:ban:${sample.user.id}`.split(":"));
    expect((await getUser(prisma, sample.user.id))!.banned).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "user_ban" } })).toBe(1);

    const { ctx: ctx2 } = adminCtx({ callbackData: `v1:adm:users:unban:${sample.user.id}` });
    await handleAdminCallback(ctx2, `v1:adm:users:unban:${sample.user.id}`.split(":"));
    expect((await getUser(prisma, sample.user.id))!.banned).toBe(false);
  });

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

  it("ticket close sets the ticket CLOSED", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "help" } });
    const { ctx } = adminCtx({ callbackData: `v1:adm:ticket:close:${ticket.id}` });
    await handleAdminCallback(ctx, `v1:adm:ticket:close:${ticket.id}`.split(":"));
    expect((await prisma.supportTicket.findUnique({ where: { id: ticket.id } }))!.status).toBe(TicketStatus.CLOSED);
  });

  it("dashboard / product / settings menus render", async () => {
    for (const data of ["v1:adm:dash", "v1:adm:prod:menu", "v1:adm:settings:menu", "v1:adm:vouch:menu"]) {
      const { ctx, sink } = adminCtx({ callbackData: data });
      await handleAdminCallback(ctx, data.split(":"));
      expect(sink.length, data).toBeGreaterThan(0);
    }
  });
});

// ===========================================================================
// Callback router (routeCallback)
// ===========================================================================

describe("callback router", () => {
  it("dispatches v1:menu:main to the customer dashboard", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:menu:main" });
    await routeCallback(ctx);
    expect(sink.length).toBeGreaterThan(0);
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
});
