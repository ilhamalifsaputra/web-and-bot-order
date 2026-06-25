/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { apiGet, apiPost } from "./client";

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
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403 })));
    await expect(apiGet("/api/dashboard/kpis")).rejects.toThrow("403");
  });
});

describe("apiPost", () => {
  it("attaches the CSRF token read from the meta tag as an X-CSRF-Token header", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/dashboard/something", { foo: "bar" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/something",
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({ "X-CSRF-Token": "test-token" }),
      }),
    );
  });
});
