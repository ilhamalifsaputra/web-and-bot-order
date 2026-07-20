import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TicketDetailPage from "./TicketDetailPage";
import { apiGet, apiPost, apiPostForm } from "../api/client";
import type { TicketDetailData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPostForm: vi.fn(),
}));

const openTicket: TicketDetailData = {
  ticket: {
    id: 7,
    message: "It broke",
    status: "open",
    created_at_display: "2026-07-01 09:00",
    admin_reply: null,
    closed: false,
    attachments: [],
  },
  messages: [
    { from_user: true, content: "Follow up", created_at_display: "2026-07-01 09:05", attachments: [] },
  ],
};

function renderTicket(respond: () => unknown, id = "7") {
  (apiGet as Mock).mockImplementation(async () => respond());
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

describe("TicketDetailPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
  });

  it("renders the thread and posts a reply, then refetches", async () => {
    renderTicket(() => openTicket);
    expect(await screen.findByRole("heading", { name: "Ticket #7" })).toBeInTheDocument();
    expect(screen.getByText("It broke")).toBeInTheDocument();
    expect(screen.getByText("Follow up")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), {
      target: { value: "Still broken" },
    });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reply", { message: "Still broken" }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  it("hides the reply form for a closed ticket", async () => {
    renderTicket(() => ({
      ticket: { ...openTicket.ticket, status: "closed", closed: true },
      messages: [],
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.queryByPlaceholderText("Tell us what's wrong…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reply" })).not.toBeInTheDocument();
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
      ticket: { ...openTicket.ticket, attachments: ["/uploads/tickets/evidence-a.png"] },
      messages: [{ ...openTicket.messages[0]!, attachments: ["/uploads/tickets/evidence-b.mp4"] }],
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(document.querySelector('img[src="/uploads/tickets/evidence-a.png"]')).toBeInTheDocument();
    expect(document.querySelector('video[src="/uploads/tickets/evidence-b.mp4"]')).toBeInTheDocument();
  });

  it("attaches a file to a reply and submits via apiPostForm instead of apiPost", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), {
      target: { value: "Still broken" },
    });
    const file = new File(["fake video bytes"], "evidence.mp4", { type: "video/mp4" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    (apiPostForm as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(apiPostForm).toHaveBeenCalled());
    expect(apiPost).not.toHaveBeenCalled();
    const [path, form] = (apiPostForm as Mock).mock.calls[0] as [string, FormData];
    expect(path).toBe("/api/v1/account/support/7/reply");
    expect(form.get("message")).toBe("Still broken");
    expect(form.get("attachments")).toBeInstanceOf(File);
  });
});
