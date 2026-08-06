/**
 * Locale integrity guard (WEB.md / feedback §8.8). The bot UI is the customer's
 * whole experience — a key present in one language but not the other means a
 * raw key or a fallback leaks to the user. This test fails the moment en/id
 * drift apart, in keys OR in their `{placeholder}` sets.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");
const load = (lang: string): Record<string, string> =>
  JSON.parse(readFileSync(join(LOCALES_DIR, `${lang}.json`), "utf8"));

const placeholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("locale parity (en ↔ id)", () => {
  const en = load("en");
  const id = load("id");

  it("both languages define exactly the same keys", () => {
    const enKeys = Object.keys(en).sort();
    const idKeys = Object.keys(id).sort();
    const missingInId = enKeys.filter((k) => !(k in id));
    const missingInEn = idKeys.filter((k) => !(k in en));
    expect({ missingInId, missingInEn }).toEqual({ missingInId: [], missingInEn: [] });
  });

  it("each key has the same {placeholder} set in both languages", () => {
    const mismatches: Record<string, { en: string[]; id: string[] }> = {};
    for (const key of Object.keys(en)) {
      if (!(key in id)) continue;
      const a = placeholders(en[key]!);
      const b = placeholders(id[key]!);
      if (JSON.stringify(a) !== JSON.stringify(b)) mismatches[key] = { en: a, id: b };
    }
    expect(mismatches).toEqual({});
  });
});

/**
 * Guest checkout DOES email the order code now — but only where the shop has
 * SMTP configured, which is per-deployment (`getSmtpCreds` → null turns the
 * feature off silently), and only when the send actually succeeds.
 *
 * So no string that is written BEFORE the answer is known may promise an
 * inbox. Every key below is exactly that: checkout-time and recovery-time copy
 * rendered while `email_sent` is still unknowable. Copy that points such a
 * shopper at an inbox that may never receive anything strands them — the order
 * code is otherwise on one screen only, and without it `POST /api/v1/track`
 * cannot let them back in, so "check your confirmation email" is not a small
 * inaccuracy but the difference between recovering an order and being locked
 * out of a paid one forever.
 *
 * The one place the shop may say it sent an email is the pay page, off the
 * server's `email_sent: true` (`web.pay_code_emailed`) — a statement of fact
 * about a send that already happened, which is why that key is not listed here.
 *
 * The property is pinned, not the wording: rewrite these strings freely, just
 * never let one of them promise mail on a deployment that sends none.
 */
describe("guest-facing copy never promises an email the shop may not send", () => {
  const GUEST_KEYS = [
    "web.guest_email_invalid",
    "web.guest_contact_title",
    "web.guest_email_label",
    "web.guest_email_hint",
    "web.guest_account_note",
    "web.track_title",
    "web.track_intro",
    "web.track_not_found_title",
    "web.track_not_found",
    "web.track_link",
  ];

  /** EN and ID phrasings of "something will arrive in your inbox". */
  const INBOX_PROMISES: RegExp[] = [
    /confirmation e-?mail/i,
    /email konfirmasi/i,
    /\bwe(?:'ll| will)? (?:send|e-?mail|mail)\b/i,
    /\bsent to (?:your |this )?(?:e-?mail|inbox|address)/i,
    /\bcheck your (?:e-?mail|inbox)/i,
    /\b(?:go|goes|arrive|arrives|land|lands) (?:here|there)\b/i,
    /kami kirim/i,
    /dikirim(?:kan)? ke (?:email|inbox)/i,
    /cek (?:email|inbox)/i,
  ];

  for (const [lang, strings] of [
    ["en", load("en")],
    ["id", load("id")],
  ] as const) {
    it(`${lang}: no guest-facing string tells the shopper to look in an inbox`, () => {
      const offenders: Record<string, string> = {};
      for (const key of GUEST_KEYS) {
        const value = strings[key];
        expect(value, `${lang} is missing ${key}`).toBeTypeOf("string");
        const hit = INBOX_PROMISES.find((re) => re.test(value!));
        if (hit) offenders[key] = `matched ${hit} in: ${value}`;
      }
      expect(offenders).toEqual({});
    });
  }
});
