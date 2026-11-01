import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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

  it("gives the inline 'Add Admin' Telegram ID field a persistent visible label (F-006)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ admins: [ADMIN], roles: ["super", "support", "readonly"] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<AdminsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());
    expect(screen.getByLabelText(/telegram id/i)).toBeInTheDocument();
  });
});

describe("AdminsPage pending add", () => {
  it("keeps the Add Admin label on a busy, disabled button while adding", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ admins: [ADMIN], roles: ["super", "support", "readonly"] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<AdminsPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());
    spy.mockImplementation(() => new Promise(() => {}));
    fireEvent.change(screen.getByLabelText(/telegram id/i), { target: { value: "999" } });
    fireEvent.click(screen.getByRole("button", { name: /add admin/i }));
    const button = await screen.findByRole("button", { name: /add admin/i });
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeDisabled();
  });
});
