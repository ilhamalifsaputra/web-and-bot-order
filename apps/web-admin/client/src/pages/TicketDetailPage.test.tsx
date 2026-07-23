import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TicketDetailPage } from "./TicketDetailPage";
import { apiPost } from "../api/client";

vi.mock("../api/client", () => ({
  apiPost: vi.fn(),
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/support/1"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/support/:ticketId" element={children} />
          <Route path="/support" element={<div>support-list-page</div>} />
        </Routes>
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const ADMINS_DATA = {
  admins: [
    { id: 7, telegramId: 555, role: "ADMIN", passwordSet: true, twoFa: false, hasSession: true, name: "Rina", isSelf: false, fromEnv: false },
    { id: 9, telegramId: 111, role: "ADMIN", passwordSet: true, twoFa: false, hasSession: true, name: null, isSelf: false, fromEnv: false },
  ],
  roles: ["ADMIN", "SUPER"],
};

function ticketDetail(overrides: Partial<{
  status: string;
  priority: string;
  category: string | null;
  adminId: number | null;
  admin: { id: number; fullName: string | null; username: string | null } | null;
}> = {}) {
  return {
    ticket: {
      id: 1,
      subject: "Order tidak sampai",
      status: "OPEN",
      priority: "MEDIUM",
      category: "ORDER",
      adminId: null,
      admin: null,
      createdAt: "2026-06-26T10:00:00.000Z",
      ...overrides,
    },
    messages: [
      { id: 1, content: "Halo, order saya belum sampai.", senderType: "USER", createdAt: "2026-06-26T10:00:00.000Z", createdAtDisplay: "2026-06-26 10:00" },
    ],
    user: { id: 10, fullName: "Budi", username: null },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Routes GET fetch by URL — ticket detail vs admins list. POST mutations go
 *  through the mocked `apiPost` instead (mirrors OrderDetailPage.test.tsx). */
function mockFetchRouter(overrides: { ticket?: unknown; admins?: unknown } = {}) {
  const ticketResponse = overrides.ticket ?? ticketDetail();
  const adminsResponse = overrides.admins ?? ADMINS_DATA;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/admins")) return jsonResponse(adminsResponse);
    return jsonResponse(ticketResponse);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(apiPost).mockReset();
  vi.mocked(apiPost).mockResolvedValue({ ok: true });
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them (same shim as SupportPage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("TicketDetailPage", () => {
  it("shows the ticket subject, customer and message thread", async () => {
    mockFetchRouter();
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(screen.getByText("Halo, order saya belum sampai.")).toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load ticket/i)).toBeInTheDocument());
  });

  it("sends a reply and clears the textarea on success", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter();
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());

    const textarea = screen.getByPlaceholderText("Write a reply…");
    await user.type(textarea, "We're checking your order.");
    await user.click(screen.getByRole("button", { name: /send reply/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/reply", { content: "We're checking your order." }),
    );
    await waitFor(() => expect(textarea).toHaveValue(""));
    await waitFor(() => expect(screen.getByText("Reply sent.")).toBeInTheDocument());
  });

  it("shows a toast (not inline text) when the reply mutation fails", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter();
    vi.mocked(apiPost).mockRejectedValueOnce(new Error("error.unexpected"));
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText("Write a reply…"), "test");
    await user.click(screen.getByRole("button", { name: /send reply/i }));

    await waitFor(() => expect(screen.getByText("error.unexpected")).toBeInTheDocument());
  });

  it("closes the ticket via ConfirmDialog and navigates back to /support", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter();
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /close ticket/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^close$/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/close", {}));
    await waitFor(() => expect(screen.getByText("support-list-page")).toBeInTheDocument());
  });

  it("shows Resolve for an OPEN ticket and posts to /resolve on confirm", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter({ ticket: ticketDetail({ status: "OPEN" }) });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /^resolve$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^resolve$/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/resolve", {}));
    await waitFor(() => expect(screen.getByText("Ticket resolved.")).toBeInTheDocument());
  });

  it("hides Resolve and Close, and shows Reopen, for a CLOSED ticket", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter({ ticket: ticketDetail({ status: "CLOSED" }) });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close ticket/i })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Write a reply…")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^reopen$/i }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^reopen$/i }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/support/1/reopen", {}));
    await waitFor(() => expect(screen.getByText("Ticket reopened.")).toBeInTheDocument());
  });

  it("hides Resolve for a RESOLVED ticket (only OPEN/REPLIED are eligible)", async () => {
    mockFetchRouter({ ticket: ticketDetail({ status: "RESOLVED" }) });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^resolve$/i })).not.toBeInTheDocument();
    // RESOLVED is not CLOSED, so Reply/Close are still available.
    expect(screen.getByPlaceholderText("Write a reply…")).toBeInTheDocument();
  });

  it("changing the Priority select fires the classify mutation", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter();
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox", { name: "Priority" }));
    await user.click(await screen.findByRole("option", { name: "Urgent" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/classify", { priority: "URGENT" }),
    );
    await waitFor(() => expect(screen.getByText("Ticket classification updated.")).toBeInTheDocument());
  });

  it("changing the Category select to Uncategorized sends category: null", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter();
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());

    await user.click(screen.getByRole("combobox", { name: "Category" }));
    await user.click(await screen.findByRole("option", { name: "Uncategorized" }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/classify", { category: null }),
    );
  });

  it("Assign opens the shared dialog pre-selected to the current admin and reassigns", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockFetchRouter({ ticket: ticketDetail({ adminId: 7, admin: { id: 7, fullName: "Rina", username: null } }) });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Rina" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Assign this ticket?")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Assignee" })).toHaveTextContent("Rina");

    await user.click(within(dialog).getByRole("combobox", { name: "Assignee" }));
    await user.click(await screen.findByRole("option", { name: "Telegram ID 111" }));
    await user.click(within(dialog).getByRole("button", { name: /^confirm$/i }));

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/support/1/assign", { adminId: 9 }),
    );
    await waitFor(() => expect(screen.getByText("Ticket assigned.")).toBeInTheDocument());
  });

  it("shows a plain 'Assign' label when the ticket has no admin assigned yet", async () => {
    mockFetchRouter({ ticket: ticketDetail({ adminId: null, admin: null }) });
    render(<TicketDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Ticket #1: Order tidak sampai")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Assign" })).toBeInTheDocument();
  });
});
