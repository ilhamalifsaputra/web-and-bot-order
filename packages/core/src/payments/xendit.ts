/**
 * Xendit gateway settings + connection check (QRIS and cards). Pure: no
 * @app/db dependency (credential resolution lives in @app/db `getXenditCreds`).
 *
 * This task only covers admin configuration; the payment flow (checkout,
 * webhook, reconcile) is added later. The callback token is the Xendit
 * "Webhook verification token", later compared with the `x-callback-token`
 * request header.
 */
import { HTTP_TIMEOUT_MS } from "../http";

export const XENDIT_ENABLED_KEY = "xendit_enabled";
export const XENDIT_SECRET_KEY = "xendit_secret_key";
export const XENDIT_CALLBACK_TOKEN_KEY = "xendit_callback_token";
export const XENDIT_QRIS_ENABLED_KEY = "xendit_qris_enabled";
export const XENDIT_CARD_ENABLED_KEY = "xendit_card_enabled";

const API_BASE = process.env.XENDIT_API_BASE ?? "https://api.xendit.co";

export type XenditCreds = {
  secretKey: string;
  callbackToken: string;
  qrisEnabled: boolean;
  cardEnabled: boolean;
};

export type XenditMode = "test" | "live";

/** Test or live, read from the key prefix alone; null for anything else. */
export function xenditMode(secretKey: string): XenditMode | null {
  const key = secretKey.trim();
  if (key.startsWith("xnd_development_")) return "test";
  if (key.startsWith("xnd_production_")) return "live";
  return null;
}

export type XenditConnectionResult =
  | { ok: true; mode: XenditMode | null; balance: number | null }
  | { ok: false; reason: "unauthorized" | "http_error" | "network"; status?: number };

/**
 * Proves the secret key is accepted by calling the read-only balance endpoint.
 * Never throws, and never puts the key (or the underlying fetch error, whose
 * `cause` can carry request headers) into a result or message.
 */
export async function checkXenditConnection(
  secretKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<XenditConnectionResult> {
  const auth = Buffer.from(`${secretKey}:`).toString("base64");
  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}/balance`, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS.gatewayWrite), // an admin is waiting on the Settings page
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "unauthorized", status: res.status };
  if (!res.ok) return { ok: false, reason: "http_error", status: res.status };
  let balance: number | null = null;
  try {
    const body = (await res.json()) as { balance?: unknown };
    if (typeof body.balance === "number" && Number.isFinite(body.balance)) balance = body.balance;
  } catch {
    balance = null;
  }
  return { ok: true, mode: xenditMode(secretKey), balance };
}
