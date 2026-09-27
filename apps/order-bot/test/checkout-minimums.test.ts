// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  prisma,
  createVoucher,
  setSetting,
  getOrder,
  MIN_ORDER_AMOUNT_IDR_KEY,
  TOKOPAY_MIN_AMOUNT_KEY,
  BYBIT_MIN_AMOUNT_KEY,
  USD_IDR_RATE_UPDATED_AT_KEY,
  FX_QUOTE_TTL_MINUTES_KEY,
  DEFAULT_FX_QUOTE_TTL_MINUTES,
} from "@app/db";
import { OrderStatus, PaymentMethod, VoucherType } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, lastMarkup, sentIncludes, calls, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { t } from "../src/util/i18n";
import * as checkout from "../src/handlers/checkout";

/**
 * M11 / audit P0-1 at the Telegram checkout — the buyer-facing half of the
 * minimum-order-amount work:
 *
 *  - An order a voucher alone reduced to Rp0 is settled from the shop's own
 *    books. The confirmation screen already collapses to a single "Complete
 *    Order" button at a zero total (orderConfirmKb's `fullyCovered` branch),
 *    but that button used to be a dead end unless wallet credit was what
 *    zeroed the order: it bounced straight back to the same screen. There was
 *    no route by which a fully-discounted order could be bought.
 *  - A rail whose configured minimum the order total cannot clear is not
 *    offered. Same settings, same helper as the finalize-time guard, so the
 *    keyboard can never offer a rail that `finalizeOrderPayment` would refuse.
 */

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  invalidateRateCache();
  sample = await buildSampleData(prisma); // product price "5.00" IDR
  // Bumped from the fixture's Rp5 default: at 16.000 that converts to 0.0003
  // USDT, which usdtFromIdr's rounding step would floor to 0.0 regardless of
  // any minimum — exactly the "nothing to collect" case, not the "rail
  // minimum" case this file's USDT-visibility tests are about. Rp5.000
  // converts to a comfortably non-zero 0.3 USDT, and stays well under every
  // TokoPay-minimum figure this file sets (so those cases are unaffected).
  await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "5000" } });
  await setSetting(prisma, "usd_idr_rate", "16000");
  // A live IDR rail (TokoPay) + a live USDT one (Bybit) to filter.
  await setSetting(prisma, "tokopay_merchant_id", "M-TEST");
  await setSetting(prisma, "tokopay_secret", "S-TEST");
  await setSetting(prisma, "bybit_uid", "123456789");
  await setSetting(prisma, "bybit_api_key", "k");
  await setSetting(prisma, "bybit_api_secret", "s");
  await setSetting(prisma, TOKOPAY_MIN_AMOUNT_KEY, "");
  await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "");
  await createVoucher(prisma, { code: "FREE100", type: VoucherType.PERCENT, value: "100", usageLimit: 100 });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function userSession(scratch: Record<string, unknown> = {}): Partial<SessionData> {
  return {
    lang: "en",
    scratch,
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: sample.user.role,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
      preferredCurrency: null,
    },
  };
}

function customerCtx(scratch: Record<string, unknown> = {}) {
  return makeCtx({ from: { id: 42, username: "tester" }, session: userSession(scratch) });
}

/** Every callback_data on the last keyboard the bot rendered. */
function buttons(sink: SentCall[]): string[] {
  const markup = lastMarkup(sink) as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? "");
}

describe("completeOrderWithWallet — an order a discount alone reduced to Rp0", () => {
  it("settles and delivers it without a gateway, though no wallet credit was toggled", async () => {
    const { ctx, sink } = customerCtx({ appliedVoucherCode: "FREE100" });

    await checkout.completeOrderWithWallet(ctx, sample.product.id, 1);

    const order = await prisma.order.findFirstOrThrow({ where: { userId: sample.user.id } });
    const full = (await getOrder(prisma, order.id))!;
    expect(full.status).toBe(OrderStatus.DELIVERED);
    expect(full.paymentMethod).toBe(PaymentMethod.WALLET);
    expect(Number(full.totalAmount)).toBe(0);
    expect(Number(full.walletUsed)).toBe(0);
    expect(full.paymentRef).toBeNull();
    // Not null: settleFullyDiscountedOrder never touches the creation-time
    // payment window, it only skips ever replacing it with a gateway's own
    // (see zero_total_checkout.test.ts, which asserts this same equality).
    expect(full.expiresAt?.getTime()).toBe(order.expiresAt?.getTime());
    expect(await prisma.walletTransaction.count({ where: { userId: sample.user.id } })).toBe(0);
    // The buyer is told the order is paid, not bounced back to the same screen.
    // Checked as a fragment, not the full templated string: sentIncludes matches
    // against JSON.stringify(args), which escapes the template's embedded "\n\n"
    // as a literal two-character sequence, so a needle built from the same
    // template (with a REAL newline) can never match it whole — this fragment
    // sits after both newlines.
    expect(sentIncludes(sink, `Order <code>${full.orderCode}</code> is fully covered`)).toBe(true);
  });

  it("still refuses a tap with neither credit toggled nor a zeroing discount", async () => {
    // customerCtx()'s one parameter feeds session.scratch, not makeCtx's own
    // callbackData option — this needs a real callback tap (ctx.callbackQuery
    // set) so the handler's stale-tap toast actually has something to answer.
    const { ctx, sink } = makeCtx({
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: `v1:walletpay:${sample.product.id}:1`,
    });

    await checkout.completeOrderWithWallet(ctx, sample.product.id, 1);

    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(0);
    const alert = calls(sink, "answerCallbackQuery").find(
      (c) => (c.args[0] as { text?: string } | undefined)?.text === t(ctx, "error.stale_screen"),
    );
    expect(alert).toBeTruthy();
  });
});

