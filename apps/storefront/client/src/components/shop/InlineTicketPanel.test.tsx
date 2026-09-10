import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import InlineTicketPanel from "./InlineTicketPanel";
import { apiGet, apiPost } from "../../api/client";
import type { SupportTicketSummary, TicketDetailData } from "../../api/types";

vi.mock("../../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPostFormWithProgress: vi.fn(),
}));

const openTicket: TicketDetailData = {
  ticket: {
    id: 7,
    message: "Alight Motion login issue\nMore details on the second line",
    status: "open",
    created_at_display: "2026-07-01 09:00",
    admin_reply: null,
    replied_at_display: null,
    closed: false,
    closed_at_display: null,
    reopenable: false,
    attachments: [],
  },
  messages: [{ from_user: false, content: "We're on it", created_at_display: "2026-07-01 09:05", attachments: [] }],
  order: null,
};

const summary: SupportTicketSummary = {
  id: 7,
  message: openTicket.ticket.message,
  status: "open",
  created_at_display: "2026-07-01 09:00",
  admin_reply: null,
  attachments: [],
  subject: "Alight Motion login issue",
  order_code: "ORD-10421",
  product_name: "Alight Motion",
  updated_at_iso: "2026-07-01T09:05:00.000Z",
};

// jsdom under this repo's Vitest config exposes no `window.localStorage` at
// all (see TicketDetailPage.test.tsx's own installStorage helper for the
// same quirk) — install a minimal in-memory one so ticketDraft.ts's real
// localStorage calls have something to hit.
function installStorage(): void {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (entries.has(key) ? entries.get(key)! : null),
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

function renderPanel(
  respond: (path: string) => unknown,
  props: Partial<{ ticketId: number; summary?: SupportTicketSummary; onClose: () => void; onMutated: () => void }> = {},
) {
  (apiGet as Mock).mockImplementation(async (path: string) => respond(path));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = props.onClose ?? vi.fn();
  const onMutated = props.onMutated ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <InlineTicketPanel
          ticketId={props.ticketId ?? 7}
          summary={"summary" in props ? props.summary : summary}
          onClose={onClose}
          onMutated={onMutated}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onClose, onMutated };
}

describe("InlineTicketPanel", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    installStorage();
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
  });

  it("shows a skeleton while the ticket is loading", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    renderPanel(() => new Promise((resolve) => (resolveFetch = resolve)));
    expect(screen.getByLabelText("Loading…")).toBeInTheDocument();
    act(() => resolveFetch(openTicket));
    await waitFor(() => expect(screen.queryByLabelText("Loading…")).not.toBeInTheDocument());
  });

  it("renders the header, badge, thread, and last-updated line from the summary prop", async () => {
    renderPanel(() => openTicket);
    expect(await screen.findByText("#TK-7")).toBeInTheDocument();
    expect(screen.getByText("Alight Motion login issue")).toBeInTheDocument();
    expect(screen.getByText("Order #ORD-10421")).toBeInTheDocument();
    expect(screen.getByText("Waiting for Support")).toBeInTheDocument();
    expect(screen.getByText(/Last updated/)).toBeInTheDocument();
    expect(screen.getByText(/Created on 2026-07-01 09:00/)).toBeInTheDocument();
    // Thread renders both bubbles (subject appears once in the header, once
    // as the opening message's content in the thread).
    expect(screen.getAllByText(/Alight Motion login issue/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("We're on it")).toBeInTheDocument();
  });

  it("derives the subject from the ticket's message first line and omits last-updated when summary is absent", async () => {
    renderPanel(() => openTicket, { summary: undefined });
    expect(await screen.findByText("#TK-7")).toBeInTheDocument();
    expect(screen.getByText("Alight Motion login issue")).toBeInTheDocument();
    expect(screen.queryByText(/Last updated/)).not.toBeInTheDocument();
  });

  it("calls onClose when Back to tickets is clicked", async () => {
    const { onClose } = renderPanel(() => openTicket);
    await screen.findByText("#TK-7");
    fireEvent.click(screen.getByRole("button", { name: "Back to tickets" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("submits a reply, clears the composer, and calls onMutated", async () => {
    const { onMutated } = renderPanel(() => openTicket);
    await screen.findByText("#TK-7");
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "Still broken" } });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reply", { message: "Still broken" }),
    );
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
    expect(screen.getByPlaceholderText("Tell us what's wrong…")).toHaveValue("");
  });

  it("shows a Reopen ticket button for a closed, reopenable ticket and calls onMutated on success", async () => {
    const { onMutated } = renderPanel(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, status: "closed", closed: true, closed_at_display: "2026-07-02 09:00", reopenable: true },
    }));
    await screen.findByText("#TK-7");
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reopen ticket" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reopen", {}));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it("shows a Close ticket button once support has replied and calls onMutated on success", async () => {
    const { onMutated } = renderPanel(() => openTicket);
    await screen.findByText("#TK-7");
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Issue solved" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/close", {}));
    await waitFor(() => expect(onMutated).toHaveBeenCalled());
  });

  it("does not show Close ticket before support has replied", async () => {
    renderPanel(() => ({ ...openTicket, messages: [] }));
    await screen.findByText("#TK-7");
    expect(screen.queryByRole("button", { name: "Issue solved" })).not.toBeInTheDocument();
  });

  it("redirects to login on a 401", async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", { value: { assign: assignSpy }, writable: true });
    renderPanel(() => {
      const err = new Error("unauthorized") as Error & { status?: number };
      err.status = 401;
      throw err;
    });
    await waitFor(() => expect(assignSpy).toHaveBeenCalledWith("/login?next=%2Fhelp"));
  });

  it("renders a download link with the attachment's basename", async () => {
    renderPanel(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, attachments: ["/uploads/tickets/error-login.png"] },
    }));
    await screen.findByText("#TK-7");
    const link = screen.getByRole("link", { name: /error-login\.png/ });
    expect(link).toHaveAttribute("href", "/uploads/tickets/error-login.png");
    expect(link).toHaveAttribute("download");
  });
});
