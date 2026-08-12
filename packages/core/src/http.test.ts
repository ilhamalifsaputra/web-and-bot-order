import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout, fetchWithTimeoutSafe, HttpTimeoutError, HTTP_TIMEOUT_MS } from "./http";

describe("HTTP_TIMEOUT_MS", () => {
  it("exposes the three per-call-site budgets used across every gateway client", () => {
    expect(HTTP_TIMEOUT_MS.gatewayRead).toBe(10_000);
    expect(HTTP_TIMEOUT_MS.gatewayWrite).toBe(15_000);
    expect(HTTP_TIMEOUT_MS.explorerRead).toBe(8_000);
  });
});

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("passes a real AbortSignal through to fetch so a hung peer is bounded", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithTimeout("https://example.com", { timeoutMs: 5_000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards the rest of init (method/headers/body) unchanged", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await fetchWithTimeout("https://example.com", {
      timeoutMs: 5_000,
      method: "POST",
      headers: { "x-api-key": "k" },
      body: "payload",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.com");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "x-api-key": "k" });
    expect(init.body).toBe("payload");
  });

  it("rejects with HttpTimeoutError, whose message never echoes the request, once the signal fires", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        // Simulate what undici does once AbortSignal.timeout fires: the
        // fetch promise rejects with the signal's own abort reason, a
        // DOMException named "TimeoutError".
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
        });
      }),
    );
    await expect(fetchWithTimeout("https://example.com/?secret=leak-me", { timeoutMs: 1 })).rejects.toBeInstanceOf(
      HttpTimeoutError,
    );
    let caught: unknown;
    try {
      await fetchWithTimeout("https://example.com/?secret=leak-me", { timeoutMs: 1 });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).not.toContain("leak-me");
    expect((caught as Error).message).toMatch(/timed out/);
  });

  it("passes through a non-timeout rejection (DNS/connection failure) unchanged", async () => {
    const original = new Error("connect ECONNREFUSED");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(original));
    await expect(fetchWithTimeout("https://example.com", { timeoutMs: 5_000 })).rejects.toBe(original);
  });
});

describe("fetchWithTimeoutSafe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the Response unchanged on success", async () => {
    const response = { ok: true, status: 200 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(fetchWithTimeoutSafe("https://example.com", { timeoutMs: 5_000 }, "Gateway request")).resolves.toBe(
      response,
    );
  });

  it("replaces a header-credential-bearing rejection with a brand-new, cause-free error built only from the prefix", async () => {
    const original = Object.assign(new Error("fetch failed"), {
      cause: { request: { headers: { "x-api-key": "LEAKED-SECRET" }, url: "https://example.com/?token=LEAKED-SECRET" } },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(original));
    let caught: unknown;
    try {
      await fetchWithTimeoutSafe("https://example.com/?token=LEAKED-SECRET", { timeoutMs: 5_000 }, "Gateway request");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(original);
    expect((caught as Error).cause).toBeUndefined();
    expect((caught as Error).message).not.toContain("LEAKED-SECRET");
    expect((caught as Error).message).not.toContain("example.com");
    expect((caught as Error).message).toMatch(/^Gateway request /);
  });

  it("distinguishes a timeout from a network error in the sanitized message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
        });
      }),
    );
    let caught: unknown;
    try {
      await fetchWithTimeoutSafe("https://example.com", { timeoutMs: 1 }, "Gateway request");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("Gateway request timed out");
  });

  it("labels a genuine network failure distinctly from a timeout", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    let caught: unknown;
    try {
      await fetchWithTimeoutSafe("https://example.com", { timeoutMs: 5_000 }, "Gateway request");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("Gateway request network error");
  });
});