describe("showOrderConfirmation — rails the order total cannot clear are not offered", () => {
  it("offers QRIS and USDT when the total clears every minimum", async () => {
    const { ctx, sink } = customerCtx();
    await checkout.showOrderConfirmation(ctx, sample.product.id, 1);
    const data = buttons(sink);
    expect(data.some((d) => d.startsWith("v1:payq:"))).toBe(true);
    expect(data.some((d) => d.startsWith("v1:usdt:"))).toBe(true);
  });

  it("hides QRIS once TokoPay's own minimum is above the total", async () => {
    await setSetting(prisma, TOKOPAY_MIN_AMOUNT_KEY, "50000");
    const { ctx, sink } = customerCtx();
    await checkout.showOrderConfirmation(ctx, sample.product.id, 1);
    const data = buttons(sink);
    expect(data.some((d) => d.startsWith("v1:payq:"))).toBe(false);
    // The crypto rails have no minimum of their own here, so they stay.
    expect(data.some((d) => d.startsWith("v1:usdt:"))).toBe(true);
  });

  it("the shop-wide minimum hides every rail and the screen says why", async () => {
    await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "50000");
    const { ctx, sink } = customerCtx();
    await checkout.showOrderConfirmation(ctx, sample.product.id, 1);
    const data = buttons(sink);
    expect(data.some((d) => d.startsWith("v1:payq:"))).toBe(false);
    expect(data.some((d) => d.startsWith("v1:payd:"))).toBe(false);
    expect(data.some((d) => d.startsWith("v1:usdt:"))).toBe(false);
    expect(sentIncludes(sink, t(ctx, "checkout.no_method_for_total"))).toBe(true);
  });

  it("hides a USDT rail whose USDT minimum the converted total misses", async () => {
    await setSetting(prisma, BYBIT_MIN_AMOUNT_KEY, "5");
    const { ctx, sink } = customerCtx();
    await checkout.showUsdtMethods(ctx, sample.product.id, 1);
    const data = buttons(sink);
    expect(data.some((d) => d.startsWith("v1:payb:"))).toBe(false);
  });
});

/**
 * Whole-branch review A2: the same "never offer what the guard would refuse"
 * rule, applied to the OTHER thing that refuses a USDT finalize — M12's quote
 * TTL. `fx_rate_max_age_hours` (48h) is what makes the rate read as null and
 * takes the USDT screens away; `fx_quote_ttl_minutes` (180m) refuses the
 * finalize. Between the two, the bot used to show every USDT button and answer
 * every tap with `error.fx_quote_expired`.
 *
 * The rate stays a live, non-null Rp16.000 throughout: what these cases move is
 * only its freshness stamp, which is exactly the window the bug lived in.
 */
describe("showOrderConfirmation — USDT rails are hidden once the rate's quote lifetime has passed", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  it("hides USDT but keeps QRIS when the stamp is older than the default TTL", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 5));
    const { ctx, sink } = customerCtx();
    await checkout.showOrderConfirmation(ctx, sample.product.id, 1);
    const data = buttons(sink);
    expect(data.some((d) => d.startsWith("v1:usdt:"))).toBe(false);
    expect(data.some((d) => d.startsWith("v1:payq:"))).toBe(true);
  });

  it("keeps USDT when the stamp is inside the TTL", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(5));
    const { ctx, sink } = customerCtx();
    await checkout.showOrderConfirmation(ctx, sample.product.id, 1);
    expect(buttons(sink).some((d) => d.startsWith("v1:usdt:"))).toBe(true);
  });

  it("widening fx_quote_ttl_minutes past the stamp's age brings the USDT rails back", async () => {
    // Derived from the default, not a literal: a 120-minute stamp was stale
    // under the old 60-minute default and is fresh under today's 180, so a
    // literal here stops discriminating the moment the default moves again.
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 60));
    await setSetting(prisma, FX_QUOTE_TTL_MINUTES_KEY, String(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 120));
    const { ctx, sink } = customerCtx();
    await checkout.showOrderConfirmation(ctx, sample.product.id, 1);
    expect(buttons(sink).some((d) => d.startsWith("v1:usdt:"))).toBe(true);
  });

  it("hides the individual USDT methods too, not just the submenu button", async () => {
    await setSetting(prisma, USD_IDR_RATE_UPDATED_AT_KEY, minutesAgo(Number(DEFAULT_FX_QUOTE_TTL_MINUTES) + 5));
    const { ctx, sink } = customerCtx();
    await checkout.showUsdtMethods(ctx, sample.product.id, 1);
    expect(buttons(sink).some((d) => d.startsWith("v1:payb:"))).toBe(false);
  });
});
