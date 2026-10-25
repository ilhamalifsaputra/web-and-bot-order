// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * Game Top-up END-TO-END through the REAL order-bot (Phase 5, P5-2).
 *
 * Every buyer step goes through `buildBot()` — the production middleware
 * chain (bindUpdateId → sequentialize → Prisma-backed session →
 * conversations → registeredUser → rateLimit → commerceGate → joinGate →
 * requireCurrency → conversations → commands → the v1 callback router →
 * the message:text handler) — via `bot.handleUpdate()` with hand-built
 * Telegram updates, awaited one at a time. Telegram itself is replaced by
 * the recording transport in ./helpers/fakeTelegram.ts. Every
 * `callback_data` (including the price-lock nonce) is read back from the
 * keyboards the bot actually rendered, never written here.
 *
 * Stubbed, and only these: the TokoPay gateway (`createTransaction`), the
 * KokinPay nickname HTTP call and the Digiflazz supplier call — no network.
 *
 * Seams that are NOT the bot's update chain, and why (each honest, none of
 * them replaces the behavior under test):
 *  - Payment: a real TokoPay webhook runs in the web process; the test calls
 *    its settlement function `deliverPaidTokopayOrder` directly, then
 *    `dispatchDigiflazzOrderNow` (what the webhook's dispatch trigger runs).
 *  - Background workers: the scheduler is not started; the test calls the
 *    jobs (`sendPaymentReminders`, `autoCancelExpiredOrders`), the outbox
 *    `drainBatch(bot)` and one `FulfillmentMessageWorker.tick` itself, all
 *    on the SAME bot/transport, so their Telegram calls are recorded too.
 *  - Time: `autoCancelExpiredOrders` has no injectable clock, so expired /
 *    about-to-expire orders are made by moving `expiresAt` (and, for the
 *    reminder, `createdAt`: an order created 25 minutes ago) in the DB.
 *  - Rate limit: the scripted buyer taps far faster than a person; the
 *    5-per-3s limiter would drop the steps, so RATE_LIMIT_MAX is raised for
 *    this file. The limiter is still in the chain, only its budget changes.
 *
 * grammY transformer order (checked in grammy/out/core/client.js `use()`:
 * `transformers.reduce(concatTransformer, this.call)`): the last installed
 * transformer is the outermost. The fake transport is installed after
 * `buildBot()`'s `htmlDefaultsTransformer`, so it sees each payload as the
 * handler built it and the HTML defaults never run — hence these tests
 * assert message CONTENT, never `parse_mode`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "1000";
});

const kokinpayMock = vi.hoisted(() => ({ checkGameNickname: vi.fn() }));
vi.mock("@app/core/suppliers/kokinpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/kokinpay")>()),
  checkGameNickname: kokinpayMock.checkGameNickname,
}));
const tokopayMock = vi.hoisted(() => ({ createTransaction: vi.fn(), checkTransaction: vi.fn() }));
vi.mock("@app/core/payments/tokopay", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/tokopay")>()),
  createTransaction: tokopayMock.createTransaction,
  checkTransaction: tokopayMock.checkTransaction,
}));
const digiflazzMock = vi.hoisted(() => ({ createTransaction: vi.fn(), getPriceList: vi.fn() }));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  createTransaction: digiflazzMock.createTransaction,
  getPriceList: digiflazzMock.getPriceList,
}));

import {
  prisma,
  setSetting,
  setUserPreferredCurrency,
  invalidateWarmUser,
  createCatalogProduct,
  createDenomination,
  deliverPaidTokopayOrder,
  dispatchDigiflazzOrderNow,
  DIGIFLAZZ_USERNAME_KEY,
  DIGIFLAZZ_API_KEY_KEY,
} from "@app/db";
import { NotificationEvent, OrderKind, OrderStatus } from "@app/core/enums";
import { qrisChargeAmount } from "@app/core/payments/tokopay";
import { formatIdrFor } from "@app/core/moneyFormat";
import { Decimal } from "@app/core/money";
import { resetDb } from "../../../tests/helpers/sampleData";
import { buildGameTopupFixtures, FIXTURE_BUYER_TELEGRAM_ID, type GameTopupFixtureIds } from "../../../tests/helpers/gameTopupFixtures";
import { drainBatch } from "../../../packages/outbox-dispatcher/src/dispatcher";
import { FulfillmentMessageWorker } from "../../../packages/outbox-dispatcher/src/fulfillmentMessages";
import { buildBot } from "../src/main";
import { sendPaymentReminders, autoCancelExpiredOrders } from "../src/jobs";
import { invalidateRateCache } from "../src/util/rate";
import { coreT } from "../src/util/i18n";
import { FAKE_ME, FakeTelegram, type RecordedCall } from "./helpers/fakeTelegram";

