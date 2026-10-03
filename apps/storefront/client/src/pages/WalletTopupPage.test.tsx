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
  rail_min: {
    qris: "1000",
    paydisini: "1000",
    binance: "0.07",
    bybit: "0.07",
    bybit_bsc: "0.07",
    nowpayments: "0.07",
  },
  // The server folds the top-up bound and the rail floors into one figure (F4b);
  // in this fixture the top-up bound is the higher of the two, so it wins.
  effective_min_idr: "50000",
  effective_min_usdt: "5",
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

  // Whole-branch review D9. The shop-wide rail minimum refuses an IDR top-up
  // through the same guard product checkout uses, and used to hand the buyer
  // that flow's sentence: "Add more items, or choose a different payment
  // method." There is no cart here. The replacement copy also has to survive
  // this surface's plumbing, which throws `new Error(body.error)` and so loses
  // the error's format arguments — a template with {min} in it would reach the
  // buyer with the braces still showing.
  it("renders the top-up rail-minimum refusal without cart wording or unfilled placeholders", async () => {
    renderTopup(() => baseData);
    await screen.findByRole("heading", { name: "Top up wallet" });
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });
    (apiPost as Mock).mockRejectedValue(new Error("error.wallet_topup_below_rail_minimum"));
    fireEvent.click(screen.getByRole("button", { name: "Top up now" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "That amount is below the minimum this payment method accepts. Please top up a larger amount, or choose a different payment method.",
    );
    expect(alert).not.toHaveTextContent(/add more items/i);
    expect(alert.textContent).not.toMatch(/\{\w+\}/);
  });

  // Whole-branch review F3 (part 2). The bot's gateway picker now hides a rail
  // whose floor the typed amount cannot clear; this is the same rule on the
  // storefront form, off the `rail_min` figures the GET reports. Offering a rail
  // the create call is going to refuse turns a fixable "type a bigger number"
  // into a failed submission.
  describe("rails the typed amount cannot be paid through (F3)", () => {
    const bothIdrRails: WalletTopupData = {
      ...baseData,
      paydisini_enabled: true,
      // PayDisini's own floor is far above QRIS's here, so one rail accepts a
      // Rp100.000 top-up and the other does not.
      rail_min: { ...baseData.rail_min, qris: "1000", paydisini: "200000" },
    };

    it("offers every configured rail while no amount has been typed — there is nothing to judge yet", async () => {
      renderTopup(() => bothIdrRails);
      await screen.findByRole("heading", { name: "Top up wallet" });
      expect(screen.getByText("QRIS")).toBeInTheDocument();
      expect(screen.getByText("QRIS / E-Wallet")).toBeInTheDocument();
    });

    it("drops a rail whose floor the typed amount does not clear, and keeps the one that accepts it", async () => {
      renderTopup(() => bothIdrRails);
      await screen.findByRole("heading", { name: "Top up wallet" });
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });

      expect(screen.getByText("QRIS")).toBeInTheDocument();
      expect(screen.queryByText("QRIS / E-Wallet")).not.toBeInTheDocument();
      // The rail that survived is the one submitted, not the one that was
      // default-selected before the amount was known.
      expect(screen.getByRole("button", { name: "Top up now" })).not.toBeDisabled();
    });

    it("keeps a rail the buyer picked themselves rather than resetting the choice on every keystroke", async () => {
      renderTopup(() => ({ ...baseData, paydisini_enabled: true }));
      await screen.findByRole("heading", { name: "Top up wallet" });
      fireEvent.click(screen.getByText("QRIS / E-Wallet"));
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });

      const response: WalletTopupCreateResponse = { orderCode: "TOPUP2" };
      (apiPost as Mock).mockResolvedValue(response);
      fireEvent.click(screen.getByRole("button", { name: "Top up now" }));
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/wallet/topup", {
          currency: "IDR",
          amount: "100000",
          method: "paydisini",
        }),
      );
    });

    // Two causes look identical in an empty picker and need opposite messages —
    // the same distinction PaymentMethodSelector.tsx draws with
    // `below_all_minimums` on the product checkout page. A shop with no working
    // gateway is nothing the buyer can act on; an amount under every floor is
    // fixed by typing a bigger one, and the "check back soon" wording would
    // leave them waiting for something that is never going to change.
    it("says the amount is too small — not 'check back soon' — when it clears no configured rail", async () => {
      renderTopup(() => ({ ...baseData, rail_min: { ...baseData.rail_min, qris: "500000" } }));
      await screen.findByRole("heading", { name: "Top up wallet" });
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });

      expect(
        screen.getByText(
          "That amount is below the minimum every payment method for this currency accepts. Enter a larger amount and the methods will appear.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/check back soon/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Top up now" })).toBeDisabled();
    });

    it("still says 'check back soon' when the currency has no configured rail at all", async () => {
      renderTopup(() => ({ ...baseData, idr_enabled: false, paydisini_enabled: false }));
      await screen.findByRole("heading", { name: "Top up wallet" });
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });

      expect(screen.getByText(/check back soon/i)).toBeInTheDocument();
      expect(screen.queryByText(/below the minimum every payment method/i)).not.toBeInTheDocument();
    });

    // A rail with no floor of its own must not be filtered out by a
    // missing/undefined entry being read as zero-or-anything — null means "no
    // floor to clear", which every amount clears.
    it("treats a rail with no floor as accepting any amount", async () => {
      renderTopup(() => ({ ...baseData, rail_min: { ...baseData.rail_min, qris: null } }));
      await screen.findByRole("heading", { name: "Top up wallet" });
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "100000" } });
      expect(screen.getByText("QRIS")).toBeInTheDocument();
    });
  });

  // Whole-branch review F4b. The hint read `min_idr`/`min_usdt` — the top-up
  // bounds alone — so a shop whose rail floor was higher advertised a minimum the
  // create call then refused. Both the sentence and the submit button now read the
  // server's effective minimum.
  describe("the advertised minimum (F4b)", () => {
    // A shop with no top-up bound of its own, where the rail floor is the only
    // thing binding: the old code showed no minimum at all here.
    const railFloorOnly: WalletTopupData = {
      ...baseData,
      min_idr: null,
      min_usdt: null,
      max_idr: null,
      max_usdt: null,
      rail_min: { ...baseData.rail_min, qris: "10000" },
      effective_min_idr: "10000",
      effective_min_usdt: "0.07",
    };

    it("shows the effective minimum, not the raw top-up bound", async () => {
      renderTopup(() => railFloorOnly);
      await screen.findByRole("heading", { name: "Top up wallet" });
      expect(screen.getByText("Minimum Rp10.000.")).toBeInTheDocument();
    });

    it("blocks an amount under the effective minimum even though no top-up bound is set", async () => {
      renderTopup(() => railFloorOnly);
      await screen.findByRole("heading", { name: "Top up wallet" });
      const submit = screen.getByRole("button", { name: "Top up now" });

      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5000" } });
      expect(submit).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10000" } });
      expect(submit).not.toBeDisabled();
    });

    it("renders the range hint from the effective minimum and the configured maximum", async () => {
      renderTopup(() => ({ ...railFloorOnly, max_idr: "5000000" }));
      await screen.findByRole("heading", { name: "Top up wallet" });
      expect(screen.getByText("Between Rp10.000 and Rp5.000.000.")).toBeInTheDocument();
    });

    it("shows no minimum at all when neither bound exists", async () => {
      renderTopup(() => ({ ...railFloorOnly, effective_min_idr: null }));
      await screen.findByRole("heading", { name: "Top up wallet" });
      expect(screen.queryByText(/Minimum/)).not.toBeInTheDocument();
    });
  });

  // A buyer types the amount the way they write money: "10.000" in Indonesian
  // style used to read as 10 (Number("10.000")) and "10,000" as NaN. The field
  // now reads the amount by its shape (normalizeMoneyInput, the same table the
  // bot uses) and posts the CANONICAL figure, never the raw typed text.
  describe("amounts typed with separators", () => {
    const UNREADABLE =
      "Enter the amount as digits, e.g. 50000 or 50.000. For USDT, a single separator followed by exactly three digits is ambiguous — write 1000 for a thousand, or 1.00 for one.";

    it("reads an Indonesian-style 10.000 as ten thousand rupiah and posts the canonical 10000", async () => {
      renderTopup(() => ({ ...baseData, min_idr: "10000", effective_min_idr: "10000" }));
      await screen.findByRole("heading", { name: "Top up wallet" });
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "10.000" } });
      const submit = screen.getByRole("button", { name: "Top up now" });
      expect(submit).not.toBeDisabled();

      (apiPost as Mock).mockResolvedValue({ orderCode: "TOPUP3" } satisfies WalletTopupCreateResponse);
      fireEvent.click(submit);
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/wallet/topup", {
          currency: "IDR",
          amount: "10000",
          method: "qris",
        }),
      );
    });

    it("reads a decimal-comma 5,5 USDT as 5.5 and posts the canonical 5.5", async () => {
      renderTopup(() => baseData);
      await screen.findByRole("heading", { name: "Top up wallet" });
      fireEvent.click(screen.getByRole("button", { name: "USDT" }));
      await screen.findByText("BINANCE");
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5,5" } });
      const submit = screen.getByRole("button", { name: "Top up now" });
      expect(submit).not.toBeDisabled();

      (apiPost as Mock).mockResolvedValue({ orderCode: "TOPUP4" } satisfies WalletTopupCreateResponse);
      fireEvent.click(submit);
      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/v1/wallet/topup", {
          currency: "USDT",
          amount: "5.5",
          method: "binance",
        }),
      );
    });

    it("refuses an ambiguous 1.000 USDT with an inline error, keeps submit disabled and posts nothing", async () => {
      renderTopup(() => baseData);
      await screen.findByRole("heading", { name: "Top up wallet" });
      fireEvent.click(screen.getByRole("button", { name: "USDT" }));
      await screen.findByText("BINANCE");
      const amountInput = screen.getByLabelText("Amount");
      fireEvent.change(amountInput, { target: { value: "1.000" } });

      expect(screen.getByText(UNREADABLE)).toBeInTheDocument();
      expect(amountInput).toHaveAttribute("aria-invalid", "true");
      const submit = screen.getByRole("button", { name: "Top up now" });
      expect(submit).toBeDisabled();
      fireEvent.click(submit);
      expect(apiPost).not.toHaveBeenCalled();

      // Writing it unambiguously clears the error.
      fireEvent.change(amountInput, { target: { value: "10" } });
      expect(screen.queryByText(UNREADABLE)).not.toBeInTheDocument();
      expect(submit).not.toBeDisabled();
    });

    it("shows no format error for a blank field", async () => {
      renderTopup(() => baseData);
      await screen.findByRole("heading", { name: "Top up wallet" });
      expect(screen.queryByText(UNREADABLE)).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "  " } });
      expect(screen.queryByText(UNREADABLE)).not.toBeInTheDocument();
    });

    it("still blocks a separator-typed amount that is below the minimum once read (1.000 IDR < 50000)", async () => {
      renderTopup(() => baseData);
      await screen.findByRole("heading", { name: "Top up wallet" });
      fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.000" } });
      expect(screen.getByRole("button", { name: "Top up now" })).toBeDisabled();
      // Readable, just too small: the format error is not the reason.
      expect(screen.queryByText(UNREADABLE)).not.toBeInTheDocument();
    });

    it("filters rails by the parsed figure: 50.000 drops the same rails 50000 does", async () => {
      const rails: WalletTopupData = {
        ...baseData,
        paydisini_enabled: true,
        rail_min: { ...baseData.rail_min, qris: "1000", paydisini: "60000" },
      };
      for (const typed of ["50.000", "50000"]) {
        const { unmount } = renderTopup(() => rails);
        await screen.findByRole("heading", { name: "Top up wallet" });
        fireEvent.change(screen.getByLabelText("Amount"), { target: { value: typed } });
        expect(screen.getByText("QRIS"), typed).toBeInTheDocument();
        expect(screen.queryByText("QRIS / E-Wallet"), typed).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Top up now" }), typed).not.toBeDisabled();
        unmount();
      }
    });
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
