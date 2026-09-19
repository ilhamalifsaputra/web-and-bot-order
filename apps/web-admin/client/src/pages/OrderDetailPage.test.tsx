import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrderDetailPage } from "./OrderDetailPage";
import { apiPost } from "../api/client";

// Task 2 (fetch → shared Application Client): OrderDetailPage's useOrderDetail
// now calls apiGet(...) instead of raw fetch(), so the mocked module needs an
// apiGet too — implemented as a thin forward to the global `fetch` this file's
// tests already stub per-test via vi.spyOn(globalThis, "fetch"), so every
// existing test body keeps working unchanged.
vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
  apiGet: vi.fn(async (path: string) => {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`${path} failed`);
    return res.json();
  }),
}));

// The page now always opens an SSE connection for live digiflazz sub-status
// (useSse, wired inside OrderDetailPage), so every test in this file needs
// EventSource stubbed, or it would throw on a real EventSource constructor
// jsdom doesn't implement.
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

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/orders/1"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/orders/:orderId" element={children} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const ORDER_DETAIL_DATA = {
  order: {
    id: 1,
    orderCode: "ORD-0001",
    status: "PENDING_VERIFICATION",
    currency: "IDR",
    totalAmount: "50000",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdAtDisplay: "2026-01-01 07:00",
    user: { id: 10, fullName: "Andi Santoso", username: "andi", telegramId: "111" },
    items: [
      {
        id: 100,
        quantity: 1,
        unitPrice: "99000",
        product: { id: 5, name: "CapCut Pro 1M" },
        stockItem: null,
      },
    ],
    voucher: null,
    deliveredContent: null,
  },
  money: {
    currency: "IDR",
    itemsTotal: "50000",
    bulkDiscount: null,
    discount: null,
    walletCredit: null,
    amountMarker: null,
    totalToPay: "50000",
    equivalentIdr: null,
  },
  isDelivered: false,
  canAct: true,
  canCredit: true,
  canFulfill: false,
  customerDataFields: [] as Array<{ key: string; label: { id: string; en: string }; type: string; required: boolean; options: string[]; placeholder: string }>,
  customerData: [] as Array<Record<string, string>>,
  // M20: every replacement request ever opened against a unit of this order.
  stockReplacements: [] as Array<Record<string, unknown>>,
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiPost).mockReset();
  vi.stubGlobal("EventSource", MockEventSource);
  MockEventSource.instances = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrderDetailPage", () => {
  it("shows order detail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(ORDER_DETAIL_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    // Wait for data — product name is in the items table td (unique leaf cell)
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    // Unit price td has "99000" (different from itemsTotal "50000" to avoid any confusion)
    expect(screen.getByText("99000")).toBeInTheDocument();
    expect(screen.getByText("2026-01-01 07:00")).toBeInTheDocument(); // createdAtDisplay
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("shows a Resend button for a delivered order with a Telegram buyer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: { ...ORDER_DETAIL_DATA.order, status: "DELIVERED" },
          isDelivered: true,
          canAct: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /resend to telegram/i })).toBeInTheDocument();
  });

  it("hides the Resend button before the order is delivered", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(ORDER_DETAIL_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /resend to telegram/i })).not.toBeInTheDocument();
  });

  it("hides the Resend button for a web-only buyer (no Telegram id)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: {
            ...ORDER_DETAIL_DATA.order,
            status: "DELIVERED",
            user: { id: 20, fullName: null, username: null, telegramId: null },
          },
          isDelivered: true,
          canAct: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /resend to telegram/i })).not.toBeInTheDocument();
  });

  // Task 4: a WALLET_TOPUP order has zero OrderItem rows by design (it
  // credits the buyer's wallet balance rather than delivering a SKU) — the
  // page must render a clear label instead of an empty/confusing Items
  // table, and never offer Resend (there are no credentials to resend).
  it("shows a Wallet Top-Up label and no Items table or Resend button for a WALLET_TOPUP order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: { ...ORDER_DETAIL_DATA.order, kind: "WALLET_TOPUP", status: "DELIVERED", items: [] },
          isDelivered: true,
          canAct: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Wallet Top-Up (IDR)")).toBeInTheDocument());
    expect(screen.queryByText("CapCut Pro 1M")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resend to telegram/i })).not.toBeInTheDocument();
  });
});

