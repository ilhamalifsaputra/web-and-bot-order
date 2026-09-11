import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GameDetailPage } from "./GameDetailPage";

function Wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MemoryRouter initialEntries={["/games/1"]}>
      <QueryClientProvider client={qc}>
        <Routes>
          <Route path="/games/:gameId" element={children} />
          <Route path="/games" element={<div>games-list-page</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const GAME_DETAIL = {
  game: {
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
  },
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe("GameDetailPage", () => {
  it("shows the game's own fields and its provider mappings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(GAME_DETAIL));
    render(<GameDetailPage />, { wrapper: Wrapper });

    expect(await screen.findByText("Mobile Legends")).toBeInTheDocument();
    expect(screen.getByText("mobile-legends")).toBeInTheDocument();
    expect(screen.getByText("moba")).toBeInTheDocument();
    expect(screen.getByText("KokinPay")).toBeInTheDocument();
    expect(screen.getByText("ML001")).toBeInTheDocument();
  });

  it("saves edited game fields through the edit endpoint", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/games/1" && !init?.method) return jsonResponse(GAME_DETAIL);
      return jsonResponse({ ok: true });
    });
    render(<GameDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Mobile Legends")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /edit game/i }));
    const nameInput = screen.getByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "Mobile Legends: Bang Bang");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/games/1/edit", expect.objectContaining({ method: "POST" })),
    );
    const editCall = fetchSpy.mock.calls.find(
      ([url, init]) => url === "/api/games/1/edit" && (init as RequestInit)?.method === "POST",
    )!;
    expect(JSON.parse(String((editCall[1] as RequestInit).body))).toEqual({
      name: "Mobile Legends: Bang Bang",
      slug: "mobile-legends",
      category: "moba",
      nicknameSupported: true,
      requiresZone: true,
      requiresServer: false,
      isActive: true,
    });
  });

  it("adds a mapping restricted to providers not already mapped", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/games/1" && !init?.method) return jsonResponse(GAME_DETAIL);
      return jsonResponse({ ok: true });
    });
    render(<GameDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Mobile Legends")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /add mapping/i }));
    const dialog = await screen.findByRole("dialog");
    // KokinPay is already mapped for this game — only the remaining two
    // providers should be offered.
    await user.click(within(dialog).getByRole("combobox", { name: "Provider" }));
    expect(screen.queryByRole("option", { name: "KokinPay" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "VIP-Reseller" }));

    await user.type(within(dialog).getByLabelText("Provider game code"), "ML-VIP-001");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/games/1/mappings", expect.objectContaining({ method: "POST" })),
    );
    const addCall = fetchSpy.mock.calls.find(
      ([url, init]) => url === "/api/games/1/mappings" && (init as RequestInit)?.method === "POST",
    )!;
    expect(JSON.parse(String((addCall[1] as RequestInit).body))).toEqual({
      provider: "vipreseller",
      providerGameCode: "ML-VIP-001",
      enabled: true,
      priority: 0,
    });
  });

  it("edits an existing mapping with the provider locked", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/games/1" && !init?.method) return jsonResponse(GAME_DETAIL);
      return jsonResponse({ ok: true });
    });
    render(<GameDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Mobile Legends")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for KokinPay mapping" }));
    await user.click(await screen.findByRole("menuitem", { name: /edit/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "Provider" })).toBeDisabled();
    const codeInput = within(dialog).getByLabelText("Provider game code");
    await user.clear(codeInput);
    await user.type(codeInput, "ML002");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith("/api/games/1/mappings", expect.objectContaining({ method: "POST" })),
    );
    const saveCall = fetchSpy.mock.calls.find(
      ([url, init]) => url === "/api/games/1/mappings" && (init as RequestInit)?.method === "POST",
    )!;
    expect(JSON.parse(String((saveCall[1] as RequestInit).body))).toEqual({
      provider: "kokinpay",
      providerGameCode: "ML002",
      enabled: true,
      priority: 0,
    });
  });

  it("deletes a mapping through the confirmation dialog", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/games/1" && !init?.method) return jsonResponse(GAME_DETAIL);
      return jsonResponse({ ok: true });
    });
    render(<GameDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Mobile Legends")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Actions for KokinPay mapping" }));
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/games/1/mappings/10/delete",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows the server's reason when a game still has linked products, instead of silently failing", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/games/1" && !init?.method) return jsonResponse(GAME_DETAIL);
      if (url === "/api/games/1/delete") {
        return jsonResponse(
          { error: '"Mobile Legends" is still linked to one or more products — reassign or clear their game before deleting it.' },
          400,
        );
      }
      return jsonResponse({ ok: true });
    });
    render(<GameDetailPage />, { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByText("Mobile Legends")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /delete game/i }));
    const confirmDialog = await screen.findByRole("dialog");
    await user.click(within(confirmDialog).getByRole("button", { name: "Delete" }));

    expect(
      await screen.findByText(
        '"Mobile Legends" is still linked to one or more products — reassign or clear their game before deleting it.',
      ),
    ).toBeInTheDocument();
    // The page itself is still here — the guard didn't silently navigate away.
    expect(screen.getByText("Mobile Legends")).toBeInTheDocument();
  });
});
