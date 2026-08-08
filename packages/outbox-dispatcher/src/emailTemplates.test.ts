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

const DISTINCTIVE_ORDER_CODE = "ZZZTESTCODE99";

describe("emailTemplates.renderEmail", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockResolvedValue(null);
    config.ADMIN_PUBLIC_URL = undefined;
  });
  describe("OWNER_EMAIL_ORDER_PAID", () => {
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

    it("formats non-IDR money via formatPrice (2dp + currency suffix), not formatIdr", async () => {
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
      expect(result!.html).toContain("10.50 USDT");
      expect(result!.text).toContain("10.50 USDT");
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

  it("returns null for an unknown event", async () => {
    expect(await renderEmail("NOT_A_REAL_EVENT", {})).toBeNull();
  });

  it("returns null for a Telegram-channel event handled by templates.ts instead", async () => {
    expect(await renderEmail("ORDER_DELIVERED", {})).toBeNull();
  });
});
