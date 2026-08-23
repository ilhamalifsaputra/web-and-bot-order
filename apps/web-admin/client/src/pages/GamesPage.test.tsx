import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GamesPage } from "./GamesPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const MOBILE_LEGENDS = {
  id: 1,
  slug: "mobile-legends",
  name: "Mobile Legends",
  category: "moba",
  nicknameSupported: true,
  requiresZone: true,
  requiresServer: false,
  isActive: true,
  providerMappings: [
    { id: 10, gameId: 1, provider: "kokinpay", providerGameCode: "ML001", enabled: true, priority: 0 },
  ],
};

const FREE_FIRE = {
  id: 2,
  slug: "free-fire",
  name: "Free Fire",
  category: null,
  nicknameSupported: true,
  requiresZone: false,
  requiresServer: false,
  isActive: false,
  providerMappings: [],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Mock fetch: the games GET returns `games`; every other call succeeds. */
function mockFetch(games: unknown, overrides: Record<string, Response> = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/games" && !init?.method) return jsonResponse({ games });
    const key = `${init?.method ?? "GET"} ${url}`;
    return overrides[key] ?? jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calls(fetchMock: ReturnType<typeof vi.fn>, method: string) {
  return fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === method,
  ) as [string, RequestInit][];
}

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("GamesPage", () => {
  it("lists games with their slug, category and provider-mapping count", async () => {
    mockFetch([MOBILE_LEGENDS, FREE_FIRE]);
    render(<GamesPage />, { wrapper: Wrapper });

    expect(await screen.findByText("Mobile Legends")).toBeInTheDocument();
    expect(screen.getByText("Free Fire")).toBeInTheDocument();
    expect(screen.getByText("mobile-legends")).toBeInTheDocument();
    expect(screen.getByText("moba")).toBeInTheDocument();
    expect(screen.getByText("1 provider")).toBeInTheDocument();
    expect(screen.getByText("0 providers")).toBeInTheDocument();
  });

  it("opens the create dialog from the header button", async () => {
    mockFetch([MOBILE_LEGENDS]);
    render(<GamesPage />, { wrapper: Wrapper });

    fireEvent.click(await screen.findByRole("button", { name: /add game/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("New game")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Slug")).toBeInTheDocument();
  });

  it("keeps Create disabled until both name and slug are filled in", async () => {
    const user = userEvent.setup();
    mockFetch([]);
    render(<GamesPage />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /add game/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Name"), "Genshin Impact");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Slug"), "genshin-impact");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("creates a game with the entered fields and default toggles", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch([]);
    render(<GamesPage />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /add game/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Genshin Impact");
    await user.type(within(dialog).getByLabelText("Slug"), "genshin-impact");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(calls(fetchMock, "POST").length).toBe(1));
    const [url, init] = calls(fetchMock, "POST")[0]!;
    expect(url).toBe("/api/games");
    expect(JSON.parse(String(init.body))).toEqual({
      slug: "genshin-impact",
      name: "Genshin Impact",
      category: null,
      nicknameSupported: true,
      requiresZone: false,
      requiresServer: false,
    });
  });

  it("shows the server's error when create fails", async () => {
    const user = userEvent.setup();
    mockFetch([], {
      "POST /api/games": jsonResponse({ error: 'A game with the slug "free-fire" already exists.' }, 400),
    });
    render(<GamesPage />, { wrapper: Wrapper });

    await user.click(await screen.findByRole("button", { name: /add game/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Free Fire");
    await user.type(within(dialog).getByLabelText("Slug"), "free-fire");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(await screen.findByText('A game with the slug "free-fire" already exists.')).toBeInTheDocument();
  });

  it("toggles a game active through the edit endpoint", async () => {
    const fetchMock = mockFetch([FREE_FIRE]);
    render(<GamesPage />, { wrapper: Wrapper });

    fireEvent.click(await screen.findByLabelText("Free Fire active"));

    await waitFor(() => expect(calls(fetchMock, "POST").length).toBe(1));
    const [url, init] = calls(fetchMock, "POST")[0]!;
    expect(url).toBe("/api/games/2/edit");
    expect(JSON.parse(String(init.body))).toEqual({ isActive: true });
  });

  it("offers a way in from the empty state", async () => {
    mockFetch([]);
    render(<GamesPage />, { wrapper: Wrapper });

    expect(await screen.findByText("No games yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /add game/i }).length).toBeGreaterThan(1);
  });

  it("navigates to the detail page when a row is clicked", async () => {
    const user = userEvent.setup();
    mockFetch([MOBILE_LEGENDS]);

    let location = "";
    function LocationProbe() {
      location = useLocation().pathname;
      return null;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={["/games"]}>
        <QueryClientProvider client={qc}>
          <Routes>
            <Route path="/games" element={<GamesPage />} />
            <Route path="/games/:gameId" element={<div>detail-page</div>} />
          </Routes>
          <LocationProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await user.click(await screen.findByText("Mobile Legends"));

    await waitFor(() => expect(location).toBe("/games/1"));
  });
});
