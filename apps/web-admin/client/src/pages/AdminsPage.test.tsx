import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
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

describe("AdminsPage — failed loads keep the page usable", () => {
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }
  function renderWithClient() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>
          <AdminsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    return qc;
  }

  it("a failed first load shows Retry and keeps the Add Admin form; Retry loads the rows", async () => {
    let failing = true;
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return failing ? json({ error: "Database unavailable" }, 500) : json({ admins: [ADMIN], roles: ["super"] });
    });
    renderWithClient();

    expect(await screen.findByText("Failed to load admins.")).toBeInTheDocument();
    expect(screen.getByLabelText(/telegram id/i)).toBeInTheDocument();
    expect(calls).toBe(1);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());
    expect(calls).toBe(2);
    expect(screen.queryByText("Failed to load admins.")).not.toBeInTheDocument();
  });

  it("a failed refresh keeps the rows and the typed Telegram ID, with a Couldn't refresh notice and Retry", async () => {
    let failing = false;
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return failing ? json({ error: "Database unavailable" }, 500) : json({ admins: [ADMIN], roles: ["super"] });
    });
    const qc = renderWithClient();
    await waitFor(() => expect(screen.getByText("Budi")).toBeInTheDocument());
    const field = screen.getByLabelText(/telegram id/i);
    fireEvent.change(field, { target: { value: "999" } });

    failing = true;
    await act(async () => { await qc.refetchQueries({ queryKey: ["admins"] }); });
    expect(await screen.findByText(/Couldn't refresh admins/)).toBeInTheDocument();
    expect(screen.getByLabelText(/telegram id/i)).toBe(field);
    expect(field).toHaveValue("999");
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(calls).toBe(2);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Couldn't refresh admins/)).not.toBeInTheDocument());
    expect(calls).toBe(3);
    expect(field).toHaveValue("999");
  });
});
