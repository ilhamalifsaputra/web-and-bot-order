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

/** A server that responded (`onResponse` fires with the status, exactly as the
 * real `apiPost` does the moment a Response is in hand) and then rejected. */
function respondedWith(status: number, message: string) {
  return async (_path: string, _body: unknown, options?: PostOptions) => {
    options?.onResponse?.(status);
    const err = new Error(message) as Error & { status?: number };
    err.status = status;
    throw err;
  };
}

/** A request that never got a response at all — a timeout, a dropped
 * connection, a laptop that slept mid-flight. `fetch` itself rejects, so
 * `onResponse` never fires. The mutation may or may not have run. */
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
      o?.onResponse?.(200);
      return {};
    });
    const { result } = renderHook(() => useIdempotentPost());

    await result.current("/api/payments/dismiss", { binance_tx_id: "TX1" });
    await result.current("/api/payments/dismiss", { binance_tx_id: "TX1" });

    expect(keyOfCall(0)).toMatch(/^[0-9a-f-]{36}$/);
    // Both attempts were ANSWERED, so the second click is a new operation.
    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("reuses the identical key when a retry follows a request that never got an answer", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result } = renderHook(() => useIdempotentPost());

    const body = {};
    await expect(result.current("/api/payments/order/501/refund", body)).rejects.toThrow();
    await expect(result.current("/api/payments/order/501/refund", body)).rejects.toThrow();
    await expect(result.current("/api/payments/order/501/refund", body)).rejects.toThrow();

    // Byte-identical across all three attempts — this is what lets the server
    // replay the first attempt's response instead of running the refund a second time.
    expect(keyOfCall(1)).toBe(keyOfCall(0));
    expect(keyOfCall(2)).toBe(keyOfCall(0));
  });

  it("mints a new key once the server has answered 4xx, so a retry is not stuck replaying that answer", async () => {
    vi.mocked(apiPost).mockImplementation(respondedWith(422, "Order is no longer underpaid."));
    const { result } = renderHook(() => useIdempotentPost());

    const body = {};
    await expect(result.current("/api/payments/order/501/refund", body)).rejects.toThrow("Order is no longer underpaid.");
    await expect(result.current("/api/payments/order/501/refund", body)).rejects.toThrow("Order is no longer underpaid.");

    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  // A 5xx arrived, but it says nothing about whether the mutation ran: no
  // route here ever STORES a 5xx (`respond()` is only called with
  // 200/400/404/422), so there is no stale answer to get stuck on — while a
  // 504 over a refund that actually paid out is exactly the double-payment
  // case the key exists to close.
  it.each([500, 502, 503, 504])("holds the key when the response was a %i", async (status) => {
    vi.mocked(apiPost).mockImplementation(respondedWith(status, `/api/payments/order/501/refund responded ${status}`));
    const { result } = renderHook(() => useIdempotentPost());

    const body = {};
    await expect(result.current("/api/payments/order/501/refund", body)).rejects.toThrow(String(status));
    await expect(result.current("/api/payments/order/501/refund", body)).rejects.toThrow(String(status));

    expect(keyOfCall(1)).toBe(keyOfCall(0));
  });

  // The boundary itself, so a later refactor can't quietly move it.
  it("treats 499 as answered and 500 as unknown", async () => {
    vi.mocked(apiPost).mockImplementation(respondedWith(499, "client closed request"));
    const { result: a } = renderHook(() => useIdempotentPost());
    await expect(a.current("/api/payments/order/501/refund", {})).rejects.toThrow();
    await expect(a.current("/api/payments/order/501/refund", {})).rejects.toThrow();
    expect(keyOfCall(1)).not.toBe(keyOfCall(0));

    vi.mocked(apiPost).mockReset();
    vi.mocked(apiPost).mockImplementation(respondedWith(500, "boom"));
    const { result: b } = renderHook(() => useIdempotentPost());
    await expect(b.current("/api/payments/order/501/refund", {})).rejects.toThrow();
    await expect(b.current("/api/payments/order/501/refund", {})).rejects.toThrow();
    expect(keyOfCall(1)).toBe(keyOfCall(0));
  });

  it("drops the key after a 2xx, so the next click is a new operation", async () => {
    vi.mocked(apiPost).mockImplementation(async (_p, _b, o?: PostOptions) => {
      o?.onResponse?.(200);
      return {};
    });
    const { result } = renderHook(() => useIdempotentPost());

    const body = {};
    await result.current("/api/payments/order/501/refund", body);
    await result.current("/api/payments/order/501/refund", body);

    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("mints a new key when the body changes, even while the first attempt's outcome is unknown", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result } = renderHook(() => useIdempotentPost());

    await expect(result.current("/api/payments/dismiss", { binance_tx_id: "TX1" })).rejects.toThrow();
    // A different request. Reusing the key here would earn a 409
    // `idempotency_key_reused`, not protection.
    await expect(result.current("/api/payments/dismiss", { binance_tx_id: "TX2" })).rejects.toThrow();

    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("mints a new key per path, so two different payment actions never share one", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result } = renderHook(() => useIdempotentPost());

    await expect(result.current("/api/payments/order/501/deliver", {})).rejects.toThrow();
    await expect(result.current("/api/payments/order/501/refund", {})).rejects.toThrow();

    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  it("holds one key per in-doubt request, so an unrelated call between an attempt and its retry doesn't lose it", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result } = renderHook(() => useIdempotentPost());

    await expect(result.current("/api/payments/dismiss", { binance_tx_id: "TX1" })).rejects.toThrow();
    await expect(result.current("/api/payments/match", { binance_tx_id: "TX9", order_code: "ORD-9" })).rejects.toThrow();
    await expect(result.current("/api/payments/dismiss", { binance_tx_id: "TX1" })).rejects.toThrow();

    expect(keyOfCall(2)).toBe(keyOfCall(0));
    expect(keyOfCall(1)).not.toBe(keyOfCall(0));
  });

  // `crypto.randomUUID` is secure-context only. An admin panel served over
  // plain http:// has none, and without a fallback the Refund button would
  // throw a TypeError instead of refunding.
  it("still produces a unique key where crypto.randomUUID does not exist (plain http)", async () => {
    const realRandomUUID = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      vi.mocked(apiPost).mockImplementation(neverAnswered());
      const { result } = renderHook(() => useIdempotentPost());

      await expect(result.current("/api/payments/dismiss", { binance_tx_id: "TX1" })).rejects.toThrow();
      await expect(result.current("/api/payments/dismiss", { binance_tx_id: "TX2" })).rejects.toThrow();

      expect(keyOfCall(0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(keyOfCall(1)).not.toBe(keyOfCall(0));
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: realRandomUUID, configurable: true });
    }
  });

  it("keeps the key stable across re-renders of the page holding it", async () => {
    vi.mocked(apiPost).mockImplementation(neverAnswered());
    const { result, rerender } = renderHook(() => useIdempotentPost());

    await expect(result.current("/api/payments/dismiss", { binance_tx_id: "TX1" })).rejects.toThrow();
    rerender();
    rerender();
    await expect(result.current("/api/payments/dismiss", { binance_tx_id: "TX1" })).rejects.toThrow();

    expect(keyOfCall(1)).toBe(keyOfCall(0));
  });
});
