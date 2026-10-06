import { describe, expect, it } from "vitest";
import { Decimal } from "@app/core/money";
import { priceIdr } from "../src/util/format";

describe("order item USD price hint", () => {
  it("keeps two decimals and the requested language separators", () => {
    expect(priceIdr("40000", new Decimal("16000"), "en")).toBe("Rp40,000 (≈ $2.50)");
    expect(priceIdr("40000", new Decimal("16000"), "id")).toBe("Rp40.000 (≈ $2,50)");
    expect(priceIdr("40000", new Decimal("16000"), "id", "en")).toBe("Rp40.000 (≈ $2.50)");
  });
});
