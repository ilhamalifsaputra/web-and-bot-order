/**
 * Brute-force / rate-limit protection for the storefront's public auth
 * endpoints — port of apps/web-admin/src/auth.ts's login-rate-limit +
 * account-lockout pair (lines 294-347 there). Storefront accounts hold
 * wallet balances, so the same protection that guards admin logins is
 * needed here.
 *
 * Two independent throttles, same as admin:
 *  - `loginRateLimited(ip)` — per-IP sliding window. Stops a single source
 *    from hammering ANY account.
 *  - `accountLockedOut(identifier)` / `recordAccountFailure(identifier)` /
 *    `resetAccountFailures(identifier)` — per-identity failure throttle.
 *    Stops an attacker rotating IPs against ONE account. The admin keys this
 *    by telegramId (number); the storefront has no telegramId for web
 *    accounts, so this is keyed by the lowercased/trimmed login identifier
 *    string (username or email as typed) — callers are responsible for
 *    normalizing before calling.
 *
 * Both throttles share `config.WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS` /
 * `config.WEB_LOGIN_RATE_LIMIT_MAX` with the admin panel. In-process Maps are
 * fine here: the storefront, like the admin, runs as a single process.
 */
import type { FastifyRequest } from "fastify";
import { config } from "@app/core/config";

/**
 * Shared sliding-window check used by every per-key throttle in this module.
 * Prunes hits older than `windowSeconds` out of `store`'s deque for `key`,
 * then: if the pruned deque is already at `maxHits`, returns `true` WITHOUT
 * recording a new hit (an over-limit caller shouldn't get to keep pushing
 * its window forward); otherwise records this call as a hit and returns
 * `false`. One `Map` per throttle — callers must never share a `store`
 * between two logically different caps, or one cap's hits would count
 * against the other's quota.
 */
function slidingWindowLimited(
  store: Map<string, number[]>,
  key: string,
  windowSeconds: number,
  maxHits: number,
): boolean {
  const now = Date.now() / 1000;
  const dq = store.get(key) ?? [];
  while (dq.length && now - dq[0]! > windowSeconds) dq.shift();
  if (dq.length >= maxHits) {
    store.set(key, dq);
    return true;
  }
  dq.push(now);
  store.set(key, dq);
  return false;
}

/**
 * The request's real client IP. Delegates to Fastify's own `req.ip`, which is
 * computed from `X-Forwarded-For` ONLY when `trustProxy` is configured
 * (`TRUST_PROXY` env — see server.ts/config.ts) to the actual reverse proxy's
 * address. Previously this read the raw `x-forwarded-for` header directly,
 * always trusting its left-most (client-supplied, unverified) entry — any
 * direct caller could forge that header and spoof a different IP for every
 * request, defeating per-IP rate limiting entirely (Storefront-4 fix,
 * security audit 2026-06-23).
 */
export function clientIp(req: FastifyRequest): string {
  return req.ip || "unknown";
}

// ---------------------------------------------------------------------------
// Login rate limit (per IP, in-process) — mirrors the admin's deque approach.
// ---------------------------------------------------------------------------

const attempts = new Map<string, number[]>();

export function loginRateLimited(ip: string): boolean {
  return slidingWindowLimited(
    attempts,
    ip,
    config.WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    config.WEB_LOGIN_RATE_LIMIT_MAX,
  );
}

export function resetLoginAttempts(ip: string): void {
  attempts.delete(ip);
}

// Per-account failure throttle. The per-IP limiter above doesn't stop an
// attacker rotating IPs against ONE account, so we also lock an identifier
// after too many *failed* logins in the window. Unlike the IP limiter this
// only counts failures (recorded by the caller), so legitimate logins never
// trip it.
const accountFailures = new Map<string, number[]>();

function pruneFailures(key: string, now: number): number[] {
  const window = config.WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS;
  const dq = accountFailures.get(key) ?? [];
  while (dq.length && now - dq[0]! > window) dq.shift();
  accountFailures.set(key, dq);
  return dq;
}

/** True if `identifier` has hit the failed-login cap within the window. */
export function accountLockedOut(identifier: string): boolean {
  if (!identifier) return false;
  return pruneFailures(identifier, Date.now() / 1000).length >= config.WEB_LOGIN_RATE_LIMIT_MAX;
}

