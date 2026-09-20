/// <reference lib="dom" />
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { apiGet, apiPost, apiPatch, apiDelete, publicPost, logout } from "./client";

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
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, text: async () => "{}" })));
    await expect(apiGet("/api/dashboard/kpis")).rejects.toThrow("403");
  });

  // Reproduces the bug: fetch() follows a 303 session/setup redirect (see
  // plugins/auth.ts and plugins/setupGate.ts) automatically, landing on a
  // 200 OK HTML page — res.ok is true, but res.json() throws a raw
  // SyntaxError. This is defense-in-depth for that (now server-fixed) case
  // and any other 2xx-non-JSON edge case.
  it("throws a clean error instead of a raw SyntaxError when a 2xx response isn't JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON');
        },
      })),
    );
    await expect(apiGet("/api/settings")).rejects.toThrow(
      "/api/settings returned an unexpected response. Reload the page and try again.",
    );
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

  it("translates a CSRF-check-failed 403 into an actionable reload message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, text: async () => "CSRF check failed" })),
    );
    await expect(apiPost("/api/dashboard/something", {})).rejects.toThrow(
      "Your session was refreshed in another tab. Reload this page to continue.",
    );
  });

  it("sends no Idempotency-Key unless one is given (the routes' opt-out)", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/dashboard/something", {});
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).has("Idempotency-Key")).toBe(false);
  });

  it("attaches the given key as an Idempotency-Key header", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/payments/order/501/refund", {}, { idempotencyKey: "9f1c-key" });
    // Fastify lowercases incoming header names, so this is what the routes
    // read as `req.headers["idempotency-key"]`.
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("idempotency-key")).toBe("9f1c-key");
  });

  it("reports a received response's status through onResponse, whatever that status is", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, text: async () => JSON.stringify({ error: "Order is no longer underpaid." }) })));
    const answered = vi.fn();
    await expect(apiPost("/api/payments/order/501/refund", {}, { onResponse: answered })).rejects.toThrow(
      "Order is no longer underpaid.",
    );
    // The status is what `useIdempotentPost` reads to tell a stored 4xx from
    // a 5xx that stored nothing.
    expect(answered).toHaveBeenCalledTimes(1);
    expect(answered).toHaveBeenCalledWith(422);

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    const ok = vi.fn();
    await apiPost("/api/payments/order/501/refund", {}, { onResponse: ok });
    expect(ok).toHaveBeenCalledTimes(1);
    expect(ok).toHaveBeenCalledWith(200);

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 504, text: async () => "" })));
    const gatewayTimeout = vi.fn();
    await expect(apiPost("/api/payments/order/501/refund", {}, { onResponse: gatewayTimeout })).rejects.toThrow("504");
    expect(gatewayTimeout).toHaveBeenCalledTimes(1);
    expect(gatewayTimeout).toHaveBeenCalledWith(504);
  });

  it("stays silent on a transport failure, where no response ever arrived", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const unanswered = vi.fn();
    await expect(apiPost("/api/payments/order/501/refund", {}, { onResponse: unanswered })).rejects.toThrow("Failed to fetch");
    expect(unanswered).not.toHaveBeenCalled();
  });
});

// P2: the figures a refusal's copy names travel with it, so `describeError` can
// print them. `message` stays the bare key — pages compare it (`=== "error.x"`)
// and `describeError` looks it up — and the args ride alongside.
describe("error_args", () => {
  it("carries a refusal's figures on the thrown error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () =>
          JSON.stringify({
            error: "error.cannot_deliver_out_of_stock",
            error_args: { product: "Mobile Legends Diamonds" },
          }),
      })),
    );
    const err = await apiPost("/api/payments/order/501/deliver", {}).catch((e: unknown) => e);
    expect((err as Error).message).toBe("error.cannot_deliver_out_of_stock");
    expect((err as { errorArgs?: unknown }).errorArgs).toEqual({ product: "Mobile Legends Diamonds" });
  });

  it("leaves errorArgs undefined when the response carries none", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ error: "error.order_not_underpaid" }),
      })),
    );
    const err = await apiPost("/api/payments/order/501/deliver", {}).catch((e: unknown) => e);
    expect((err as { errorArgs?: unknown }).errorArgs).toBeUndefined();
  });

  it("ignores an error_args that is not a flat map, so a foreign body cannot reach the DOM", async () => {
    for (const hostile of [["min", 5], "min=5", { min: { nested: 5 } }, null]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 422,
          text: async () => JSON.stringify({ error: "error.cart_too_large", error_args: hostile }),
        })),
      );
      const err = await apiPost("/api/anything", {}).catch((e: unknown) => e);
      expect((err as { errorArgs?: unknown }).errorArgs).toBeUndefined();
    }
  });

  it("accepts a number or boolean as a figure, stringified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ error: "error.cart_too_large", error_args: { limit: 50 } }),
      })),
    );
    const err = await apiPost("/api/anything", {}).catch((e: unknown) => e);
    expect((err as { errorArgs?: unknown }).errorArgs).toEqual({ limit: "50" });
  });

  it("carries them through apiGet, apiPatch and apiDelete too", async () => {
    const body = JSON.stringify({
      error: "error.text_too_long",
      error_args: { max: "500" },
    });
    for (const call of [
      () => apiGet("/api/anything"),
      () => apiPatch("/api/anything", {}),
      () => apiDelete("/api/anything"),
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 422, text: async () => body })));
      const err = await call().catch((e: unknown) => e);
      expect((err as { errorArgs?: unknown }).errorArgs).toEqual({ max: "500" });
    }
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({ error: "Cannot delete a denomination with order history." }),
      })),
    );
    await expect(apiDelete("/api/catalog/denominations/10")).rejects.toThrow(
      "Cannot delete a denomination with order history.",
    );
  });
});

// apiGet's own test above ("throws a clean error instead of a raw
// SyntaxError...") reproduces the bug for one helper; every other JSON
// helper shares the exact same `parseJsonOrThrow` guard on its success path
// (see client.ts), so a regression in any single one of them should fail a
// test too, not just apiGet's.
describe("parseJsonOrThrow guard, shared by every JSON helper", () => {
  const nonJsonRes = () => ({
    ok: true,
    json: async () => {
      throw new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON');
    },
  });

  const cases: [name: string, path: string, call: (path: string) => Promise<unknown>][] = [
    ["apiPost", "/api/settings", (path) => apiPost(path, {})],
    ["apiPatch", "/api/settings", (path) => apiPatch(path, {})],
    ["apiDelete", "/api/settings", (path) => apiDelete(path)],
    ["publicPost", "/setup/restart", (path) => publicPost(path, {})],
  ];

  it.each(cases)("%s throws a clean error instead of a raw SyntaxError on a non-JSON 2xx body", async (_name, path, call) => {
    vi.stubGlobal("fetch", vi.fn(async () => nonJsonRes()));
    await expect(call(path)).rejects.toThrow(
      `${path} returned an unexpected response. Reload the page and try again.`,
    );
  });
});

describe("logout", () => {
  it("POSTs to /logout with credentials and no CSRF header (the route doesn't require one)", async () => {
    const fetchMock = vi.fn(async (_path: string, _init: RequestInit) => ({ ok: true, status: 200, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await logout();
    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/logout");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers).toBeUndefined();
  });

  it("throws when the response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(logout()).rejects.toThrow("500");
  });
});