const BUYER = FIXTURE_BUYER_TELEGRAM_ID;
const EN = "en";
// A later /start in the same session also strips the buttons of the previous
// menu bubble, so it touches one more message than the very first /start.
const AGAIN = ["sendMessage", "editMessageReplyMarkup"];

let fx: GameTopupFixtureIds;
// update_ids must never repeat in this process (bindUpdateId's processed-update
// ledger), so every test's FakeTelegram starts from a fresh range.
let updateSeq = 100_000;

beforeEach(async () => {
  await resetDb(prisma);
  // resetDb leaves bot sessions alone; each test starts from a buyer with no
  // session (no menu anchor, no scratch) left by the previous one.
  await prisma.botSession.deleteMany();
  invalidateRateCache();
  kokinpayMock.checkGameNickname.mockReset();
  digiflazzMock.createTransaction.mockReset();
  tokopayMock.createTransaction.mockReset();
  tokopayMock.createTransaction.mockImplementation(async (_creds: unknown, args: { refId: string; amountIdr: Decimal.Value }) => ({
    trxId: `TP-${args.refId}`,
    payUrl: null,
    qrLink: "https://qr.test/qr.png",
    qrString: "000201",
    totalBayar: String(args.amountIdr),
  }));
  fx = await buildGameTopupFixtures(prisma);
  // An onboarded buyer: display currency chosen (IDR), language left at the
  // DEFAULT_LANGUAGE "en" the bootstrap sets.
  await setUserPreferredCurrency(prisma, fx.userId, "IDR");
  // Placeholder credentials so the rails count as configured; every call that
  // would use them is stubbed above.
  await setSetting(prisma, "tokopay_merchant_id", "fixture-merchant");
  await setSetting(prisma, "tokopay_secret", "fixture-secret");
  await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, "fixture-user");
  await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, "fixture-key");
});

