import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserDetailPage } from "./UserDetailPage";
import { apiPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/users/7"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/users/:userId" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const USER_DETAIL = {
  user: { id: 7, username: "andi", fullName: "Andi Santoso", telegramId: "111", role: "CUSTOMER", banned: false, banReason: null, walletBalance: "500000", walletBalanceUsdt: "12.5" },
  totalSpent: { idr: "150000", usdt: "0" },
  orders: [],
  tickets: [],
  ledger: [],
  roles: ["CUSTOMER", "RESELLER"],
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiPost).mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("UserDetailPage — role change", () => {
  it("renders the current role in an editable Select instead of a static badge", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("changes the role via POST /api/users/:userId/role", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "RESELLER" }));
    await user.click(screen.getByRole("option", { name: "RESELLER" }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/users/7/role", { role: "RESELLER" }));
  });

  it("shows a static badge (no Select) for an ADMIN user — admin status is managed elsewhere", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...USER_DETAIL, user: { ...USER_DETAIL.user, role: "ADMIN" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("ADMIN")).toBeInTheDocument();
  });

  it("alerts on a failed role change", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("Invalid role."));
    const alertSpy = vi.spyOn(globalThis, "alert").mockImplementation(() => {});
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox"));
    await waitFor(() => screen.getByRole("option", { name: "RESELLER" }));
    await user.click(screen.getByRole("option", { name: "RESELLER" }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith("Invalid role."));
  });
});

describe("UserDetailPage — wallet display", () => {
  it("renders both IDR and USDT wallet balances on the Profile card", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByText("Rp500.000")).toBeInTheDocument();
    expect(screen.getByText("12.50 USDT")).toBeInTheDocument();
  });
});

describe("UserDetailPage — wallet adjustment currency", () => {
  it("defaults to IDR when no currency toggle is clicked", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Amount (+ or −)"), "5");
    await user.type(screen.getByPlaceholderText("Reason (required)"), "goodwill");
    await user.click(screen.getByRole("button", { name: "Adjust" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/users/7/wallet", { delta: "5", note: "goodwill", currency: "IDR" }),
    );
  });

  it("adjusts the USDT balance when the USDT toggle is selected", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(USER_DETAIL), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<UserDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "USDT" }));
    await user.type(screen.getByPlaceholderText("Amount (+ or −)"), "5");
    await user.type(screen.getByPlaceholderText("Reason (required)"), "top up");
    await user.click(screen.getByRole("button", { name: "Adjust" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/users/7/wallet", { delta: "5", note: "top up", currency: "USDT" }),
    );
  });
});
