import { describe, it, expect, vi, beforeEach } from "vitest";

// emailTemplates.ts now reads Settings (shop_name, web_logo_url,
// email_brand_color, email_support_address, the four email_order_paid_*
// copy keys) via @app/db's prisma/getSetting for the OWNER_EMAIL_ORDER_PAID
// branch only. Mocked here (rather than spun up against a real test DB, the
// pattern notifications.test.ts/settlePaidOrder.test.ts use) so this stays a
// fast, pure unit-test file for the string-building logic — getSetting
// resolves null for every key by default, exercising the documented
// defaults from the plan's Global Constraints table.
vi.mock("@app/db", () => ({
  prisma: {},
  getSetting: vi.fn().mockResolvedValue(null),
}));

// resolveOwnerBrandConfig's logoUrl resolution (Task 7) joins a relative
// web_logo_url against config.ADMIN_PUBLIC_URL. Mocked (rather than using the
// real config, which reads process.env at import time) so tests can flip
// ADMIN_PUBLIC_URL between set/unset per case without depending on the
// environment this suite happens to run in.
vi.mock("@app/core/config", () => ({
  config: {
    ADMIN_PUBLIC_URL: undefined as string | undefined,
    SHOP_PUBLIC_URL: undefined as string | undefined,
    PUBLIC_URL: undefined as string | undefined,
  },
}));

import { renderEmail } from "./emailTemplates";
import { getSetting } from "@app/db";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";

const DISTINCTIVE_ORDER_CODE = "ZZZTESTCODE99";

