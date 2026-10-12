import { describe, expect, it } from "vitest";
import en from "../../../../../packages/core/locales/en.json";
import id from "../../../../../packages/core/locales/id.json";

describe.each([
  { lang: "en", copy: en },
  { lang: "id", copy: id },
])("digital commerce copy ($lang)", ({ copy }) => {
  it("keeps public information universal without promoting a product family or access details", () => {
    const publicKey = /^web\.(?:brand_|home_meta_|hero_|features_|feat_|how_|promise_|trust_|stat_|testi_|contact_|footer_|static_help_|about_|hto_|terms_|privacy_|refund_|faq_)/;
    const publicEntries = Object.entries(copy).filter(([key]) => publicKey.test(key) || ["start.welcome", "faq.content", "terms.content"].includes(key));
    expect(publicEntries.length).toBeGreaterThan(100);
    for (const [key, value] of publicEntries) {
      expect(value, key).not.toMatch(/akun|\baccounts?\b|e-?mail|password|kata\s+sandi|credential|kredensial|\blogin\b|premium\s+apps?|app\s+products?|produk\s+aplikasi|game\s+top[ -]?ups?|top\s+up\s+game/i);
    }
    expect(copy["web.about_p1"]).not.toMatch(/gift cards|software licenses|vouchers|voucher/i);
    expect(copy["web.how_s4"]).not.toMatch(/credential|kredensial/i);
  });
  it("preserves product categories and clear required authentication fields", () => {
    expect(copy["browse.group_premium_apps"]).toMatch(/Premium Apps|Aplikasi Premium/);
    expect(copy["browse.group_game_topup"]).toMatch(/Game Top Up|Top Up Game/);
    expect(copy["web.login_identifier"]).toMatch(/email/);
    expect(copy["web.login_password"]).toMatch(/Password|Kata sandi/);
    expect(copy["web.guest_email_label"]).toMatch(/email/i);
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
    expect(copy["web.privacy_p2"]).toContain("bcrypt");
    expect(copy["web.privacy_p4"]).toContain("Telegram");
    expect(copy["web.privacy_p6"]).toContain("Telegram");
  });
});
