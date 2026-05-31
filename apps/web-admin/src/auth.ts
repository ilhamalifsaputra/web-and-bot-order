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
// TOTP 2FA (RFC 6238, SHA-1 / 6 digits / 30s) — implemented on node:crypto so
// the web stays buildless. Secrets are base32 (what authenticator apps expect).
// ---------------------------------------------------------------------------

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const twoFaSecretKey = (telegramId: number | bigint) => `web_2fa_secret:${telegramId}`;
export const twoFaPendingKey = (telegramId: number | bigint) => `web_2fa_pending:${telegramId}`;

/** Fresh base32 TOTP secret (160-bit). */
export const generateTotpSecret = (): string => base32Encode(randomBytes(20));

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return (bin % 1_000_000).toString().padStart(6, "0");
}

/** Current 6-digit code for a secret (the live step). Exposed for enrolment
 * confirmation flows and tests that must produce a valid code. */
export const currentTotp = (secret: string): string => hotp(secret, Math.floor(Date.now() / 1000 / 30));

/** True if `token` matches the secret within ±`window` 30s steps (clock skew). */
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const t = (token ?? "").trim();
  if (!/^\d{6}$/.test(t)) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    if (hotp(secret, step + i) === t) return true;
  }
  return false;
}

/** otpauth:// URI to paste/scan into an authenticator app. */
export function otpauthUri(secret: string, label: string, issuer = "StockAdmin"): string {
  const e = encodeURIComponent;
  return `otpauth://totp/${e(issuer)}:${e(label)}?secret=${secret}&issuer=${e(issuer)}&digits=6&period=30`;
}

// ---------------------------------------------------------------------------
// Signed timed cookie sessions
// ---------------------------------------------------------------------------

export interface SessionData {
  userId: number;
  telegramId: number;
  jti: string;
  csrf: string;
}

// ---------------------------------------------------------------------------
// Web-admin RBAC roles (stored in settings, like the password hash — no schema)
// ---------------------------------------------------------------------------

/** super = full access · support = operational mutations only · readonly = view + own password. */
export type WebRole = "super" | "support" | "readonly";
export const WEB_ROLES: readonly WebRole[] = ["super", "support", "readonly"];
export const DEFAULT_WEB_ROLE: WebRole = "super"; // unset role ⇒ super (backward compatible)

export const webRoleKey = (telegramId: number | bigint) => `web_admin_role:${telegramId}`;
export const isWebRole = (s: string | null | undefined): s is WebRole =>
  s != null && (WEB_ROLES as readonly string[]).includes(s);

/** req.admin shape: the cookie payload plus the server-loaded current role. */
export type AdminSession = SessionData & { role: WebRole };

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
