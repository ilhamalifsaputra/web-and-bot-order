import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuditPage } from "./AuditPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const ROWS = [
  {
    id: 1,
    adminId: 42,
    action: "update_setting",
    targetType: "setting",
    targetId: "shop_name",
    details: "Changed shop name to Demo Shop",
    createdAt: "2026-06-26T10:00:00.000Z",
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("AuditPage", () => {
  it("shows audit rows fetched from /api/audit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ rows: ROWS, total: 1, page: 1, hasNext: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<AuditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("update_setting")).toBeInTheDocument());
    expect(screen.getByText("Changed shop name to Demo Shop")).toBeInTheDocument();
  });

  it("shows empty state when no rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ rows: [], total: 0, page: 1, hasNext: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    render(<AuditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no audit entries/i)).toBeInTheDocument());
  });

  it("shows error state on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<AuditPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
