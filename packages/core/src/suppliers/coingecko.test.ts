import { describe, it, expect, vi, afterEach } from "vitest";
import { Decimal } from "../money";
import { fetchTetherIdrPrice } from "./coingecko";

function stubFetch(payload: unknown, opts: { ok?: boolean; status?: number; throwOnJson?: Error } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => {
        if (opts.throwOnJson) {
          throw opts.throwOnJson;
        }
        return payload;
      },
    }),
  );
}

function stubFetchReject(error: Error) {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
}

describe("fetchTetherIdrPrice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("success: resolves to a Decimal equal to 16350", async () => {
    stubFetch({ tether: { idr: 16350 } });
    const result = await fetchTetherIdrPrice();
    expect(result).toEqual(new Decimal(16350));
  });

  it("HTTP 429 rejects with rate-limited message", async () => {
    stubFetch({}, { ok: false, status: 429 });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/rate-limited/);
  });

  it("HTTP 500 rejects with HTTP status message", async () => {
    stubFetch({}, { ok: false, status: 500 });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/HTTP 500/);
  });

  it("HTTP 502 rejects with HTTP status message", async () => {
    stubFetch({}, { ok: false, status: 502 });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/HTTP 502/);
  });

  it("res.json() throws a plain SyntaxError, rejects with unparseable message", async () => {
    const error = new SyntaxError("Unexpected token < in JSON");
    stubFetch({}, { throwOnJson: error });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/unparseable/);
  });

  it("res.json() throws TimeoutError, rejects with timed out message (not unparseable)", async () => {
    const error = Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
    stubFetch({}, { throwOnJson: error });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/timed out/);
    // Also verify it doesn't say unparseable
    try {
      await fetchTetherIdrPrice();
    } catch (err) {
      expect((err as Error).message).not.toMatch(/unparseable/);
    }
  });

  it("missing tether.idr ({}) rejects with no usable message", async () => {
    stubFetch({});
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/no usable/);
  });

  it("missing tether.idr ({ tether: {} }) rejects with no usable message", async () => {
    stubFetch({ tether: {} });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/no usable/);
  });

  it("tether.idr is 0, rejects with no usable message", async () => {
    stubFetch({ tether: { idr: 0 } });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/no usable/);
  });

  it("tether.idr is negative, rejects with no usable message", async () => {
    stubFetch({ tether: { idr: -100 } });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/no usable/);
  });

  it("tether.idr is NaN, rejects with no usable message", async () => {
    stubFetch({ tether: { idr: NaN } });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/no usable/);
  });

  it("tether.idr is Infinity, rejects with no usable message", async () => {
    stubFetch({ tether: { idr: Infinity } });
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/no usable/);
  });

  it("fetch() itself rejects (network/DNS failure), rejects with network error message", async () => {
    stubFetchReject(new Error("Network error: ECONNREFUSED"));
    await expect(fetchTetherIdrPrice()).rejects.toThrow(/network error/);
  });

  it("request URL contains ids=tether and vs_currencies=idr", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tether: { idr: 16350 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchTetherIdrPrice();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callUrl = fetchMock.mock.calls[0]![0] as string;
    expect(callUrl).toContain("ids=tether");
    expect(callUrl).toContain("vs_currencies=idr");
  });

  it("x-cg-demo-api-key header is absent by default (when COINGECKO_API_KEY is not set)", async () => {
    vi.stubEnv("COINGECKO_API_KEY", "");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tether: { idr: 16350 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchTetherIdrPrice();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    // By default, API_KEY is empty, so the header should not be present
    expect(headers?.["x-cg-demo-api-key"]).toBeUndefined();
  });

  it("x-cg-demo-api-key header uses the API key supplied by runtime settings", async () => {
    vi.stubEnv("COINGECKO_API_KEY", "legacy-env-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tether: { idr: 16350 } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await fetchTetherIdrPrice("admin-settings-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["x-cg-demo-api-key"]).toBe("admin-settings-key");
  });

  it("resolves with a proper Decimal type that supports arithmetic", async () => {
    stubFetch({ tether: { idr: 16350.5 } });
    const result = await fetchTetherIdrPrice();
    expect(result).toBeInstanceOf(Decimal);
    // Verify arithmetic works
    const doubled = result.times(2);
    expect(doubled.toFixed(1)).toBe("32701.0");
  });
});
