import { describe, it, expect } from "vitest";
import { money, fmtMoney, moneyEq, Decimal } from "./money";
import { t } from "./i18n";
import { fetchUsdIdrMarketRate, roundRateToStep } from "./fx";
import { OrderStatus, UserRole, NotificationEvent, langCode } from "./enums";

describe("money", () => {
  it("quantizes to 4 dp", () => {
    expect(fmtMoney(money("5.00071"))).toBe("5.0007");
    expect(fmtMoney(money("5.00075"))).toBe("5.0008"); // round half up
  });
  it("keeps Decimal precision (no float)", () => {
    expect(money("0.1").plus(money("0.2")).equals(new Decimal("0.3"))).toBe(true);
  });
  it("moneyEq compares quantized", () => {
    expect(moneyEq("1.00000", "1")).toBe(true);
  });
  it("null renders em dash", () => {
    expect(fmtMoney(null)).toBe("—");
  });
});

describe("enums match stored DB names (uppercase)", () => {
  it("uses SQLAlchemy member names", () => {
    expect(OrderStatus.DELIVERED).toBe("DELIVERED");
    expect(UserRole.ADMIN).toBe("ADMIN");
    expect(NotificationEvent.ORDER_DELIVERED).toBe("ORDER_DELIVERED");
  });
  it("langCode maps stored language to locale", () => {
    expect(langCode("EN")).toBe("en");
    expect(langCode("ID")).toBe("id");
    expect(langCode(null)).toBe("en");
  });
});

describe("i18n", () => {
  it("falls back to key when missing", () => {
    expect(t("nonexistent.key.xyz", "en")).toBe("nonexistent.key.xyz");
  });
  it("accepts uppercase stored language (lowercased internally)", () => {
    expect(t("start.welcome", "EN")).toBe(t("start.welcome", "en"));
  });
  it("substitutes placeholders", () => {
    expect(t("start.welcome", "en", { name: "Bob" })).toContain("Bob");
  });
});

describe("fx (market USDT rate + rounding)", () => {
  it("rounds to the nearest step (half-up)", () => {
    expect(roundRateToStep(new Decimal("16243.7"), 100).toString()).toBe("16200");
    expect(roundRateToStep(new Decimal("16250"), 100).toString()).toBe("16300");
    expect(roundRateToStep(new Decimal("16249.99"), 100).toString()).toBe("16200");
    expect(roundRateToStep(new Decimal("16243.7"), 500).toString()).toBe("16000");
    expect(roundRateToStep(new Decimal("16251"), 500).toString()).toBe("16500");
  });
  it("invalid/zero step returns the rate unrounded", () => {
    expect(roundRateToStep(new Decimal("16243.7"), 0).toString()).toBe("16243.7");
    expect(roundRateToStep(new Decimal("16243.7"), "abc").toString()).toBe("16243.7");
  });
  it("parses the er-api payload", async () => {
    const fake = (async () => ({
      ok: true,
      json: async () => ({ result: "success", rates: { IDR: 16234.55 } }),
    })) as unknown as typeof fetch;
    expect((await fetchUsdIdrMarketRate(fake)).toString()).toBe("16234.55");
  });
  it("rejects bad payloads and HTTP errors", async () => {
    const bad = (async () => ({ ok: true, json: async () => ({ result: "success", rates: {} }) })) as unknown as typeof fetch;
    await expect(fetchUsdIdrMarketRate(bad)).rejects.toThrow();
    const http500 = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(fetchUsdIdrMarketRate(http500)).rejects.toThrow();
  });
});
