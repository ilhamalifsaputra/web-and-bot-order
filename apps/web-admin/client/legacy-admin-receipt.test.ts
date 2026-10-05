/** @vitest-environment jsdom */
import "@testing-library/jest-dom";
import { createElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Decimal } from "@app/core/money";
import { orderMoneyView } from "../src/routes/orderMoneyView";
import { OrderDetailPage } from "./src/pages/OrderDetailPage";
import { apiGet } from "./src/api/client";

vi.mock("./src/api/client", () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
beforeEach(() => vi.stubGlobal("EventSource", class { close() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("final review: legacy admin receipt", () => {
  it.each([
    { discount: "1501.5", wallet: "0", total: "8509" },
    { discount: "0", wallet: "1000.5", total: "9010" },
  ])("renders an additive IDR payment summary for $discount/$wallet legacy fractions", async (example) => {
    const view = orderMoneyView({ currency: "IDR", fxRate: null, subtotalAmount: "10010", bulkDiscountAmount: "0",
      discountAmount: example.discount, walletUsed: example.wallet, uniqueCents: "0", totalAmount: example.total });
    const money = Object.fromEntries(Object.entries(view).map(([key, value]) => [key, value instanceof Decimal ? value.toString() : value]));
    vi.mocked(apiGet).mockResolvedValue({ money, order: { id: 1, orderCode: "OLD-IDR", status: "DELIVERED", currency: "IDR",
      totalAmount: example.total, createdAt: "2026-01-01T00:00:00Z", createdAtDisplay: "2026-01-01 07:00",
      user: { id: 1, fullName: "Buyer", username: "buyer", telegramId: "111" }, items: [], voucher: null, deliveredContent: null },
      hasDeliveredContent: false, isDelivered: true, canAct: false, canCredit: false, canFulfill: false,
      customerDataFields: [], customerData: [], stockReplacements: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(MemoryRouter, { initialEntries: ["/orders/1"] },
      createElement(QueryClientProvider, { client }, createElement(Routes, null,
        createElement(Route, { path: "/orders/:orderId", element: createElement(OrderDetailPage) })))));
    await screen.findByText("Payment");
    const payment = screen.getByText("Items").parentElement!.parentElement!;
    expect(payment).toHaveTextContent("10011 IDR");
    const amount = (label: string) => new Decimal(screen.getByText(label).parentElement!.lastElementChild!.textContent!
      .replace(" IDR", "").replace("\u2212", "-"));
    const sum = amount("Items").plus(example.discount === "0" ? 0 : amount("Discount"))
      .plus(example.wallet === "0" ? 0 : amount("Wallet credit"));
    expect(sum.toString()).toBe(amount("Total").toString());
  });
});
