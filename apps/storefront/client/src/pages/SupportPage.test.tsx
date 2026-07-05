import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SupportPage from "./SupportPage";
import { apiGet, apiPost } from "../api/client";
import type { SupportData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

const supportData: SupportData = {
  tickets: [
    { id: 1, message: "Help please", status: "open", created_at_display: "2026-07-01 09:00", admin_reply: null },
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
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support", { message: "New issue" }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
  });

  it("renders the empty state when there are no tickets", async () => {
    renderSupport(() => ({ tickets: [] }));
    expect(await screen.findByText("No support tickets yet.")).toBeInTheDocument();
  });
});
