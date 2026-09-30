// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * Task 3b: bot catalog/checkout prices follow the buyer's display currency
 * (User.preferredCurrency), while payment payables, order history, wallet
 * and admin screens stay in their own native currency.
 */
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

vi.mock("@app/core/payments/paydisini", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/paydisini")>()),
  createTransaction: vi.fn().mockResolvedValue({
    trxId: "PD-TEST",
    qrString: "000",
    qrUrl: "https://x/pd-qr.png",
    checkoutUrl: null,
    totalBayar: "100",
  }),
}));

import {
  prisma,
  setSetting,
  createDenomination,
  createVoucher,
  createOrderDirect,
  finalizeOrderPayment,
  upsertUser,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
} from "@app/db";
import { PAYDISINI_USERKEY_KEY, PAYDISINI_APIKEY_KEY } from "@app/core/payments/paydisini";
import { Decimal } from "@app/core/money";
import { DisplayCurrency, OrderCurrency, UserRole, VoucherType } from "@app/core/enums";
import { formatIdr, formatUsdtAmount } from "@app/core/formatters";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, sentIncludes, calls, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { resetBotIdentity } from "@app/core/runtime";
import * as customer from "../src/handlers/customer";
import * as checkout from "../src/handlers/checkout";
import { handleAdminCallback } from "../src/handlers/admin";
import { t, coreT } from "../src/util/i18n";

let sample: SampleData;
let adminDbId: number;

beforeEach(async () => {
  await resetDb(prisma);
  invalidateRateCache();
  resetBotIdentity();
  sample = await buildSampleData(prisma);
  const adminUser = await upsertUser(prisma, { telegramId: 999, username: "boss", fullName: "Admin Boss" });
  adminDbId = adminUser.id;
  // Realistic central-IDR price: Rp79.000 → $4.94 at 16000.
  await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "79000" } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

type Cur = DisplayCurrency | null;

function session(cur: Cur): Partial<SessionData> {
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
      preferredCurrency: cur,
    },
  };
}

function customerCtx(cur: Cur, opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({ from: { id: 42, username: "tester" }, session: session(cur), ...opts });
}

/** Every string argument the bot sent (message bodies/captions), no ids. */
function sentText(sink: SentCall[]): string {
  return sink
    .flatMap((c) =>
      c.args.flatMap((a) => {
        if (typeof a === "string") return [a];
        if (a && typeof a === "object" && "caption" in a) return [String((a as { caption?: unknown }).caption ?? "")];
        return [];
      }),
    )
    .join("\n");
}

async function useRate(rate = "16000") {
  await setSetting(prisma, "usd_idr_rate", rate);
  invalidateRateCache();
}

// ===========================================================================
// Catalog
// ===========================================================================

describe("denomination detail", () => {
  it("shows $ for a USD user and no Rp price", async () => {
    await useRate();
    const { ctx, sink } = customerCtx(DisplayCurrency.USD);
    await customer.browseDenomination(ctx, sample.product.id);
    const text = sentText(sink);
    expect(text).toContain("$4.94");
    expect(text).not.toContain("Rp79.000");
    expect(text).not.toContain(coreT("currency.rate_unavailable", "en"));
  });

  it("shows Rp only (no ≈ $ hint) for an IDR user", async () => {
    await useRate();
    const { ctx, sink } = customerCtx(DisplayCurrency.IDR);
    await customer.browseDenomination(ctx, sample.product.id);
    const text = sentText(sink);
    expect(text).toContain("Rp79,000");
    expect(text).not.toContain("≈");
    expect(text).not.toContain("$");
  });

  it("treats a NULL preference as IDR-labelled", async () => {
    await useRate();
    const { ctx, sink } = customerCtx(null);
    await customer.browseDenomination(ctx, sample.product.id);
    const text = sentText(sink);
    expect(text).toContain("Rp79,000");
    expect(text).not.toContain("$");
  });

  it("falls back to explicit Rp and shows the rate-unavailable notice once when a USD user has no rate", async () => {
    const { ctx, sink } = customerCtx(DisplayCurrency.USD);
    await customer.browseDenomination(ctx, sample.product.id);
    const text = sentText(sink);
    expect(text).toContain("Rp79,000");
    expect(text).not.toContain("$");
    const notice = coreT("currency.rate_unavailable", "en");
    expect(text.split(notice).length - 1).toBe(1);
  });

  it("converts both the old and the new flash-sale price for a USD user", async () => {
    await useRate();
    const hour = 3_600_000;
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: {
        flashDiscountPercent: "25",
        flashStartsAt: new Date(Date.now() - hour),
        flashEndsAt: new Date(Date.now() + hour),
      },
    });
    const { ctx, sink } = customerCtx(DisplayCurrency.USD);
    await customer.browseDenomination(ctx, sample.product.id);
    // 79000 → $4.94; 59250 → 3.703… → $3.71 (ceil).
    expect(sentText(sink)).toContain(t(ctx, "browse.flash_price", { old: "$4.94", new: "$3.71" }));
    expect(sentText(sink)).not.toContain("Rp");
  });
});