/** Record one failed login against `identifier`. */
export function recordAccountFailure(identifier: string): void {
  if (!identifier) return;
  pruneFailures(identifier, Date.now() / 1000).push(Date.now() / 1000);
}

/** Clear an identifier's failure count (call on a successful login). */
export function resetAccountFailures(identifier: string): void {
  accountFailures.delete(identifier);
}

// ---------------------------------------------------------------------------
// Payment webhook rate limit (per IP, in-process) — Payment-3 fix, security
// audit 2026-06-23. The TokoPay/PayDisini/NOWPayments callbacks are public
// and unauthenticated until the signature check inside the handler runs; a
// flood of forged-signature bodies still costs a body parse + signature
// compute (and, on a lucky refId guess, a DB query) before being rejected.
// ---------------------------------------------------------------------------

const webhookHits = new Map<string, number[]>();
export const WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = 60;
export const WEBHOOK_RATE_LIMIT_MAX = 30;

/** True if `${route}:${ip}` has exceeded the webhook rate limit this window. */
export function webhookRateLimited(route: string, ip: string): boolean {
  const key = `${route}:${ip}`;
  return slidingWindowLimited(webhookHits, key, WEBHOOK_RATE_LIMIT_WINDOW_SECONDS, WEBHOOK_RATE_LIMIT_MAX);
}

// ---------------------------------------------------------------------------
// Per-email forgot-password throttle — Storefront-4 fix, security audit
// 2026-06-23. loginRateLimited(ip) alone doesn't stop an attacker rotating
// IPs from email-bombing ONE victim with reset-token emails; this caps
// attempts per (lowercased, trimmed) email address regardless of source IP.
// Shares the same window/cap as the login throttles — no need for a separate
// config knob for what's conceptually the same kind of abuse.
// ---------------------------------------------------------------------------

const forgotEmailHits = new Map<string, number[]>();

export function forgotEmailRateLimited(email: string): boolean {
  if (!email) return false;
  return slidingWindowLimited(
    forgotEmailHits,
    email,
    config.WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
    config.WEB_LOGIN_RATE_LIMIT_MAX,
  );
}

// ---------------------------------------------------------------------------
// Guest checkout rate limit (per IP, in-process) — Task 3, guest checkout.
// Guest checkout creates a brand-new `User` row for every order, so the
// existing MAX_PENDING_ORDERS=10 per-user cap in checkout.ts
// (countUserPendingOrders) never bites for a guest: each checkout starts a
// fresh user whose pending-order count is always 0. Without a per-IP cap,
// one attacker could flood the `users` and `orders` tables and tie up stock
// via reservations, all with that cap never once engaging.
// ---------------------------------------------------------------------------

const guestCheckoutHits = new Map<string, number[]>();
export const GUEST_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes
export const GUEST_CHECKOUT_RATE_LIMIT_MAX = 5;

/** True if `ip` has exceeded its guest-checkout quota within the window. */
export function guestCheckoutRateLimited(ip: string): boolean {
  return slidingWindowLimited(
    guestCheckoutHits,
    ip,
    GUEST_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS,
    GUEST_CHECKOUT_RATE_LIMIT_MAX,
  );
}

// ---------------------------------------------------------------------------
// Order-tracking lookup rate limit (per IP, in-process) — Task 3, guest
// checkout. The order-tracking endpoint (a later task) validates an order
// code + email pair with no login required; without a throttle it's an
// oracle an attacker can hammer to brute-force valid order codes.
// ---------------------------------------------------------------------------

const trackLookupHits = new Map<string, number[]>();
export const TRACK_LOOKUP_RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes
export const TRACK_LOOKUP_RATE_LIMIT_MAX = 10;

/** True if `ip` has exceeded its order-lookup quota within the window. */
export function trackLookupRateLimited(ip: string): boolean {
  return slidingWindowLimited(
    trackLookupHits,
    ip,
    TRACK_LOOKUP_RATE_LIMIT_WINDOW_SECONDS,
    TRACK_LOOKUP_RATE_LIMIT_MAX,
  );
}
