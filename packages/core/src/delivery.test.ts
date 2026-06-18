import { describe, it, expect } from "vitest";
import {
  buildAccountFileContent,
  buildDeliveryCaption,
  warrantyDaysFor,
  accountFileName,
  type DeliveredItem,
} from "./delivery";

const item = (productId: number, name: string, creds: string | null, warranty = 30): DeliveredItem => ({
  productId,
  product: { name },
  stockItem: creds == null ? null : { credentials: creds },
  warrantyDaysSnapshot: warranty,
});

describe("buildAccountFileContent", () => {
  it("groups credentials per product, one per line, with no HTML", () => {
    const items = [
      item(1, "Netflix Premium", "user1:pass1"),
      item(1, "Netflix Premium", "user2:pass2"),
      item(2, "Spotify", "user3:pass3"),
    ];
    const out = buildAccountFileContent({ orderCode: "ORD-1", warrantyDays: 30, items }, "id");

    expect(out).toContain("ORD-1");
    expect(out).toContain("user1:pass1\nuser2:pass2");
    expect(out).toContain("user3:pass3");
    // Both products present, grouped.
    expect(out).toContain("Netflix Premium");
    expect(out).toContain("Spotify");
    // Plain text file — never HTML tags.
    expect(out).not.toMatch(/<[a-z]+>/i);
  });

  it("skips items without an allocated stock credential", () => {
    const items = [item(1, "Netflix", "ok:1"), item(2, "Disney", null)];
    const out = buildAccountFileContent({ orderCode: "ORD-2", warrantyDays: 30, items }, "en");
    expect(out).toContain("ok:1");
    expect(out).not.toContain("Disney");
  });
});

describe("warrantyDaysFor", () => {
  it("returns the longest snapshot but never below 30", () => {
    expect(warrantyDaysFor([{ warrantyDaysSnapshot: 7 }, { warrantyDaysSnapshot: 90 }])).toBe(90);
    expect(warrantyDaysFor([{ warrantyDaysSnapshot: 7 }])).toBe(30);
    expect(warrantyDaysFor([])).toBe(30);
  });
});

describe("buildDeliveryCaption", () => {
  it("includes the order code and warranty, in HTML", () => {
    const cap = buildDeliveryCaption("ORD-9", 30, "id");
    expect(cap).toContain("ORD-9");
    expect(cap).toContain("30");
    expect(cap).toMatch(/<b>/);
  });
});

describe("accountFileName", () => {
  it("is the order code with a .txt extension", () => {
    expect(accountFileName("ORD-20260619-AB12")).toBe("ORD-20260619-AB12.txt");
  });
});
