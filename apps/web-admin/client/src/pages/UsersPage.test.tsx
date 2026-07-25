import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { UsersPage } from "./UsersPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function daysFromNow(n: number): string {
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

const USER = {
  id: 1,
  username: "andi",
  fullName: "Andi Santoso",
  telegramId: "111",
  role: "CUSTOMER",
  banned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdAtDisplay: "2026-01-01",
  lastSeenAt: "2026-01-02T00:00:00.000Z",
  lastSeenAtDisplay: "2026-01-02 07:00",
  totalSpent: { idr: "150000", usdt: "0" },
  orderCount: 4,
};

const BANNED_USER = {
  ...USER,
  id: 2,
  username: "budi",
  fullName: "Budi Santoso",
  telegramId: "222",
  banned: true,
  orderCount: 1,
};

const NEW_USER = {
  ...USER,
  id: 3,
  username: "citra",
  fullName: "Citra Dewi",
  telegramId: "333",
  banned: false,
  createdAt: daysFromNow(-3), // within the last 7 days — drives the New Customer badge
  orderCount: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetchRouter(overrides: {
  users?: unknown;
  onPost?: (url: string, body: unknown) => unknown;
} = {}) {
  const usersResponse = overrides.users ?? { users: [USER], q: "" };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const result = overrides.onPost?.(url, body) ?? { ok: true };
      return jsonResponse(result);
    }
    return jsonResponse(usersResponse);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("UsersPage", () => {
  it("renders user rows", async () => {
    mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByText("@andi")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument(); // avatar initial
    expect(screen.getByText("111")).toBeInTheDocument(); // telegramId, tertiary metadata
    expect(screen.getByText("Rp150.000")).toBeInTheDocument(); // totalSpent.idr
    expect(screen.getByText("2026-01-01")).toBeInTheDocument(); // createdAtDisplay
    expect(screen.getByText("2026-01-02 07:00")).toBeInTheDocument(); // lastSeenAtDisplay
    const row = screen.getByText("Andi Santoso").closest("tr")!;
    expect(within(row).getByText("4")).toBeInTheDocument(); // orderCount

    // New grouped column headers. "Customer" collides with the CUSTOMER role
    // badge's text, so scope that one lookup to a <th>.
    expect(screen.getByRole("columnheader", { name: "Customer" })).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("Spending")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Orders" })).toBeInTheDocument();
  });

  it("shows empty state when no users", async () => {
    mockFetchRouter({ users: { users: [], q: "" } });
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no customers/i)).toBeInTheDocument());
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"));
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("shows the Banned badge for a banned row, New Customer for a recently-joined row, and only the role badge otherwise", async () => {
    mockFetchRouter({ users: { users: [USER, BANNED_USER, NEW_USER], q: "" } });
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    const oldRow = screen.getByText("Andi Santoso").closest("tr")!;
    const bannedRow = screen.getByText("Budi Santoso").closest("tr")!;
    const newRow = screen.getByText("Citra Dewi").closest("tr")!;

    // USER (old, not banned): only the role badge.
    expect(within(oldRow).queryByText("Banned")).not.toBeInTheDocument();
    expect(within(oldRow).queryByText("New Customer")).not.toBeInTheDocument();

    // BANNED_USER: role badge + Banned badge, no New Customer badge.
    expect(within(bannedRow).getByText("Banned")).toBeInTheDocument();
    expect(within(bannedRow).queryByText("New Customer")).not.toBeInTheDocument();

    // NEW_USER (created within the last 7 days, not banned): New Customer badge.
    expect(within(newRow).getByText("New Customer")).toBeInTheDocument();
    expect(within(newRow).queryByText("Banned")).not.toBeInTheDocument();
  });

  it("Copy Telegram ID copies the row's Telegram ID and shows a success toast", async () => {
    // See VouchersPage.test.tsx — user-event installs the clipboard stub, so we
    // spy on its writeText rather than pre-mocking navigator.clipboard.
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for Andi Santoso" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Copy Telegram ID"));

    expect(writeText).toHaveBeenCalledWith("111");
    await waitFor(() => expect(screen.getByText("Telegram ID copied.")).toBeInTheDocument());
  });

  it("Suspend opens a confirm dialog and, on confirm, posts to /api/users/:id/ban and shows a success toast", async () => {
    const user = userEvent.setup();
    let banBody: unknown = null;
    mockFetchRouter({
      onPost: (url, body) => {
        if (url === "/api/users/1/ban") banBody = body;
        return { ok: true };
      },
    });
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for Andi Santoso" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Suspend"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Suspend this customer?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^suspend$/i }));

    await waitFor(() => expect(banBody).toEqual({ banned: "1" }));
    await waitFor(() => expect(screen.getByText("Customer suspended.")).toBeInTheDocument());
  });

  it("Unban (for an already-banned row) posts banned: \"0\" and shows a success toast", async () => {
    const user = userEvent.setup();
    let banBody: unknown = null;
    mockFetchRouter({
      users: { users: [BANNED_USER], q: "" },
      onPost: (url, body) => {
        if (url === "/api/users/2/ban") banBody = body;
        return { ok: true };
      },
    });
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Budi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for Budi Santoso" }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Unban"));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Unban this customer?")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^unban$/i }));

    await waitFor(() => expect(banBody).toEqual({ banned: "0" }));
    await waitFor(() => expect(screen.getByText("Customer unbanned.")).toBeInTheDocument());
  });
});
