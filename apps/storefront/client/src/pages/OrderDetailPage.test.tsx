import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OrderDetailPage from "./OrderDetailPage";
import { apiGet, apiPatch } from "../api/client";
import type { AdditionalField, OrderDetailData, ShopContext } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
}));

// The page opens an SSE connection whenever `processing` is true (useSse,
// wired inside OrderDetailPage), so every test that renders a processing
// order needs EventSource stubbed, or it would throw on a real EventSource
// constructor jsdom doesn't implement.
class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string, _opts?: { withCredentials?: boolean }) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

const context: ShopContext = {
  lang: "en",
  fx: null,
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: { username: "alice", email: null, telegram_linked: false },
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  wa_number: null,
  tzname: "Asia/Jakarta",
  currency: null,
};

const baseOrder: OrderDetailData["order"] = {
  code: "ORD1",
  status: "delivered",
  subtotal: "158000",
  discount: "0",
  bulk_discount: "0",
  wallet_credit: "0",
  currency: "IDR",
  total: "158000",
  created_at_display: "2026-07-01 10:00",
  customer_data_fields: [],
  customer_data: [],
  delivered_content: null,
  items: [
    { name: "Netflix", duration: "1 month", unit_price: "158000", warranty_days: 30, credentials: null },
  ],
};

const infoFields: AdditionalField[] = [
  { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
];

function renderDetail(respond: (path: string) => unknown, code = "ORD1", ctx: ShopContext = context) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return ctx;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/account/orders/${code}`]}>
        <Routes>
          <Route path="/account/orders/:code" element={<OrderDetailPage />} />
          <Route path="/checkout/:code/pay" element={<div>pay-page-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OrderDetailPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    vi.stubGlobal("EventSource", MockEventSource);
    MockEventSource.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows credentials for a delivered order", async () => {
    const data: OrderDetailData = {
      order: {
        ...baseOrder,
        items: [{ ...baseOrder.items[0], credentials: "user:pass" }],
      },
      delivered: true,
      pending_payment: false,
      processing: false,
    };
    renderDetail(() => data);
    expect(await screen.findByText("Your credentials")).toBeInTheDocument();
    expect(screen.getByText("user:pass")).toBeInTheDocument();
  });

  // The summary rows are stacked and read as arithmetic, so every reduction
  // that moved the total needs a row: a wallet-paid order used to show its
  // subtotal and discounts above a Total lower by the whole credit, with
  // nothing explaining the gap (the server derives these figures now — see
  // apps/storefront/src/routes/buyerOrderSummary.ts).
  it("prints the wallet-credit row when the balance paid for part of the order", async () => {
    const data: OrderDetailData = {
      order: {
        ...baseOrder,
        bulk_discount: "20000",
        discount: "30000",
        wallet_credit: "28000",
        // 158.000 − 20.000 − 30.000 − 28.000, the identity the rows assert.
        total: "80000",
      },
      delivered: true,
      pending_payment: false,
      processing: false,
    };
    renderDetail(() => data);
    expect(await screen.findByText("Wallet credit")).toBeInTheDocument();
    expect(screen.getByText("−Rp28,000")).toBeInTheDocument();
  });

  it("omits the wallet-credit row when no balance was spent", async () => {
    renderDetail(() => ({ order: baseOrder, delivered: true, pending_payment: false, processing: false }));
    await screen.findByRole("heading", { name: /Order code/ });
    expect(screen.queryByText("Wallet credit")).not.toBeInTheDocument();
  });

  // Task 5 fix pass: `order.total` is the order's OWN settlement amount (IDR or
  // USDT, per `order.currency`), fixed at pay time — the viewer's display-
  // currency preference must never re-convert it. `unit_price`/`subtotal`/
  // discounts are stored in central IDR for every order (see
  // packages/db/src/crud/orders.ts's orderCurrencyConverter doc), so they are
  // printed as the Rupiah figures they are, not display-converted either.
  describe("settled amounts ignore the display-currency preference", () => {
    const usdtOrder: OrderDetailData = {
      order: { ...baseOrder, currency: "USDT", total: "9.88" },
      delivered: true,
      pending_payment: false,
      processing: false,
    };

    it.each([["USD" as const], ["IDR" as const], [null]])(
      "a USDT-settled order shows its native USDT total (viewer preference %s)",
      async (currency) => {
        renderDetail(() => usdtOrder, "ORD1", { ...context, fx: "16000", currency });
        expect(await screen.findByText("9.88 USDT")).toBeInTheDocument();
        // Re-converting 9.88 as if it were IDR would print "$0.01" (USD) or
        // "Rp10 ≈ $0.01" (null) — neither may appear, nor any "$" figure at all.
        expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
        expect(screen.queryByText("Rp10")).not.toBeInTheDocument();
        // The item line + subtotal stay the central-IDR figures they are.
        expect(screen.getAllByText("Rp158,000")).toHaveLength(2);
      },
    );

    it.each([["USD" as const], ["IDR" as const]])(
      "an IDR-settled order keeps subtotal, discounts, item price and total all in Rupiah (viewer preference %s)",
      async (currency) => {
        const data: OrderDetailData = {
          order: { ...baseOrder, bulk_discount: "20000", discount: "30000", total: "108000" },
          delivered: true,
          pending_payment: false,
          processing: false,
        };
        renderDetail(() => data, "ORD1", { ...context, fx: "16000", currency });
        expect(await screen.findByText("Rp108,000")).toBeInTheDocument();
        expect(screen.getAllByText("Rp158,000")).toHaveLength(2); // item line + subtotal
        expect(screen.getByText("−Rp20,000")).toBeInTheDocument();
        expect(screen.getByText("−Rp30,000")).toBeInTheDocument();
        // One basis for the whole card: nothing on it is display-converted.
        expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
      },
    );
  });

  it("hides credentials for a non-delivered order", async () => {
    const data: OrderDetailData = {
      order: { ...baseOrder, status: "pending_payment" },
      delivered: false,
      pending_payment: false,
      processing: false,
    };
    renderDetail(() => data);
    await screen.findByRole("heading", { name: /Order code/ });
    expect(screen.queryByText("Your credentials")).not.toBeInTheDocument();
  });

  it("shows the continue-to-payment link when pending_payment", async () => {
    const data: OrderDetailData = {
      order: { ...baseOrder, status: "pending_payment" },
      delivered: false,
      pending_payment: true,
      processing: false,
    };
    renderDetail(() => data);
    expect(await screen.findByRole("link", { name: /Pay now/ })).toHaveAttribute(
      "href",
      "/checkout/ORD1/pay",
    );
  });

  it("renders ErrorPage on a 404", async () => {
    renderDetail(() => {
      const err = new Error("not_found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    expect(await screen.findByText("404")).toBeInTheDocument();
  });

  // Task 10: PROCESSING reassurance + no new UI for auto/manual orders.
  it("shows the PROCESSING reassurance card and a working Refresh button, with no info section (auto order)", async () => {
    const data: OrderDetailData = {
      order: { ...baseOrder, status: "PROCESSING" },
      delivered: false,
      pending_payment: false,
      processing: true,
    };
    renderDetail(() => data);
    // "Being prepared" appears twice — once in the StatusBadge chip, once as
    // the reassurance card's heading.
    expect(await screen.findAllByText("Being prepared")).toHaveLength(2);
    expect(screen.getByText(/preparing your order by hand/)).toBeInTheDocument();
    // No manual_with_info fields on this fixture -> no info section at all.
    expect(screen.queryByText("Your submitted information")).not.toBeInTheDocument();

    (apiGet as Mock).mockClear();
    fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/api/v1/account/orders/ORD1`));
  });

  it("renders nothing new (no reassurance, no info section, no delivered-content block) for a plain delivered auto order", async () => {
    const data: OrderDetailData = {
      order: { ...baseOrder, items: [{ ...baseOrder.items[0], credentials: "user:pass" }] },
      delivered: true,
      pending_payment: false,
      processing: false,
    };
    renderDetail(() => data);
    await screen.findByText("Your credentials");
    expect(screen.queryByText("Being prepared")).not.toBeInTheDocument();
    expect(screen.queryByText("Your submitted information")).not.toBeInTheDocument();
    expect(screen.queryByText("Delivered content")).not.toBeInTheDocument();
  });

  describe("manual_with_info: submitted info display + edit", () => {
    function infoData(overrides: Partial<OrderDetailData>): OrderDetailData {
      return {
        order: {
          ...baseOrder,
          status: "PROCESSING",
          customer_data_fields: infoFields,
          customer_data: [{ game_id: "player1" }],
        },
        delivered: false,
        pending_payment: false,
        processing: true,
        ...overrides,
      };
    }

    it("shows the buyer's current answers read-only, with an Edit button while PROCESSING", async () => {
      renderDetail(() => infoData({}));
      expect(await screen.findByText("Your submitted information")).toBeInTheDocument();
      expect(screen.getByText("Game ID")).toBeInTheDocument();
      expect(screen.getByText("player1")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Edit/ })).toBeInTheDocument();
    });

    it("locks editing (no Edit button) once DELIVERED", async () => {
      const data = infoData({ delivered: true, processing: false, pending_payment: false });
      data.order.status = "DELIVERED";
      renderDetail(() => data);
      expect(await screen.findByText("Your submitted information")).toBeInTheDocument();
      expect(screen.getByText("player1")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    });

    it("Edit pre-fills the form with the current answer, and Save submits the PATCH then refetches", async () => {
      renderDetail(() => infoData({}));
      await screen.findByText("Your submitted information");
      fireEvent.click(screen.getByRole("button", { name: /Edit/ }));

      const input = (await screen.findByLabelText("Game ID")) as HTMLInputElement;
      expect(input.value).toBe("player1");

      fireEvent.change(input, { target: { value: "corrected-id" } });
      (apiPatch as Mock).mockResolvedValue({ ok: true });
      (apiGet as Mock).mockClear();
      fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));

      await waitFor(() =>
        expect(apiPatch).toHaveBeenCalledWith(`/api/v1/account/orders/ORD1/info`, {
          customer_data: [{ game_id: "corrected-id" }],
        }),
      );
      // Exits edit mode and refetches on success.
      await waitFor(() => expect(screen.queryByRole("button", { name: /Save changes/ })).not.toBeInTheDocument());
      expect(apiGet).toHaveBeenCalledWith(`/api/v1/account/orders/ORD1`);
    });

    it("the mid-edit race: a 400 error.order_not_processing shows the error, exits edit mode, and refetches", async () => {
      renderDetail(() => infoData({}));
      await screen.findByText("Your submitted information");
      fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
      const input = await screen.findByLabelText("Game ID");
      fireEvent.change(input, { target: { value: "too-late" } });

      (apiPatch as Mock).mockRejectedValue(new Error("error.order_not_processing"));
      (apiGet as Mock).mockClear();
      fireEvent.click(screen.getByRole("button", { name: /Save changes/ }));

      expect(
        await screen.findByText("This order is no longer awaiting fulfilment — it may have already been processed."),
      ).toBeInTheDocument();
      // Locked out of editing — the race means the order already left PROCESSING.
      expect(screen.queryByRole("button", { name: /Save changes/ })).not.toBeInTheDocument();
      await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/api/v1/account/orders/ORD1`));
    });

    it("Cancel discards in-progress edits without calling the PATCH route", async () => {
      renderDetail(() => infoData({}));
      await screen.findByText("Your submitted information");
      fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
      const input = await screen.findByLabelText("Game ID");
      fireEvent.change(input, { target: { value: "abandoned-edit" } });
      fireEvent.click(screen.getByRole("button", { name: /Cancel/ }));
      expect(screen.queryByRole("button", { name: /Save changes/ })).not.toBeInTheDocument();
      expect(screen.getByText("player1")).toBeInTheDocument();
      expect(apiPatch).not.toHaveBeenCalled();
    });
  });

  it("shows a manually-fulfilled order's delivered_content in its own titled, copyable block", async () => {
    const data: OrderDetailData = {
      order: { ...baseOrder, delivered_content: "user: acc1\npass: hunter2" },
      delivered: true,
      pending_payment: false,
      processing: false,
    };
    renderDetail(() => data);
    expect(await screen.findByText("Delivered content")).toBeInTheDocument();
    // testing-library's default text normalizer collapses the literal
    // newline in the fixture to a single space.
    expect(screen.getByText("user: acc1 pass: hunter2")).toBeInTheDocument();
  });

  it("scrolls the credentials section into view when loaded with a #credentials hash", async () => {
    window.history.pushState({}, "", "/account/orders/ORD1#credentials");
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderDetail((path) => {
      if (path === "/api/v1/account/orders/ORD1") {
        return { order: { ...baseOrder, items: [{ ...baseOrder.items[0]!, credentials: "acc@mail.com:pw" }] }, delivered: true, pending_payment: false, processing: false };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await screen.findByText("Your credentials"); // web.credentials, en.json
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    window.history.pushState({}, "", "/account/orders/ORD1"); // reset for other tests
  });
});

describe("OrderDetailPage — realtime digiflazz sub-status (Task 14)", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    vi.stubGlobal("EventSource", MockEventSource);
    MockEventSource.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function processingData(overrides: Partial<OrderDetailData> = {}): OrderDetailData {
    return {
      order: { ...baseOrder, status: "PROCESSING" },
      delivered: false,
      pending_payment: false,
      processing: true,
      ...overrides,
    };
  }

  it("renders the reassurance card without any digiflazz sub-status line before any SSE push arrives", async () => {
    renderDetail(() => processingData());
    expect(await screen.findAllByText("Being prepared")).toHaveLength(2);
    expect(screen.queryByText("We're finalizing your top-up with our supplier. This usually only takes a moment.")).not.toBeInTheDocument();
    expect(screen.queryByText("Our team is reviewing your order and will finish it shortly.")).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined/i)).not.toBeInTheDocument();
  });

  // Final whole-branch review I-2 fix: the base GET now returns digiflazz_status
  // directly (mapped, buyer-safe) rather than the SSE push being the only
  // source for it — proving the fallback actually works (not just that the
  // field exists in the type) requires a fixture with digiflazz_status
  // already present on the INITIAL fetch and NO SSE push at all.
  it("shows the digiflazz_pending_body text from the initial fetch alone, with no SSE push at all", async () => {
    renderDetail(() => processingData({ order: { ...baseOrder, status: "PROCESSING", digiflazz_status: "pending" } }));
    await screen.findAllByText("Being prepared");

    expect(
      await screen.findByText("We're finalizing your top-up with our supplier. This usually only takes a moment."),
    ).toBeInTheDocument();
    // No SSE frame was ever emitted — MockEventSource.instances[0].emit(...)
    // deliberately never called in this test.
  });

  it("shows the digiflazz_pending_body text once the SSE stream pushes digiflazzStatus: pending", async () => {
    let current = processingData();
    renderDetail(() => current);
    await screen.findAllByText("Being prepared");

    current = processingData({ order: { ...baseOrder, status: "PROCESSING", digiflazz_status: "pending" } });
    MockEventSource.instances[0]!.emit({ orderStatus: "PROCESSING", digiflazzStatus: "pending" });

    expect(
      await screen.findByText("We're finalizing your top-up with our supplier. This usually only takes a moment."),
    ).toBeInTheDocument();
  });

  it("shows the digiflazz_failed_body text once the SSE stream pushes digiflazzStatus: reviewing, and never the word 'failed'", async () => {
    let current = processingData();
    renderDetail(() => current);
    await screen.findAllByText("Being prepared");

    current = processingData({ order: { ...baseOrder, status: "PROCESSING", digiflazz_status: "reviewing" } });
    MockEventSource.instances[0]!.emit({ orderStatus: "PROCESSING", digiflazzStatus: "reviewing" });

    expect(
      await screen.findByText("Our team is reviewing your order and will finish it shortly."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
  });

  it("does not open an SSE connection when the order is not processing", async () => {
    renderDetail(() => ({
      order: { ...baseOrder, items: [{ ...baseOrder.items[0], credentials: "user:pass" }] },
      delivered: true,
      pending_payment: false,
      processing: false,
    }));
    await screen.findByText("Your credentials");
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it("refetches full detail on an SSE transition so status and delivered content update together", async () => {
    let current = processingData();
    renderDetail(() => current);
    await screen.findAllByText("Being prepared");

    current = {
      order: { ...baseOrder, status: "DELIVERED", items: [{ ...baseOrder.items[0]!, credentials: "delivered:secret" }] },
      delivered: true, pending_payment: false, processing: false,
    };
    MockEventSource.instances[0]!.emit({ orderStatus: "DELIVERED", digiflazzStatus: "pending" });
    expect(await screen.findByText("delivered:secret")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
    expect(screen.queryByText("Being prepared")).not.toBeInTheDocument();
    expect(MockEventSource.instances[0]!.closed).toBe(true);
  });
});

describe("OrderDetailPage — canonical automatic fulfillment", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    vi.stubGlobal("EventSource", MockEventSource);
    MockEventSource.instances = [];
  });
  afterEach(() => vi.unstubAllGlobals());

  function automaticData(status = "PROCESSING", editable = false) {
    const completed = status === "SUCCESS";
    const pending = status === "NOT_STARTED";
    return {
      order: {
        ...baseOrder, status: completed ? "DELIVERED" : pending ? "PENDING_PAYMENT" : "PROCESSING",
        customer_data_fields: infoFields, customer_data: [{ game_id: "player1" }],
        fulfillment: {
          mode: "AUTO", provider: "DIGIFLAZZ", status,
          payment_status: pending ? "PENDING" : "PAID", can_edit_customer_data: editable,
        },
      },
      delivered: completed, pending_payment: pending, processing: !completed && !pending,
    };
  }

  it.each([
    ["QUEUED", "Starting top-up"], ["SUBMITTING", "Sending order"], ["PROCESSING", "Processing top-up"],
    ["SUCCESS", "Top-up completed"], ["FAILED", "Top-up failed"], ["NEEDS_REVIEW", "We're checking your order"],
  ])("renders backend %s copy without manual wording", async (status, title) => {
    renderDetail(() => automaticData(status));
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.queryByText(/by hand|Being prepared/)).not.toBeInTheDocument();
    const progress = screen.getByRole("list", { name: "Order progress" });
    expect(within(progress).getAllByRole("listitem")).toHaveLength(3);
    if (["QUEUED", "SUBMITTING", "PROCESSING"].includes(status)) {
      expect(progress.querySelector('[aria-current="step"]')).toBeInTheDocument();
    } else {
      expect(progress.querySelector('[aria-current="step"]')).not.toBeInTheDocument();
      expect(progress.querySelector(".animate-spin")).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
  });

  it("uses Indonesian fulfillment copy", async () => {
    document.documentElement.lang = "id";
    renderDetail(() => automaticData());
    expect(await screen.findByRole("heading", { name: "Memproses top-up" })).toBeInTheDocument();
    expect(screen.queryByText(/by hand|Being prepared/)).not.toBeInTheDocument();
  });

  it("keeps manual preparation copy for a canonical MANUAL queued order", async () => {
    const current = automaticData("QUEUED", true);
    current.order.fulfillment.mode = "MANUAL";
    current.order.fulfillment.provider = "MANUAL";
    renderDetail(() => current);
    expect(await screen.findByRole("heading", { name: "Being prepared" })).toBeInTheDocument();
    expect(screen.getByText(/preparing your order by hand/)).toBeInTheDocument();
    expect(screen.queryByText(/automatic processing/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit/ })).toBeInTheDocument();
  });

  it("renders mobile items once, with the summary after submitted information and wrapping controls", async () => {
    const { container } = renderDetail(() => automaticData());
    await screen.findByRole("heading", { name: "Processing top-up" });
    expect(screen.getAllByText("Netflix")).toHaveLength(1);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const info = screen.getByText("Your submitted information");
    const summary = screen.getByRole("heading", { name: "Order summary" });
    expect(info.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".grid-cols-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh/ })).toHaveClass("min-h-11");
    expect(screen.getByRole("button", { name: /Refresh/ }).closest(".card")).toContainElement(screen.getByRole("list", { name: "Order progress" }));
  });

  it("locks an open edit form when SSE announces dispatch, after fetching the authoritative detail", async () => {
    let current = automaticData("QUEUED", true);
    renderDetail(() => current);
    await screen.findByRole("heading", { name: "Starting top-up" });
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }));
    expect(await screen.findByLabelText("Game ID")).toHaveValue("player1");
    current = automaticData("SUBMITTING", false);
    MockEventSource.instances[0]!.emit({ orderStatus: "PROCESSING", digiflazzStatus: null, fulfillment: current.order.fulfillment });
    await screen.findByRole("heading", { name: "Sending order" });
    expect(screen.queryByRole("button", { name: /Save changes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Edit/ })).not.toBeInTheDocument();
    expect(apiPatch).not.toHaveBeenCalled();
  });

  it("subscribes before payment and refetches payment, fulfillment, and flags together", async () => {
    let current = automaticData("NOT_STARTED", true);
    renderDetail(() => current);
    await screen.findByRole("link", { name: /Pay now/ });
    expect(MockEventSource.instances).toHaveLength(1);
    current = automaticData("QUEUED");
    MockEventSource.instances[0]!.emit({ orderStatus: "PROCESSING", digiflazzStatus: null, fulfillment: current.order.fulfillment });
    expect(await screen.findByRole("heading", { name: "Starting top-up" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Pay now/ })).not.toBeInTheDocument();
  });

  it("polls pending payment as a backup even without any SSE messages", async () => {
    let current = automaticData("NOT_STARTED", true);
    renderDetail(() => current);
    await screen.findByRole("link", { name: /Pay now/ });
    current = automaticData("SUCCESS");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Top-up completed" })).toBeInTheDocument(), { timeout: 6500 });
    expect(screen.queryByRole("link", { name: /Pay now/ })).not.toBeInTheDocument();
  });
});
