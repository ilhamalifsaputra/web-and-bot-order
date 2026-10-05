import { describe, expect, it } from "vitest";
import { verificationQueueKb, productsAdminKb } from "../src/keyboards/admin";
import { visualWidth, MAX_LABEL_WIDTH } from "@app/core/buttonLimits";

describe("admin keyboard currency labels", () => {
  it("labels catalog prices as IDR and keeps labels within the shared width budget", () => {
    for (const name of ["A very long product description", "超級禮包".repeat(20), "🎮💎".repeat(20)]) {
      const buttons = productsAdminKb([{ id: 1, name, price: "79000" }], "en").inline_keyboard.flat();
      const label = buttons.find((b) => "callback_data" in b && b.callback_data.includes("edit"))!.text;
      expect(label).toContain("Rp79,000");
      expect(label).not.toContain("USDT");
      expect(visualWidth(label)).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
    }
  });
  it("uses each verification order's stored currency", () => {
    const labels = verificationQueueKb([{ id: 1, orderCode: "ORD-IDR", totalAmount: "79000", currency: "IDR" }, { id: 2, orderCode: "ORD-USDT", totalAmount: "4.94", currency: "USDT" }], "en").inline_keyboard.flat().map((b) => b.text);
    expect(labels[0]).toContain("Rp79,000");
    expect(labels[1]).toContain("4.94 USDT");
  });
});
