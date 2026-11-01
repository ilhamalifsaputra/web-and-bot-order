import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { SessionExpiredBanner } from "../components/layout/SessionExpiredBanner";
import { apiGet, apiPost } from "./client";
import { createAppQueryClient } from "./queryClient";
import { clearSessionExpired, shouldRetryQuery } from "./sessionExpiry";

const SESSION_MESSAGE = "Your session has expired. Reload the page and log in again.";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function Poller({ path }: { path: string }) {
  const query = useQuery({ queryKey: [path], queryFn: () => apiGet(path) });
  return <p>{query.isError ? `${path}: ${(query.error as Error).message}` : "loading"}</p>;
}

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderShell(initialPath: string, children: React.ReactNode) {
  const client = createAppQueryClient();
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={client}>
        <SessionExpiredBanner />
        <Where />
        <Routes><Route path="*" element={<>{children}</>} /></Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return client;
}

beforeEach(() => {
  clearSessionExpired();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSessionExpired();
});

describe("session expiry", () => {
  it("raises one banner for several failing queries, retries none of them, and never navigates", async () => {
    const fetchSpy = vi.fn(async () => json({ error: SESSION_MESSAGE }, 401));
    vi.stubGlobal("fetch", fetchSpy);
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    renderShell("/orders", <><Poller path="/api/a" /><Poller path="/api/b" /><Poller path="/api/c" /></>);

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/session has ended/i);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // The server's message is not lost.
    expect(await screen.findByText(`/api/a: ${SESSION_MESSAGE}`)).toBeInTheDocument();
    await screen.findByText(`/api/c: ${SESSION_MESSAGE}`);
    // Exactly one request per query: a 401 is never retried (no back-off waits needed).
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // A later failing poll does not stack a second banner.
    await expect(apiGet("/api/d")).rejects.toThrow(SESSION_MESSAGE);
    expect(screen.getByTestId("where")).toHaveTextContent("/orders");
    expect(open).not.toHaveBeenCalled();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("offers Log in in a new tab and a Reload action", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: SESSION_MESSAGE }, 401)));
    renderShell("/orders", <Poller path="/api/a" />);
    const login = await screen.findByRole("link", { name: "Log in" });
    expect(login).toHaveAttribute("href", "/login");
    expect(login).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("does not retry a 401 or 403 but keeps the default retries for other failures", () => {
    expect(shouldRetryQuery(0, Object.assign(new Error("x"), { status: 401 }))).toBe(false);
    expect(shouldRetryQuery(0, Object.assign(new Error("x"), { status: 403 }))).toBe(false);
    expect(shouldRetryQuery(0, Object.assign(new Error("x"), { status: 500 }))).toBe(true);
    expect(shouldRetryQuery(2, new Error("network"))).toBe(true);
    expect(shouldRetryQuery(3, new Error("network"))).toBe(false);
  });

  it("makes exactly one request for a 401 through the real QueryClient policy", async () => {
    const fetchSpy = vi.fn(async () => json({ error: SESSION_MESSAGE }, 401));
    vi.stubGlobal("fetch", fetchSpy);
    function Once() {
      const query = useQuery({ queryKey: ["once"], queryFn: () => apiGet("/api/once") });
      return <p>{query.isError ? "failed" : "loading"}</p>;
    }
    renderShell("/orders", <Once />);
    await screen.findByText("failed");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each(["/login", "/forgot", "/reset", "/bootstrap", "/setup", "/setup/owner"])("shows no banner on %s", async (path) => {
    const fetchSpy = vi.fn(async () => json({ error: SESSION_MESSAGE }, 401));
    vi.stubGlobal("fetch", fetchSpy);
    renderShell(path, <Poller path="/api/a" />);
    await screen.findByText(`/api/a: ${SESSION_MESSAGE}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the banner once a request succeeds again", async () => {
    const fetchSpy = vi.fn(async () => json({ error: SESSION_MESSAGE }, 401));
    vi.stubGlobal("fetch", fetchSpy);
    renderShell("/orders", <p>page</p>);
    await expect(apiGet("/api/x")).rejects.toThrow(SESSION_MESSAGE);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fetchSpy.mockImplementation(async () => json({ ok: true }, 200));
    await act(async () => { await apiGet("/api/x"); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a mutation 401 raises the banner and still rejects so the form keeps its text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: SESSION_MESSAGE }, 401)));
    renderShell("/orders", <input aria-label="Reason" defaultValue="typed" />);
    await expect(apiPost("/api/orders/1/cancel", {})).rejects.toThrow(SESSION_MESSAGE);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const input = screen.getByLabelText("Reason");
    await userEvent.type(input, " more");
    expect(input).toHaveValue("typed more");
  });
});

describe("permission and CSRF messages", () => {
  it("maps a text/plain 403 to a clear permission message, not the URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => text("Forbidden", 403)));
    const failure = await apiGet("/api/users/5/wallet").catch((e: Error & { status?: number }) => e);
    expect((failure as Error).message).toMatch(/don't have permission/i);
    expect((failure as Error).message).not.toContain("/api/users/5/wallet");
    expect((failure as { status?: number }).status).toBe(403);
  });

  it("keeps a JSON 403's own message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "error.not_allowed" }, 403)));
    await expect(apiGet("/api/x")).rejects.toThrow("error.not_allowed");
  });

  it("still answers the CSRF failure body with the reload message first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => text("CSRF check failed", 403)));
    await expect(apiPost("/api/x", {})).rejects.toThrow("Your session was refreshed in another tab. Reload this page to continue.");
  });
});
