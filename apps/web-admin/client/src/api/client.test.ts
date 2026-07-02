/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { apiGet, apiPost, apiPatch, apiDelete } from "./client";

beforeEach(() => {
  document.head.insertAdjacentHTML("beforeend", '<meta name="csrf-token" content="test-token">');
});
afterEach(() => {
  document.head.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("apiGet", () => {
  it("sends credentials and parses the JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ hello: "world" }) })));
    const result = await apiGet<{ hello: string }>("/api/dashboard/kpis");
    expect(result).toEqual({ hello: "world" });
    expect(fetch).toHaveBeenCalledWith("/api/dashboard/kpis", expect.objectContaining({ credentials: "include" }));
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));
    await expect(apiGet("/api/dashboard/kpis")).rejects.toThrow("403");
  });
});

describe("apiPost", () => {
  it("attaches the CSRF token read from the meta tag as an X-CSRF-Token header", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/dashboard/something", { foo: "bar" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("test-token");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ foo: "bar" });
  });
});

describe("apiPatch", () => {
  it("attaches the CSRF token as an X-CSRF-Token header and sends PATCH", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPatch("/api/catalog/denominations/10", { name: "New name" });
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/catalog/denominations/10");
    expect(init.method).toBe("PATCH");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("test-token");
    expect(JSON.parse(init.body as string)).toEqual({ name: "New name" });
  });
});

describe("apiDelete", () => {
  it("attaches the CSRF token as an X-CSRF-Token header and sends DELETE", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiDelete("/api/catalog/denominations/10");
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/catalog/denominations/10");
    expect(init.method).toBe("DELETE");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("test-token");
  });

  it("throws the server's error message on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: "Cannot delete a denomination with order history." }) })));
    await expect(apiDelete("/api/catalog/denominations/10")).rejects.toThrow("Cannot delete a denomination with order history.");
  });
});
