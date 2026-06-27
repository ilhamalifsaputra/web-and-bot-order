import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AdminsPage } from "./AdminsPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const ADMIN = { telegramId: 12345, role: "super", passwordSet: true, twoFa: false, hasSession: true, name: "Budi", isSelf: true, fromEnv: true };

beforeEach(() => { vi.restoreAllMocks(); });

describe("AdminsPage", () => {
  it("renders admin rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ admins: [ADMIN], roles: ["super", "support", "readonly"] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<AdminsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/12345/)).toBeInTheDocument());
    expect(screen.getByText("Budi")).toBeInTheDocument();
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<AdminsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });
});
