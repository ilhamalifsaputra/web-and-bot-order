/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { apiGet, apiPost, publicPost, apiPostFormWithProgress } from "./client";
import { FakeXHR } from "../test/fakeXhr";

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
    const result = await apiGet<{ hello: string }>("/api/v1/pages/context");
    expect(result).toEqual({ hello: "world" });
    expect(fetch).toHaveBeenCalledWith("/api/v1/pages/context", expect.objectContaining({ credentials: "include" }));
  });

  it("throws with the HTTP status attached for redirect handling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: "unauthorized" }) })));
    const failure = apiGet("/api/v1/account");
    await expect(failure).rejects.toThrow("unauthorized");
    await failure.catch((err: Error & { status?: number }) => expect(err.status).toBe(401));
  });
});

describe("apiPost", () => {
  it("attaches the CSRF token read from the meta tag as an X-CSRF-Token header", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/v1/cart", { denomination_id: 1, qty: 2 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("test-token");
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({ denomination_id: 1, qty: 2 });
  });
});

// Guest checkout and /track mint a session in the MIDDLE of the request that
// asks for it, so the page that made the call is still holding the empty
// token an anonymous shell rendered. Without adopting the `csrf_token` those
// responses carry, every follow-up request from that page 403s — which is
// exactly the buyer who just had a checkout fail and wants to retry.
describe("csrf_token adoption", () => {
  it("uses a csrf_token from an ERROR response on the next request, replacing the empty meta token", async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="">';
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({
      ok: false,
      status: 400,
      json: async () => ({ error: "web.pay_method_unavailable", csrf_token: "guest-session-token" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiPost("/api/v1/checkout", { method: "qris" })).rejects.toThrow("web.pay_method_unavailable");
    // The failed attempt itself went out with the empty shell token.
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("X-CSRF-Token")).toBe("");

    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as never);
    await apiPost("/api/v1/checkout", { method: "binance" });
    expect(new Headers(fetchMock.mock.calls[1]![1].headers).get("X-CSRF-Token")).toBe("guest-session-token");
    // The page's own token store — the meta tag — is what was updated, so
    // every other caller (including a later apiPatch/upload) agrees.
    expect(document.querySelector('meta[name="csrf-token"]')?.getAttribute("content")).toBe("guest-session-token");
  });

  it("adopts a csrf_token from a SUCCESS response too (POST /api/v1/track)", async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="">';
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ redirect: "/account/orders/ORD1", csrf_token: "track-session-token" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await publicPost("/api/v1/track", { order_code: "ORD1", email: "a@b.com" });
    await apiPost("/api/v1/cart", {});
    expect(new Headers(fetchMock.mock.calls[1]![1].headers).get("X-CSRF-Token")).toBe("track-session-token");
  });

  it("leaves the meta-tag token in charge when no response ever carried one", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/v1/cart", {});
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("X-CSRF-Token")).toBe("test-token");
  });
});

describe("publicPost", () => {
  it("sends no CSRF header (pre-session auth endpoints)", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, json: async () => ({ redirect: "/" }) }));
    vi.stubGlobal("fetch", fetchMock);
    await publicPost("/api/v1/auth/login", { identifier: "a", password: "b" });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBeNull();
    expect(init.credentials).toBe("include");
  });

  it("throws the server's error message on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: "login_failed" }) })));
    await expect(publicPost("/api/v1/auth/login", {})).rejects.toThrow("login_failed");
  });
});

describe("apiPostFormWithProgress", () => {
  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXHR as unknown as typeof XMLHttpRequest);
  });

  it("attaches the CSRF header, reports upload progress, and resolves with the parsed JSON body", async () => {
    const form = new FormData();
    form.append("message", "help");
    const onProgress = vi.fn();
    const promise = apiPostFormWithProgress<{ ok: boolean }>("/api/v1/account/support", form, onProgress);

    const xhr = FakeXHR.instances[0]!;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/v1/account/support");
    expect(xhr.requestHeaders["X-CSRF-Token"]).toBe("test-token");
    expect(xhr.sentBody).toBe(form);

    xhr.progress(50, 100);
    expect(onProgress).toHaveBeenCalledWith(50);

    xhr.respond(200, JSON.stringify({ ok: true }));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("rejects with the server's error message on failure", async () => {
    const promise = apiPostFormWithProgress("/api/v1/account/support", new FormData(), vi.fn());
    FakeXHR.instances[0]!.respond(413, JSON.stringify({ error: "That file is too large." }));
    await expect(promise).rejects.toThrow("That file is too large.");
  });
});
