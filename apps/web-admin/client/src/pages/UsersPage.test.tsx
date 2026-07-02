import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UsersPage } from "./UsersPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const USER = {
  id: 1,
  username: "andi",
  fullName: "Andi Santoso",
  telegramId: "111",
  role: "CUSTOMER",
  banned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastSeenAt: "2026-01-02T00:00:00.000Z",
  totalSpent: { idr: "150000", usdt: "0" },
};

beforeEach(() => { vi.restoreAllMocks(); });

describe("UsersPage", () => {
  it("renders user rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ users: [USER], q: "" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByText("@andi")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument(); // avatar initial
    expect(screen.getByText("Rp150.000")).toBeInTheDocument(); // totalSpent.idr
  });

  it("shows empty state when no users", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ users: [], q: "" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no customers/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
