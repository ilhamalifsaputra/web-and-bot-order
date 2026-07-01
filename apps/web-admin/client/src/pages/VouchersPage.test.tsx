import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

const VOUCHER = { id: 1, code: "SAVE10", type: "PERCENT", value: "10", isActive: true, usageLimit: 100, usedCount: 5, minPurchase: "0", expiresAt: null };

// Active, no expiry set within the next 7 days -> should NOT be flagged as expiring soon.
const FAR_FUTURE_VOUCHER = { id: 2, code: "FARAWAY", type: "FIXED", value: "5", isActive: true, usageLimit: null, usedCount: 0, minPurchase: "0", expiresAt: daysFromNow(30) };

// Active, expires in 3 days -> should be flagged as expiring soon.
const EXPIRING_SOON_VOUCHER = { id: 3, code: "SOONISH", type: "PERCENT", value: "15", isActive: true, usageLimit: null, usedCount: 0, minPurchase: "0", expiresAt: daysFromNow(3) };

// Already expired -> must NOT be flagged as expiring soon, even though technically "in the past 7 days".
const EXPIRED_VOUCHER = { id: 4, code: "OLDCODE", type: "PERCENT", value: "20", isActive: true, usageLimit: null, usedCount: 0, minPurchase: "0", expiresAt: daysFromNow(-1) };

// Fully used up, expires in 2 days -> must NOT be flagged as expiring soon (no longer usable).
const USED_UP_VOUCHER = { id: 5, code: "ALLGONE", type: "FIXED", value: "1", isActive: true, usageLimit: 10, usedCount: 10, minPurchase: "0", expiresAt: daysFromNow(2) };

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them. Mock all three to prevent unhandled errors when the
  // dropdown opens and focuses the first option.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

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

  it("copies the voucher code to the clipboard", async () => {
    // `userEvent.setup()` installs its own working clipboard stub on
    // `navigator.clipboard` (jsdom has no real implementation), so we spy on
    // that stub's `writeText` — pre-mocking `navigator.clipboard` ourselves
    // would just get overwritten by user-event's setup.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ vouchers: [VOUCHER], types: ["PERCENT", "FIXED"] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SAVE10")).toBeInTheDocument());

    const copyButton = screen.getByRole("button", { name: /copy code save10/i });
    await user.click(copyButton);

    expect(writeText).toHaveBeenCalledWith("SAVE10");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(await navigator.clipboard.readText()).toBe("SAVE10");

    // Icon swaps to a checkmark confirmation after copying.
    await waitFor(() => expect(copyButton.querySelector("svg.lucide-check")).toBeInTheDocument());
  });

  it("flags a voucher expiring within 7 days, but not an expired, far-future, or used-up one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [FAR_FUTURE_VOUCHER, EXPIRING_SOON_VOUCHER, EXPIRED_VOUCHER, USED_UP_VOUCHER],
          types: ["PERCENT", "FIXED"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("SOONISH")).toBeInTheDocument());

    const rows = screen.getAllByRole("row");
    const rowFor = (code: string) => rows.find(r => within(r).queryByText(code));

    expect(within(rowFor("SOONISH")!).getByText(/expiring soon/i)).toBeInTheDocument();
    expect(within(rowFor("FARAWAY")!).queryByText(/expiring soon/i)).not.toBeInTheDocument();
    expect(within(rowFor("OLDCODE")!).queryByText(/expiring soon/i)).not.toBeInTheDocument();
    expect(within(rowFor("ALLGONE")!).queryByText(/expiring soon/i)).not.toBeInTheDocument();
  });

  it("filters vouchers by status", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          vouchers: [FAR_FUTURE_VOUCHER, EXPIRED_VOUCHER, USED_UP_VOUCHER],
          types: ["PERCENT", "FIXED"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<VouchersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("FARAWAY")).toBeInTheDocument());
    expect(screen.getByText("OLDCODE")).toBeInTheDocument();
    expect(screen.getByText("ALLGONE")).toBeInTheDocument();

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Expired" }));
    await user.click(screen.getByRole("option", { name: "Expired" }));

    expect(screen.getByText("OLDCODE")).toBeInTheDocument();
    expect(screen.queryByText("FARAWAY")).not.toBeInTheDocument();
    expect(screen.queryByText("ALLGONE")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Used up" }));
    await user.click(screen.getByRole("option", { name: "Used up" }));

    expect(screen.getByText("ALLGONE")).toBeInTheDocument();
    expect(screen.queryByText("OLDCODE")).not.toBeInTheDocument();
    expect(screen.queryByText("FARAWAY")).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "Active" }));
    await user.click(screen.getByRole("option", { name: "Active" }));

    expect(screen.getByText("FARAWAY")).toBeInTheDocument();
    expect(screen.queryByText("OLDCODE")).not.toBeInTheDocument();
    expect(screen.queryByText("ALLGONE")).not.toBeInTheDocument();
  });
});