afterEach(() => {
  // registeredUser keeps a per-Telegram-id warm snapshot of the user (DB id
  // included); the next test's resetDb gives the buyer a new id.
  invalidateWarmUser(fx.userId);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function openBot(): FakeTelegram {
  const bot = buildBot("123:test-token");
  bot.botInfo = FAKE_ME;
  const tg = new FakeTelegram(bot, BUYER, { id: BUYER, first_name: "Fixture", username: "fixture_buyer" }, updateSeq);
  updateSeq += 10_000;
  return tg;
}

/** Run one step and return the screen-affecting Telegram methods it called. */
async function step(tg: FakeTelegram, fn: () => Promise<unknown>): Promise<{ screen: string[]; calls: RecordedCall[] }> {
  const mark = tg.mark();
  await fn();
  return { screen: tg.screen(mark), calls: tg.since(mark) };
}

const textOf = (c: RecordedCall) => String(c.payload.text ?? c.payload.caption ?? "");
const toasts = (calls: RecordedCall[]) => calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.payload.text);

/** Every chat the bot addressed is the buyer's own private chat. */
function expectOnlyBuyerChat(tg: FakeTelegram) {
  expect([...tg.chatIds()]).toEqual([String(BUYER)]);
}

/** /start → Products → Game Top Up group → a category's numbered list. */
async function openGameCategory(tg: FakeTelegram, category: RegExp, startScreen: string[] = ["sendMessage"]) {
  expect((await step(tg, () => tg.sendText("/start"))).screen).toEqual(startScreen);
  const products = await step(tg, () => tg.pressReply(/Products/));
  expect(products.screen).toEqual(["sendMessage", "editMessageReplyMarkup"]);
  expect((await step(tg, () => tg.press(/Game Top Up/))).screen).toEqual(["editMessageText"]);
  const list = await step(tg, () => tg.press(category));
  // A number-pad reply keyboard, then the list itself in the browse bubble.
  expect(list.screen).toEqual(["sendMessage", "editMessageText"]);
  return textOf(list.calls.find((c) => c.method === "editMessageText")!);
}

/**
 * Game product → pack → Buy → one-message account input → review. Returns the
 * review screen's text. `pack` matches the pack button label.
 */
async function buyGamePack(tg: FakeTelegram, listNumber: string, pack: RegExp, account: string, example = "123456789 1234") {
  const picker = await step(tg, () => tg.sendText(listNumber));
  expect(picker.screen).toEqual(["sendMessage", "editMessageReplyMarkup"]);
  expect((await step(tg, () => tg.press(pack))).screen).toEqual(["editMessageText"]);
  const prompt = await step(tg, () => tg.press(/Buy/));
  expect(prompt.screen).toEqual(["editMessageText"]);
  expect(tg.screenText()).toContain(`<code>${example}</code>`); // the advertised example
  const review = await step(tg, () => tg.sendText(account));
  // The accepted input is deleted, the wizard bubble becomes the review.
  expect(review.screen).toEqual(["deleteMessage", "editMessageText"]);
  return tg.screenText();
}

/** Review → Continue → payment screen → tap QRIS; returns the order it made. */
async function continueAndPay(tg: FakeTelegram) {
  const pay = await step(tg, () => tg.press(/Continue/));
  expect(pay.screen).toEqual(["editMessageText"]);
  expect(tg.screenText()).toContain("Confirm Order");
  const qr = await step(tg, () => tg.press(/QRIS/));
  // The QR photo is sent and the text confirm bubble it replaces is deleted.
  expect(qr.screen).toEqual(["sendPhoto", "deleteMessage"]);
  return prisma.order.findFirstOrThrow({ orderBy: { id: "desc" } });
}

describe("Game Top-up end to end through buildBot() with a fake Telegram transport", () => {
  it("1. happy path: browse → pack → account input → review → pay → TokoPay settlement → Digiflazz → DELIVERED", async () => {
    const tg = openBot();
    const list = await openGameCategory(tg, /Game Top Up/);
    expect(list).toContain("Mobile Legends");

    const review = await buyGamePack(tg, "1", /^257/, "123456789 1234");
    // Both account fields, shown separately, and the review's own buttons only.
    expect(review).toContain(coreT("checkout.review_title", EN));
    expect(review).toMatch(/User ID: <code>123456789<\/code>/);
    expect(review).toMatch(/Zone ID: <code>1234<\/code>/);
    expect(review).toContain(formatIdrFor(new Decimal("58000"), EN));
    const reviewButtons = tg.buttons().map((b) => b.text);
    expect(reviewButtons).toHaveLength(3);
    expect(reviewButtons.some((l) => /Continue/.test(l))).toBe(true);
    expect(reviewButtons.some((l) => /Change details/.test(l))).toBe(true);
    expect(reviewButtons.some((l) => /Back/.test(l))).toBe(true);
    expect(tg.buttons().some((b) => b.callback_data?.startsWith("v1:pay"))).toBe(false);
    expect(await prisma.order.count()).toBe(0);

    const order = await continueAndPay(tg);
    expect(order).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, paymentMethod: "TOKOPAY", kind: OrderKind.PRODUCT });
    // The price lock held: the order total is the total the review quoted.
    expect(order.totalAmount.toString()).toBe("58000");
    expect(JSON.parse(order.customerData!)).toEqual([{ user_id: "123456789", zone_id: "1234" }]);
    expect(tokopayMock.createTransaction).toHaveBeenCalledTimes(1);
    expect(tg.screenText()).toContain(order.orderCode);

    // --- the payment lands (web-process webhook seam) and Digiflazz delivers ---
    digiflazzMock.createTransaction.mockResolvedValue({
      status: "Sukses", refId: order.orderCode, buyerSkuCode: "fixture-ml257", customerNo: "1234567891234",
      message: "success", rc: "00", sn: "SN-FIXTURE-1", price: new Decimal("57000"),
    });
    const settled = await deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId: `TP-${order.orderCode}`, amount: qrisChargeAmount(order.totalAmount) });
    expect(settled.status).toBe("processing");
    expect(await dispatchDigiflazzOrderNow(prisma, order.id)).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    // Zone appended to the id per providerInputMapping {"keys":["user_id","zone_id"],"separator":""}.
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
    expect(digiflazzMock.createTransaction.mock.calls[0]![1]).toMatchObject({ refId: order.orderCode, buyerSkuCode: "fixture-ml257", customerNo: "1234567891234" });

    const delivered = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { statusHistory: { orderBy: { id: "asc" } } } });
    expect(delivered.status).toBe(OrderStatus.DELIVERED);
    expect(delivered.paymentState).toBe("PAID");
    expect(delivered.statusHistory.map((h) => h.status)).toEqual([OrderStatus.PENDING_VERIFICATION, OrderStatus.PROCESSING, OrderStatus.DELIVERED]);

    // No buyer Telegram DM is queued for this route (the tracked status
    // message is the buyer's notice), so the outbox sends nothing.
    const outbox = await prisma.notificationOutbox.findMany({ where: { channel: { not: "EMAIL" } } });
    expect(outbox).toEqual([]);
    expect((await step(tg, () => drainBatch(tg.bot))).screen).toEqual([]);

    // The order's one tracked status message: the QR photo is retired by the
    // final status text (one send, one delete).
    const photoId = order.paymentMsgId!;
    const worker = await step(tg, () => new FulfillmentMessageWorker(tg.bot.api, { now: () => new Date(Date.now() + 3000) }).tick(order.id));
    expect(worker.screen).toEqual(["sendMessage", "deleteMessage"]);
    expect(Number(worker.calls.find((c) => c.method === "deleteMessage")!.payload.message_id)).toBe(photoId);
    const done = textOf(worker.calls.find((c) => c.method === "sendMessage")!);
    expect(done).toContain(order.orderCode);
    expect(done).toContain("SN-FIXTURE-1");
    expectOnlyBuyerChat(tg);
  });

  it("2. price lock: a price change after Continue re-renders the payment screen; the old button never pays, the new one pays once at the new price", async () => {
    const tg = openBot();
    await openGameCategory(tg, /Game Top Up/);
    await buyGamePack(tg, "1", /^86/, "123456789 1234");
    expect((await step(tg, () => tg.press(/Continue/))).screen).toEqual(["editMessageText"]);
    const oldPay = tg.findButton(/QRIS/);
    expect(tg.screenText()).toContain(formatIdrFor(new Decimal("20000"), EN));

    await prisma.denomination.update({ where: { id: fx.denominations["ml-86"]! }, data: { price: new Decimal("25000") } });
    const newTotal = formatIdrFor(new Decimal("25000"), EN);

    const changed = await step(tg, () => tg.tap(oldPay.messageId, oldPay.button.callback_data!));
    expect(changed.screen).toEqual(["editMessageText"]);
    expect(await prisma.order.count()).toBe(0);
    expect(tokopayMock.createTransaction).not.toHaveBeenCalled();
    expect(tg.screenText()).toContain(coreT("checkout.price_changed", EN, { total: newTotal }));
    expect(tg.screenText()).toContain(`Total: <b>${newTotal}</b>`);
    const newPay = tg.findButton(/QRIS/);
    expect(newPay.button.callback_data).not.toBe(oldPay.button.callback_data);

    // The OLD button again: a stale-screen toast and a fresh render, no order.
    const stale = await step(tg, () => tg.tap(oldPay.messageId, oldPay.button.callback_data!));
    expect(stale.screen).toEqual(["editMessageText"]);
    expect(toasts(stale.calls)).toContain(coreT("error.stale_screen", EN));
    expect(await prisma.order.count()).toBe(0);
    expect(tokopayMock.createTransaction).not.toHaveBeenCalled();

    // The button now on screen pays, exactly once, at the new price.
    const qr = await step(tg, () => tg.press(/QRIS/));
    expect(qr.screen).toEqual(["sendPhoto", "deleteMessage"]);
    const orders = await prisma.order.findMany();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.totalAmount.toString()).toBe("25000");
    expect(orders[0]!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(tokopayMock.createTransaction).toHaveBeenCalledTimes(1);
    expectOnlyBuyerChat(tg);
  });

  it("3. a game without a region goes straight to its pack, and a mixed category lists every product", async () => {
    const tg = openBot();
    const list = await openGameCategory(tg, /^🎮 Game Top Up$/);
    expect(list).toContain("Delta Force");

    // Regional game: its pack screen is headed by the region.
    const ml = await step(tg, () => tg.sendText("1"));
    expect(ml.screen).toEqual(["sendMessage", "editMessageReplyMarkup"]);
    expect(tg.screenText()).toContain("Indonesia");

    // Delta Force (no region, one pack): straight to the pack, no region text.
    await openGameCategory(tg, /^🎮 Game Top Up$/, AGAIN);
    const df = await step(tg, () => tg.sendText("3"));
    expect(df.screen).toEqual(["sendMessage", "editMessageReplyMarkup"]);
    expect(tg.screenText()).toContain("Delta Force");
    expect(tg.screenText()).toContain("300 Delta Coins");
    expect(tg.screenText()).not.toContain("Indonesia");
    expect(tg.buttons().some((b) => /Buy/.test(b.text))).toBe(true);

    // Mixed category: the regional product and both region-less ones.
    const mixed = await openGameCategory(tg, /Mixed Games/, AGAIN);
    for (const name of ["Mixed Game Regional", "Mixed Game Global", "Mixed Game Plain"]) expect(mixed).toContain(name);
    const global = await step(tg, () => tg.sendText("2"));
    expect(global.screen).toEqual(["sendMessage", "editMessageReplyMarkup"]);
    expect(tg.screenText()).toContain("Mixed Game Global");
    expect(tg.screenText()).not.toContain("Indonesia");
    expectOnlyBuyerChat(tg);
  });

  it("4. /search returns Game Top-up products only, never a Premium Apps product with a matching name", async () => {
    const premiumNamesake = await createCatalogProduct(prisma, { categoryId: fx.categories.premiumApps, name: "Legends Streaming" });
    await createDenomination(prisma, { productId: premiumNamesake.id, name: "1 Month", price: new Decimal("30000"), type: "SHARED", durationLabel: "1 Month", deliveryType: "manual" });

    const tg = openBot();
    expect((await step(tg, () => tg.sendText("/start"))).screen).toEqual(["sendMessage"]);
    const search = await step(tg, () => tg.sendText("/search legends"));
    // The results replace the dashboard bubble (the menu anchor) in place.
    expect(search.screen).toEqual(["editMessageText"]);
    const results = tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:pick:"));
    expect(results.map((b) => b.text)).toEqual([expect.stringContaining("Mobile Legends")]);
    expect(tg.screenText()).not.toContain("Legends Streaming");
    expect(tg.buttons().some((b) => b.text.includes("Legends Streaming"))).toBe(false);

    // A result opens the game's pack screen in the same bubble.
    const open = await step(tg, () => tg.press(/Mobile Legends/));
    expect(open.screen).toEqual(["editMessageText"]);
    expect(tg.screenText()).toContain("Choose a top-up amount");
    expectOnlyBuyerChat(tg);
  });

  it("5. Premium Apps control: plan picker, no review, no From label, no game hints or placeholders", async () => {
    await createDenomination(prisma, { productId: fx.products.premiumApp, name: "3 Month Plan", price: new Decimal("150000"), type: "SHARED", durationLabel: "3 Months", deliveryType: "manual", warrantyDays: 90 });

    const tg = openBot();
    expect((await step(tg, () => tg.sendText("/start"))).screen).toEqual(["sendMessage"]);
    expect((await step(tg, () => tg.pressReply(/Products/))).screen).toEqual(["sendMessage", "editMessageReplyMarkup"]);
    // One Premium category: the group opens its product list directly.
    const list = await step(tg, () => tg.press(/Premium Apps/));
    expect(list.screen).toEqual(["sendMessage", "editMessageText"]);
    const listText = textOf(list.calls.find((c) => c.method === "editMessageText")!);
    expect(listText).toContain("Streaming App");
    expect(listText.toLowerCase()).not.toContain("from");
    expect(listText).not.toContain("/search");

    // The original Premium plan picker (browse.denomination_line rows).
    const picker = await step(tg, () => tg.sendText("1"));
    expect(picker.screen).toEqual(["sendMessage", "editMessageReplyMarkup"]);
    expect(tg.screenText()).toContain("Choose a plan:");
    expect(tg.buttons().filter((b) => b.callback_data?.startsWith("v1:browse:denom:")).map((b) => b.text)).toEqual(["1 Month", "3 Months"]);

    const detail = await step(tg, () => tg.press(/^1 Month$/));
    expect(detail.screen).toEqual(["editMessageText"]);
    expect(tg.screenText()).toContain("Warranty: 30 days");

    // Buy goes straight to the payment screen: no account prompt, no review.
    const buy = await step(tg, () => tg.press(/Buy/));
    expect(buy.screen).toEqual(["editMessageText"]);
    expect(tg.screenText()).toContain("Confirm Order");
    expect(tg.buttons().some((b) => b.callback_data?.startsWith("v1:payq:"))).toBe(true);
    const allText = tg.calls.map(textOf).join("\n");
    expect(allText).not.toContain(coreT("checkout.review_title", EN));
    expect(allText).not.toContain("123456789");
    expect(allText).not.toMatch(/Zone ID|User ID|Player ID/);
    expect(tg.buttons().some((b) => b.callback_data?.startsWith("v1:rev:"))).toBe(false);

    const qr = await step(tg, () => tg.press(/QRIS/));
    expect(qr.screen).toEqual(["sendPhoto", "deleteMessage"]);
    const order = await prisma.order.findFirstOrThrow();
    expect(order.totalAmount.toString()).toBe("55000");
    expect(order.customerData).toBeNull();
    expectOnlyBuyerChat(tg);
  });

  it("6. reminder: one DM to the buyer ~5 minutes before expiry, deduplicated, and none once a payment was detected", async () => {
    const tg = openBot();
    await openGameCategory(tg, /Game Top Up/);
    await buyGamePack(tg, "1", /^86/, "123456789 1234");
    const unpaid = await continueAndPay(tg);
    // The QR photo is the live anchor now; /start leaves its buttons alone.
    await openGameCategory(tg, /Game Top Up/);
    await buyGamePack(tg, "2", /^70/, "987654321", "123456789");
    const detected = await continueAndPay(tg);
    expect(detected.id).not.toBe(unpaid.id);

    // Both created 25 minutes ago with a 30-minute window: 5 minutes left.
    const now = new Date();
    for (const o of [unpaid, detected]) {
      await prisma.order.update({ where: { id: o.id }, data: { createdAt: new Date(now.getTime() - 25 * 60_000), expiresAt: new Date(now.getTime() + 5 * 60_000) } });
    }
    // A provider already saw the second order's payment.
    await prisma.order.update({ where: { id: detected.id }, data: { paymentState: "PAYMENT_DETECTED" } });

    const enqueue = await step(tg, () => sendPaymentReminders(tg.bot.api, { now }));
    expect(enqueue.calls).toEqual([]); // enqueue only, never Telegram itself
    const sent = await step(tg, () => drainBatch(tg.bot));
    expect(sent.screen).toEqual(["sendMessage"]);
    const dm = sent.calls[0]!;
    expect(Number(dm.payload.chat_id)).toBe(BUYER);
    expect(textOf(dm)).toContain("Payment reminder");
    expect(textOf(dm)).toContain(unpaid.orderCode);
    expect(textOf(dm)).not.toContain(detected.orderCode);

    // A second tick queues nothing new (dedupe key per order).
    await sendPaymentReminders(tg.bot.api, { now: new Date(now.getTime() + 60_000) });
    expect((await step(tg, () => drainBatch(tg.bot))).screen).toEqual([]);
    const reminders = await prisma.notificationOutbox.findMany({ where: { event: NotificationEvent.PAYMENT_REMINDER_DM } });
    expect(reminders.map((r) => [r.orderId, r.status])).toEqual([[unpaid.id, "SENT"]]);
    expectOnlyBuyerChat(tg);
  });

  describe("7. expiry", () => {
    async function backdate(orderId: number) {
      await prisma.order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    }
    const tick = (tg: FakeTelegram, orderId: number) =>
      new FulfillmentMessageWorker(tg.bot.api, { now: () => new Date(Date.now() + 3000) }).tick(orderId);

    it("a tracked QR photo is retired by a new cancelled status message, so no extra expiry push is queued (route 1b)", async () => {
      const tg = openBot();
      await openGameCategory(tg, /Game Top Up/);
      await buyGamePack(tg, "1", /^86/, "123456789 1234");
      const order = await continueAndPay(tg);
      await backdate(order.id);

      // The sweep cancels and only wakes the tracked message's worker.
      expect((await step(tg, () => autoCancelExpiredOrders(tg.bot.api))).calls).toEqual([]);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);
      expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.ORDER_EXPIRED_DM } })).toBe(0);

      const worker = await step(tg, () => tick(tg, order.id));
      expect(worker.screen).toEqual(["sendMessage", "deleteMessage"]);
      expect(Number(worker.calls[1]!.payload.message_id)).toBe(order.paymentMsgId);
      expect(textOf(worker.calls[0]!)).toContain(order.orderCode);
      expect((await step(tg, () => drainBatch(tg.bot))).screen).toEqual([]);
      expectOnlyBuyerChat(tg);
    });

    it("a tracked TEXT payment message is edited silently to cancelled, so exactly one expiry push reaches the buyer (route 1a)", async () => {
      // No QR image from the gateway: the payment screen stays a text bubble.
      tokopayMock.createTransaction.mockImplementation(async (_creds: unknown, args: { refId: string; amountIdr: Decimal.Value }) => ({
        trxId: `TP-${args.refId}`, payUrl: null, qrLink: null, qrString: "000201", totalBayar: String(args.amountIdr),
      }));
      const tg = openBot();
      await openGameCategory(tg, /Game Top Up/);
      await buyGamePack(tg, "1", /^86/, "123456789 1234");
      expect((await step(tg, () => tg.press(/Continue/))).screen).toEqual(["editMessageText"]);
      expect((await step(tg, () => tg.press(/QRIS/))).screen).toEqual(["editMessageText"]);
      const order = await prisma.order.findFirstOrThrow();
      await backdate(order.id);

      expect((await step(tg, () => autoCancelExpiredOrders(tg.bot.api))).calls).toEqual([]);
      const worker = await step(tg, () => tick(tg, order.id));
      expect(worker.screen).toEqual(["editMessageText"]);
      expect(Number(worker.calls.find((c) => c.method === "editMessageText")!.payload.message_id)).toBe(order.paymentMsgId);

      const push = await step(tg, () => drainBatch(tg.bot));
      expect(push.screen).toEqual(["sendMessage"]);
      expect(textOf(push.calls[0]!)).toContain(`Order <code>${order.orderCode}</code> was cancelled`);
      expect(textOf(push.calls[0]!)).toContain("The reserved stock has been released.");
      expect((await step(tg, () => drainBatch(tg.bot))).screen).toEqual([]);
      expectOnlyBuyerChat(tg);
    });

    it("a wallet top-up's untracked text bubble is edited with the top-up wording, and its one push uses the top-up text (route 2a)", async () => {
      tokopayMock.createTransaction.mockImplementation(async (_creds: unknown, args: { refId: string; amountIdr: Decimal.Value }) => ({
        trxId: `TP-${args.refId}`, payUrl: null, qrLink: null, qrString: "000201", totalBayar: String(args.amountIdr),
      }));
      const tg = openBot();
      expect((await step(tg, () => tg.sendText("/start"))).screen).toEqual(["sendMessage"]);
      expect((await step(tg, () => tg.pressReply(/Wallet/))).screen).toEqual(["sendMessage", "editMessageReplyMarkup"]);
      expect((await step(tg, () => tg.press(/Top Up/))).screen).toEqual(["editMessageText"]);
      expect((await step(tg, () => tg.press(/IDR/))).screen).toEqual(["editMessageText"]);
      expect((await step(tg, () => tg.sendText("50000"))).screen).toEqual(["deleteMessage", "editMessageText"]);
      expect((await step(tg, () => tg.press(/QRIS/))).screen).toEqual(["editMessageText"]);
      const order = await prisma.order.findFirstOrThrow();
      expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
      // Seam: drop the coordinator row so the order is an anchored, untracked
      // bubble — the shape of orders placed before the coordinator existed,
      // and the only way to reach notifyAutoCancelled's anchor route.
      await prisma.fulfillmentMessage.delete({ where: { orderId: order.id } });
      await backdate(order.id);

      const cancel = await step(tg, () => autoCancelExpiredOrders(tg.bot.api));
      expect(cancel.screen).toEqual(["editMessageText"]);
      expect(Number(cancel.calls[0]!.payload.message_id)).toBe(order.paymentMsgId);
      expect(textOf(cancel.calls[0]!)).toBe(coreT("order.auto_cancelled_topup", EN, { code: order.orderCode }));

      const push = await step(tg, () => drainBatch(tg.bot));
      expect(push.screen).toEqual(["sendMessage"]);
      const pushText = textOf(push.calls[0]!);
      expect(pushText).toContain(order.orderCode);
      expect(pushText).toContain("your balance is credited automatically");
      expect(pushText).not.toContain("stock");
      const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { event: NotificationEvent.ORDER_EXPIRED_DM } });
      expect(JSON.parse(row.payloadJson)).toMatchObject({ is_wallet_topup: true, chat_id: BUYER });
      expect((await step(tg, () => drainBatch(tg.bot))).screen).toEqual([]);
      expectOnlyBuyerChat(tg);
    });
  });
});
