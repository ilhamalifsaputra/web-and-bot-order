import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VouchersPage } from "./VouchersPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const VOUCHER = { id: 1, code: "SAVE10", type: "PERCENT", value: "10", isActive: true, usageLimit: 100, usedCount: 5, minPurchase: "0", expiresAt: null };

beforeEach(() => { vi.restoreAllMocks(); });

describe("VouchersPage", () => {
  it("renders voucher rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [VOUCHER], types: ["PERCENT", "FIXED"] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());
    expect(screen.getByText("PERCENT")).toBeInTheDocument();
  });

  it("shows empty state when no vouchers", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [], types: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no vouchers/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