describe("OrderDetailPage — guest buyers", () => {
  const GUEST_USER = {
    id: 30,
    fullName: null,
    username: null,
    telegramId: null,
    isGuest: true,
    guestEmail: "budi@gmail.com",
  };

  function guestOrderResponse(user: Record<string, unknown>) {
    return new Response(
      JSON.stringify({
        ...ORDER_DETAIL_DATA,
        order: { ...ORDER_DETAIL_DATA.order, user },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  it("marks a guest order with a Guest badge and shows the contact email", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(guestOrderResponse(GUEST_USER));
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    expect(screen.getByText("Guest")).toBeInTheDocument();
    expect(screen.getByText("budi@gmail.com")).toBeInTheDocument();
    // Reachable in one click — the address is a mailto link, not plain text.
    expect(screen.getByRole("link", { name: "budi@gmail.com" })).toHaveAttribute(
      "href",
      "mailto:budi@gmail.com",
    );
  });

  it("wraps a long guest email instead of clipping it", async () => {
    const longEmail = "budi.setiawan.pelanggan.setia.sekali@surel-yang-panjang-sekali.example.com";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      guestOrderResponse({ ...GUEST_USER, guestEmail: longEmail }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });

    // This address is the only way to reach a guest buyer, so it must stay
    // fully readable — break-all, never truncate. The card is overflow-hidden,
    // so without a break opportunity the tail would be silently amputated.
    const link = await screen.findByRole("link", { name: longEmail });
    expect(link).toHaveClass("break-all");
    expect(link).not.toHaveClass("truncate");
    expect(link).toHaveAttribute("href", `mailto:${longEmail}`);
  });

  it("does not mark a registered buyer's order as a guest order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      guestOrderResponse({
        id: 10,
        fullName: "Andi Santoso",
        username: "andi",
        telegramId: "111",
        isGuest: false,
        guestEmail: null,
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    expect(screen.getByText("Andi Santoso")).toBeInTheDocument();
    expect(screen.queryByText("Guest")).not.toBeInTheDocument();
    expect(screen.queryByText("Guest Buyer")).not.toBeInTheDocument();
  });

  it("explains a guest order with no email on file instead of rendering an empty contact area", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      guestOrderResponse({ ...GUEST_USER, guestEmail: null }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    expect(screen.getByText("Guest")).toBeInTheDocument();
    expect(screen.getByText("Guest Buyer")).toBeInTheDocument();
    expect(screen.getByText(/no contact address on file/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /@/ })).not.toBeInTheDocument();
  });
});

describe("OrderDetailPage — manual fulfilment", () => {
  it("shows a Send to Buyer action for a PROCESSING order and posts the typed content", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: { ...ORDER_DETAIL_DATA.order, status: "PROCESSING" },
          canAct: false,
          canFulfill: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true });
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    const sendButton = screen.getByRole("button", { name: /send to buyer/i });
    expect(sendButton).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/account\/content to send/i), "user:x pass:y");
    await user.click(sendButton);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(`/api/orders/1/fulfill`, { content: "user:x pass:y" }),
    );
  });

  it("hides the Send to Buyer action when the order isn't PROCESSING", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(ORDER_DETAIL_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /send to buyer/i })).not.toBeInTheDocument();
  });

  it("shows the buyer's submitted custom-field answers, labeled, when customerData is present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: { ...ORDER_DETAIL_DATA.order, status: "PROCESSING" },
          canAct: false,
          canFulfill: true,
          customerDataFields: [
            { key: "invite_email", label: { id: "Email Undangan", en: "Invite Email" }, type: "email", required: true, options: [], placeholder: "" },
          ],
          customerData: [{ invite_email: "budi@gmail.com" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Buyer-Submitted Info")).toBeInTheDocument());
    expect(screen.getByText("Invite Email")).toBeInTheDocument();
    expect(screen.getByText("budi@gmail.com")).toBeInTheDocument();
  });

  it("labels each answer per unit when quantity > 1", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: { ...ORDER_DETAIL_DATA.order, status: "PROCESSING" },
          canAct: false,
          canFulfill: true,
          customerDataFields: [
            { key: "invite_email", label: { id: "Email Undangan", en: "Invite Email" }, type: "email", required: true, options: [], placeholder: "" },
          ],
          customerData: [{ invite_email: "budi@gmail.com" }, { invite_email: "siti@gmail.com" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Buyer-Submitted Info")).toBeInTheDocument());
    expect(screen.getByText("Unit 1 — Invite Email")).toBeInTheDocument();
    expect(screen.getByText("Unit 2 — Invite Email")).toBeInTheDocument();
  });

  it("renders nothing for the Buyer-Submitted Info block when customerData is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(ORDER_DETAIL_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    expect(screen.queryByText("Buyer-Submitted Info")).not.toBeInTheDocument();
  });

  it("shows the Delivered Content card for a manually delivered order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: { ...ORDER_DETAIL_DATA.order, status: "DELIVERED", deliveredContent: "user:x pass:y" },
          isDelivered: true,
          canAct: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Delivered Content")).toBeInTheDocument());
    expect(screen.getByText("user:x pass:y")).toBeInTheDocument();
  });

  it("hides the Delivered Content card for an auto-delivered order (deliveredContent null)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: { ...ORDER_DETAIL_DATA.order, status: "DELIVERED" },
          isDelivered: true,
          canAct: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    expect(screen.queryByText("Delivered Content")).not.toBeInTheDocument();
  });
});

