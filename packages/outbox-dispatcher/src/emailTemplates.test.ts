import { describe, it, expect } from "vitest";
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
    };

    it("renders a fixed subject and a body with the key facts", () => {
      const result = renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result).not.toBeNull();
      expect(result!.subject).toBe("New paid order");
      expect(result!.text).toContain(DISTINCTIVE_ORDER_CODE);
      expect(result!.text).toContain("3");
      expect(result!.text).toContain("150000.00");
      expect(result!.text).toContain("IDR");
    });

    it("never puts the order code in the subject (regression guard)", () => {
      const result = renderEmail("OWNER_EMAIL_ORDER_PAID", payload);
      expect(result!.subject).not.toContain(DISTINCTIVE_ORDER_CODE);
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

    it("renders a fixed subject and a body with order code, items, and total", () => {
      const result = renderEmail("OWNER_EMAIL_MANUAL_ORDER_QUEUED", payload);
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

    it("never puts the order code in the subject (regression guard)", () => {
      const result = renderEmail("OWNER_EMAIL_MANUAL_ORDER_QUEUED", payload);
      expect(result!.subject).not.toContain(DISTINCTIVE_ORDER_CODE);
    });
  });

  describe("OWNER_EMAIL_NEW_TICKET", () => {
    it("renders a fixed subject and a body with ticket id, category, and message", () => {
      const payload = {
        to: "owner@example.com",
        ticket_id: 42,
        user_id: 7,
        category: "billing",
        message: "My payment did not go through, please help.",
      };
      const result = renderEmail("OWNER_EMAIL_NEW_TICKET", payload);
      expect(result).not.toBeNull();
      expect(result!.subject).toBe("New support ticket");
      expect(result!.text).toContain("42");
      expect(result!.text).toContain("billing");
      expect(result!.text).toContain("My payment did not go through, please help.");
    });

    it("omits the category line entirely when category is null", () => {
      const payload = {
        to: "owner@example.com",
        ticket_id: 42,
        user_id: 7,
        category: null,
        message: "General question.",
      };
      const result = renderEmail("OWNER_EMAIL_NEW_TICKET", payload);
      expect(result).not.toBeNull();
      expect(result!.text.toLowerCase()).not.toContain("category: null");
      expect(result!.text.toLowerCase()).not.toContain("category: undefined");
    });
  });

  describe("OWNER_EMAIL_TICKET_REPLY", () => {
    it("renders a fixed subject and a body with ticket id and message", () => {
      const payload = {
        to: "owner@example.com",
        ticket_id: 99,
        user_id: 7,
        message: "Thanks, that solved it — but I have one more question.",
      };
      const result = renderEmail("OWNER_EMAIL_TICKET_REPLY", payload);
      expect(result).not.toBeNull();
      expect(result!.subject).toBe("New reply on a support ticket");
      expect(result!.text).toContain("99");
      expect(result!.text).toContain("Thanks, that solved it — but I have one more question.");
    });
  });

  it("returns null for an unknown event", () => {
    expect(renderEmail("NOT_A_REAL_EVENT", {})).toBeNull();
  });

  it("returns null for a Telegram-channel event handled by templates.ts instead", () => {
    expect(renderEmail("ORDER_DELIVERED", {})).toBeNull();
  });
});
