import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WalletTransactionsPage } from "./WalletTransactionsPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const REASONS = ["admin_adjust", "underpaid_refund", "referral", "order_payment", "order_refund", "adjust", "wallet_topup"];

const TOPUP = {
  id: 11,
  userId: 7,
  customerLabel: "buyer",
  delta: "150000",
  balanceAfter: "150000",
  currency: "IDR",
  reason: "wallet_topup",
  note: "TokoPay top-up",
  adminId: null,
  orderId: 42,
  createdAt: "2026-06-26T10:00:00.000Z",
  createdAtDisplay: "2026-06-26 17:00",
  user: { id: 7, username: "buyer", fullName: "Buyer", telegramId: "42" },
};
const SPEND = {
  ...TOPUP,
  id: 10,
  delta: "-20000",
  balanceAfter: "130000",
  reason: "order_payment",
  orderId: null,
  note: "",
};

function mockFetch(payload: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("WalletTransactionsPage", () => {
  it("shows each movement's customer, reason, signed amount and resulting balance", async () => {
    mockFetch({ rows: [TOPUP, SPEND], total: 2, page: 1, pageSize: 50, hasNext: false, reasons: REASONS });
    render(<WalletTransactionsPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("Wallet top-up")).toBeInTheDocument());
    expect(screen.getAllByText("buyer").length).toBeGreaterThan(0);
    expect(screen.getByText("Order payment")).toBeInTheDocument();
    // Credits are signed so a top-up reads as money arriving, debits as money leaving.
    expect(screen.getByText("+Rp150.000")).toBeInTheDocument();
    expect(screen.getByText("-Rp20.000")).toBeInTheDocument();
    expect(screen.getByText("Rp130.000")).toBeInTheDocument(); // balance after the debit
    expect(screen.getAllByText("2026-06-26 17:00")).toHaveLength(2); // createdAtDisplay, one per row
  });

  it("links a movement to its order when it has one, and shows a dash when it does not", async () => {
    mockFetch({ rows: [TOPUP, SPEND], total: 2, page: 1, pageSize: 50, hasNext: false, reasons: REASONS });
    render(<WalletTransactionsPage />, { wrapper: Wrapper });

    const link = await screen.findByRole("link", { name: /#42/ });
    expect(link).toHaveAttribute("href", "/orders/42");
    expect(screen.queryByRole("link", { name: /#null/ })).not.toBeInTheDocument();
  });

  it("re-queries with the chosen reason and returns to page 1", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetch({ rows: [], total: 0, page: 1, pageSize: 50, hasNext: false, reasons: REASONS });
    render(<WalletTransactionsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no wallet movements/i)).toBeInTheDocument());

    await user.click(screen.getByRole("combobox", { name: /reason/i }));
    await user.click(await screen.findByRole("option", { name: "Wallet top-up" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("reason=wallet_topup"), expect.anything()));
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining("page=2"), expect.anything());
  });

  it("shows an empty state when there are no movements", async () => {
    mockFetch({ rows: [], total: 0, page: 1, pageSize: 50, hasNext: false, reasons: REASONS });
    render(<WalletTransactionsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no wallet movements/i)).toBeInTheDocument());
  });

  it("shows an error message when the request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    render(<WalletTransactionsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load wallet transactions/i)).toBeInTheDocument());
  });
});
