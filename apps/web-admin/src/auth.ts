/**
 * Auth primitives — port of telegram-stock-web/app/auth.py.
 *
 * Session model
 * -------------
 * A logged-in admin holds one signed cookie carrying `{u,t,j,c}`
 * (user_id, telegram_id, jti, csrf). The matching `jti` is stored in the bot's
 * `settings` table under `web_session_jti:<telegram_id>`. Logout rotates that
 * jti, which invalidates any cookie still in the wild — server-side
 * invalidation without a sessions table.
 *
 * The Python original used itsdangerous `URLSafeTimedSerializer` (HMAC + an
 * embedded timestamp checked against max_age). We reproduce that exactly with
 * a small HMAC-SHA256 timed token rather than @fastify/cookie's signing (which
 * has no server-side TTL): `<payloadB64url>.<ts>.<sigB64url>`.
 *
 * Password storage: bcrypt hashes under `web_admin_password_hash:<telegram_id>`.
 * We use bcryptjs (pure-JS, hash-compatible with Python's bcrypt $2b$ hashes)
 * to stay buildless on Windows; rounds=12 matches the Python original.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { config } from "@app/core/config";

const PWD_HASH_PREFIX = "web_admin_password_hash:";
const SESSION_JTI_PREFIX = "web_session_jti:";
const SIGN_SALT = "stockweb-session";

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, bcrypt.genSaltSync(12));
}

export function verifyPassword(plain: string, hashed: string): boolean {
  try {
    return bcrypt.compareSync(plain, hashed);
  } catch {
    return false;
  }
}

export const passwordHashKey = (telegramId: number | bigint) =>
  `${PWD_HASH_PREFIX}${telegramId}`;

export const sessionJtiKey = (telegramId: number | bigint) =>
  `${SESSION_JTI_PREFIX}${telegramId}`;

// ---------------------------------------------------------------------------
// Signed timed cookie sessions
// ---------------------------------------------------------------------------

export interface SessionData {
  userId: number;
  telegramId: number;
  jti: string;
  csrf: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(body: string): string {
  return b64url(createHmac("sha256", cookieSecret()).update(`${SIGN_SALT}.${body}`).digest());
}

function cookieSecret(): string {
  const s = config.WEB_COOKIE_SECRET;
  if (!s) throw new Error("WEB_COOKIE_SECRET is required for the web admin");
  return s;
}

export const newJti = () => b64url(randomBytes(18));

/** Mint a fresh signed cookie value and return it alongside the parsed payload. */
export function makeSession(
  userId: number,
  telegramId: number,
  jti: string,
): { raw: string; data: SessionData } {
  const data: SessionData = { userId, telegramId, jti, csrf: b64url(randomBytes(24)) };
  const payload = b64url(
    Buffer.from(JSON.stringify({ u: data.userId, t: data.telegramId, j: data.jti, c: data.csrf })),
  );
  const ts = Math.floor(nowMs() / 1000).toString();
  const body = `${payload}.${ts}`;
  return { raw: `${body}.${sign(body)}`, data };
}

/** Validate a cookie's signature + age and return its payload, or null. */
export function readSession(raw: string | undefined): SessionData | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [payload, ts, sig] = parts as [string, string, string];

  const expected = sign(`${payload}.${ts}`);
  if (!constantTimeEqual(sig, expected)) return null;

  const issued = Number(ts);
  if (!Number.isFinite(issued)) return null;
  const maxAgeSec = config.WEB_SESSION_TTL_HOURS * 3600;
  if (nowMs() / 1000 - issued > maxAgeSec) return null;

  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return {
      userId: Number(obj.u),
      telegramId: Number(obj.t),
      jti: String(obj.j),
      csrf: String(obj.c),
    };
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// `Date.now` is fine at runtime; isolated behind a fn so tests stay readable.
function nowMs(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Login rate limit (per IP, in-process) — mirrors the Python deque approach.
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