/**
 * M20: a bad delivered account is replaced (or refunded) one PURCHASED UNIT at
 * a time, from a row action on the Items table this page already rendered. The
 * guards all live in the service (packages/db/src/crud/stockReplacement.ts) —
 * what these tests pin down is that the page offers each action only where it
 * could succeed, and posts to the per-unit route with the reason the admin
 * actually typed.
 */
describe("OrderDetailPage — replacing a bad delivered account", () => {
  const UNIT_A = {
    id: 100,
    quantity: 1,
    unitPrice: "99000",
    product: { id: 5, name: "CapCut Pro 1M" },
    stockItem: { id: 900, credentials: "a@mail.com:pw1" },
  };
  const UNIT_B = {
    id: 101,
    quantity: 1,
    unitPrice: "99000",
    product: { id: 6, name: "Canva Pro 1M" },
    stockItem: { id: 901, credentials: "b@mail.com:pw2" },
  };

  function deliveredResponse(overrides: Record<string, unknown> = {}) {
    return new Response(
      JSON.stringify({
        ...ORDER_DETAIL_DATA,
        order: { ...ORDER_DETAIL_DATA.order, status: "DELIVERED", items: [UNIT_A, UNIT_B] },
        isDelivered: true,
        canAct: false,
        ...overrides,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const AWAITING_REQUEST = {
    id: 7,
    orderItemId: UNIT_A.id,
    status: "AWAITING_STOCK",
    reason: "account banned within 24h",
    originalStockItemId: 900,
    replacementStockItemId: null,
    supportTicketId: null,
    requestedAt: "2026-01-02T00:00:00.000Z",
    requestedAtDisplay: "2026-01-02 07:00",
    resolvedAt: null,
    resolvedAtDisplay: null,
    refund: null,
  };

  it("reports one unit as bad with the typed reason, on the per-unit route", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(deliveredResponse());
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, status: "COMPLETED", credentialIssued: true });
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    await user.click(screen.getAllByRole("button", { name: /report issue/i })[0]);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText(/what was wrong/i), "password changed by the owner");
    await user.click(within(dialog).getByRole("button", { name: /^report/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/orders/1/items/100/replace", {
        reason: "password changed by the owner",
      }),
    );
  });

  it("refuses to submit an empty reason — the service requires one", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(deliveredResponse());
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    await user.click(screen.getAllByRole("button", { name: /report issue/i })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /^report/i })).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("offers Retry now and Refund instead — two distinct actions — for a unit waiting on stock", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      deliveredResponse({ stockReplacements: [AWAITING_REQUEST] }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    expect(screen.getByRole("button", { name: /retry now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refund instead/i })).toBeInTheDocument();
    // The unit already has an open request, so reporting it again is not on
    // offer — only the other unit's action is.
    expect(screen.getAllByRole("button", { name: /report issue/i })).toHaveLength(1);
    expect(screen.getByText("Awaiting Stock")).toBeInTheDocument();
  });

  it("retries the allocation for a waiting request", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      deliveredResponse({ stockReplacements: [AWAITING_REQUEST] }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, status: "COMPLETED", credentialIssued: true });
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /retry now/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/orders/1/replacements/7/retry", {}),
    );
  });

  it("refunds the unit instead, behind a confirmation", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      deliveredResponse({ stockReplacements: [AWAITING_REQUEST] }),
    );
    vi.mocked(apiPost).mockResolvedValueOnce({ ok: true, refunded: "99000", currency: "IDR" });
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /refund instead/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^refund/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/orders/1/replacements/7/refund", {}),
    );
  });

  it("shows what each past request resolved to, and when", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      deliveredResponse({
        stockReplacements: [
          {
            ...AWAITING_REQUEST,
            id: 5,
            status: "COMPLETED",
            replacementStockItemId: 950,
            resolvedAt: "2026-01-03T00:00:00.000Z",
            resolvedAtDisplay: "2026-01-03 07:00",
          },
          {
            ...AWAITING_REQUEST,
            id: 6,
            orderItemId: UNIT_B.id,
            status: "REFUNDED_INSTEAD",
            resolvedAt: "2026-01-04T00:00:00.000Z",
            resolvedAtDisplay: "2026-01-04 07:00",
            refund: { id: 3, amount: "89100", currency: "IDR", status: "COMPLETED" },
          },
        ],
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    expect(screen.getByText(/a fresh account was issued/i)).toBeInTheDocument();
    // Money is rendered through the admin panel's shared display helper, so it
    // reads as Rp89.100 rather than a raw server string.
    expect(screen.getByText(/refunded Rp89\.100/i)).toBeInTheDocument();
    expect(screen.getByText("2026-01-03 07:00")).toBeInTheDocument();
    expect(screen.getByText("2026-01-04 07:00")).toBeInTheDocument();
  });

  it("reports several selected units in one pass — one independent request per unit", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(deliveredResponse());
    vi.mocked(apiPost).mockResolvedValue({ ok: true, status: "AWAITING_STOCK", credentialIssued: false });
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select unit 1 of 2/i }));
    await user.click(screen.getByRole("checkbox", { name: /select unit 2 of 2/i }));
    await user.click(screen.getByRole("button", { name: /report issue \(2 units\)/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByPlaceholderText(/what was wrong/i), "whole batch is dead");
    await user.click(within(dialog).getByRole("button", { name: /^report/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(apiPost).toHaveBeenCalledWith("/api/orders/1/items/100/replace", { reason: "whole batch is dead" });
    expect(apiPost).toHaveBeenCalledWith("/api/orders/1/items/101/replace", { reason: "whole batch is dead" });
  });

  it("offers nothing on an order that was never delivered", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ ...ORDER_DETAIL_DATA, order: { ...ORDER_DETAIL_DATA.order, items: [UNIT_A] } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /report issue/i })).not.toBeInTheDocument();
  });

  it("offers nothing for a hand-fulfilled unit, which never held a stock account", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      deliveredResponse({
        order: {
          ...ORDER_DETAIL_DATA.order,
          status: "DELIVERED",
          items: [{ ...UNIT_A, stockItem: null }],
        },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /report issue/i })).not.toBeInTheDocument();
  });
});

