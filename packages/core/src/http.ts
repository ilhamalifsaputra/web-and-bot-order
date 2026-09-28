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
  /** Public market-price lookups (CoinGecko) — cheap, read-only, and already
   * retried on the next hourly cron tick if this one is slow. */
  priceRead: 5_000,
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
 *
 * `init`'s type deliberately omits `signal`: this function owns the abort
 * signal (it has to, to enforce `timeoutMs`), so a caller-supplied `signal`
 * would otherwise be silently dropped by the spread below instead of composed
 * with the deadline. No caller passes one today; the omitted type just keeps
 * that mistake from compiling if one ever does.
 */
export async function fetchWithTimeout(
  url: string,
  init: Omit<RequestInit, "signal"> & { timeoutMs: number },
): Promise<Response> {
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

/**
 * `fetchWithTimeout` wrapped in the credential-safe choke point that most
 * gateway/RPC clients in this codebase need, and that used to be hand-rolled
 * (`try { await fetchWithTimeout(...) } catch { throw new Error(<static
 * message>) }`) at every call site whose credentials ride in a header or
 * query string. On ANY rejection — a genuine network/DNS/TLS failure, or
 * `fetchWithTimeout`'s own `HttpTimeoutError` once the deadline elapses — this
 * throws a BRAND NEW `Error` built only from `errorPrefix` plus whether the
 * failure was a timeout. It never inspects, forwards, or attaches the
 * original error, its `.cause` (where Node's fetch sometimes attaches the
 * failed request — headers and URL included — for a rejected promise), or
 * the request URL, so a credential riding in a header or query string can
 * never reach a caller, and therefore can never reach a logger through one.
 *
 * On success, returns the raw `Response` unchanged — the caller still owns
 * status-code handling and any `res.json()`/`res.text()` body read: guard
 * those too (a peer that sends headers then stalls the body can still abort
 * mid-read, and that rejection carries no request context but still deserves
 * a readable error instead of a raw parse exception escaping).
 *
 * Naming: `fetchWithTimeout` alone still lets whatever `fetch()` rejects with
 * escape to the caller unchanged. This is the one call that promises request
 * context never leaves it — use it (not `fetchWithTimeout` directly) at any
 * call site whose credentials ride in the URL or headers.
 */
export async function fetchWithTimeoutSafe(
  url: string,
  init: Omit<RequestInit, "signal"> & { timeoutMs: number },
  errorPrefix: string,
): Promise<Response> {
  try {
    return await fetchWithTimeout(url, init);
  } catch (err) {
    const timedOut = err instanceof HttpTimeoutError;
    throw new Error(`${errorPrefix} ${timedOut ? "timed out" : "network error"}`);
  }
}
