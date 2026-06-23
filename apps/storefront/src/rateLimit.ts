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
  const window = config.WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS;
  const maxHits = config.WEB_LOGIN_RATE_LIMIT_MAX;
  const now = Date.now() / 1000;
  const dq = attempts.get(ip) ?? [];
  while (dq.length && now - dq[0]! > window) dq.shift();
  if (dq.length >= maxHits) {
    attempts.set(ip, dq);
    return true;
  }
  dq.push(now);
  attempts.set(ip, dq);
  return false;
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
  const now = Date.now() / 1000;
  const dq = webhookHits.get(key) ?? [];
  while (dq.length && now - dq[0]! > WEBHOOK_RATE_LIMIT_WINDOW_SECONDS) dq.shift();
  if (dq.length >= WEBHOOK_RATE_LIMIT_MAX) {
    webhookHits.set(key, dq);
    return true;
  }
  dq.push(now);
  webhookHits.set(key, dq);
  return false;
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
  const window = config.WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS;
  const maxHits = config.WEB_LOGIN_RATE_LIMIT_MAX;
  const now = Date.now() / 1000;
  const dq = forgotEmailHits.get(email) ?? [];
  while (dq.length && now - dq[0]! > window) dq.shift();
  if (dq.length >= maxHits) {
    forgotEmailHits.set(email, dq);
    return true;
  }
  dq.push(now);
  forgotEmailHits.set(email, dq);
  return false;
}
