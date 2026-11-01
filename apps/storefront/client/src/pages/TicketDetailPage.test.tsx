import "@testing-library/jest-dom/vitest";
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
    subject: "Login issue",
    ticket_number: "TKT-20260701-ABC123",
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
  support_telegram_url: "https://t.me/shopsupport",
  wa_number: null,
  tzname: "Asia/Jakarta",
};

const emptySupportList: SupportData = { tickets: [] };

function renderTicket(respond: (path: string) => unknown, id = "7", ctx: object = context) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return ctx;
    if (path === "/api/v1/account/support") return emptySupportList;
    if (path === "/api/v1/account/support/options") return { media: { enabled: true } };
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
    expect(await screen.findByRole("heading", { name: "Login issue" })).toBeInTheDocument();
    expect(screen.getByText("It broke")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "Still broken" } });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reply", { message: "Still broken", request_id: expect.any(String), attachment_ids: [] }),
    );
  });

  it("hides the composer and shows the closed banner for a closed, non-reopenable ticket", async () => {
    renderTicket(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, status: "closed", closed: true, reopenable: false },
    }));
    await screen.findByRole("heading", { name: "Login issue" });
    expect(screen.queryByPlaceholderText("Tell us what's wrong…")).not.toBeInTheDocument();
    expect(screen.getByText("This ticket is closed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen ticket" })).not.toBeInTheDocument();
  });

  it("shows a Reopen button for a closed, reopenable ticket, and reopening refetches", async () => {
    renderTicket(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, status: "closed", closed: true, closed_at_display: "2026-07-02 09:00", reopenable: true },
    }));
    await screen.findByRole("heading", { name: "Login issue" });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reopen ticket" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reopen", {}));
  });

  it("shows Issue Solved only after support has replied, and closing calls the close route", async () => {
    renderTicket(() => ({
      ...openTicket,
      messages: [{ id: 1, from_user: false, content: "try this fix", created_at_display: "2026-07-01 09:05", attachments: [] }],
    }));
    await screen.findByRole("heading", { name: "Login issue" });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Issue solved" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/close", {}));
  });

  it("does not show Issue Solved before support has replied", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Login issue" });
    expect(screen.queryByRole("button", { name: "Issue solved" })).not.toBeInTheDocument();
  });

  it("a quick-reply template fills the composer instead of submitting", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Login issue" });
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
        items: [{ id: 2, name: "Netflix", duration: "1 month", warranty_days: 30, warranty_expires_at_display: "2026-08-01 10:00", warranty_active: true }],
      },
    }));
    await screen.findByRole("heading", { name: "Login issue" });
    expect(screen.getByText("ORD-TICK-1")).toBeInTheDocument();
    expect(screen.getByText(/Netflix/)).toBeInTheDocument();
  });

  it("links the sidebar's Telegram help to support_contact, never to the bot username", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Login issue" });
    expect(screen.getByRole("link", { name: "Message us on Telegram" })).toHaveAttribute(
      "href",
      "https://t.me/shopsupport",
    );
  });

  it("hides the sidebar's Telegram help when support_contact is unset, even with a bot username", async () => {
    renderTicket(() => openTicket, "7", { ...context, support_telegram_url: null });
    await screen.findByRole("heading", { name: "Login issue" });
    expect(screen.queryByRole("link", { name: "Message us on Telegram" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href*="tokobot"]')).toBeNull();
  });

  it("shows the generic no-order sidebar text when the ticket has no linked order", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Login issue" });
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
      messages: [{ id: 3, from_user: true, content: "more", created_at_display: "2026-07-01 09:05", attachments: ["/uploads/tickets/evidence-b.mp4"] }],
    }));
    await screen.findByRole("heading", { name: "Login issue" });
    expect(document.querySelector('img[src="/uploads/tickets/evidence-a.png"]')).toBeInTheDocument();
    expect(document.querySelector('video[src="/uploads/tickets/evidence-b.mp4"]')).toBeInTheDocument();
  });

  it("uploads directly, blocks send until verification, and sends only attachment IDs", async () => {
    const requests: FakeUpload[] = [];
    class FakeUpload {
      upload = { onprogress: null as null | ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) };
      status = 200; timeout = 0;
      onload: null | (() => void) = null;
      onerror = null; ontimeout = null; onabort = null;
      open = vi.fn(); setRequestHeader = vi.fn(); abort = vi.fn();
      send() { requests.push(this); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeUpload);
    (apiPost as Mock).mockImplementation(async (path: string) => path.endsWith("/uploads") ? { id: "verified-file", url: "https://r2.example/upload", headers: { "Content-Type": "video/mp4" } } : { ok: true });
    try {
      renderTicket(() => openTicket);
      await screen.findByRole("heading", { name: "Login issue" });
      fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong\u2026"), { target: { value: "Still broken" } });
      fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [new File(["video bytes"], "evidence.mp4", { type: "video/mp4" })] } });
      await waitFor(() => expect(requests).toHaveLength(1));
      expect(screen.getByRole("button", { name: "Reply" })).toBeDisabled();
      act(() => requests[0]!.upload.onprogress!({ lengthComputable: true, loaded: 77, total: 100 }));
      expect(screen.getByRole("progressbar")).toHaveAttribute("value", "77");
      act(() => requests[0]!.onload!());
      await waitFor(() => expect(screen.getByRole("button", { name: "Reply" })).toBeEnabled());
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/uploads/verified-file/finalize", {});
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reply", { message: "Still broken", request_id: expect.any(String), attachment_ids: ["verified-file"] }));
    } finally { vi.unstubAllGlobals(); }
  });

  it("loads a saved draft into the composer on mount", async () => {
    localStorage.setItem("ticket-draft:7", "resuming my draft");
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Login issue" });
    expect(screen.getByPlaceholderText("Tell us what's wrong…")).toHaveValue("resuming my draft");
  });
});

