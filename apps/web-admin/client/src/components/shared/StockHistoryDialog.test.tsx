import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StockHistoryDialog } from "./StockHistoryDialog";

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <StockHistoryDialog stockItemId={7} onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("StockHistoryDialog", () => {
  it("shows a loading state, then requests the item's history", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(new Promise(() => {}));
    renderDialog();
    expect(screen.getByText("Loading history…")).toBeInTheDocument();
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("/api/stock/item/7/history");
  });

  it("shows an honest empty state when nothing is recorded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ events: [] }));
    renderDialog();
    await waitFor(() => expect(screen.getByText("No recorded history yet.")).toBeInTheDocument());
  });

  it("renders events in the given order with actor, reason and an order link", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        events: [
          { id: 1, eventType: "IMPORTED", fromStatus: null, toStatus: "AVAILABLE", reasonCode: null, actorType: "ADMIN", actorName: "Budi", orderId: null, orderCode: null, occurredAtDisplay: "2026-01-01 08:00" },
          { id: 2, eventType: "MARKED_DEAD", fromStatus: "AVAILABLE", toStatus: "DEAD", reasonCode: "EXPIRED", actorType: "SYSTEM", actorName: null, orderId: 5, orderCode: "ORD-5", occurredAtDisplay: "2026-01-02 09:00" },
        ],
      }),
    );
    renderDialog();
    await waitFor(() => expect(screen.getByText("Imported")).toBeInTheDocument());
    expect(screen.getByText(/Budi/)).toBeInTheDocument();
    expect(screen.getByText("Marked dead")).toBeInTheDocument();
    expect(screen.getByText(/System · Expired/)).toBeInTheDocument();
    expect(screen.getByText("AVAILABLE → DEAD")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ORD-5" })).toHaveAttribute("href", "/orders/5");
    const labels = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(labels[0]).toContain("Imported");
    expect(labels[1]).toContain("Marked dead");
  });
});
