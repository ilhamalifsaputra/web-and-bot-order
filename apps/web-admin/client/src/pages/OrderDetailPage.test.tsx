import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OrderDetailPage } from "./OrderDetailPage";
import { apiPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
}));

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
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiPost).mockReset();
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
