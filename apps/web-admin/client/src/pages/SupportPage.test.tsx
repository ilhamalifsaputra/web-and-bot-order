import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SupportPage } from "./SupportPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const TICKET = { id: 1, subject: "Order tidak sampai", status: "OPEN", createdAt: "2026-06-26T10:00:00.000Z", user: { fullName: "Budi", username: null } };

beforeEach(() => { vi.restoreAllMocks(); });

describe("SupportPage", () => {
  it("renders open tickets", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ tickets: [TICKET] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Order tidak sampai")).toBeInTheDocument());
    expect(screen.getByText("Budi")).toBeInTheDocument();
  });

  it("shows empty state when no tickets", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ tickets: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no open tickets/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<SupportPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
