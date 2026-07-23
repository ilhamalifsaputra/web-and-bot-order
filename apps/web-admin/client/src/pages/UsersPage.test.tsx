import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UsersPage } from "./UsersPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function LocationSearchDisplay() {
  const location = useLocation();
  return <div data-testid="url-search">{location.search}</div>;
}

/** Same as Wrapper, but also exposes the current URL's search string via a
 * `data-testid="url-search"` element — for asserting the debounced search
 * value round-trips into the URL. */
function WrapperWithLocation({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/users"]}>
      <QueryClientProvider client={qc}>
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </QueryClientProvider>
      <LocationSearchDisplay />
    </MemoryRouter>
  );
}

/** Wrapper seeded with a `?q=...` URL — for asserting the search box
 * pre-fills from the URL on load. */
function wrapperWithInitialQuery(q: string) {
  return function InitialQueryWrapper({ children }: { children: React.ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <MemoryRouter initialEntries={[`/users?q=${q}`]}>
        <QueryClientProvider client={qc}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </QueryClientProvider>
      </MemoryRouter>
    );
  };
}

const KPIS_DATA = {
  totalCustomers: 42,
  newToday: 3,
  activeToday: 10,
  returningCustomers: 5,
  totalRevenue: { idr: "5000000", usdt: "120.5" },
};

// Andi: full identity, non-zero IDR spend, >=2 delivered orders (RETURNING badge).
const USER_ANDI = {
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
  totalOrders: 5,
  deliveredOrders: 3,
  lastOrderAt: "2026-01-05T00:00:00.000Z",
  lastOrderAtDisplay: "2026-01-05",
};

// Budi: no username/fullName/telegramId at all, banned, USDT-only spend
// (zero IDR must be filtered out of the Total Spent cell).
const USER_BUDI = {
  id: 2,
  username: null,
  fullName: null,
  telegramId: null,
  role: "RESELLER",
  banned: true,
  createdAt: "2026-01-03T00:00:00.000Z",
  createdAtDisplay: "2026-01-03",
  lastSeenAt: null,
  lastSeenAtDisplay: null,
  totalSpent: { idr: "0", usdt: "20.5" },
  totalOrders: 0,
  deliveredOrders: 0,
  lastOrderAt: null,
  lastOrderAtDisplay: null,
};

// Citra: fullName only (no username/telegramId — View Orders must fall back
// to fullName), zero spend in both currencies (Total Spent shows a dash).
const USER_CITRA = {
  id: 3,
  username: null,
  fullName: "Citra Dewi",
  telegramId: null,
  role: "CUSTOMER",
  banned: false,
  createdAt: "2026-01-04T00:00:00.000Z",
  createdAtDisplay: "2026-01-04",
  lastSeenAt: "2026-01-05T00:00:00.000Z",
  lastSeenAtDisplay: "2026-01-05 09:00",
  totalSpent: { idr: "0", usdt: "0" },
  totalOrders: 1,
  deliveredOrders: 1,
  lastOrderAt: null,
  lastOrderAtDisplay: null,
};

