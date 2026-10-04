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
// Anonymous checkout-read rate limit (per IP, in-process) — guest checkout,
// fix pass 1. Opening `GET /api/v1/checkout` and
// `POST /api/v1/checkout/voucher/preview` to anonymous callers created two
// problems this cap closes:
//  - the voucher preview answers "does this code exist?" for ANY code,
//    whatever the cart holds (computeTotals in routes/checkout.ts looks the
//    code up before it looks at eligibility), so without a cap it is a
//    voucher-code oracle an attacker can hammer at line rate;
//  - the summary fans out to eight settings/credential lookups per call, so
//    it is also the heaviest unauthenticated read in the storefront.
// Both routes share ONE quota deliberately — an attacker must not be able to
// reset the oracle by alternating between them.
//
// 30 requests / 60 s: a real shopper opens checkout once, maybe reloads a
// couple of times and tries a handful of voucher codes — under ten requests
// in any minute, so the cap has roughly 3x headroom even for an impatient
// one and for a few shoppers sharing an office/carrier NAT. An attacker, in
// exchange, drops from thousands of guesses per second to 43 200 per day per
// IP, which makes guessing a random voucher code hopeless.
//
// Signed-in callers are NOT throttled by this (see routes/apiCheckout.ts):
// they are already bounded by having had to register and log in, and the
// checkout page is one a paying customer legitimately reloads.
// ---------------------------------------------------------------------------

const checkoutPreviewHits = new Map<string, number[]>();
export const CHECKOUT_PREVIEW_RATE_LIMIT_WINDOW_SECONDS = 60;
export const CHECKOUT_PREVIEW_RATE_LIMIT_MAX = 30;

/** True if `ip` has exceeded its anonymous checkout-read quota this window. */
export function checkoutPreviewRateLimited(ip: string): boolean {
  return slidingWindowLimited(
    checkoutPreviewHits,
    ip,
    CHECKOUT_PREVIEW_RATE_LIMIT_WINDOW_SECONDS,
    CHECKOUT_PREVIEW_RATE_LIMIT_MAX,
  );
}

// ---------------------------------------------------------------------------
// Order-tracking lookup rate limit (per IP, in-process) — Task 3, guest
// checkout. The order-tracking endpoint (a later task) validates a bare
// order code with no login required; without a throttle it's an oracle an
// attacker can hammer to brute-force valid order codes.
// ---------------------------------------------------------------------------

const trackLookupHits = new Map<string, number[]>();
export const TRACK_LOOKUP_RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes
export const TRACK_LOOKUP_RATE_LIMIT_MAX = 10;

/**
 * The key a per-client throttle should count `ip` under. An IPv6 client is
 * normally handed a whole /64 (2^64 addresses), so keying by the full address
 * would let one client rotate through a fresh quota on every request — the
 * /64 is the smallest unit that actually identifies one subscriber. An
 * IPv4-mapped IPv6 address (`::ffff:1.2.3.4`) is folded back to plain IPv4.
 * Anything unparseable is returned unchanged.
 */
export function rateLimitClientKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(":")) return ip;
  const addr = ip.split("%", 1)[0]!.toLowerCase(); // drop a zone id (fe80::1%eth0)
  const halves = addr.split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // An embedded dotted-quad tail counts as two hextets; only the first four
  // hextets matter here, so its exact value is irrelevant.
  const tailLen = tail.reduce((n, h) => n + (h.includes(".") ? 2 : 1), 0);
  const fill = halves.length === 2 ? 8 - head.length - tailLen : 0;
  if (fill < 0) return ip;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  const first4 = groups.slice(0, 4).map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16).toString(16) : null));
  if (first4.length < 4 || first4.some((h) => h === null)) return ip;
  return `${first4.join(":")}::/64`;
}

/** True if `ip` (counted per /64 for IPv6) has exceeded its order-lookup quota within the window. */
export function trackLookupRateLimited(ip: string): boolean {
  return slidingWindowLimited(
    trackLookupHits,
    rateLimitClientKey(ip),
    TRACK_LOOKUP_RATE_LIMIT_WINDOW_SECONDS,
    TRACK_LOOKUP_RATE_LIMIT_MAX,
  );
}

