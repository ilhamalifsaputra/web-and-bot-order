/**
 * Shared HTTP timeout helper for gateway/RPC calls that go through Node's
 * native `fetch`. Node's `fetch` has no built-in response timeout — a peer
 * that accepts the TCP connection and then never answers (or answers with
 * headers and then stalls the body) leaves the returned promise pending
 * forever. Every payment-gateway/poller HTTP call in this codebase now goes
 * through `fetchWithTimeout` so a hung peer can never stall a poll cycle
 * past `cycleTimeoutMs` (see `pollLoop.ts` in apps/order-bot) — it fails
 * fast instead, and the cycle-abandon safety net never has to fire.
 *
 * `AbortSignal.timeout` stays attached to the response body in undici, so
 * the deadline also covers `res.json()`/`res.text()` reads made after the
 * headers arrive — not just the initial connect + header exchange.
 */

/** Per-call-site timeout budgets, in milliseconds. */
export const HTTP_TIMEOUT_MS = {
  /** Poll status/list read-only calls that already run on a recurring timer
   * — a slow response just means this tick is late, the next tick retries. */
  gatewayRead: 10_000,
  /** Create invoice/transaction calls — a human is waiting at checkout for
   * this to resolve, so it gets more budget than a background poll read. */
  gatewayWrite: 15_000,
  /** Public block-explorer RPC calls (Bybit BSC on-chain confirmation
   * tracker) — cheap, read-only, and already retried every tracker tick. */
  explorerRead: 8_000,
} as const;

/**
 * Thrown by `fetchWithTimeout` in place of whatever `AbortSignal.timeout`'s
 * rejection actually carries, so callers can distinguish "the deadline
 * elapsed" from "a genuine network/DNS/TLS failure" without ever touching
 * the original error object. That matters for the gateway clients whose
 * credentials ride in the request URL (TokoPay, PayDisini): undici
 * sometimes attaches the failed request — URL included — to a rejected
 * fetch's `err.cause`, and a caller that let that object reach a logger
 * would leak the credential. `HttpTimeoutError`'s message is built fresh
 * from only `timeoutMs`, so it is safe to log unconditionally.
 */
export class HttpTimeoutError extends Error {}

/**
 * `fetch()` with a hard deadline. Rejects with `HttpTimeoutError` once
 * `timeoutMs` elapses, whether the peer never responds at all or sends
 * headers and then stalls the body — any other failure (DNS, connection
 * refused, TLS, a non-2xx status the caller checks itself) passes through
 * unchanged.
 */
export async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs: number }): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new HttpTimeoutError(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  }
}
