import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TicketDetailPage from "./TicketDetailPage";
import { apiGet, apiPost, apiPostFormWithProgress } from "../api/client";
import type { SupportData, TicketDetailData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPostFormWithProgress: vi.fn(),
}));

const openTicket: TicketDetailData = {
  ticket: {
    id: 7,
    message: "It broke",
    status: "open",
    created_at_display: "2026-07-01 09:00",
    admin_reply: null,
    replied_at_display: null,
    closed: false,
    closed_at_display: null,
    reopenable: false,
    attachments: [],
  },
  messages: [],
  order: null,
};

const context = {
  lang: "en",
  fx: null,
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: { username: "alice", email: null, telegram_linked: false },
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  tzname: "Asia/Jakarta",
};

const emptySupportList: SupportData = { tickets: [] };

function renderTicket(respond: (path: string) => unknown, id = "7") {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    if (path === "/api/v1/account/support") return emptySupportList;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/account/support/${id}`]}>
        <Routes>
          <Route path="/account/support/:id" element={<TicketDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// jsdom under this repo's Vitest config exposes no `window.localStorage` at
// all (see apps/storefront/client/src/pages/SearchPage.test.tsx's own
// installStorage helper for the same quirk) — install a minimal in-memory
// one so ticketDraft.ts's real localStorage calls have something to hit.
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

describe("TicketDetailPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    installStorage();
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
  });

  it("renders the thread (opening message included) and posts a reply, then refetches", async () => {
    renderTicket(() => openTicket);
    expect(await screen.findByRole("heading", { name: "Ticket #7" })).toBeInTheDocument();
    expect(screen.getByText("It broke")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "Still broken" } });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reply", { message: "Still broken" }),
    );
  });

  it("hides the composer and shows the closed banner for a closed, non-reopenable ticket", async () => {
    renderTicket(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, status: "closed", closed: true, reopenable: false },
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.queryByPlaceholderText("Tell us what's wrong…")).not.toBeInTheDocument();
    expect(screen.getByText("This ticket is closed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen ticket" })).not.toBeInTheDocument();
  });

  it("shows a Reopen button for a closed, reopenable ticket, and reopening refetches", async () => {
    renderTicket(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, status: "closed", closed: true, closed_at_display: "2026-07-02 09:00", reopenable: true },
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reopen ticket" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reopen", {}));
  });

  it("shows Issue Solved only after support has replied, and closing calls the close route", async () => {
    renderTicket(() => ({
      ...openTicket,
      messages: [{ from_user: false, content: "try this fix", created_at_display: "2026-07-01 09:05", attachments: [] }],
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Issue solved" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/close", {}));
  });

  it("does not show Issue Solved before support has replied", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.queryByRole("button", { name: "Issue solved" })).not.toBeInTheDocument();
  });

  it("a quick-reply template fills the composer instead of submitting", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    fireEvent.click(screen.getByRole("button", { name: "Request a refund" }));
    expect(screen.getByPlaceholderText("Tell us what's wrong…")).toHaveValue(
      "I'd like to request a refund for this order. Reason: ",
    );
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("renders the linked order summary in the sidebar when the ticket has one", async () => {
    renderTicket(() => ({
      ...openTicket,
      order: {
        code: "ORD-TICK-1",
        status: "delivered",
        created_at_display: "2026-07-01 10:00",
        paid_at_display: "2026-07-01 10:01",
        payment_method: "BINANCE_PAY",
        total: "158000",
        voucher_code: null,
        delivered: true,
        items: [{ name: "Netflix", duration: "1 month", warranty_days: 30, warranty_expires_at_display: "2026-08-01 10:00", warranty_active: true }],
      },
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.getByText("ORD-TICK-1")).toBeInTheDocument();
    expect(screen.getByText(/Netflix/)).toBeInTheDocument();
  });

  it("shows the generic no-order sidebar text when the ticket has no linked order", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.getByText("This ticket isn't linked to a specific order.")).toBeInTheDocument();
  });

  it("renders ErrorPage on a 404", async () => {
    renderTicket(() => {
      const err = new Error("not_found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    expect(await screen.findByText("404")).toBeInTheDocument();
  });

  it("renders evidence attachments on the initial message and thread", async () => {
    renderTicket(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, attachments: ["/uploads/tickets/evidence-a.png"] },
      messages: [{ from_user: true, content: "more", created_at_display: "2026-07-01 09:05", attachments: ["/uploads/tickets/evidence-b.mp4"] }],
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(document.querySelector('img[src="/uploads/tickets/evidence-a.png"]')).toBeInTheDocument();
    expect(document.querySelector('video[src="/uploads/tickets/evidence-b.mp4"]')).toBeInTheDocument();
  });

  it("attaches a file to a reply and submits via apiPostFormWithProgress instead of apiPost", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "Still broken" } });
    const file = new File(["fake video bytes"], "evidence.mp4", { type: "video/mp4" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    (apiPostFormWithProgress as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(apiPostFormWithProgress).toHaveBeenCalled());
    expect(apiPost).not.toHaveBeenCalled();
    const [path, form] = (apiPostFormWithProgress as Mock).mock.calls[0] as [string, FormData, unknown];
    expect(path).toBe("/api/v1/account/support/7/reply");
    expect(form.get("message")).toBe("Still broken");
    expect(form.get("attachments")).toBeInstanceOf(File);
  });

  it("shows a progress bar reflecting upload progress while a reply attachment is uploading", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "Still broken" } });
    const file = new File(["fake video bytes"], "evidence.mp4", { type: "video/mp4" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });

    let capturedOnProgress: ((pct: number) => void) | undefined;
    (apiPostFormWithProgress as Mock).mockImplementation(
      (_path: string, _form: FormData, onProgress: (pct: number) => void) => {
        capturedOnProgress = onProgress;
        return new Promise(() => {});
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(apiPostFormWithProgress).toHaveBeenCalled());

    act(() => capturedOnProgress?.(77));
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "77"));
  });

  it("loads a saved draft into the composer on mount", async () => {
    localStorage.setItem("ticket-draft:7", "resuming my draft");
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.getByPlaceholderText("Tell us what's wrong…")).toHaveValue("resuming my draft");
  });
});