// H4 (UI-states audit): a failed refetch used to unmount the thread and the
// composer; only a failed first load may replace the page.
describe("TicketDetailPage — failed loads", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    installStorage();
  });

  function badGateway(path: string): Error {
    const err = new Error(`${path} responded 502`) as Error & { status?: number };
    err.status = 502;
    return err;
  }
  const ticketCalls = () => (apiGet as Mock).mock.calls.filter(([p]) => p === "/api/v1/account/support/7").length;

  function renderWith(respond: (path: string) => unknown) {
    (apiGet as Mock).mockImplementation(async (path: string) => {
      if (path === "/api/v1/pages/context") return context;
      if (path === "/api/v1/account/support") return emptySupportList;
      if (path === "/api/v1/account/support/options") return { media: { enabled: true } };
      return respond(path);
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/account/support/7"]}>
          <Routes>
            <Route path="/account/support/:id" element={<TicketDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return queryClient;
  }

  it("a failed refetch keeps the thread and the typed reply, and says it could not refresh", async () => {
    let fail = false;
    const queryClient = renderWith((path) => {
      if (fail) throw badGateway(path);
      return openTicket;
    });
    await screen.findByRole("heading", { name: "Login issue" });
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "half-written reply" } });
    fail = true;
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["account-ticket", "7"] }); });

    expect(screen.getByRole("heading", { name: "Login issue" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Tell us what's wrong…")).toHaveValue("half-written reply");
    expect(await screen.findByText("Couldn't refresh. What you see may be out of date.")).toBeInTheDocument();
    const before = ticketCalls();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(ticketCalls()).toBe(before + 1));
  });

  it("a failed first load shows an error with Try again", async () => {
    renderWith((path) => { throw badGateway(path); });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    const before = ticketCalls();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(ticketCalls()).toBe(before + 1));
  });
});

// H6 (UI-states audit): crypto.randomUUID is secure-context only; calling it
// during render on plain http threw and blanked the page.
describe("TicketDetailPage on plain http", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    installStorage();
  });

  it("renders the thread when crypto.randomUUID does not exist", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    try {
      renderTicket(() => openTicket);
      expect(await screen.findByRole("heading", { name: "Login issue" })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