describe("denomination picker", () => {
  it("renders every plan line in the user's currency", async () => {
    await useRate();
    await createDenomination(prisma, {
      productId: sample.parentProduct.id,
      name: "Netflix Premium 3M",
      type: "SHARED",
      durationLabel: "3 Months",
      price: "160000",
    });
    const usd = customerCtx(DisplayCurrency.USD);
    await customer.browseProduct(usd.ctx, sample.parentProduct.id);
    expect(sentText(usd.sink)).toContain("$4.94");
    expect(sentText(usd.sink)).toContain("$10.00");
    expect(sentText(usd.sink)).not.toContain("Rp");

    const idr = customerCtx(DisplayCurrency.IDR);
    await customer.browseProduct(idr.ctx, sample.parentProduct.id);
    expect(sentText(idr.sink)).toContain("Rp79,000");
    expect(sentText(idr.sink)).toContain("Rp160,000");
    expect(sentText(idr.sink)).not.toContain("$");
  });
});

// ===========================================================================
// Checkout confirmation
// ===========================================================================

describe("order confirmation", () => {
  it("prices the unit and the total in $ for a USD user", async () => {
    await useRate();
    const { ctx, sink } = customerCtx(DisplayCurrency.USD);
    await checkout.showOrderConfirmation(ctx, sample.product.id, 2);
    const text = sentText(sink);
    expect(text).toContain("$4.94 × 2");
    // 158000 / 16000 = 9.875 → $9.88 (converted once from the IDR subtotal).
    expect(text).toContain("<b>$9.88</b>");
    expect(text).not.toContain("Rp");
  });

  it("a USD user with NO rate gets Rp amounts and exactly one rate-unavailable notice", async () => {
    const { ctx, sink } = customerCtx(DisplayCurrency.USD);
    await checkout.showOrderConfirmation(ctx, sample.product.id, 2);
    const text = sentText(sink);
    expect(text).toContain("Rp79,000 × 2");
    expect(text).toContain("<b>Rp158,000</b>");
    expect(text).not.toContain("$");
    const notice = coreT("currency.rate_unavailable", "en");
    expect(text.split(notice).length - 1).toBe(1);
  });

  it("prices in Rp only for an IDR user", async () => {
    await useRate();
    const { ctx, sink } = customerCtx(DisplayCurrency.IDR);
    await checkout.showOrderConfirmation(ctx, sample.product.id, 2);
    const text = sentText(sink);
    expect(text).toContain("Rp79,000 × 2");
    expect(text).toContain("<b>Rp158,000</b>");
    expect(text).not.toContain("≈");
    expect(text).not.toContain("$");
  });

  it("keeps Indonesian grouping for the canonical unit and confirmation total", async () => {
    const { ctx, sink } = customerCtx(DisplayCurrency.IDR, {
      session: { ...session(DisplayCurrency.IDR), lang: "id" },
    });
    await checkout.showOrderConfirmation(ctx, sample.product.id, 2);
    const text = sentText(sink);
    expect(text).toContain("Rp79.000 × 2");
    expect(text).toContain("<b>Rp158.000</b>");
  });

  it("uses English IDR grouping for the voucher and wallet lines in confirmation", async () => {
    await createVoucher(prisma, { code: "FLAT16", type: VoucherType.FIXED, value: "16000", usageLimit: 10 });
    const voucher = customerCtx(DisplayCurrency.IDR, {
      session: { ...session(DisplayCurrency.IDR), scratch: { appliedVoucherCode: "FLAT16" } },
    });
    await checkout.showOrderConfirmation(voucher.ctx, sample.product.id, 2);
    expect(sentText(voucher.sink)).toContain(coreT("checkout.confirm_voucher_line", "en", { code: "FLAT16", discount: "Rp16,000" }));
    expect(sentText(voucher.sink)).toContain("<b>Rp142,000</b>");

    await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: "200000" } });
    const wallet = customerCtx(DisplayCurrency.IDR, {
      session: { ...session(DisplayCurrency.IDR), scratch: { useWalletIdr: true } },
    });
    await checkout.showOrderConfirmation(wallet.ctx, sample.product.id, 2);
    expect(sentText(wallet.sink)).toContain(coreT("checkout.confirm_wallet_line", "en", { amount: "Rp158,000" }));
  });

  it("shows the voucher discount and a failed minimum purchase in the user's currency", async () => {
    await useRate();
    await createVoucher(prisma, { code: "FLAT16", type: VoucherType.FIXED, value: "16000", usageLimit: 10 });
    const ok = customerCtx(DisplayCurrency.USD, {
      session: { ...session(DisplayCurrency.USD), scratch: { appliedVoucherCode: "FLAT16" } },
    });
    await checkout.showOrderConfirmation(ok.ctx, sample.product.id, 1);
    expect(sentText(ok.sink)).toContain(coreT("checkout.confirm_voucher_line", "en", { code: "FLAT16", discount: "$1.00" }));

    await createVoucher(prisma, { code: "BIGMIN", type: VoucherType.PERCENT, value: "10", usageLimit: 10, minPurchase: "100000" });
    const tooSmall = customerCtx(DisplayCurrency.USD, {
      session: { ...session(DisplayCurrency.USD), scratch: { appliedVoucherCode: "BIGMIN" } },
    });
    await checkout.showOrderConfirmation(tooSmall.ctx, sample.product.id, 1);
    expect(sentText(tooSmall.sink)).toContain(coreT("error.voucher_min_purchase", "en", { min: "$6.25" }));
  });
});

