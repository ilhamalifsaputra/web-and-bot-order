import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
    },
  ],
};

function renderSupport(respond: () => unknown = () => supportData) {
  (apiGet as Mock).mockImplementation(async () => respond());
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/account/support"]}>
        <Routes>
          <Route path="/account/support" element={<SupportPage />} />
          <Route path="/account/support/:id" element={<div>ticket-detail-stub</div>} />
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
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), {
      target: { value: "New issue" },
    });
    (apiPost as Mock).mockResolvedValue({ ok: true, ticket_id: 2 });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support", { message: "New issue" }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  // STO-020: submitting used to only clear the textbox and silently add a
  // table row — a toast should confirm the ticket was actually created.
  it("shows a 'Ticket #N created' toast on successful submission", async () => {
    renderSupport();
    await screen.findByRole("link", { name: "#1" });
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), {
      target: { value: "New issue" },
    });
    (apiPost as Mock).mockResolvedValue({ ok: true, ticket_id: 2 });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(await screen.findByText("Ticket #2 created")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders the empty state when there are no tickets", async () => {
    renderSupport(() => ({ tickets: [] }));
    expect(await screen.findByText("No support tickets yet.")).toBeInTheDocument();
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

  it("pre-fills the new-ticket textarea with a template skeleton", async () => {
    renderSupport();
    await screen.findByRole("link", { name: "#1" });
    const textarea = screen.getByPlaceholderText("Tell us what's wrong…") as HTMLTextAreaElement;
    expect(textarea.value).toContain("Order number:");
  });

  it("attaches a file and submits via apiPostFormWithProgress instead of apiPost", async () => {
    renderSupport();
    await screen.findByRole("link", { name: "#1" });
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), {
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
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), {
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