// ---------------------------------------------------------------------------
// Order-tracking FAILED-guess caps, independent of source IP — backend audit
// Task C1. The per-IP limiter above is defeated by anyone with many
// addresses (a botnet, a cloud pool), and the order code is short: every
// code is `ORD-YYYYMMDD-XXXX` with a 4-char suffix from 36 symbols, so one
// day holds only ~1.7M possible codes. Two caps count MISSES only (a real
// buyer's correct code never spends them):
//  - per target: the code's date prefix (`ORD-YYYYMMDD`). Guessing one day's
//    orders is the natural attack, so that day's bucket fills no matter how
//    many IPs the guesses come from.
//  - global: every format-valid miss, whatever its date — stops an attacker
//    simply spreading guesses across many past dates.
// A code that doesn't have the order-code shape can never match a real order
// (generateOrderCode is the only writer), so it can't be a successful guess
// and is not counted here — only the per-IP limiter applies to it.
//
// The trade-off is deliberate: when a cap trips, legitimate recovery for
// that day (or, for the global cap, for everyone) answers 429 until the
// window slides. /track is only the lost-cookie recovery path — a buyer's
// own checkout session and the order-code email are unaffected — and a
// bounded outage beats an unbounded credential oracle.
// ---------------------------------------------------------------------------

export const TRACK_FAILURE_WINDOW_SECONDS = 600; // 10 minutes
export const TRACK_TARGET_FAILURE_MAX = 30;
export const TRACK_GLOBAL_FAILURE_MAX = 300;
const ORDER_CODE_SHAPE = /^(ORD-\d{8})-[A-Z0-9]{4}$/;
const GLOBAL_TRACK_KEY = "*";
const trackTargetFailures = new Map<string, number[]>();
const trackGlobalFailures = new Map<string, number[]>();

/** `key`'s failures inside `windowSeconds`. A bucket that empties is deleted
 * (and a missing one is never created), so keys nobody is failing on any more
 * don't stay in memory forever. */
function prunedCount(
  store: Map<string, number[]>,
  key: string,
  now: number,
  windowSeconds = TRACK_FAILURE_WINDOW_SECONDS,
): number[] {
  const dq = store.get(key);
  if (!dq) return [];
  while (dq.length && now - dq[0]! > windowSeconds) dq.shift();
  if (dq.length === 0) store.delete(key);
  return dq;
}

function pushFailure(
  store: Map<string, number[]>,
  key: string,
  now: number,
  windowSeconds = TRACK_FAILURE_WINDOW_SECONDS,
): void {
  const dq = prunedCount(store, key, now, windowSeconds);
  dq.push(now);
  store.set(key, dq);
}

/** The per-target bucket for an (already normalized) order code, or null if it isn't order-code shaped. */
function trackTargetKey(orderCode: string): string | null {
  return ORDER_CODE_SHAPE.exec(orderCode)?.[1] ?? null;
}

/** True if guesses at `orderCode`'s target (or the endpoint as a whole) are currently capped. */
export function trackTargetLockedOut(orderCode: string): boolean {
  const target = trackTargetKey(orderCode);
  if (!target) return false;
  const now = Date.now() / 1000;
  return (
    prunedCount(trackTargetFailures, target, now).length >= TRACK_TARGET_FAILURE_MAX ||
    prunedCount(trackGlobalFailures, GLOBAL_TRACK_KEY, now).length >= TRACK_GLOBAL_FAILURE_MAX
  );
}

/** Test probe: how many failure buckets (per-target + global) are held in memory. */
export function trackFailureBucketCount(): number {
  return trackTargetFailures.size + trackGlobalFailures.size;
}

/** Record one failed lookup of `orderCode` against its target and the global cap. */
export function recordTrackFailure(orderCode: string): void {
  const target = trackTargetKey(orderCode);
  if (!target) return;
  const now = Date.now() / 1000;
  pushFailure(trackTargetFailures, target, now);
  pushFailure(trackGlobalFailures, GLOBAL_TRACK_KEY, now);
}

// ---------------------------------------------------------------------------
// Guest-claim email guesses (per guest user id, in-process) — backend audit
// Task C fix round. Claiming a guest row (credentials on an isGuest row)
// needs the order's contact email; a code-guesser holding the session must
// not get unlimited tries at it. Counts MISSES only, per guest row, whatever
// the source IP. A locked row refuses even the right email until the window
// slides — the real buyer can still use the order (their session is fine).
// ---------------------------------------------------------------------------

export const GUEST_CLAIM_FAILURE_WINDOW_SECONDS = 900; // 15 minutes
export const GUEST_CLAIM_FAILURE_MAX = 5;
const guestClaimFailures = new Map<string, number[]>();

/** True if guest row `userId` has used up its guest-email guesses this window. */
export function guestClaimLockedOut(userId: number): boolean {
  const now = Date.now() / 1000;
  return prunedCount(guestClaimFailures, String(userId), now, GUEST_CLAIM_FAILURE_WINDOW_SECONDS).length >= GUEST_CLAIM_FAILURE_MAX;
}

/** Record one wrong guest-email guess against guest row `userId`. */
export function recordGuestClaimFailure(userId: number): void {
  pushFailure(guestClaimFailures, String(userId), Date.now() / 1000, GUEST_CLAIM_FAILURE_WINDOW_SECONDS);
}

