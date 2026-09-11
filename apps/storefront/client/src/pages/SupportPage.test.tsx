import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SupportPage from "./SupportPage";
import { apiGet, apiPost, apiPostFormWithProgress } from "../api/client";
import type { SupportData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPostFormWithProgress: vi.fn(),
}));

const supportData: SupportData = {
  tickets: [
    {
      id: 1,
      message: "Help please",
      status: "open",
      created_at_display: "2026-07-01 09:00",
      admin_reply: null,
      attachments: [],
      subject: null,
      order_code: null,
      product_name: null,
      updated_at_iso: "2026-07-01T09:00:00.000Z",
    },
  ],
};

// Stands in for TicketDetailPage — renders enough of the router state a
// redirect carries so tests can assert the "your draft wasn't saved" notice
// actually reached the destination, without pulling in the real page.
function TicketDetailStub() {
  const location = useLocation() as { state?: { notice?: string } | null };
  return (
    <div>
      ticket-detail-stub
      {location.state?.notice && <span>{location.state.notice}</span>}
    </div>
  );
}

function renderSupport(respond: () => unknown = () => supportData, ordersRespond: () => unknown = () => ({ orders: [] })) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/account/orders") return ordersRespond();
    return respond();
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/account/support"]}>
        <Routes>
          <Route path="/account/support" element={<SupportPage />} />
          <Route path="/account/support/:id" element={<TicketDetailStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SupportPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
  });

  it("renders the ticket list", async () => {
    renderSupport();
    expect(await screen.findByRole("link", { name: "#1" })).toHaveAttribute("href", "/account/support/1");
    expect(screen.getByText("Help please")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
  });

  it("creates a new ticket and refetches", async () => {
    renderSupport();
    await screen.findByRole("link", { name: "#1" });
    fireEvent.change(screen.getByPlaceholderText(/Tell us what's wrong/), {
      target: { value: "New issue" },
    });
    (apiPost as Mock).mockResolvedValue({ ok: true, ticket_id: 2 });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support", { message: "New issue" }),
    );
    // 3 = initial support fetch + initial account-orders fetch (order picker) + refetch after submit.
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(3));
  });

  it("includes the picked order_code when creating a ticket", async () => {
    renderSupport(() => supportData, () => ({
      orders: [{ code: "ORD-PICK-1", status: "delivered", total: "10000", created_at_display: "2026-07-01 09:00", items: "Netflix" }],
    }));
    await screen.findByRole("link", { name: "#1" });
    fireEvent.change(screen.getByLabelText("Which order is this about? (optional)"), { target: { value: "ORD-PICK-1" } });
    fireEvent.change(screen.getByPlaceholderText(/Tell us what's wrong/), { target: { value: "help with this order" } });
    (apiPost as Mock).mockResolvedValue({ ok: true, ticket_id: 42 });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support", {
        message: "help with this order",
        order_code: "ORD-PICK-1",
      }),
    );
  });

  // STO-020: submitting used to only clear the textbox and silently add a
  // table row — a toast should confirm the ticket was actually created.
  it("shows a 'Ticket #N created' toast on successful submission", async () => {
    renderSupport();
    await screen.findByRole("link", { name: "#1" });
    fireEvent.change(screen.getByPlaceholderText(/Tell us what's wrong/), {
      target: { value: "New issue" },
    });
    (apiPost as Mock).mockResolvedValue({ ok: true, ticket_id: 2 });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(await screen.findByText("Ticket #2 created")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("navigates to the existing ticket with a 'wasn't saved' notice when the server reports a duplicate", async () => {
    renderSupport(() => supportData, () => ({
      orders: [{ code: "ORD-PICK-1", status: "delivered", total: "10000", created_at_display: "2026-07-01 09:00", items: "Netflix" }],
    }));
    await screen.findByRole("link", { name: "#1" });
    fireEvent.change(screen.getByLabelText("Which order is this about? (optional)"), { target: { value: "ORD-PICK-1" } });
    fireEvent.change(screen.getByPlaceholderText(/Tell us what's wrong/), {
      target: { value: "New issue" },
    });
    (apiPost as Mock).mockResolvedValue({ ok: false, duplicate: true, ticket_id: 1 });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    // SupportPage unmounts on navigate, so a toast set on it would never
    // paint — the notice must ride router state to the destination instead.
    // TicketDetailStub renders location.state.notice if the redirect carried it.
    await screen.findByText("ticket-detail-stub");
    expect(screen.getByText("You already have an open ticket for this order. What you typed wasn't saved — redirecting you to that existing ticket.")).toBeInTheDocument();
    // Nothing was created, so the form shouldn't reset and the ticket list shouldn't refetch.
    // 2 = initial support fetch + initial account-orders fetch (order picker) only.
    expect(apiGet).toHaveBeenCalledTimes(2);
  });

  it("renders the empty state when there are no tickets", async () => {
    renderSupport(() => ({ tickets: [] }));
    expect(await screen.findByText("No support tickets yet.")).toBeInTheDocument();
  });

  // Task 10 (E4): the user was explicit that a support empty state stays
  // shelf-free — the visitor is asking for help, not shopping. Locked down so
  // a later change to EmptyState's defaults can't quietly reintroduce it.
  it("never shows a product shelf on the empty-tickets state", async () => {
    renderSupport(() => ({ tickets: [] }));
    await screen.findByText("No support tickets yet.");
    expect(screen.queryByText("You might also like")).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/p/"]')).toBeNull();
  });

  it("stops showing the loading skeleton when the fetch fails", async () => {
    renderSupport(() => {
      const err = new Error("server_error") as Error & { status?: number };
      err.status = 500;
      throw err;
    });
    await waitFor(() => expect(screen.queryByLabelText("Loading…")).not.toBeInTheDocument());
    expect(screen.queryByText("No support tickets yet.")).not.toBeInTheDocument();
  });

  // Regression: order selection used to be asked twice — a literal "Order
  // number:" line the customer typed over in the textarea, plus this
  // dropdown. The dropdown is now the only place order selection happens.
  it("starts the new-ticket textarea empty, with no order-number line to type over", async () => {
    renderSupport();
    await screen.findByRole("link", { name: "#1" });
    const textarea = screen.getByPlaceholderText(/Tell us what's wrong/) as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
    expect(textarea.placeholder).not.toContain("Order number:");
  });

  it("clears the textarea back to empty (not a re-filled template) after a successful submission", async () => {
    renderSupport();
    await screen.findByRole("link", { name: "#1" });
    const textarea = screen.getByPlaceholderText(/Tell us what's wrong/) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "New issue" } });
    (apiPost as Mock).mockResolvedValue({ ok: true, ticket_id: 2 });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("attaches a file and submits via apiPostFormWithProgress instead of apiPost", async () => {
    renderSupport();
    await screen.findByRole("link", { name: "#1" });
    fireEvent.change(screen.getByPlaceholderText(/Tell us what's wrong/), {
      target: { value: "New issue" },
    });
    const file = new File(["fake image bytes"], "evidence.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    (apiPostFormWithProgress as Mock).mockResolvedValue({ ok: true, ticket_id: 3 });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(apiPostFormWithProgress).toHaveBeenCalled());
    expect(apiPost).not.toHaveBeenCalled();
    const [path, form] = (apiPostFormWithProgress as Mock).mock.calls[0] as [string, FormData, unknown];
    expect(path).toBe("/api/v1/account/support");
    expect(form.get("message")).toBe("New issue");
    expect(form.get("attachments")).toBeInstanceOf(File);
  });

  it("shows a progress bar reflecting upload progress while an attachment is uploading", async () => {
    renderSupport();
    await screen.findByRole("link", { name: "#1" });
    fireEvent.change(screen.getByPlaceholderText(/Tell us what's wrong/), {
      target: { value: "New issue" },
    });
    const file = new File(["fake image bytes"], "evidence.png", { type: "image/png" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });

    let capturedOnProgress: ((pct: number) => void) | undefined;
    (apiPostFormWithProgress as Mock).mockImplementation(
      (_path: string, _form: FormData, onProgress: (pct: number) => void) => {
        capturedOnProgress = onProgress;
        return new Promise(() => {});
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(apiPostFormWithProgress).toHaveBeenCalled());

    act(() => capturedOnProgress?.(42));
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42"));
  });
});
