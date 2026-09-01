/// <reference lib="dom" />
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { apiPost, type PostOptions } from "./client";
import { useIdempotentPost } from "./idempotency";

vi.mock("./client", () => ({ apiPost: vi.fn() }));

/** The key `apiPost` was handed on its `n`th call. */
function keyOfCall(n: number): string {
  const options = vi.mocked(apiPost).mock.calls[n]![2] as PostOptions;
  return options.idempotencyKey!;
}

/** A server that answered (`onResponse` fires, exactly as the real `apiPost`
 * does the moment a Response is in hand) and then rejected — the shape of any
 * 4xx/5xx: the outcome is KNOWN, and the route has already stored it. */
function serverAnswered(status: number, message: string) {
  return async (_path: string, _body: unknown, options?: PostOptions) => {
    options?.onResponse?.();
    const err = new Error(message) as Error & { status?: number };
    err.status = status;
    throw err;
  };
}

/** A request that never got an answer — a timeout, a dropped connection, a tab
 * that went offline mid-flight. The mutation may or may not have run. */
function neverAnswered() {
  return async () => {
    throw new TypeError("Failed to fetch");
  };
}

beforeEach(() => {
  vi.mocked(apiPost).mockReset();
});

describe("useIdempotentPost", () => {
  it("sends a key at all, and a fresh one per logical operation", async () => {
    vi.mocked(apiPost).mockImplementation(async (_p, _b, o?: PostOptions) => {
      o?.onResponse?.();
      return {};
    });
    const { result } = renderHook(() => useIdempotentPost());

    await result.current("/api/v1/checkout", { method: "binance" });
    await result.current("/api/v1/checkout", { method: "binance" });

    expect(keyOfCall(0)).toMatch(/^[0-9a-f-]{36}$/);
    // Both attempts were ANSWERED, so the second click is a new operation.
    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("reuses the identical key when a retry follows a request that never got an answer", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result } = renderHook(() => useIdempotentPost());

    const body = { method: "binance", voucher_code: "" };
    await expect(result.current("/api/v1/checkout", body)).rejects.toThrow();
    await expect(result.current("/api/v1/checkout", body)).rejects.toThrow();
    await expect(result.current("/api/v1/checkout", body)).rejects.toThrow();

    // Byte-identical across all three attempts — this is what lets the server
    // replay the first attempt's response instead of creating a second order.
    expect(keyOfCall(1)).toBe(keyOfCall(0));
    expect(keyOfCall(2)).toBe(keyOfCall(0));
  });

  it("mints a new key once the server has answered, so a retry is not stuck replaying that answer", async () => {
    vi.mocked(apiPost).mockImplementation(serverAnswered(400, "web.out_of_stock"));
    const { result } = renderHook(() => useIdempotentPost());

    const body = { method: "binance", voucher_code: "" };
    await expect(result.current("/api/v1/checkout", body)).rejects.toThrow("web.out_of_stock");
    await expect(result.current("/api/v1/checkout", body)).rejects.toThrow("web.out_of_stock");

    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("mints a new key when the body changes, even while the first attempt's outcome is unknown", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result } = renderHook(() => useIdempotentPost());

    await expect(result.current("/api/v1/checkout", { method: "binance" })).rejects.toThrow();
    // A different request. Reusing the key here would earn a 409
    // `error.idempotency_key_reused`, not protection.
    await expect(result.current("/api/v1/checkout", { method: "qris" })).rejects.toThrow();

    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("mints a new key per path, so two different mutations never share one", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result } = renderHook(() => useIdempotentPost());

    await expect(result.current("/api/v1/checkout", {})).rejects.toThrow();
    await expect(result.current("/api/v1/topup/order", {})).rejects.toThrow();

    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("holds one key per in-doubt request, so an unrelated call between an attempt and its retry doesn't lose it", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result } = renderHook(() => useIdempotentPost());

    await expect(result.current("/api/v1/checkout", { method: "binance" })).rejects.toThrow();
    await expect(result.current("/api/v1/topup/order", { qty: 1 })).rejects.toThrow();
    await expect(result.current("/api/v1/checkout", { method: "binance" })).rejects.toThrow();

    expect(keyOfCall(2)).toBe(keyOfCall(0));
    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  // `crypto.randomUUID` is secure-context only. A shop served over plain
  // http:// has none, and without a fallback the Place Order button would
  // throw a TypeError instead of placing an order.
  it("still produces a unique key where crypto.randomUUID does not exist (plain http)", async () => {
    const realRandomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      vi.mocked(apiPost).mockImplementation(neverAnswered());
      const { result } = renderHook(() => useIdempotentPost());

      await expect(result.current("/api/v1/checkout", { method: "binance" })).rejects.toThrow();
      await expect(result.current("/api/v1/checkout", { method: "qris" })).rejects.toThrow();

      expect(keyOfCall(0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(keyOfCall(1)).not.toBe(keyOfCall(0));
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: realRandomUUID, configurable: true });
    }
  });

  it("keeps the key stable across re-renders of the page holding it", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result, rerender } = renderHook(() => useIdempotentPost());

    await expect(result.current("/api/v1/checkout", { method: "binance" })).rejects.toThrow();
    rerender();
    rerender();
    await expect(result.current("/api/v1/checkout", { method: "binance" })).rejects.toThrow();

    expect(keyOfCall(1)).toBe(keyOfCall(0));
  });
});
