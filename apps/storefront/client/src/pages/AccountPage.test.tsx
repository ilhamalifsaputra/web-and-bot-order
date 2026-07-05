import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AccountPage from "./AccountPage";
import { apiGet, apiPost } from "../api/client";
import type { AccountData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const account: AccountData = {
  name: "Alice",
  order_count: 4,
  referral_code: "ALICE01",
  wallet_idr: "50000",
  wallet_usdt: "1.5",
};

function renderAccount(respond: () => unknown = () => account) {
  (apiGet as Mock).mockImplementation(async () => respond());
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AccountPage", () => {
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    originalLocation = Object.getOwnPropertyDescriptor(window, "location");
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, "location", originalLocation);
  });

  it("renders the name, order count and both wallet balances", async () => {
    renderAccount();
    expect(await screen.findByRole("heading", { name: "My account" })).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("ALICE01")).toBeInTheDocument();
    expect(screen.getByText("Rp50.000")).toBeInTheDocument();
    expect(screen.getByText("1.5000 USDT")).toBeInTheDocument();
  });

  it("logout posts to /api/v1/auth/logout then assigns / on success", async () => {
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: { assign } });
    renderAccount();
    await screen.findByRole("heading", { name: "My account" });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: /Sign out/ }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/auth/logout", {}));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  });

  it("renders the account-menu links", async () => {
    renderAccount();
    await screen.findByRole("heading", { name: "My account" });
    expect(screen.getByRole("link", { name: /My orders/ })).toHaveAttribute("href", "/account/orders");
    expect(screen.getByRole("link", { name: /Referral/ })).toHaveAttribute("href", "/account/referral");
    expect(screen.getByRole("link", { name: /My reviews/ })).toHaveAttribute("href", "/account/reviews");
    expect(screen.getByRole("link", { name: /Help & support/ })).toHaveAttribute("href", "/account/support");
    expect(screen.getByRole("link", { name: /Settings/ })).toHaveAttribute("href", "/account/settings");
  });
});