const USERS_DATA = {
  users: [USER_ANDI, USER_BUDI, USER_CITRA],
  total: 3,
  page: 1,
  pageSize: 20,
  hasNext: false,
  roles: ["CUSTOMER", "RESELLER"],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Routes fetch by URL — the page fires two GET requests on mount (customers
 *  list + kpis) whose relative order isn't guaranteed, so tests match by URL
 *  instead of call sequence (mirrors OrdersPage.test.tsx's mockFetchRouter). */
function mockFetchRouter(overrides: { users?: unknown; kpis?: unknown } = {}) {
  const usersResponse = overrides.users ?? USERS_DATA;
  const kpisResponse = overrides.kpis ?? KPIS_DATA;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/users/kpis")) return jsonResponse(kpisResponse);
    return jsonResponse(usersResponse);
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Radix Select uses pointer-capture APIs and scrollIntoView — jsdom doesn't
  // implement them (same convention as OrdersPage.test.tsx).
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("UsersPage", () => {
  it("renders customer rows with full name, username, avatar initial, and Telegram ID as its own column", async () => {
    mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByText("@andi")).toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument(); // avatar fallback initial
    expect(screen.getByText("111")).toBeInTheDocument(); // Telegram ID, its own cell
  });

  it("filters zero-valued currencies out of Total Spent (no currency line, or a dash when everything is zero)", async () => {
    mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    // Budi: idr "0" / usdt "20.5" — USDT line renders, no "Rp0" anywhere.
    // (The KPI row also renders a "120.5 USDT" line — match the exact text
    // so the two don't collide.)
    expect(screen.getByText("20.5 USDT")).toBeInTheDocument();
    expect(screen.queryByText("Rp0")).not.toBeInTheDocument();

    // Citra: both currencies zero — Total Spent cell (column index 7: select,
    // customer, telegramId, role, status, joined, lastSeen, totalSpent, ...)
    // falls back to a dash rather than any currency line.
    const citraRow = screen.getByText("Citra Dewi").closest("tr")!;
    const citraCells = within(citraRow).getAllByRole("cell");
    expect(citraCells[7]).toHaveTextContent("—");
  });

  it("only sends structured filters (Role, Status, dates, Sort) to the server after Apply is clicked, not on every selection", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    fetchSpy.mockClear();

    const roleSelect = screen.getByRole("combobox", { name: "Role" });
    await user.click(roleSelect);
    await user.click(await screen.findByRole("option", { name: "Reseller" }));
    expect(fetchSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/users?role=RESELLER", { credentials: "include" }),
    );
  });

  it("commits search live after a short debounce, with no Apply click needed", async () => {
    // Explicit timeout: this test guarantees a ~300ms debounce wait plus
    // several userEvent interactions afterward, which can exceed vitest's
    // default 5000ms test timeout on a loaded machine even though each
    // individual step is fast.
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    fetchSpy.mockClear();

    const search = screen.getByPlaceholderText("Search by name, username, Telegram ID…");
    await user.type(search, "andi");

    // Debounced, not immediate — but no Apply click is involved at all.
    await waitFor(
      () => expect(fetchSpy).toHaveBeenCalledWith("/api/users?q=andi", { credentials: "include" }),
      { timeout: 2000 },
    );

    // A structured filter selected afterwards still requires Apply, and the
    // live search value already committed is preserved alongside it.
    fetchSpy.mockClear();
    const roleSelect = screen.getByRole("combobox", { name: "Role" });
    await user.click(roleSelect);
    await user.click(await screen.findByRole("option", { name: "Reseller" }));
    expect(fetchSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/users?q=andi&role=RESELLER", { credentials: "include" }),
    );
  }, 10000);

  it("syncs the debounced search value to the URL as ?q=..., and clears it (input + URL) on Clear Filters", async () => {
    const user = userEvent.setup();
    mockFetchRouter();
    render(<UsersPage />, { wrapper: WrapperWithLocation });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByTestId("url-search")).toHaveTextContent("");

    const search = screen.getByPlaceholderText("Search by name, username, Telegram ID…");
    await user.type(search, "andi");

    await waitFor(
      () => expect(screen.getByTestId("url-search")).toHaveTextContent("?q=andi"),
      { timeout: 2000 },
    );

    await user.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => expect(screen.getByTestId("url-search")).toHaveTextContent(""));
    expect(search).toHaveValue("");
  }, 10000);

  it("pre-fills the search box (and the query sent to the server) from a ?q= URL param on load", async () => {
    const fetchSpy = mockFetchRouter();
    render(<UsersPage />, { wrapper: wrapperWithInitialQuery("andi") });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    expect(screen.getByPlaceholderText("Search by name, username, Telegram ID…")).toHaveValue("andi");
    expect(fetchSpy).toHaveBeenCalledWith("/api/users?q=andi", { credentials: "include" });
  });

  it("shows a meaningful fallback for missing customer identity, never a bare dash", async () => {
    const noNameNoUsername = { ...USER_BUDI };
    const usernameOnly = { ...USER_ANDI, id: 4, fullName: null, username: "onlyhandle" };
    mockFetchRouter({
      users: {
        users: [noNameNoUsername, usernameOnly],
        total: 2,
        page: 1,
        pageSize: 20,
        hasNext: false,
        roles: ["CUSTOMER", "RESELLER"],
      },
    });
    render(<UsersPage />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByText("Unknown Customer")).toBeInTheDocument());
    // Username stands in as the primary line when there's no full name — not
    // duplicated as a secondary line too.
    expect(screen.getByText("@onlyhandle")).toBeInTheDocument();

    const unknownRow = screen.getByText("Unknown Customer").closest("tr")!;
    const customerCell = within(unknownRow).getAllByRole("cell")[1]!;
    expect(customerCell).not.toHaveTextContent("—");
  });

  it("wires the Sort select through to the sort query param, using the exact 'Highest Spender (IDR)' label", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    fetchSpy.mockClear();

    const sortSelect = screen.getByRole("combobox", { name: "Sort" });
    await user.click(sortSelect);
    await user.click(await screen.findByRole("option", { name: "Highest Spender (IDR)" }));
    await user.click(screen.getByRole("button", { name: /^apply$/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/users?sort=spend", { credentials: "include" }));
  });

  it("row checkbox selection surfaces the sticky bulk bar with an Export link containing ids=, and Clear hides it", async () => {
    const user = userEvent.setup();
    mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("checkbox", { name: /select customer andi santoso/i }));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    const exportLink = screen.getByRole("link", { name: /^export$/i });
    expect(exportLink).toHaveAttribute("href", expect.stringContaining("ids=1"));

    // Scope to the sticky bulk bar — the FilterBar also has its own
    // permanently-visible "Clear" button.
    const bulkBar = screen.getByText("1 selected").closest("div")!;
    await user.click(within(bulkBar).getByRole("button", { name: /^clear$/i }));
    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });

  it("row action menu: View Customer always present, View Orders present only when an identifier resolves, and navigates to /orders?q=...", async () => {
    const user = userEvent.setup();
    mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    // Andi has a telegramId — View Orders present.
    await user.click(screen.getByRole("button", { name: /actions for andi santoso/i }));
    let menu = await screen.findByRole("menu");
    expect(within(menu).getByText("View Customer")).toBeInTheDocument();
    expect(within(menu).getByText("View Orders")).toBeInTheDocument();
    expect(within(menu).getByText("Transactions")).toBeInTheDocument();
    expect(within(menu).getByText("Support Tickets")).toBeInTheDocument();
    await user.click(within(menu).getByText("View Orders"));

    // Budi has no telegramId, username, or fullName — View Orders absent.
    await user.click(screen.getByRole("button", { name: /actions for 2/i }));
    menu = await screen.findByRole("menu");
    expect(within(menu).getByText("View Customer")).toBeInTheDocument();
    expect(within(menu).queryByText("View Orders")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Copy Telegram ID")).not.toBeInTheDocument();
  });

  it("row action menu: Copy Telegram ID copies to the clipboard and shows a success toast, only when telegramId is present", async () => {
    // `userEvent.setup()` installs its own working clipboard stub on
    // `navigator.clipboard` (jsdom has no real implementation) — spy on that
    // stub's writeText rather than pre-mocking navigator.clipboard ourselves
    // (mirrors VouchersPage.test.tsx's "copies the voucher code" test).
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    mockFetchRouter();
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /actions for andi santoso/i }));
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByText("Copy Telegram ID"));

    expect(writeText).toHaveBeenCalledWith("111");
    await waitFor(() => expect(screen.getByText("Telegram ID copied.")).toBeInTheDocument());
  });

  it("shows 'No customers yet' with no Clear Filters action when genuinely empty", async () => {
    mockFetchRouter({ users: { users: [], total: 0, page: 1, pageSize: 20, hasNext: false, roles: [] } });
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("No customers yet")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("shows 'No customers match these filters.' with a working Clear Filters action once a filter is active", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter({ users: { users: [], total: 0, page: 1, pageSize: 20, hasNext: false, roles: ["CUSTOMER", "RESELLER"] } });
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/no customers/i)).toBeInTheDocument());

    const search = screen.getByPlaceholderText("Search by name, username, Telegram ID…");
    await user.type(search, "zzz");

    await waitFor(
      () => expect(screen.getByText("No customers match these filters.")).toBeInTheDocument(),
      { timeout: 2000 },
    );
    const clearFiltersButton = screen.getByRole("button", { name: /clear filters/i });

    fetchSpy.mockClear();
    await user.click(clearFiltersButton);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/users?", { credentials: "include" }));
  });

  it("renders Pagination once data.total is present, and changing page size resets to page 1", async () => {
    const user = userEvent.setup();
    const fetchSpy = mockFetchRouter({
      users: { users: [USER_ANDI], total: 120, page: 2, pageSize: 20, hasNext: true, roles: ["CUSTOMER", "RESELLER"] },
    });
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
    expect(screen.getByText(/Showing/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Go to page 2" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/users?page=2", { credentials: "include" }));

    await user.click(screen.getByRole("combobox", { name: /rows per page/i }));
    await user.click(await screen.findByText("50 / page"));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith("/api/users?pageSize=50", { credentials: "include" }));
  });

  it("shows error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    render(<UsersPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  it("shows loading skeleton state before data resolves", async () => {
    let resolveFetch: (v: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/users/kpis")) return jsonResponse(KPIS_DATA);
      return pending;
    });
    render(<UsersPage />, { wrapper: Wrapper });
    // Still loading — the row data isn't rendered yet.
    expect(screen.queryByText("Andi Santoso")).not.toBeInTheDocument();
    resolveFetch!(jsonResponse(USERS_DATA));
    await waitFor(() => expect(screen.getByText("Andi Santoso")).toBeInTheDocument());
  });
});