// ===========================================================================
// Payment screens stay truthful
// ===========================================================================

describe("payment screens", () => {
  async function tokopay(cur: Cur) {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const { ctx, sink } = customerCtx(cur);
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);
    const order = (await prisma.order.findFirst({ where: { userId: sample.user.id }, orderBy: { id: "desc" } }))!;
    const { computeQrisAdminFee } = await import("@app/core/payments/tokopay");
    const charge = new Decimal(order.totalAmount).plus(computeQrisAdminFee(order.totalAmount));
    const caption = (calls(sink, "replyWithPhoto")[0]!.args[1] as { caption: string }).caption;
    return { ctx, caption, charge, order };
  }

  it("a USD user on QRIS sees the $ price AND the Rp payable (Price $… · Pay Rp…)", async () => {
    await useRate();
    const { caption, charge, order } = await tokopay(DisplayCurrency.USD);
    expect(order.currency).toBe(OrderCurrency.IDR);
    expect(caption).toContain(`Price $4.94 · Pay ${formatIdr(charge)}`);
    expect(caption).not.toContain("Total $");
    // The payable itself is still the native Rupiah figure.
    expect(caption).toContain(`<b>${formatIdr(charge)}</b>`);
  });

  it("a USD user on QRIS with NO rate gets no dual line and the native Rp payable", async () => {
    const { caption, charge } = await tokopay(DisplayCurrency.USD);
    expect(caption).toContain(`<b>${formatIdr(charge)}</b>`);
    expect(caption).not.toContain("$");
    expect(caption).not.toContain(" · Pay ");
  });

  it("a USD user on PayDisini sees the $ price AND the Rp payable (Price $… · Pay Rp…)", async () => {
    await useRate();
    await setSetting(prisma, PAYDISINI_USERKEY_KEY, "uk");
    await setSetting(prisma, PAYDISINI_APIKEY_KEY, "ak");
    const { ctx, sink } = customerCtx(DisplayCurrency.USD);
    await checkout.buyNowPaydisini(ctx, sample.product.id, 1);
    const order = (await prisma.order.findFirst({ where: { userId: sample.user.id }, orderBy: { id: "desc" } }))!;
    expect(order.currency).toBe(OrderCurrency.IDR);
    const caption = (calls(sink, "replyWithPhoto")[0]!.args[1] as { caption: string }).caption;
    expect(caption).toContain(`Price $4.94 · Pay ${formatIdr(order.totalAmount)}`);
    expect(caption).toContain(`<b>${formatIdr(order.totalAmount)}</b>`);
  });

  it("an IDR user on QRIS sees only the Rp payable", async () => {
    await useRate();
    const { caption, charge } = await tokopay(DisplayCurrency.IDR);
    expect(caption).toContain(formatIdr(charge));
    expect(caption).not.toContain("$");
  });

  it("a USD user on a USDT rail sees the USDT payable, not a re-derived $ price", async () => {
    await useRate();
    await setSetting(prisma, BINANCE_UID_KEY, "UID123");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "secret");
    const { ctx, sink } = customerCtx(DisplayCurrency.USD);
    await checkout.buyNowInternal(ctx, sample.product.id, 1);
    const order = (await prisma.order.findFirst({ where: { userId: sample.user.id }, orderBy: { id: "desc" } }))!;
    expect(order.currency).toBe(OrderCurrency.USDT);
    const text = sentText(sink);
    expect(text).toContain(`<b>${formatUsdtAmount(order.totalAmount)}</b>`);
    expect(text).not.toContain("Price $");
  });
});

