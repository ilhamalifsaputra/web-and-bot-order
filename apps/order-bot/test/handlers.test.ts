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

import { prisma, createOrderDirect, attachPaymentProof, approveOrder, getOrder, getUser, createBroadcast, setSetting, getSetting, createCatalogProduct, createDenomination, bulkAddStock, finalizeOrderPayment, listPendingTokopayOrders, createBybitBscOrder } from "@app/db";
import { createTransaction as mockedCreateTokopayTransaction } from "@app/core/payments/tokopay";
import type { Api } from "grammy";
import { drainBroadcasts } from "../src/jobs";
import { OrderStatus, OrderCurrency, PaymentMethod, StockStatus, UserRole, TicketStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, offersForwardAction, lastMarkup, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { setBotIdentity, resetBotIdentity } from "@app/core/runtime";
import { denominationPickerKb, denominationDetailKb, persistentLabel, paymentSuccessKb, qrisWaitingKb, proofCancelKb } from "../src/keyboards/customer";
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

  it("Home's keyboard is a persistent reply keyboard carrying all five buttons", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:menu:main" });
    await customer.showMainMenu(ctx);
    const markup = lastMarkup(sink) as { keyboard?: Array<Array<{ text: string }>>; is_persistent?: boolean };
    expect(markup?.keyboard).toBeDefined();
    expect(markup?.is_persistent).toBe(true);
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

  it("ticket close sets the ticket CLOSED and writes an audit row (Bot-3 fix)", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "help" } });
    const { ctx } = adminCtx({ callbackData: `v1:adm:ticket:close:${ticket.id}` });
    await handleAdminCallback(ctx, `v1:adm:ticket:close:${ticket.id}`.split(":"));
    expect((await prisma.supportTicket.findUnique({ where: { id: ticket.id } }))!.status).toBe(TicketStatus.CLOSED);
    expect(await prisma.auditLog.count({ where: { action: "ticket_close", targetId: ticket.id } })).toBe(1);
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
    expect(await prisma.auditLog.count({ where: { action: "stock_mark_dead", targetId: item!.id } })).toBe(1);
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
