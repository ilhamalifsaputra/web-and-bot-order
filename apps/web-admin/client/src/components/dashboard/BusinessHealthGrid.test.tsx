import "@testing-library/jest-dom";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BusinessHealthGrid } from "./BusinessHealthGrid";

function renderWith(health: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => health })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BusinessHealthGrid />
    </QueryClientProvider>,
  );
}

describe("BusinessHealthGrid", () => {
  it("labels each service and renders an honest 'Unmonitored' state, not a fake green", async () => {
    renderWith({ telegramBot: "green", binance: "red", bybit: "unmonitored", tokopay: "unmonitored", paydisini: "unmonitored", nowpayments: "unmonitored" });
    await waitFor(() => expect(screen.getByText("Telegram Bot")).toBeInTheDocument());
    expect(screen.getByText("Binance")).toBeInTheDocument();
    // Bybit row shows the literal Unmonitored label, with an idle (gray) dot.
    const bybitRow = screen.getByText("Bybit").closest("li")!;
    expect(bybitRow.textContent).toMatch(/Unmonitored/);
    expect(bybitRow.querySelector(".bg-ink-faint")).not.toBeNull();
  });
});