describe("emailTemplates.renderEmail", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
    config.ADMIN_PUBLIC_URL = undefined;
    // Reset alongside ADMIN_PUBLIC_URL: the BUYER_EMAIL_ORDER_READY branch
    // resolves its brand against the storefront origin, and one of its cases
    // sets these — without a reset that would leak into later tests.
    config.SHOP_PUBLIC_URL = undefined;
    config.PUBLIC_URL = undefined;
  });
  describe("OWNER_EMAIL_ORDER_PAID", () => {
    it("E28 renders signed bulk, voucher, wallet and marker adjustments in both bodies", async () => {
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", {
        currency: "USDT", subtotal: "2.92", bulk_discount: "0.37", discount: "0.13",
        wallet_credit: "0.5", unique_cents: "0.03", total: "1.95", items: [],
      });
      for (const body of [result!.text, result!.html!]) {
        expect(body).toContain("Bulk Discount");
        expect(body).toContain("-0.37 USDT");
        expect(body).toContain("-0.13 USDT");
        expect(body).toContain("Wallet Credit");
        expect(body).toContain("-0.5 USDT");
        expect(body).toContain("Unique Amount");
        expect(body).toContain("+0.03 USDT");
        expect(body).toContain("1.95 USDT");
      }
    });
    const payload = {
      to: "owner@example.com",
      order_code: DISTINCTIVE_ORDER_CODE,
      total: "150000.00",
      currency: "IDR",
      item_count: 3,
      customer_label: "john@example.com",
      items: [
        { name: "Netflix Premium", variant: "1 Month", quantity: 2, unitPrice: "50000" },
        { name: "Spotify Family", variant: null, quantity: 1, unitPrice: "50000.00" },
      ],
      subtotal: "150000.00",
      discount: "0",
      payment_method: "TOKOPAY",
      transaction_id: "TXN-77777",
      voucher_code: "SAVE10",
      paid_at: "2026-08-07T10:00:00.000Z",
      order_url: "https://admin.example.com/orders/1",
    };

    it("renders a subject and a body (text) with the key facts, same as before this task", async () => {
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result).not.toBeNull();
      // documented default (Settings unconfigured), with {order_code} substituted
      expect(result!.subject).toBe("New Paid Order - " + DISTINCTIVE_ORDER_CODE);
      expect(result!.text).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.text).toContain("Rp150.000");
    });

    it("now also returns html containing the order code, total, and item details", async () => {
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result).not.toBeNull();
      expect(result!.html).toBeTypeOf("string");
      expect(result!.html).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.html).toContain("Rp150.000");
      expect(result!.html).toContain("Netflix Premium");
      expect(result!.html).toContain("Spotify Family");
      expect(result!.html).toContain("TXN-77777");
      expect(result!.html).toContain("SAVE10");
    });

    it("puts the order code in the subject (deliberate exception for this event only)", async () => {
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result!.subject).toContain(DISTINCTIVE_ORDER_CODE);
    });

    it("omits the voucher/transaction-id/View-Order lines when those payload fields are null, without leaking null/undefined", async () => {
      const minimal = { ...payload, transaction_id: null, voucher_code: null, order_url: null };
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", minimal);
      const html = result!.html!;
      expect(html).not.toContain("TXN-77777");
      expect(html).not.toContain("SAVE10");
      expect(html.toLowerCase()).not.toContain("null");
      expect(html.toLowerCase()).not.toContain("undefined");
    });

    it("preserves explicit empty strings in Settings (e.g. shop_name cleared to '') without falling back to defaults", async () => {
      // Mock getSetting to return empty strings for shop_name and email_order_paid_title
      vi.mocked(getSetting).mockImplementation(async (_, key) => {
        if (key === "shop_name") return "";
        if (key === "email_order_paid_title") return "";
        return null; // all others get their defaults
      });

      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result).not.toBeNull();
      // Empty shop_name should pass through, not fall back to "Toko Digital" —
      // this verifies ?? behavior: null/undefined falls back, but explicit ""
      // stays empty
      expect(result!.html).not.toContain("Toko Digital");
      // Empty email_order_paid_title should pass through, not fall back to the
      // default "You've got a new order"
      expect(result!.html).not.toContain("You've got a new order");
    });

    it("falls back to the default subject when email_order_paid_subject is saved as an empty/whitespace string (a blank Subject header is a spam-filter red flag, unlike a blank title/subtitle/message)", async () => {
      vi.mocked(getSetting).mockImplementation(async (_, key) => {
        if (key === "email_order_paid_subject") return "   ";
        return null;
      });

      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result).not.toBeNull();
      expect(result!.subject).toBe("New Paid Order - " + DISTINCTIVE_ORDER_CODE);
    });

    it("formats USDT money with its native precision and currency suffix", async () => {
      const usdtPayload = {
        ...payload,
        currency: "USDT",
        subtotal: "10.5",
        discount: "0",
        total: "10.5",
        items: [{ name: "Netflix Premium", variant: "1 Month", quantity: 1, unitPrice: "5.25" }],
      };
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", usdtPayload);
      expect(result).not.toBeNull();
      expect(result!.html).toContain("10.5 USDT");
      expect(result!.text).toContain("10.5 USDT");
    });

    it("hides the Discount row/line entirely end-to-end when the payload's discount is \"0\"", async () => {
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result).not.toBeNull();
      expect(result!.html).not.toContain("Discount");
      expect(result!.text).not.toContain("Discount");
    });

    describe("resolveOwnerBrandConfig — logo URL", () => {
      it("joins a relative web_logo_url with ADMIN_PUBLIC_URL when configured", async () => {
        vi.mocked(getSetting).mockImplementation(async (_prisma, key) => {
          if (key === "web_logo_url") return "/uploads/branding/logo-abc123.png";
          return null;
        });
        config.ADMIN_PUBLIC_URL = "https://admin.example.com";

        const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
        expect(result!.html).toContain(
          'src="https://admin.example.com/uploads/branding/logo-abc123.png"',
        );
      });

      it("omits the <img> entirely (rather than emitting a guaranteed-broken relative src) when web_logo_url is relative but ADMIN_PUBLIC_URL is unset", async () => {
        vi.mocked(getSetting).mockImplementation(async (_prisma, key) => {
          if (key === "web_logo_url") return "/uploads/branding/logo-abc123.png";
          return null;
        });
        // config.ADMIN_PUBLIC_URL left undefined by beforeEach's reset

        const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
        expect(result!.html).not.toContain("<img");
        expect(result!.html).not.toContain("/uploads/branding/logo-abc123.png");
      });

      it("passes an already-absolute logo URL through unchanged, regardless of ADMIN_PUBLIC_URL", async () => {
        vi.mocked(getSetting).mockImplementation(async (_prisma, key) => {
          if (key === "web_logo_url") return "https://cdn.example.com/logo.png";
          return null;
        });
        config.ADMIN_PUBLIC_URL = "https://admin.example.com";

        const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
        expect(result!.html).toContain('src="https://cdn.example.com/logo.png"');
      });

      it("renders no <img> tag when no logo is configured at all (regression guard — unaffected by this fix)", async () => {
        // getSetting resolves null for every key by this suite's default mock
        const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
        expect(result!.html).not.toContain("<img");
      });

      it("does not produce a doubled slash when ADMIN_PUBLIC_URL has a trailing slash", async () => {
        vi.mocked(getSetting).mockImplementation(async (_prisma, key) => {
          if (key === "web_logo_url") return "/uploads/branding/logo-abc123.png";
          return null;
        });
        config.ADMIN_PUBLIC_URL = "https://admin.example.com/";

        const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
        expect(result!.html).toContain(
          'src="https://admin.example.com/uploads/branding/logo-abc123.png"',
        );
        expect(result!.html).not.toContain("//uploads");
      });
    });

    it("formats USDT money with its native precision and currency suffix", async () => {
      const usdtPayload = {
        ...payload,
        currency: "USDT",
        subtotal: "10.5",
        discount: "0",
        total: "10.5",
        items: [{ name: "Netflix Premium", variant: "1 Month", quantity: 1, unitPrice: "5.25" }],
      };
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", usdtPayload);
      expect(result).not.toBeNull();
      expect(result!.html).toContain("10.5 USDT");
      expect(result!.text).toContain("10.5 USDT");
    });

    it("hides the Discount row/line entirely end-to-end when the payload's discount is \"0\"", async () => {
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result).not.toBeNull();
      expect(result!.html).not.toContain("Discount");
      expect(result!.text).not.toContain("Discount");
    });
  });

  describe("OWNER_EMAIL_MANUAL_ORDER_QUEUED", () => {
    const payload = {
      to: "owner@example.com",
      order_code: DISTINCTIVE_ORDER_CODE,
      items: [
        { name: "Netflix Premium", qty: 2 },
        { name: "Spotify Family", qty: 1 },
      ],
      total: "75000.00",
      currency: "IDR",
    };

    it("renders a fixed subject and a body with order code, items, and total", async () => {
      const result = await renderEmail("OWNER_EMAIL_MANUAL_ORDER_QUEUED", payload);
      expect(result).not.toBeNull();
      expect(result!.subject).toBe("Order queued for manual fulfilment");
      expect(result!.text).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.text).toContain("Netflix Premium");
      expect(result!.text).toContain("x2");
      expect(result!.text).toContain("Spotify Family");
      expect(result!.text).toContain("x1");
      expect(result!.text).toContain("75000.00");
      expect(result!.text).toContain("IDR");
      expect(result!.text.toLowerCase()).toContain("fulfilled by hand");
    });

    it("never puts the order code in the subject (regression guard)", async () => {
      const result = await renderEmail("OWNER_EMAIL_MANUAL_ORDER_QUEUED", payload);
      expect(result!.subject).not.toContain(DISTINCTIVE_ORDER_CODE);
    });

    it("has no html key (regression guard — stays plain text, unlike OWNER_EMAIL_ORDER_PAID)", async () => {
      const result = await renderEmail("OWNER_EMAIL_MANUAL_ORDER_QUEUED", payload);
      expect(result!.html).toBeUndefined();
    });
  });

  describe("OWNER_EMAIL_NEW_TICKET", () => {
    it("renders a fixed subject and a body with ticket id, category, and message", async () => {
      const payload = {
        to: "owner@example.com",
        ticket_id: 42,
        user_id: 7,
        category: "billing",
        message: "My payment did not go through, please help.",
      };
      const result = await renderEmail("OWNER_EMAIL_NEW_TICKET", payload);
      expect(result).not.toBeNull();
      expect(result!.subject).toBe("New support ticket");
      expect(result!.text).toContain("42");
      expect(result!.text).toContain("billing");
      expect(result!.text).toContain("My payment did not go through, please help.");
    });

    it("omits the category line entirely when category is null", async () => {
      const payload = {
        to: "owner@example.com",
        ticket_id: 42,
        user_id: 7,
        category: null,
        message: "General question.",
      };
      const result = await renderEmail("OWNER_EMAIL_NEW_TICKET", payload);
      expect(result).not.toBeNull();
      expect(result!.text.toLowerCase()).not.toContain("category: null");
      expect(result!.text.toLowerCase()).not.toContain("category: undefined");
    });

    it("has no html key (regression guard — stays plain text, unlike OWNER_EMAIL_ORDER_PAID)", async () => {
      const payload = { to: "owner@example.com", ticket_id: 42, user_id: 7, message: "x" };
      const result = await renderEmail("OWNER_EMAIL_NEW_TICKET", payload);
      expect(result!.html).toBeUndefined();
    });
  });

  describe("OWNER_EMAIL_TICKET_REPLY", () => {
    it("renders a fixed subject and a body with ticket id and message", async () => {
      const payload = {
        to: "owner@example.com",
        ticket_id: 99,
        user_id: 7,
        message: "Thanks, that solved it — but I have one more question.",
      };
      const result = await renderEmail("OWNER_EMAIL_TICKET_REPLY", payload);
      expect(result).not.toBeNull();
      expect(result!.subject).toBe("New reply on a support ticket");
      expect(result!.text).toContain("99");
      expect(result!.text).toContain("Thanks, that solved it — but I have one more question.");
    });

    it("has no html key (regression guard — stays plain text, unlike OWNER_EMAIL_ORDER_PAID)", async () => {
      const payload = { to: "owner@example.com", ticket_id: 99, user_id: 7, message: "x" };
      const result = await renderEmail("OWNER_EMAIL_TICKET_REPLY", payload);
      expect(result!.html).toBeUndefined();
    });
  });

  describe("OWNER_EMAIL_WALLET_TOPUP", () => {
    const payload = {
      to: "owner@example.com",
      order_code: DISTINCTIVE_ORDER_CODE,
      customer_label: "jane@example.com",
      amount: "50000",
      currency: "IDR",
      new_balance: "125000",
      payment_method: "TOKOPAY",
      transaction_id: "TXN-77777",
      topped_up_at: "2026-08-14T09:30:00.000Z",
    };

    it("renders a subject, text, and html with the key facts", async () => {
      const result = await renderEmail("OWNER_EMAIL_WALLET_TOPUP", payload);
      expect(result).not.toBeNull();
      expect(result!.subject).toBeTypeOf("string");
      expect(result!.text).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.text).toContain("Rp50.000");
      expect(result!.html).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.html).toContain("Rp50.000");
      expect(result!.html).toContain("Rp125.000");
      expect(result!.html).toContain("jane@example.com");
      expect(result!.html).toContain("TOKOPAY");
      expect(result!.html).toContain("TXN-77777");
    });

    it("subject is a fixed literal — never changes when the payload (order code, amount, customer) changes", async () => {
      const first = await renderEmail("OWNER_EMAIL_WALLET_TOPUP", payload);
      const second = await renderEmail("OWNER_EMAIL_WALLET_TOPUP", {
        ...payload,
        order_code: "SOMETHING-ELSE",
        amount: "999999",
        customer_label: "someone-else@example.com",
      });
      expect(first!.subject).toBe(second!.subject);
      expect(first!.subject).not.toContain(DISTINCTIVE_ORDER_CODE);
      expect(second!.subject).not.toContain("SOMETHING-ELSE");
    });

    it("omits the transaction id line when null, without leaking null/undefined", async () => {
      const minimal = { ...payload, transaction_id: null };
      const result = await renderEmail("OWNER_EMAIL_WALLET_TOPUP", minimal);
      expect(result!.html).not.toContain("TXN-77777");
      expect(result!.html!.toLowerCase()).not.toContain("null");
      expect(result!.html!.toLowerCase()).not.toContain("undefined");
    });

    it("formats a USDT top-up via formatPrice (2dp + currency suffix), not formatIdr", async () => {
      const usdtPayload = { ...payload, currency: "USDT", amount: "10.5", new_balance: "25.75" };
      const result = await renderEmail("OWNER_EMAIL_WALLET_TOPUP", usdtPayload);
      expect(result).not.toBeNull();
      expect(result!.html).toContain("10.50 USDT");
      expect(result!.html).toContain("25.75 USDT");
      expect(result!.text).toContain("10.50 USDT");
      expect(result!.text).toContain("25.75 USDT");
    });
  });

  // The only BUYER-facing branch in this file. Everything above it is
  // addressed to the shop owner; this one lands in a customer's inbox, so its
  // two hard rules — no order code in the subject, no credentials in the body
  // — are asserted as explicit guards rather than assumed.
  describe("BUYER_EMAIL_ORDER_READY", () => {
    const payload = {
      to: "guest@example.com",
      order_code: DISTINCTIVE_ORDER_CODE,
      items: [
        { name: "Netflix Premium", variant: "1 Month", quantity: 2, unitPrice: "50000", lineTotal: "100000" },
        { name: "Spotify", variant: null, quantity: 1, unitPrice: "30000", lineTotal: "30000" },
      ],
      subtotal: "130000",
      discount: "13000",
      unique_cents: "0",
      total: "117000",
      currency: "IDR",
      warranty_days: 30,
      order_url: "https://shop.test/checkout/ZZZTESTCODE99/pay",
      track_url: "https://shop.test/track",
    };

    /** The value the rendered plain-text receipt PRINTS for a summary row —
     * the digits a buyer reads, not the payload we handed the dispatcher. */
    function printedRow(text: string, label: string): string | null {
      const line = text.split("\n").find((l) => l.startsWith(`${label}: `));
      return line ? line.slice(label.length + 2) : null;
    }

    /** "2.34 USDT" / "Rp117.000" -> Decimal. */
    function amountOf(printed: string): Decimal {
      const digits = printed.startsWith("Rp") ? printed.slice(2).replace(/\./g, "") : printed.replace(/[^0-9.-]/g, "");
      return new Decimal(digits);
    }

    it("renders a subject, text, and html with the order summary", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", payload);
      expect(result).not.toBeNull();
      expect(result!.subject).toBeTypeOf("string");
      expect(result!.html).toBeTypeOf("string");
      expect(result!.html).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.html).toContain("Netflix Premium");
      expect(result!.html).toContain("Rp50.000");
      expect(result!.html).toContain("Rp130.000");
      expect(result!.html).toContain("Rp13.000");
      expect(result!.html).toContain("Rp117.000");
      expect(result!.html).toContain("30 days / 30 hari");
      // The unit price alone would misread as the line total for the
      // quantity-2 item — the line spells out both, computed via Decimal.
      expect(result!.html).toContain("2 × Rp50.000 = Rp100.000");
      expect(result!.text).toContain("2 × Rp50.000 = Rp100.000");
      expect(result!.text).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.text).toContain("Rp117.000");
    });

    it("renders the summary labels, banner heading, and button bilingually", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", payload);
      expect(result!.html).toContain("Discount / Diskon");
      expect(result!.html).toContain("Total / Total");
      expect(result!.html).toContain("Warranty / Garansi");
      expect(result!.html).toContain("View Your Order / Lihat Pesanan");
      expect(result!.html).toContain("Your order is ready / Pesanan kamu sudah siap");
    });

    it("subject is a fixed literal that NEVER carries the order code — it is the guest's full credential and sendMail logs every subject", async () => {
      const first = await renderEmail("BUYER_EMAIL_ORDER_READY", payload);
      const second = await renderEmail("BUYER_EMAIL_ORDER_READY", {
        ...payload,
        order_code: "SOMETHING-ELSE",
        total: "999999",
      });
      expect(first!.subject).toBe(second!.subject);
      expect(first!.subject).not.toContain(DISTINCTIVE_ORDER_CODE);
      expect(second!.subject).not.toContain("SOMETHING-ELSE");
    });

    it("keeps the order code out of the inbox-preview preheader too, not just the subject", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", payload);
      // renderShell hides the preheader in a display:none div at the very top
      // of the body; the order code must not be in it, since subject +
      // preheader are exactly what a lock-screen notification shows.
      const preheaderMatch = /<div style="display:none;[^"]*">([\s\S]*?)<\/div>/.exec(result!.html!);
      expect(preheaderMatch).not.toBeNull();
      expect(preheaderMatch![1]).not.toContain(DISTINCTIVE_ORDER_CODE);
    });

    it("carries all three ways back into the order: button, printed code, and the /track link", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", payload);
      expect(result!.html).toContain("https://shop.test/checkout/ZZZTESTCODE99/pay");
      expect(result!.html).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.html).toContain("https://shop.test/track");
      expect(result!.text).toContain("https://shop.test/track");
    });

    it("renders fine with a null order_url — no broken button, code and /track still there", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", { ...payload, order_url: null });
      expect(result).not.toBeNull();
      expect(result!.html).not.toContain('href=""');
      expect(result!.html!.toLowerCase()).not.toContain("undefined");
      expect(result!.html).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.html).toContain("https://shop.test/track");
    });

    it("omits the discount and warranty lines when zero/null, without leaking null", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", {
        ...payload,
        discount: "0",
        warranty_days: null,
      });
      expect(result!.html).not.toContain("Discount");
      expect(result!.html).not.toContain("Warranty");
      expect(result!.html!.toLowerCase()).not.toContain("null");
    });

    it("formats a USDT order via formatMoney (2dp + suffix), not formatIdr", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", {
        ...payload,
        currency: "USDT",
        subtotal: "10.5",
        discount: "0.5",
        total: "10",
        items: [{ name: "Netflix Premium", variant: null, quantity: 1, unitPrice: "10.5", lineTotal: "10.5" }],
      });
      expect(result!.html).toContain("10.50 USDT");
      expect(result!.text).toContain("10.00 USDT");
    });

    // The line total is a CONVERTED figure the enqueue side computed once, in
    // central IDR, before rounding to the nearest 0.1 USDT — it is NOT
    // `unitPrice * quantity` in the display currency, and this branch must not
    // "helpfully" recompute it. 5 x Rp8.900 at an fxRate of 16.000 is the
    // sharpest small case: the per-unit 0.55625 rounds UP to 0.6, so a naive
    // 0.6 x 5 would print a 3.00 USDT line total directly above a Subtotal of
    // 44.500/16.000 = 2.78125 -> 2.80 USDT, contradicting it by 0.2 USDT in a
    // receipt a paying customer reads.
    it("renders the caller's lineTotal verbatim instead of re-deriving it from the already-rounded unit price", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", {
        ...payload,
        currency: "USDT",
        subtotal: "2.8",
        discount: "0",
        total: "2.8",
        items: [{ name: "Netflix Premium", variant: null, quantity: 5, unitPrice: "0.6", lineTotal: "2.8" }],
      });
      expect(result!.html).toContain("5 × 0.60 USDT = 2.80 USDT");
      expect(result!.text).toContain("5 × 0.60 USDT = 2.80 USDT");
      // ...and it agrees with the Subtotal row printed a few lines below it,
      // which is the whole point: this order has one line.
      expect(result!.text).toMatch(/Subtotal \/ Subtotal[^\n]*2\.80 USDT/);
      // The naive product, which would otherwise sit visibly above it.
      expect(result!.html).not.toContain("3.00 USDT");
      expect(result!.text).not.toContain("3.00 USDT");
    });

    // Backward compatibility for outbox rows enqueued before `lineTotal`
    // joined the payload: those rows are already PENDING when the new code
    // deploys and must still render a line total rather than a blank or a
    // zero. The fallback multiplies via Decimal, never float.
    it("falls back to quantity x unitPrice (via Decimal, not float) for a pre-existing row whose payload has no lineTotal", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", {
        ...payload,
        currency: "USDT",
        items: [{ name: "Netflix Premium", variant: null, quantity: 3, unitPrice: "0.1" }],
      });
      // 0.1 * 3 as a naive float is 0.30000000000000004 — Decimal must give
      // exactly 0.30.
      expect(result!.html).toContain("3 × 0.10 USDT = 0.30 USDT");
    });

    // The receipt a paying customer reads has to RECONCILE. On a USDT order
    // `finalizeOrderPayment` folds 0.002-0.098 USDT of deterministic
    // "unique cents" into totalAmount so the payment poller can match the
    // transfer by amount — a real component of what the buyer paid, and one
    // no line of this receipt used to print. Rp45.000 with a 20% voucher at
    // an fxRate of 16.000 is the enqueue side's worked example: subtotal
    // 2.8, discount 0.5, unique code 0.042, total 2.342.
    const usdtPayload = {
      ...payload,
      currency: "USDT",
      items: [{ name: "Netflix Premium", variant: "1 Month", quantity: 1, unitPrice: "2.8", lineTotal: "2.8" }],
      subtotal: "2.8",
      discount: "0.5",
      unique_cents: "0.042",
      total: "2.342",
    };

    it("prints the unique code as its own bilingually labelled row on a USDT order", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", usdtPayload);
      expect(result!.html).toContain("Unique code / Kode unik");
      expect(result!.text).toContain("Unique code / Kode unik");
      expect(printedRow(result!.text, "Unique code / Kode unik")).toBe("0.04 USDT");
    });

    it("prints a USDT summary that reconciles: Subtotal - Discount + Unique code = Total, on the digits themselves", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", usdtPayload);
      const subtotal = amountOf(printedRow(result!.text, "Subtotal / Subtotal")!);
      const discount = amountOf(printedRow(result!.text, "Discount / Diskon")!);
      const unique = amountOf(printedRow(result!.text, "Unique code / Kode unik")!);
      const total = amountOf(printedRow(result!.text, "Total / Total")!);
      expect(subtotal.minus(discount).plus(unique).toString()).toBe(total.toString());
      // And concretely, so a regression can't quietly redefine "reconciles":
      expect(printedRow(result!.text, "Subtotal / Subtotal")).toBe("2.80 USDT");
      expect(printedRow(result!.text, "Discount / Diskon")).toBe("0.50 USDT");
      expect(printedRow(result!.text, "Total / Total")).toBe("2.34 USDT");
    });

    // Buckets 1 and 2 of computeUniqueCents (0.002 and 0.004) round to
    // nothing at the 2dp this receipt prints. A "0.00 USDT" row reads as a
    // bug, and hiding it keeps the arithmetic true rather than breaking it:
    // a row worth exactly zero at display precision contributes exactly zero
    // to the printed total.
    it("hides the unique-code row when it would round to zero at the printed precision, and the summary still adds up", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", {
        ...usdtPayload,
        unique_cents: "0.002",
        total: "2.302",
      });
      expect(result!.html).not.toContain("Unique code");
      expect(result!.html).not.toContain("Kode unik");
      expect(result!.text).not.toContain("Unique code");
      const subtotal = amountOf(printedRow(result!.text, "Subtotal / Subtotal")!);
      const discount = amountOf(printedRow(result!.text, "Discount / Diskon")!);
      const total = amountOf(printedRow(result!.text, "Total / Total")!);
      expect(subtotal.minus(discount).toString()).toBe(total.toString());
    });

    it("hides the unique-code row on an IDR order, whose unique cents are zero — and that summary adds up too", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", payload);
      expect(result!.html).not.toContain("Unique code");
      expect(result!.html).not.toContain("Kode unik");
      expect(result!.text).not.toContain("Unique code");
      const subtotal = amountOf(printedRow(result!.text, "Subtotal / Subtotal")!);
      const discount = amountOf(printedRow(result!.text, "Discount / Diskon")!);
      const total = amountOf(printedRow(result!.text, "Total / Total")!);
      expect(subtotal.minus(discount).toString()).toBe(total.toString());
    });

    // Rows enqueued before `unique_cents` joined the payload are already
    // PENDING when this code deploys; they must render exactly as they did
    // before rather than showing a row or a stray "NaN"/"null".
    it("renders a pre-existing row whose payload has no unique_cents at all, with no unique-code row", async () => {
      const { unique_cents: _omitted, ...legacy } = payload;
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", legacy);
      expect(result).not.toBeNull();
      expect(result!.html).not.toContain("Unique code");
      expect(result!.html).not.toContain("NaN");
      expect(result!.text).not.toContain("NaN");
      expect(result!.html).toContain("Rp117.000");
    });

    it("resolves the buyer's brand logo against the STOREFRONT origin, never the admin panel's", async () => {
      // The reader is a customer. A logo joined against ADMIN_PUBLIC_URL
      // would both break (the admin origin is often private) and advertise
      // the admin panel's hostname to the public.
      config.ADMIN_PUBLIC_URL = "https://admin.internal.test";
      config.SHOP_PUBLIC_URL = "https://shop.test";
      vi.mocked(getSetting).mockImplementation(async (_prisma, key) => {
        if (key === "web_logo_url") return "/uploads/logo.png";
        return null;
      });
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", payload);
      expect(result!.html).toContain("https://shop.test/uploads/logo.png");
      expect(result!.html).not.toContain("admin.internal.test");
    });

    it("never puts anything credential-shaped in the body — the payload has no such field and the render invents none", async () => {
      const result = await renderEmail("BUYER_EMAIL_ORDER_READY", payload);
      expect(result!.html).not.toContain("deliveredContent");
      expect(result!.html).not.toContain("credentials");
      expect(result!.text).not.toContain("deliveredContent");
      expect(result!.text).not.toContain("credentials");
      // And it says so to the reader, so nobody expects the goods by mail.
      expect(result!.text).toContain("never sent by email");
    });
  });

  it("returns null for an unknown event", async () => {
    expect(await renderEmail("NOT_A_REAL_EVENT", {})).toBeNull();
  });

  it("returns null for a Telegram-channel event handled by templates.ts instead", async () => {
    expect(await renderEmail("ORDER_DELIVERED", {})).toBeNull();
  });
});