// ---------------------------------------------------------------------------
// Nickname-check rate limit (per IP, in-process) — Task 7, the KokinPay
// live-typing lookup on InstantBuyPage's account field. Fired on every
// debounced (~800ms) keystroke, so it's a "live-typing lookup" endpoint in
// the same sense as checkoutPreviewRateLimited above, but even chattier —
// unlike that endpoint it's called continuously while the buyer is still
// typing their account id, not once per page load/voucher attempt.
//
// Code review: this was previously a generous 40 req/min on the reasoning
// that the endpoint isn't security-sensitive (no secret/oracle exposed) and
// only needs to bound outbound call volume loosely. That undercounts the
// real cost — KokinPay is a PAID, prepaid-balance-metered API, so every
// outbound call (even a "not found" one) spends real money from the shop's
// account, regardless of how the storefront response degrades. An
// unauthenticated, distributed caller could otherwise drain that balance at
// up to 40 req/min per IP with no meaningful friction. 10 req/60s matches
// the spirit of the order-tracking lookup limiter (trackLookupRateLimited)
// above and comfortably covers a real buyer debouncing at 800ms/keystroke on
// a short account-id field — well under 10 requests/minute even typing
// continuously.
// ---------------------------------------------------------------------------

const nicknameCheckHits = new Map<string, number[]>();
export const NICKNAME_CHECK_RATE_LIMIT_WINDOW_SECONDS = 60;
export const NICKNAME_CHECK_RATE_LIMIT_MAX = 10;

/** True if `ip` has exceeded its nickname-check quota within the window. */
export function nicknameCheckRateLimited(ip: string): boolean {
  return slidingWindowLimited(
    nicknameCheckHits,
    ip,
    NICKNAME_CHECK_RATE_LIMIT_WINDOW_SECONDS,
    NICKNAME_CHECK_RATE_LIMIT_MAX,
  );
}

// ---------------------------------------------------------------------------
// Checkout-submit rate limit (per IP, in-process) — Task 5. Every other
// throttle in this file guards a READ or a login attempt; this is the first
// one guarding the order-creating MUTATIONS themselves:
// `POST /api/v1/checkout` and `POST /topup/order`. Both share ONE quota
// deliberately (one Map, keyed by IP only) — same reasoning as
// checkoutPreviewRateLimited sharing across its two routes above: an
// attacker must not be able to reset the budget by alternating endpoints.
//
// Unlike checkoutPreviewRateLimited, this DOES apply to signed-in callers
// too — a preview is a cheap read that login already gates well enough, but
// this is a database-writing, potentially payment-gateway-calling mutation,
// so being logged in doesn't make repeat submits free.
// ---------------------------------------------------------------------------

const checkoutSubmitHits = new Map<string, number[]>();
export const CHECKOUT_SUBMIT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const CHECKOUT_SUBMIT_RATE_LIMIT_MAX = 30;

/** True if `ip` has exceeded its checkout/topup-submit quota within the window. */
export function checkoutSubmitRateLimited(ip: string): boolean {
  return slidingWindowLimited(checkoutSubmitHits, ip, CHECKOUT_SUBMIT_RATE_LIMIT_WINDOW_SECONDS, CHECKOUT_SUBMIT_RATE_LIMIT_MAX);
}

// ---------------------------------------------------------------------------
// Telegram-account-linking rate limit (per customer id, in-process) — Task 5.
// `GET /account/settings/link-telegram` only ever runs behind an
// authenticated session (routes/settings.ts's `currentCustomer` preHandler),
// so identity is the right dimension here rather than IP — same reasoning as
// `accountLockedOut`/`recordAccountFailure` above being keyed by identifier
// rather than source. Window/max (5/600s) mirrors
// GUEST_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS/_MAX since linking Telegram is a
// similarly rare, deliberate action.
//
// Keyed by `String(customerId)`: slidingWindowLimited's `store` param type is
// `Map<string, number[]>`, so this declares the same shape as every other
// throttle in this file rather than a `Map<number, ...>` that wouldn't
// type-check against it.
// ---------------------------------------------------------------------------

const linkTelegramHits = new Map<string, number[]>();
export const LINK_TELEGRAM_RATE_LIMIT_WINDOW_SECONDS = 600; // 10 minutes
export const LINK_TELEGRAM_RATE_LIMIT_MAX = 5;

/** True if `customerId` has exceeded its Telegram-linking quota within the window. */
export function linkTelegramRateLimited(customerId: number): boolean {
  return slidingWindowLimited(
    linkTelegramHits,
    String(customerId),
    LINK_TELEGRAM_RATE_LIMIT_WINDOW_SECONDS,
    LINK_TELEGRAM_RATE_LIMIT_MAX,
  );
}
