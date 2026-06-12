/**
 * Customer auth — Telegram Login Widget verification + signed timed cookie
 * sessions (port of apps/web-admin/src/auth.ts's token scheme with a
 * customer-specific salt + cookie, so shop & admin sessions never collide
 * when both run in one process).
 *
 * Telegram Login verification (official algorithm):
 *   data_check_string = sorted "key=value" lines of every auth field but hash
 *   secret_key        = SHA256(bot_token)
 *   valid             ⇔ hex(HMAC_SHA256(data_check_string, secret_key)) == hash
 * plus an auth_date freshness window to stop replays (plan.md §17.2 #6).
 *
 * Session invalidation mirrors the admin: the cookie carries a `jti` that must
 * match `shop_session_jti:<telegramId>` in settings; logout rotates the jti.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "@app/core/config";
import { botToken as botToken_ } from "@app/core/runtime";

export const SHOP_COOKIE_NAME = "shop_session";
const SIGN_SALT = "storefront-session";
/** Customer sessions last longer than admin ones (shoppers, not operators). */
export const SHOP_SESSION_TTL_HOURS = 24 * 30;
/** Reject Telegram auth payloads older than this (replay guard). */
export const TG_AUTH_MAX_AGE_SECONDS = 15 * 60;

export const shopSessionJtiKey = (telegramId: number | bigint) =>
  `shop_session_jti:${telegramId}`;

// ---------------------------------------------------------------------------
// Telegram Login Widget verification
// ---------------------------------------------------------------------------

export interface TelegramAuthData {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
}

/**
 * Verify a Telegram Login payload (the query params Telegram appends to the
 * auth URL). Returns the parsed user data on success, null on any failure.
 */
export function verifyTelegramLogin(
  params: Record<string, string>,
  botToken = botToken_(),
  now = Date.now(),
): TelegramAuthData | null {
  const { hash, ...fields } = params;
  if (!hash || !fields.id || !fields.auth_date) return null;
  if (!botToken) return null; // no bot configured → no way to verify the HMAC

  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secretKey = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secretKey).update(checkString).digest("hex");
  if (!constantTimeEqual(expected, hash)) return null;

  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate)) return null;
  if (now / 1000 - authDate > TG_AUTH_MAX_AGE_SECONDS) return null; // stale = replay risk

  const id = Number(fields.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  return {
    id,
    first_name: fields.first_name,
    last_name: fields.last_name,
    username: fields.username,
    photo_url: fields.photo_url,
    auth_date: authDate,
  };
}

// ---------------------------------------------------------------------------
// Signed timed cookie sessions (same construction as web-admin)
// ---------------------------------------------------------------------------

export interface CustomerSession {
  userId: number;
  telegramId: number;
  jti: string;
  csrf: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function cookieSecret(): string {
  const s = config.WEB_COOKIE_SECRET;
  if (!s) throw new Error("WEB_COOKIE_SECRET is required for the storefront");
  return s;
}

function sign(body: string): string {
  return b64url(createHmac("sha256", cookieSecret()).update(`${SIGN_SALT}.${body}`).digest());
}

export const newJti = () => b64url(randomBytes(18));

/** Mint a fresh signed cookie value + its parsed payload. */
export function makeCustomerSession(
  userId: number,
  telegramId: number,
  jti: string,
): { raw: string; data: CustomerSession } {
  const data: CustomerSession = { userId, telegramId, jti, csrf: b64url(randomBytes(24)) };
  const payload = b64url(
    Buffer.from(JSON.stringify({ u: data.userId, t: data.telegramId, j: data.jti, c: data.csrf })),
  );
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = `${payload}.${ts}`;
  return { raw: `${body}.${sign(body)}`, data };
}

/** Validate a cookie's signature + age and return its payload, or null. */
export function readCustomerSession(raw: string | undefined): CustomerSession | null {
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [payload, ts, sig] = parts as [string, string, string];

  if (!constantTimeEqual(sig, sign(`${payload}.${ts}`))) return null;

  const issued = Number(ts);
  if (!Number.isFinite(issued)) return null;
  if (Date.now() / 1000 - issued > SHOP_SESSION_TTL_HOURS * 3600) return null;

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
