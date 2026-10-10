import { describe, expect, it } from "vitest";
import en from "../../../../../packages/core/locales/en.json";
import id from "../../../../../packages/core/locales/id.json";

describe.each([
  { lang: "en", copy: en, game: "Game top-ups", app: "App products", hash: "password hashes made with bcrypt" },
  { lang: "id", copy: id, game: "Top up game", app: "Produk aplikasi", hash: "hash kata sandi menggunakan bcrypt" },
])("digital commerce copy ($lang)", ({ copy, game, app, hash }) => {
  it("explains both fulfillment families without selling unlisted categories", () => {
    expect(copy["web.about_p2"]).toContain(game);
    expect(copy["web.terms_p7"]).toContain(game);
    expect(copy["web.terms_p7"]).toContain(app);
    expect(copy["web.about_p1"]).not.toMatch(/gift cards|software licenses|vouchers|voucher/i);
    expect(copy["web.how_s4"]).not.toMatch(/credential|kredensial/i);
  });
  it("does not claim Xendit or card acceptance before integration and activation", () => {
    expect(copy["web.terms_p6"]).not.toMatch(/Xendit|Visa|Mastercard|JCB/);
    expect(copy["web.privacy_p4"]).not.toContain("Xendit");
    expect(copy["web.privacy_p5"]).not.toContain("Xendit");
    expect(copy["web.faq_a3"]).toMatch(/checkout/);
    // Keep conditional USDT guidance; do not conceal an existing payment family.
    expect(copy["web.hto_p4"]).toContain("USDT");
  });
  it("describes hashing and delivery data sharing without a false notification guarantee", () => {
    expect(copy["web.privacy_p2"]).toContain(hash);
    expect(copy["web.privacy_p4"]).toContain("Telegram");
    expect(copy["web.privacy_p6"]).toContain("Telegram");
  });
});
