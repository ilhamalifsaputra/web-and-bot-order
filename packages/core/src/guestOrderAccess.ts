import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { webCookieSecret } from "./runtime";

export const GUEST_ORDER_ACCESS_TTL_SECONDS = 30 * 24 * 3600;

function signature(body: string): Buffer {
  const secret = webCookieSecret();
  if (!secret) throw new Error("WEB_COOKIE_SECRET is required");
  return createHmac("sha256", secret).update(`guest-order-access.v1.${body}`).digest();
}

/** Token acak, terikat satu order dan waktu; terpisah dari cookie/login admin. */
export function mintGuestOrderAccess(orderCode: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ c: orderCode, t: Math.floor(now / 1000), n: randomBytes(24).toString("base64url") })).toString("base64url");
  return `${body}.${signature(body).toString("base64url")}`;
}

export function verifyGuestOrderAccess(token: unknown, orderCode: string, now = Date.now()): boolean {
  if (typeof token !== "string" || token.length > 1024) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  try {
    const [body, rawSignature] = parts as [string, string];
    const actual = Buffer.from(rawSignature, "base64url");
    const expected = signature(body);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const age = Math.floor(now / 1000) - data.t;
    return data.c === orderCode && Number.isSafeInteger(data.t) && age >= 0 && age < GUEST_ORDER_ACCESS_TTL_SECONDS;
  } catch { return false; }
}

/** Fragment tidak dikirim sebagai URL HTTP/referrer ke origin. */
export function guestOrderRecoveryUrl(base: string, orderCode: string): string {
  return `${base}/track#${new URLSearchParams({ order_code: orderCode, access_token: mintGuestOrderAccess(orderCode) })}`;
}
