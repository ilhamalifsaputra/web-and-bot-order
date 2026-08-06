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

  it("cancel posts and navigates to /cart", async () => {
    const pay: PayData = { ...basePay, state: "waiting", is_qris: true };
    renderPay(respondFor(pay));
    await screen.findByRole("heading", { name: "Payment" });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel this order" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/orders/ORD1/cancel", {}));
    expect(await screen.findByText("cart-page-stub")).toBeInTheDocument();
  });

  it("renders ErrorPage on a 404", async () => {
    renderPay(() => {
      const err = new Error("not_found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    expect(await screen.findByText("404")).toBeInTheDocument();
  });

  // Guest checkout's order-code email (docs/PROJECT_ARCHITECTURE.md §Guest
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