// ===========================================================================
// Native screens are untouched by the preference
// ===========================================================================

describe("screens that must not follow the display currency", () => {
  async function makeIdrOrder() {
    return prisma.$transaction(async (tx) => {
      const created = await createOrderDirect(tx, {
        user: { id: sample.user.id, role: sample.user.role },
        productId: sample.product.id,
        quantity: 1,
      });
      return finalizeOrderPayment(tx, created!.id, { currency: OrderCurrency.IDR });
    });
  }

  it("an order created as IDR still reads Rp… after the user switches to USD (history is immutable)", async () => {
    await useRate();
    const order = (await makeIdrOrder())!;
    const asIdr = customerCtx(DisplayCurrency.IDR);
    await customer.viewOrder(asIdr.ctx, order.id);
    const asUsd = customerCtx(DisplayCurrency.USD);
    await customer.viewOrder(asUsd.ctx, order.id);
    expect(sentText(asIdr.sink)).toContain(formatIdr(order.totalAmount));
    expect(sentText(asUsd.sink)).toBe(sentText(asIdr.sink));

    const listIdr = customerCtx(DisplayCurrency.IDR);
    await customer.listMyOrders(listIdr.ctx);
    const listUsd = customerCtx(DisplayCurrency.USD);
    await customer.listMyOrders(listUsd.ctx);
    expect(sentText(listUsd.sink)).toContain(formatIdr(order.totalAmount));
    expect(sentText(listUsd.sink)).toBe(sentText(listIdr.sink));
  });

  it("the wallet screen is identical for USD and IDR users (native balances)", async () => {
    await useRate();
    await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: "50000", walletBalanceUsdt: "3.5" } });
    const usd = customerCtx(DisplayCurrency.USD);
    await customer.viewWallet(usd.ctx);
    const idr = customerCtx(DisplayCurrency.IDR);
    await customer.viewWallet(idr.ctx);
    expect(sentText(usd.sink)).toContain("Rp50.000");
    expect(sentText(usd.sink)).toBe(sentText(idr.sink));
  });

  it("admin product list stays Rp even for an admin who picked USD", async () => {
    await useRate();
    const { ctx, sink } = makeCtx({
      from: { id: 999, username: "boss" },
      callbackData: "v1:adm:prod:menu",
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
          preferredCurrency: DisplayCurrency.USD,
        },
      },
    });
    await handleAdminCallback(ctx, "v1:adm:prod:menu".split(":"));
    expect(sentIncludes(sink, "Rp79.000")).toBe(true);
    expect(sentText(sink)).not.toContain("$4.94");
  });
});
