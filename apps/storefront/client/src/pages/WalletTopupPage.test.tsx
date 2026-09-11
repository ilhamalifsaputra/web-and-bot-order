import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import WalletTopupPage from "./WalletTopupPage";
import { apiGet, apiPost } from "../api/client";
import type { WalletTopupCreateResponse, WalletTopupData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const baseData: WalletTopupData = {
  idr_enabled: true,
  paydisini_enabled: false,
  binance_enabled: true,
  bybit_enabled: false,
  bybit_bsc_enabled: false,
  nowpayments_enabled: false,
  min_idr: "50000",
  max_idr: "5000000",
  min_usdt: "5",
  max_usdt: "1000",
  wallet_idr: "0",
  wallet_usdt: "0",
};

function renderTopup(respond: (path: string) => unknown, initialPath = "/wallet/topup") {
  (apiGet as Mock).mockImplementation(async (path: string) => respond(path));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/wallet/topup" element={<WalletTopupPage />} />
          <Route path="/wallet/topup/:code/pay" element={<div>topup-pay-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WalletTopupPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the gateway rows for a stubbed set of methods, gated per currency", async () => {
    renderTopup(() => baseData);
    await screen.findByRole("heading", { name: "Top up wallet" });

    // IDR is preselected by default: only the enabled IDR method (QRIS) shows,
    // paydisini stays hidden since it's disabled in the fixture.
    expect(screen.getByText("QRIS")).toBeInTheDocument();
    expect(screen.queryByText("QRIS / E-Wallet")).not.toBeInTheDocument();
    expect(screen.queryByText("BINANCE")).not.toBeInTheDocument();

    // Switching currency swaps the rendered rows to the USDT set.
    fireEvent.click(screen.getByRole("button", { name: "USDT" }));
    expect(await screen.findByText("BINANCE")).toBeInTheDocument();
    expect(screen.queryByText("QRIS")).not.toBeInTheDocument();
  });

  it("keeps submit disabled until a valid amount is entered, and disables it again out of range", async () => {
    renderTopup(() => baseData);
    await screen.findByRole("heading", { name: "Top up wallet" });
    const submit = screen.getByRole("button", { name: "Top up now" });
    const amountInput = screen.getByLabelText("Amount");

    // Empty amount, method already auto-selected (qris) -> still blocked.
    expect(submit).toBeDisabled();

    // Below min_idr (50000) -> stays disabled (client-side hint only).
    fireEvent.change(amountInput, { target: { value: "1000" } });
    expect(submit).toBeDisabled();

    // Above max_idr (5000000) -> stays disabled.
    fireEvent.change(amountInput, { target: { value: "9999999" } });
    expect(submit).toBeDisabled();

    // Within range -> enabled.
    fireEvent.change(amountInput, { target: { value: "100000" } });
    expect(submit).not.toBeDisabled();
  });

  it("submits apiPost with exactly {currency, amount, method} and navigates to the pay screen on success", async () => {
    renderTopup(() => baseData);
    await screen.findByRole("heading", { name: "Top up wallet" });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });
    const submit = screen.getByRole("button", { name: "Top up now" });
    expect(submit).not.toBeDisabled();

    const response: WalletTopupCreateResponse = { orderCode: "TOPUP1" };
    (apiPost as Mock).mockResolvedValue(response);
    fireEvent.click(submit);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/wallet/topup", {
        currency: "IDR",
        amount: "100000",
        method: "qris",
      }),
    );
    expect(await screen.findByText("topup-pay-stub")).toBeInTheDocument();
  });

  it("renders a submit error via the Alert banner (role=alert) with the translated copy", async () => {
    renderTopup(() => baseData);
    await screen.findByRole("heading", { name: "Top up wallet" });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });
    (apiPost as Mock).mockRejectedValue(new Error("error.wallet_topup_below_min"));
    fireEvent.click(screen.getByRole("button", { name: "Top up now" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("That amount is below the minimum for a wallet top-up.");
  });

  it("apologises in plain language when the failure carries no i18n key", async () => {
    renderTopup(() => baseData);
    await screen.findByRole("heading", { name: "Top up wallet" });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });
    (apiPost as Mock).mockRejectedValue(new Error("/api/v1/wallet/topup responded 500"));
    fireEvent.click(screen.getByRole("button", { name: "Top up now" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong. Please try again.");
    expect(screen.queryByText("/api/v1/wallet/topup responded 500")).not.toBeInTheDocument();
  });
});
