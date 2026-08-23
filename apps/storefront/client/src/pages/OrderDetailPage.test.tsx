import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
};

const baseOrder: OrderDetailData["order"] = {
  code: "ORD1",
  status: "delivered",
  subtotal: "158000",
  discount: "0",
  bulk_discount: "0",
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

function renderDetail(respond: (path: string) => unknown, code = "ORD1") {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
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

  it("shows the digiflazz_pending_body text once the SSE stream pushes digiflazzStatus: pending", async () => {
    renderDetail(() => processingData());
    await screen.findAllByText("Being prepared");

    MockEventSource.instances[0]!.emit({ orderStatus: "PROCESSING", digiflazzStatus: "pending" });

    expect(
      await screen.findByText("We're finalizing your top-up with our supplier. This usually only takes a moment."),
    ).toBeInTheDocument();
  });

  it("shows the digiflazz_failed_body text once the SSE stream pushes digiflazzStatus: reviewing, and never the word 'failed'", async () => {
    renderDetail(() => processingData());
    await screen.findAllByText("Being prepared");

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

  it("ignores orderStatus from the SSE push — the page still shows the processing card, not a delivered view", async () => {
    renderDetail(() => processingData());
    await screen.findAllByText("Being prepared");

    MockEventSource.instances[0]!.emit({ orderStatus: "DELIVERED", digiflazzStatus: "pending" });

    await waitFor(() =>
      expect(
        screen.getByText("We're finalizing your top-up with our supplier. This usually only takes a moment."),
      ).toBeInTheDocument(),
    );
    // Still the processing reassurance card, not the delivered-order view —
    // proving the merge did NOT overwrite order.status/processing/delivered
    // from the SSE push's orderStatus field. Asserting the exact count (2:
    // the StatusBadge chip + the card title, same as the other "still
    // processing" tests in this file) rather than just >0 matters here: a
    // regression that merged order.status into the cache WITHOUT also
    // touching the top-level processing/delivered booleans (the narrower,
    // more likely mistake than corrupting all three) would still leave the
    // processing card and "Your credentials" section exactly as they are —
    // the only thing that would change is StatusBadge switching from
    // "Being prepared" to "Delivered" for its one occurrence, dropping the
    // count from 2 to 1. A bare >0 check can't see that; this can.
    expect(screen.getAllByText("Being prepared")).toHaveLength(2);
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();
    expect(screen.queryByText("Your credentials")).not.toBeInTheDocument();
  });
});