describe("OrderDetailPage — realtime digiflazz sub-status", () => {
  // Final whole-branch review I-3 fix: this SSE push's orderStatus
  // ("PROCESSING") differs from the initial fetch's order.status
  // ("PENDING_VERIFICATION"), which now correctly triggers an
  // invalidateQueries refetch (see Fix 3) — the mocked fetch needs a second
  // queued response for it. That refetch response carries the same
  // digiflazz fields the SSE push carried (realistic: GET /api/orders/:id
  // already returns real digiflazzStatus scalars, Fix 2's admin-side
  // confirmation), so the badge reads correctly regardless of whether the
  // merge or the refetch resolves last.
  it("shows the pending-at-supplier badge with the attempt count once the SSE stream pushes it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(ORDER_DETAIL_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: {
            ...ORDER_DETAIL_DATA.order,
            status: "PROCESSING",
            digiflazzStatus: "pending_at_supplier",
            digiflazzAttempts: 2,
            digiflazzNextRecheckAt: "2026-01-01T00:05:00.000Z",
            digiflazzFailureDetail: null,
          },
          canAct: false,
          canFulfill: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    MockEventSource.instances[0].emit({
      orderStatus: "PROCESSING",
      digiflazzStatus: "pending_at_supplier",
      digiflazzAttempts: 2,
      digiflazzNextRecheckAt: "2026-01-01T00:05:00.000Z",
      digiflazzFailureDetail: null,
    });

    await waitFor(() => expect(screen.getByText(/pending at supplier/i)).toBeInTheDocument());
    expect(screen.getByText(/attempt 2/i)).toBeInTheDocument();
  });

  it("shows the failed badge and the failure detail text once the SSE stream pushes a failed status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(ORDER_DETAIL_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());

    MockEventSource.instances[0].emit({
      orderStatus: "PENDING_VERIFICATION",
      digiflazzStatus: "failed",
      digiflazzAttempts: 5,
      digiflazzNextRecheckAt: null,
      digiflazzFailureDetail: "Supplier returned insufficient balance.",
    });

    await waitFor(() => expect(screen.getByText(/failed — needs manual review/i)).toBeInTheDocument());
    expect(screen.getByText("Supplier returned insufficient balance.")).toBeInTheDocument();
  });

  // Final whole-branch review I-3 fix: the SSE merge no longer overwrites
  // order.status directly — a changed orderStatus now triggers an
  // invalidateQueries instead, so status AND its server-computed sibling
  // booleans (canAct/canFulfill/canReject/isDelivered) refetch together
  // rather than desyncing. This test's mocked fetch now needs a SECOND
  // response for that refetch, carrying the post-transition eligibility
  // booleans alongside the DELIVERED status.
  it("updates the Status badge to DELIVERED when the SSE stream pushes a Sukses transition", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(ORDER_DETAIL_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    // StatusBadge title-cases the raw code — the seeded order is
    // PENDING_VERIFICATION, so "Delivered" isn't present yet.
    expect(screen.queryByText("Delivered")).not.toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: { ...ORDER_DETAIL_DATA.order, status: "DELIVERED" },
          isDelivered: true,
          canAct: false,
          canFulfill: false,
          canReject: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    MockEventSource.instances[0].emit({
      orderStatus: "DELIVERED",
      digiflazzStatus: null,
      digiflazzAttempts: 1,
      digiflazzNextRecheckAt: null,
      digiflazzFailureDetail: null,
    });

    // An invalidate-triggered refetch also eventually shows "Delivered" —
    // this is the pre-existing Task 13 assertion, still true after the fix.
    await waitFor(() => expect(screen.getByText("Delivered")).toBeInTheDocument());
  });

  // The actual I-3 regression guard: the original Task 13 test only checked
  // the Status badge, never whether the action panel (which reads the
  // separate canAct/canFulfill/canReject booleans, not order.status) stayed
  // in sync with it. Before the fix, the badge flipped to "Delivered" while
  // Approve/Reject kept rendering as if the order were still actionable —
  // this proves that split-brain is closed.
  it("hides the action buttons once an SSE-triggered orderStatus transition invalidates and refetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(ORDER_DETAIL_DATA), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<OrderDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
    // canAct: true in the fixture — the Approve button is up before the push.
    expect(screen.getByRole("button", { name: /approve & deliver/i })).toBeInTheDocument();

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...ORDER_DETAIL_DATA,
          order: { ...ORDER_DETAIL_DATA.order, status: "DELIVERED" },
          isDelivered: true,
          canAct: false,
          canFulfill: false,
          canReject: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    MockEventSource.instances[0].emit({
      orderStatus: "DELIVERED",
      digiflazzStatus: null,
      digiflazzAttempts: 1,
      digiflazzNextRecheckAt: null,
      digiflazzFailureDetail: null,
    });

    await waitFor(() => expect(screen.getByText("Delivered")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /approve & deliver/i })).not.toBeInTheDocument();
  });

  /**
   * Overpayment card (task F2). The action's whole justification is that the
   * amount has an external source, so what these tests pin is that the page shows
   * the rail's figures, offers the action only while there is an UNCREDITED
   * excess, and sends a body with no amount in it.
   */
  describe("overpayment", () => {
    const OVERPAID = {
      gateway: "TOKOPAY",
      receivedAmount: "52500",
      expectedAmount: "50000",
      excess: "2500",
      currency: "IDR",
      credited: false,
    };

    function renderWith(overpayment: Record<string, unknown> | null) {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ...ORDER_DETAIL_DATA, overpayment }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      render(<OrderDetailPage />, { wrapper: Wrapper });
    }

    it("shows the rail's own figures beside the excess it is offering to return", async () => {
      renderWith(OVERPAID);

      await waitFor(() => expect(screen.getByText("Overpayment")).toBeInTheDocument());
      // The received/billed pair is what lets an admin check the number before
      // handing money over, instead of trusting the button.
      expect(screen.getByText(/TOKOPAY recorded Rp52\.500 arriving against a bill of Rp50\.000/)).toBeInTheDocument();
      expect(screen.getByText("Rp2.500")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /return Rp2\.500 to the buyer/i }),
      ).toBeInTheDocument();
    });

    it("renders nothing at all for an ordinary order nobody overpaid", async () => {
      renderWith(null);

      await waitFor(() => expect(screen.getByText("CapCut Pro 1M")).toBeInTheDocument());
      expect(screen.queryByText("Overpayment")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /to the buyer/i })).not.toBeInTheDocument();
    });

    it("stops offering the action once the excess has been returned", async () => {
      renderWith({ ...OVERPAID, credited: true });

      await waitFor(() => expect(screen.getByText("Overpayment")).toBeInTheDocument());
      expect(screen.getByText(/already returned to the buyer's wallet balance/i)).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /return Rp2\.500 to the buyer/i }),
      ).not.toBeInTheDocument();
    });

    it("says plainly that there is nothing to return when the derived excess is zero", async () => {
      // A flagged-but-stale rail row: the amount recorded is at or below what the
      // order billed. Offering a button here would only earn a 422.
      renderWith({ ...OVERPAID, receivedAmount: "50000", excess: "0" });

      await waitFor(() => expect(screen.getByText("Overpayment")).toBeInTheDocument());
      expect(screen.getByText(/does not actually show the buyer paying more/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /to the buyer/i })).not.toBeInTheDocument();
    });

    it("posts an EMPTY body — the amount is the server's to derive, never the client's", async () => {
      renderWith(OVERPAID);
      await waitFor(() => expect(screen.getByText("Overpayment")).toBeInTheDocument());
      vi.mocked(apiPost).mockResolvedValue({ ok: true, credited: "2500", currency: "IDR" });

      await userEvent.click(screen.getByRole("button", { name: /return Rp2\.500 to the buyer/i }));
      await userEvent.click(screen.getByRole("button", { name: "Return it" }));

      await waitFor(() =>
        expect(apiPost).toHaveBeenCalledWith("/api/orders/1/credit-overpayment", {}),
      );
      // No amount field of any kind reached the wire.
      const body = vi.mocked(apiPost).mock.calls[0]![1] as Record<string, unknown>;
      expect(Object.keys(body)).toHaveLength(0);
    });

    it("surfaces a refusal from the server instead of claiming the money moved", async () => {
      renderWith(OVERPAID);
      await waitFor(() => expect(screen.getByText("Overpayment")).toBeInTheDocument());
      vi.mocked(apiPost).mockRejectedValue(new Error("error.overpayment_already_credited"));

      await userEvent.click(screen.getByRole("button", { name: /return Rp2\.500 to the buyer/i }));
      await userEvent.click(screen.getByRole("button", { name: "Return it" }));

      await waitFor(() => expect(screen.getByText(/already been credited/i)).toBeInTheDocument());
    });
  });

  it("does not open an SSE connection while orderId is still undefined", () => {
    function NoParamWrapper({ children }: { children: React.ReactNode }) {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return (
        <MemoryRouter initialEntries={["/orders"]}>
          <QueryClientProvider client={qc}>
            <Routes>
              <Route path="/orders" element={children} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>
      );
    }
    vi.spyOn(globalThis, "fetch");
    render(<OrderDetailPage />, { wrapper: NoParamWrapper });
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
