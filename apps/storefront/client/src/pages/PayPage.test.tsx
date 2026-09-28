import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PayPage from "./PayPage";
import { apiGet, apiPost } from "../api/client";
import { rememberCodeEmailed } from "../lib/orderCodeEmailed";
import type { PayData, PayStatusData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const basePay: PayData = {
  order: {
    code: "ORD1",
    status: "PENDING_PAYMENT",
    currency: "IDR",
    total: "158000",
    qris_admin_fee: null,
    qris_grand_total: null,
    payment_ref: null,
    expires_at_iso: null,
  },
  state: "waiting",
  is_binance: false,
  is_bybit: false,
  is_bybit_bsc: false,
  is_qris: false,
  is_paydisini: false,
  is_nowpayments: false,
  bybit_uid: "",
  bybit_bsc_address: "",
  binance_uid: "",
  gateway: null,
  gateway_error: false,
  paydisini_gateway: null,
  paydisini_gateway_error: false,
  nowpayments_gateway: null,
  nowpayments_gateway_error: false,
  min_amount: null,
  wa_number: "",
  bot_username: "tokobot",
};

function renderPay(respond: (path: string) => unknown, code = "ORD1") {
  (apiGet as Mock).mockImplementation(async (path: string) => respond(path));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/checkout/${code}/pay`]}>
        <Routes>
          <Route path="/checkout/:code/pay" element={<PayPage />} />
          <Route path="/cart" element={<div>cart-page-stub</div>} />
          <Route path="/account/orders/:code" element={<div>credentials-page-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Every test's order fetches BOTH /pay and /status — this keeps the status
 * poll quiet (state stays in sync with /pay) unless a test overrides it. */
function respondFor(pay: PayData, status?: PayStatusData) {
  return (path: string) => {
    if (path.endsWith("/status")) return status ?? { state: pay.state, redirect: null };
    return pay;
  };
}

describe("PayPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the QRIS waiting branch with the QR image and the amount due", async () => {
    const pay: PayData = {
      ...basePay,
      state: "waiting",
      is_qris: true,
      gateway: { trxId: "TRX1", payUrl: "https://pay.example/trx1", qrLink: "https://img.example/qr.png", qrString: null, totalBayar: "158000" },
    };
    renderPay(respondFor(pay));
    expect(await screen.findByRole("heading", { name: "Payment" })).toBeInTheDocument();
    expect(screen.getByAltText("QRIS")).toHaveAttribute("src", "https://img.example/qr.png");
    expect(screen.getByText("Rp158.000")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open payment page/ })).toHaveAttribute("href", "https://pay.example/trx1");
  });

  // Task 5 bug fix (regression guard): formatIdr used to be called
  // unconditionally on order.total/qris_admin_fee/qris_grand_total. A
  // defensive, synthetic case — order.currency "USDT" reaching the is_qris
  // branch — proves the fix actually branches on order.currency rather than
  // relying on "only IDR-only gateways ever set is_qris" holding everywhere.
  it("renders a USDT-currency order's amount as a native USDT string, never an IDR-formatted number", async () => {
    const pay: PayData = {
      ...basePay,
      state: "waiting",
      is_qris: true,
      order: { ...basePay.order, currency: "USDT", total: "9.88", qris_admin_fee: null, qris_grand_total: null },
    };
    renderPay(respondFor(pay));
    await screen.findByRole("heading", { name: "Payment" });
    expect(screen.getByText("9.88 USDT")).toBeInTheDocument();
    expect(screen.queryByText(/^Rp/)).not.toBeInTheDocument();
  });

  it("renders the QRIS admin fee breakdown and fee-inclusive grand total when present", async () => {
    const pay: PayData = {
      ...basePay,
      state: "waiting",
      is_qris: true,
      order: { ...basePay.order, total: "158000", qris_admin_fee: "1206", qris_grand_total: "159206" },
      gateway: { trxId: "TRX1", payUrl: "https://pay.example/trx1", qrLink: "https://img.example/qr.png", qrString: null, totalBayar: "159206" },
    };
    renderPay(respondFor(pay));
    await screen.findByRole("heading", { name: "Payment" });
    expect(screen.getByText("Rp158.000")).toBeInTheDocument(); // subtotal line
    expect(screen.getByText("QRIS admin fee")).toBeInTheDocument();
    expect(screen.getByText("Rp1.206")).toBeInTheDocument();
    expect(screen.getByText("Rp159.206")).toBeInTheDocument(); // grand total
  });

  it("renders the Bybit waiting branch with the UID and the send amount", async () => {
    const pay: PayData = {
      ...basePay,
      state: "waiting",
      is_bybit: true,
      bybit_uid: "UID-999",
      order: { ...basePay.order, currency: "USDT", total: "9.88" },
    };
    renderPay(respondFor(pay));
    await screen.findByRole("heading", { name: "Payment" });
    expect(screen.getByText("UID-999")).toBeInTheDocument();
    expect(screen.getByText("$9.88")).toBeInTheDocument();
  });

  it("renders the WhatsApp/Telegram fallback links on a gateway error", async () => {
    const pay: PayData = {
      ...basePay,
      state: "waiting",
      is_qris: true,
      gateway: null,
      gateway_error: true,
      wa_number: "6281234567890",
    };
    renderPay(respondFor(pay));
    await screen.findByRole("heading", { name: "Payment" });
    expect(screen.getByText("Rupiah payment is briefly unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Try again/ })).toHaveAttribute("href", "/checkout/ORD1/pay");
    expect(screen.getByRole("link", { name: /WhatsApp/ })).toHaveAttribute("href", "https://wa.me/6281234567890");
  });

  it("navigates to the credentials page once the poll reports delivered", async () => {
    const pay: PayData = { ...basePay, state: "waiting", is_qris: true };
    renderPay(respondFor(pay, { state: "delivered", redirect: "/account/orders/ORD1" }));
    expect(await screen.findByText("credentials-page-stub")).toBeInTheDocument();
  });

  it("renders a live countdown from expires_at_iso, and 0:00 once past", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-04T12:00:00.000Z").getTime());
    const pay: PayData = {
      ...basePay,
      state: "waiting",
      is_qris: true,
      order: { ...basePay.order, expires_at_iso: "2026-07-04T12:04:30.000Z" }, // 4:30 from now
    };
    renderPay(respondFor(pay));
    await screen.findByRole("heading", { name: "Payment" });
    expect(document.getElementById("countdown")).toHaveTextContent("4:30");
  });

  it("shows 0:00 when expires_at_iso is already in the past", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-04T12:00:00.000Z").getTime());
    const pay: PayData = {
      ...basePay,
      state: "waiting",
      is_qris: true,
      order: { ...basePay.order, expires_at_iso: "2026-07-04T11:00:00.000Z" }, // already past
    };
    renderPay(respondFor(pay));
    await screen.findByRole("heading", { name: "Payment" });
    expect(document.getElementById("countdown")).toHaveTextContent("0:00");
  });

  // Task 14: the cancel button no longer fires cancelMutation directly — it
  // opens a confirmation AlertDialog first (Global Constraints / Task 1
  // audit §F item 3). These three tests replace the old "cancel posts and
  // navigates to /cart" single-click test.
  describe("cancel confirmation dialog", () => {
    it("clicking Cancel this order opens the dialog and does NOT call the mutation", async () => {
      const pay: PayData = { ...basePay, state: "waiting", is_qris: true };
      renderPay(respondFor(pay));
      await screen.findByRole("heading", { name: "Payment" });

      fireEvent.click(screen.getByRole("button", { name: "Cancel this order" }));

      expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
      expect(apiPost).not.toHaveBeenCalled();
    });

    it("confirming in the dialog calls the same cancel mutation and navigates to /cart", async () => {
      const pay: PayData = { ...basePay, state: "waiting", is_qris: true };
      renderPay(respondFor(pay));
      await screen.findByRole("heading", { name: "Payment" });
      (apiPost as Mock).mockResolvedValue({ ok: true });

      fireEvent.click(screen.getByRole("button", { name: "Cancel this order" }));
      await screen.findByRole("alertdialog");
      fireEvent.click(screen.getByRole("button", { name: "Yes, cancel" }));

      await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/orders/ORD1/cancel", {}));
      expect(await screen.findByText("cart-page-stub")).toBeInTheDocument();
    });

    it("cancelling the dialog closes it without calling the mutation", async () => {
      const pay: PayData = { ...basePay, state: "waiting", is_qris: true };
      renderPay(respondFor(pay));
      await screen.findByRole("heading", { name: "Payment" });

      fireEvent.click(screen.getByRole("button", { name: "Cancel this order" }));
      await screen.findByRole("alertdialog");
      fireEvent.click(screen.getByRole("button", { name: "No, go back" }));

      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(apiPost).not.toHaveBeenCalled();
    });
  });

  it("renders ErrorPage on a 404", async () => {
    renderPay(() => {
      const err = new Error("not_found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    expect(await screen.findByText("404")).toBeInTheDocument();
  });

  // Guest checkout's order-code email (docs/archive/PROJECT_ARCHITECTURE.md §Guest
  // Checkout). CheckoutPage cannot show this itself — a successful guest
  // checkout leaves the SPA via a full page load — so the notice lands here,
  // beside the very code that was mailed, carried over by lib/orderCodeEmailed.
  describe("guest order-code email notice", () => {
    interface FakeStorage {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
      removeItem(key: string): void;
    }
    /** jsdom under this repo's Vitest config exposes no sessionStorage. */
    function installStorage(): void {
      const entries = new Map<string, string>();
      const storage: FakeStorage = {
        getItem: (key) => (entries.has(key) ? entries.get(key)! : null),
        setItem: (key, value) => {
          entries.set(key, value);
        },
        removeItem: (key) => {
          entries.delete(key);
        },
      };
      Object.defineProperty(window, "sessionStorage", { value: storage, configurable: true });
    }

    const NOTICE = /We've emailed this order code to guest@example\.com/;

    beforeEach(() => {
      installStorage();
    });

    it("names the address the code was emailed to when the mail actually went out", async () => {
      rememberCodeEmailed("ORD1", "guest@example.com");
      renderPay(respondFor({ ...basePay, state: "waiting", is_qris: true }));
      await screen.findByRole("heading", { name: "Payment" });
      expect(screen.getByText(NOTICE)).toBeInTheDocument();
    });

    it("promises nothing when no mail was sent (SMTP off, or a send that failed)", async () => {
      // Nothing handed over — `email_sent: false` writes no entry at all.
      renderPay(respondFor({ ...basePay, state: "waiting", is_qris: true }));
      await screen.findByRole("heading", { name: "Payment" });
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
      expect(screen.queryByText(/emailed/i)).not.toBeInTheDocument();
    });

    it("still says it after a refresh — it is a fact about the order, not a toast", async () => {
      rememberCodeEmailed("ORD1", "guest@example.com");
      const first = renderPay(respondFor({ ...basePay, state: "waiting", is_qris: true }));
      await screen.findByRole("heading", { name: "Payment" });
      expect(screen.getByText(NOTICE)).toBeInTheDocument();
      first.unmount();

      renderPay(respondFor({ ...basePay, state: "waiting", is_qris: true }));
      await screen.findByRole("heading", { name: "Payment" });
      expect(screen.getByText(NOTICE)).toBeInTheDocument();
    });

    it("never shows one order's notice on a different order's page", async () => {
      rememberCodeEmailed("ORD1", "guest@example.com");
      renderPay(respondFor({ ...basePay, order: { ...basePay.order, code: "ORD2" }, state: "waiting", is_qris: true }), "ORD2");
      await screen.findByRole("heading", { name: "Payment" });
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
    });
  });

  // Final-review fix: the web twin of the bot's payAlongsidePriceLine. A
  // USD-display viewer on an IDR-settled QRIS/PayDisini order sees
  // "Price $X · Pay RpY" (Price = order.total pre-fee, converted once; Pay =
  // the rail's fee-inclusive charge) ALONGSIDE the native Rp payable, which
  // keeps rendering exactly as Task 5 left it. fx 16000: 158000 → $9.88.
  describe("Price · Pay line for a USD-display viewer", () => {
    const ctxFor = (currency: "USD" | "IDR" | null, fx: string | null = "16000") => ({
      lang: "en",
      fx,
      shop_name: "Toko Digital",
      shop_tagline: "",
      cart_count: 0,
      customer: null,
      favicon_url: "/static/favicon.svg",
      logo_url: "",
      bot_username: "tokobot",
      wa_number: null,
      tzname: "Asia/Jakarta",
      currency,
    });
    function respondWithCtx(pay: PayData, ctx: ReturnType<typeof ctxFor>) {
      const base = respondFor(pay);
      return (path: string) => (path === "/api/v1/pages/context" ? ctx : base(path));
    }
    const qrisWithFee: PayData = {
      ...basePay,
      state: "waiting",
      is_qris: true,
      order: { ...basePay.order, total: "158000", qris_admin_fee: "1206", qris_grand_total: "159206" },
      gateway: { trxId: "TRX1", payUrl: "https://pay.example/trx1", qrLink: "https://img.example/qr.png", qrString: null, totalBayar: "159206" },
    };
    const paydisini: PayData = { ...basePay, state: "waiting", is_paydisini: true };

    it("QRIS + USD: adds the line and keeps the native Rp breakdown and payable unchanged", async () => {
      renderPay(respondWithCtx(qrisWithFee, ctxFor("USD")));
      expect(await screen.findByText("Price $9.88 · Pay Rp159.206")).toBeInTheDocument();
      // Task 5's regression guard: the payable is still the order's own figure.
      expect(screen.getByText("Rp158.000")).toBeInTheDocument();
      expect(screen.getByText("Rp1.206")).toBeInTheDocument();
      expect(screen.getByText("Rp159.206")).toBeInTheDocument();
    });

    it("QRIS without a fee breakdown + USD: Pay is order.total", async () => {
      renderPay(respondWithCtx({ ...basePay, state: "waiting", is_qris: true }, ctxFor("USD")));
      expect(await screen.findByText("Price $9.88 · Pay Rp158.000")).toBeInTheDocument();
      expect(screen.getByText("Rp158.000")).toBeInTheDocument();
    });

    it("QRIS + USD in Indonesian uses the shared checkout.price_and_pay wording", async () => {
      document.documentElement.lang = "id";
      renderPay(respondWithCtx(qrisWithFee, ctxFor("USD")));
      expect(await screen.findByText("Harga $9.88 · Bayar Rp159.206")).toBeInTheDocument();
    });

    it("PayDisini + USD: adds the line beside the unchanged Rp payable", async () => {
      renderPay(respondWithCtx(paydisini, ctxFor("USD")));
      expect(await screen.findByText("Price $9.88 · Pay Rp158.000")).toBeInTheDocument();
      expect(screen.getByText("Rp158.000")).toBeInTheDocument();
    });

    it("IDR / no-preference / no-rate viewers: unchanged, no line", async () => {
      for (const ctx of [ctxFor("IDR"), ctxFor(null), ctxFor("USD", null)]) {
        const view = renderPay(respondWithCtx(qrisWithFee, ctx));
        await screen.findByText("Rp159.206");
        await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/v1/pages/context"));
        expect(screen.queryByText(/Pay Rp/)).not.toBeInTheDocument();
        view.unmount();
      }
    });

    it("USDT-settled order + USD: already native, no line added", async () => {
      const bybit: PayData = {
        ...basePay,
        state: "waiting",
        is_bybit: true,
        bybit_uid: "UID-999",
        order: { ...basePay.order, currency: "USDT", total: "9.88" },
      };
      renderPay(respondWithCtx(bybit, ctxFor("USD")));
      await screen.findByText("$9.88");
      await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/v1/pages/context"));
      expect(screen.queryByText(/Pay Rp/)).not.toBeInTheDocument();
    });

    it("a USDT-currency order that reaches the QRIS branch gets no line (never a Rp claim on a USDT order)", async () => {
      const pay: PayData = {
        ...basePay,
        state: "waiting",
        is_qris: true,
        order: { ...basePay.order, currency: "USDT", total: "9.88" },
      };
      renderPay(respondWithCtx(pay, ctxFor("USD")));
      await screen.findByText("9.88 USDT");
      await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/v1/pages/context"));
      expect(screen.queryByText(/Pay /)).not.toBeInTheDocument();
    });
  });

  it("renders stepper outside the max-w-2xl container (njk parity)", async () => {
    const pay: PayData = { ...basePay, state: "waiting", is_qris: true };
    const { container } = renderPay(respondFor(pay));
    await screen.findByRole("heading", { name: "Payment" });
    const maxWidthContainer = container.querySelector(".max-w-2xl");
    const stepperOl = container.querySelector("ol");
    expect(maxWidthContainer).toBeInTheDocument();
    expect(stepperOl).toBeInTheDocument();
    // Stepper (the <ol>) must NOT be a descendant of max-w-2xl container
    expect(maxWidthContainer!.contains(stepperOl!)).toBe(false);
  });
});
