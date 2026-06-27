import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SearchPage } from "./SearchPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/search?q=andi"]}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => { vi.restoreAllMocks(); });

describe("SearchPage", () => {
  it("renders user and product results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          q: "andi",
          exactOrderId: null,
          users: [{ id: 1, username: "andi", fullName: "Andi Santoso", telegramId: "111" }],
          products: [{ id: 10, name: "Netflix 1mo", product: { name: "Netflix" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SearchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByText("Netflix 1mo")).toBeInTheDocument();
  });

  it("shows no-results message for empty results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ q: "xyz", exactOrderId: null, users: [], products: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SearchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no results/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<SearchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
