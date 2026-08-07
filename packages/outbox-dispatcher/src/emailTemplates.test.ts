import { describe, it, expect, vi } from "vitest";

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

import { renderEmail } from "./emailTemplates";

const DISTINCTIVE_ORDER_CODE = "ZZZTESTCODE99";

describe("emailTemplates.renderEmail", () => {
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
      expect(result!.subject).toBe("New paid order"); // documented default (Settings unconfigured)
      expect(result!.text).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.text).toContain("150000.00");
      expect(result!.text).toContain("IDR");
    });

    it("now also returns html containing the order code, total, and item details", async () => {
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result).not.toBeNull();
      expect(result!.html).toBeTypeOf("string");
      expect(result!.html).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.html).toContain("150000.00");
      expect(result!.html).toContain("IDR");
      expect(result!.html).toContain("Netflix Premium");
      expect(result!.html).toContain("Spotify Family");
      expect(result!.html).toContain("TXN-77777");
      expect(result!.html).toContain("SAVE10");
    });

    it("never puts the order code in the subject (regression guard)", async () => {
      const result = await renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result!.subject).not.toContain(DISTINCTIVE_ORDER_CODE);
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
