import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

  it("debounces typed input into the q URL param", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ q: "andi", exactOrderId: null, users: [], products: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SearchPage />, { wrapper: Wrapper });
    await vi.waitFor(() => expect(screen.getByText(/no results/i)).toBeInTheDocument());

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ q: "budi", exactOrderId: null, users: [], products: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const search = screen.getByPlaceholderText(/order code, username, or product/i);
    fireEvent.change(search, { target: { value: "budi" } });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("q=budi")));
    vi.useRealTimers();
  });

  it("does not render a Search button — typing alone drives the query", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ q: "andi", exactOrderId: null, users: [], products: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(<SearchPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no results/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
  });
});
