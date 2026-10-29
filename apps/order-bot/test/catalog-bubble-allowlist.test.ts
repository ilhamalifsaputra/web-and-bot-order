/**
 * The ALLOWLIST that decides whether an obsolete tapped / previous bubble may
 * be deleted (util/chat.ts isCatalogKeyboard): only a keyboard made entirely
 * of catalog callbacks, rendered by the real keyboard builders. A receipt
 * ("Buy again"), a confirmation, a payment / QR screen or any other screen is
 * never a catalog keyboard, so it is only keyboard-retired, never deleted.
 */
import { describe, expect, it } from "vitest";
import { Decimal } from "@app/core/money";
import { isCatalogKeyboard } from "../src/util/chat";
import {
  backKb, backToMain, canonicalDenominationPickerKb, categoryPickerKb, denominationDetailKb, gameListKb, gameRegionPickerKb,
  gameSearchResultsKb, gameVariantPickerKb, groupPickerKb, notificationKb, orderConfirmKb, paymentSuccessKb, popularKb, productListKb,
  qrisWaitingKb, usdtMethodsKb, accountReviewKb, nicknameConfirmKb, walletKb,
} from "../src/keyboards/customer";

const EN = "en";
const denom = { id: 7, name: "86 Diamonds", price: new Decimal(20000), deliveryType: "manual_with_info", autoDeliverySource: null };

describe("isCatalogKeyboard (allowlist for deleting an obsolete bubble)", () => {
  it("accepts every catalog screen keyboard", () => {
    const catalog = {
      groupPicker: groupPickerKb(EN),
      categoryPicker: categoryPickerKb([{ id: 1, name: "Game Top Up", emoji: null }], EN),
      gameList: gameListKb([{ name: "Mobile Legends", index: 0 }], 1, 0, 2, EN, "v1:browse:grps"),
      editionPicker: gameVariantPickerKb([{ label: "Umum", emoji: null }, { label: "Infinite", emoji: null }], 1, "v1:browse:games:1:0", EN, "ged"),
      regionPicker: gameRegionPickerKb(["🇮🇩 Indonesia", "🇲🇾 Malaysia"], 1, "v1:browse:games:1:0", EN, "grg"),
      productList: productListKb([{ id: 3, name: "Free Fire" }], 0, 2, EN, "v1:browse:grps"),
      packPicker: canonicalDenominationPickerKb([[{ text: "86 💎", callback_data: "v1:browse:denom:7" }]], 3, EN, 0, 2),
      detail: denominationDetailKb(denom, 0, EN, 1, 3, 0),
      search: gameSearchResultsKb([{ id: 3, name: "Free Fire", serviceKey: "service.game_topup" }], 0, 2, EN),
      popular: popularKb([{ id: 3, name: "Free Fire" }], EN),
      emptyList: backKb(EN, "v1:browse:grps"),
    };
    for (const [name, keyboard] of Object.entries(catalog)) expect(isCatalogKeyboard(keyboard), name).toBe(true);
  });

  it("refuses receipts, confirmations, payment / QR and other screens — they are never deleted", () => {
    const other = {
      paymentSuccess: paymentSuccessKb(EN),
      notification: notificationKb(EN),
      orderConfirm: orderConfirmKb(7, 1, EN, "", true, true, true, true, true, true, null, null, null, false, "n0nce"),
      usdtMethods: usdtMethodsKb(7, 1, EN, true, true, true, true, "n0nce"),
      qrisWaiting: qrisWaitingKb(42, EN),
      accountReview: accountReviewKb(7, 1, EN),
      nicknameConfirm: nicknameConfirmKb(7, 1, EN),
      wallet: walletKb(EN),
      menuOnly: backToMain(EN),
    };
    for (const [name, keyboard] of Object.entries(other)) expect(isCatalogKeyboard(keyboard), name).toBe(false);
  });

  it("refuses a missing or empty keyboard, a URL button and one foreign callback among catalog ones", () => {
    expect(isCatalogKeyboard(undefined)).toBe(false);
    expect(isCatalogKeyboard({ inline_keyboard: [] })).toBe(false);
    expect(isCatalogKeyboard({ inline_keyboard: [[{ text: "x", url: "https://t.me" }]] })).toBe(false);
    expect(isCatalogKeyboard({ inline_keyboard: [[{ text: "a", callback_data: "v1:browse:prods" }], [{ text: "b", callback_data: "v1:order:list" }]] })).toBe(false);
    expect(isCatalogKeyboard({ inline_keyboard: [[{ text: "a", callback_data: "v1:browse:prods" }], [{ text: "b", callback_data: "v1:payq:1:n" }]] })).toBe(false);
  });
});
