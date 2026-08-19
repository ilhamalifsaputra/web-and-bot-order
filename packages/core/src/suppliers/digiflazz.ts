/**
 * Digiflazz supplier client (HTTP + signature) — the auto-fulfillment backend
 * for the "Top Up Game" instant-checkout pilot. Pure: no @app/db dependency
 * (credential resolution belongs to a later task, in @app/db). Mirrors
 * `../payments/tokopay.ts`'s shape.
 *
 * ⚠ ASSUMPTION (flagged, same spirit as tokopay.ts): this is a pilot scaffold,
 *   not a certified integration. The endpoint paths, request/response field
 *   names, and MD5 signature formulas below are modeled on Digiflazz's
 *   publicly documented API shape but have not been verified against a live
 *   account. Verify against the real Digiflazz dashboard/docs before go-live.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Decimal } from "../money";
import { logger } from "../logger";
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "../http";

const API_BASE = process.env.DIGIFLAZZ_API_BASE ?? "https://api.digiflazz.com/v1";

export interface DigiflazzCreds {
  username: string;
  apiKey: string;
}

/** The three states Digiflazz reports for a top-up order. Anything the
 * supplier sends that isn't recognized collapses to "Pending" — never assumed
 * delivered, never assumed dead, so a garbled response can't cause a double
 * dispatch or strand a buyer who did pay (same fail-safe-to-"not yet"
 * philosophy as `../payments/paymentStatus.ts`'s `normalizeProviderStatus`). */
export type DigiflazzStatus = "Sukses" | "Pending" | "Gagal";

function normalizeStatus(raw: string | null): DigiflazzStatus {
  const status = (raw ?? "").trim().toLowerCase();
  if (status === "sukses" || status === "success") return "Sukses";
  if (status === "gagal" || status === "failed") return "Gagal";
  return "Pending";
}

/**
 * POST a Digiflazz endpoint whose JSON body carries the username/API key, and
 * return its parsed JSON body. Every failure mode of the raw `fetch()` call is
 * caught HERE, inside this single choke point, via `fetchWithTimeoutSafe`
 * (`@app/core/http`): it rethrows a new `Error` built from a static,
 * credential-free string, whether `fetch()` itself rejected (DNS failure,
 * connection refused, aborted, TLS error, …: Node's `fetch` sometimes attaches
 * the failed request — including the body it was sent with — to `err.cause`,
 * which a naive `logger.error({ err })` downstream would serialize whole,
 * echoing the API key straight back into logs) or the deadline (`timeoutMs`)
 * elapsed first. `res.json()` gets the same static-message treatment below on
 * a malformed body. The existing `!res.ok` branch keeps its own static-message
 * throw. Both `getPriceList` and `createTransaction` share this one guarantee.
 */
async function fetchDigiflazzJson(
  url: string,
  init: Omit<RequestInit, "signal">,
  errorPrefix: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeoutSafe(url, { ...init, timeoutMs }, errorPrefix); // never log init.body — it carries the API key
  if (!res.ok) {
    throw new Error(`${errorPrefix} HTTP ${res.status}`); // never log init.body — it carries the API key
  }
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    // AbortSignal.timeout stays attached to the response body in undici, so a
    // peer that sends headers and then stalls the body makes res.json()
    // reject with this same TimeoutError shape (http.ts) — distinguish that
    // from a genuinely malformed body so the caller isn't told the supplier
    // sent garbage when it actually just hung.
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`${errorPrefix} response body read timed out`); // never log init.body — it carries the API key
    }
    throw new Error(`${errorPrefix} returned an unparseable response`); // never log init.body — it carries the API key
  }
}

function jsonPost(payload: Record<string, unknown>): Omit<RequestInit, "signal"> {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  };
}

export interface DigiflazzPriceListItem {
  buyerSkuCode: string;
  productName: string;
  category: string | null;
  brand: string | null;
  type: string | null;
  price: Decimal;
  buyerProductStatus: boolean;
  sellerProductStatus: boolean;
  /** Null when the supplier reports unlimited/no stock figure. */
  stock: number | null;
}

/**
 * Fetch Digiflazz's full prepaid SKU/price list for this account.
 *
 * ⚠ ASSUMPTION (flagged, same as the rest of this client): the `cmd:
 *   "prepaid"` request shape and the `sign = md5(username + apiKey +
 *   "pricelist")` formula follow Digiflazz's public docs. Verify against the
 *   live dashboard before go-live.
 */
export async function getPriceList(creds: DigiflazzCreds): Promise<DigiflazzPriceListItem[]> {
  const sign = createHash("md5").update(`${creds.username}${creds.apiKey}pricelist`).digest("hex");
  const body = (await fetchDigiflazzJson(
    `${API_BASE}/price-list`,
    jsonPost({ cmd: "prepaid", username: creds.username, sign }),
    "Digiflazz price list",
    HTTP_TIMEOUT_MS.gatewayRead, // catalog sync poll — the next tick retries if this is slow
  )) as { data?: unknown };
  const rows = Array.isArray(body.data) ? body.data : [];
  return rows.map((raw) => toPriceListItem(raw as Record<string, unknown>));
}

function toPriceListItem(d: Record<string, unknown>): DigiflazzPriceListItem {
  return {
    buyerSkuCode: str(d.buyer_sku_code) ?? "",
    productName: str(d.product_name) ?? "",
    category: str(d.category),
    brand: str(d.brand),
    type: str(d.type),
    price: toDecimalOrZero(d.price),
    buyerProductStatus: d.buyer_product_status === true,
    sellerProductStatus: d.seller_product_status === true,
    stock: typeof d.stock === "number" && Number.isFinite(d.stock) ? d.stock : null,
  };
}

/**
 * Extract a region code from the trailing parenthetical of a Digiflazz product name.
 *
 * Applies the regex `/\s*\(([^)]+)\)\s*$/` to match a trailing parenthetical suffix,
 * trimming and returning the captured text, or `null` if no match or the match is denylisted.
 *
 * **Denylist guard**: Not every trailing parenthetical is a region — Digiflazz also uses
 * parens for delivery-speed annotations like `"(Instant)"`, `"(1-3 Menit)"`, or
 * `"(Proses Cepat)"`. The denylist is case-insensitive and includes:
 * - `INSTANT`
 * - `/^\d+-\d+\s*(menit|jam|hari)$/i` (duration patterns like "1-3 Menit", "2 Jam")
 * - `PROSES CEPAT`
 *
 * A denylisted match always returns `null`, never a false split.
 *
 * **Note**: This denylist should be extended (verified against the admin's `/sync/preview`
 * screen) if a future non-region annotation starts incorrectly splitting a brand.
 * This is the highest-risk part of catalog sync; test coverage is critical.
 */
export function parseProductRegion(productName: string): string | null {
  const match = productName.match(/\s*\(([^)]+)\)\s*$/);
  if (!match) return null;

  const captured = match[1]!.trim();

  // Check denylist (case-insensitive)
  const upper = captured.toUpperCase();

  // Exact matches
  if (upper === "INSTANT" || upper === "PROSES CEPAT") {
    return null;
  }

  // Duration pattern: e.g., "1-3 Menit", "2 Jam", "30 Hari"
  if (/^\d+-\d+\s*(menit|jam|hari)$/i.test(captured)) {
    return null;
  }

  return captured;
}

/**
 * Strip a region suffix from a Digiflazz product name if present.
 *
 * Uses `parseProductRegion` internally to determine whether the trailing
 * parenthetical is a region. Only strips if `parseProductRegion` returns
 * non-null, ensuring the two functions never disagree about what counts
 * as a region.
 *
 * Input with no region suffix passes through completely unchanged (same
 * string, same whitespace).
 */
export function stripRegionSuffix(productName: string): string {
  if (parseProductRegion(productName) === null) {
    return productName;
  }
  // Strip the trailing parenthetical: match and remove everything from the last
  // non-whitespace char of the opening paren onwards, plus any trailing whitespace
  return productName.replace(/\s*\([^)]+\)\s*$/, "");
}

/**
 * Generate a grouping key from a Digiflazz brand and product name.
 *
 * Returns an object with:
 * - `brand`: the input brand unchanged
 * - `region`: the result of `parseProductRegion(productName)` (null if no region)
 * - `displayName`: if a region is present, `"${brand} (${region})"`, otherwise just `brand`
 *
 * The `displayName` is the value later used as both `Product.name` and
 * `Product.digiflazzBrand` during catalog sync. This function must be deterministic
 * and is depended on by downstream grouping and migration logic.
 */
export function digiflazzGroupKey(
  brand: string,
  productName: string,
): { brand: string; region: string | null; displayName: string } {
  const region = parseProductRegion(productName);
  return {
    brand,
    region,
    displayName: region ? `${brand} (${region})` : brand,
  };
}

export interface DigiflazzTransactionResult {
  refId: string;
  status: DigiflazzStatus;
  /** Serial number / receipt, present once status is "Sukses". */
  sn: string | null;
  /** Supplier-provided detail — success confirmation text, pending notice, or
   * failure reason, depending on `status`. */
  message: string | null;
  price: Decimal | null;
}

/**
 * Place a top-up order (deposit — prepaid). `refId` is Digiflazz's
 * idempotency key: a repeat call with the same `refId` returns the existing
 * transaction rather than creating a new one.
 *
 * ⚠ ASSUMPTION (flagged, same as the rest of this client): the request shape
 *   and the `sign = md5(username + apiKey + refId)` formula follow Digiflazz's
 *   public docs. Verify against the live dashboard before go-live.
 */
export async function createTransaction(
  creds: DigiflazzCreds,
  args: { refId: string; buyerSkuCode: string; customerNo: string },
): Promise<DigiflazzTransactionResult> {
  const sign = createHash("md5").update(`${creds.username}${creds.apiKey}${args.refId}`).digest("hex");
  const body = (await fetchDigiflazzJson(
    `${API_BASE}/transaction`,
    jsonPost({
      username: creds.username,
      buyer_sku_code: args.buyerSkuCode,
      customer_no: args.customerNo,
      ref_id: args.refId,
      sign,
    }),
    "Digiflazz transaction",
    HTTP_TIMEOUT_MS.gatewayWrite, // a human is waiting at checkout for this to resolve
  )) as { data?: Record<string, unknown> };
  const d = body.data;
  if (!d) {
    throw new Error("Digiflazz transaction rejected: missing data in response");
  }
  return {
    refId: str(d.ref_id) ?? args.refId,
    status: normalizeStatus(str(d.status)),
    sn: str(d.sn),
    message: str(d.message),
    price: d.price != null ? toDecimalOrNull(d.price) : null,
  };
}

export interface DigiflazzCallback {
  refId: string;
  status: DigiflazzStatus;
  sn: string | null;
  message: string | null;
  price: Decimal | null;
}

/**
 * Verify a webhook callback's signature + normalize. Returns null on
 * bad/missing signature, mirroring `../payments/tokopay.ts`'s
 * `verifyCallback` — same MD5 + constant-time-compare style, just against the
 * single dashboard-configured webhook secret rather than a merchant id pair.
 *
 * ⚠ ASSUMPTION (flagged, same as the rest of this client): the callback body
 *   shape (`ref_id`/`signature` alongside the transaction fields) and the
 *   `expected = md5(refId + ":" + secretKey)` formula are a plausible model
 *   for this pilot, not verified against a live Digiflazz webhook delivery.
 *   Verify against the live dashboard before go-live.
 */
export function verifyCallback(secretKey: string, body: Record<string, unknown>): DigiflazzCallback | null {
  const refId = firstString(body.ref_id, body.trx_id, body.reference);
  const signature = firstString(body.signature, body.sign);
  if (!refId || !signature) return null;

  const expected = createHash("md5").update(`${refId}:${secretKey}`).digest("hex");
  if (!constantTimeEqual(expected, signature.toLowerCase())) {
    logger.warn(`Digiflazz callback signature mismatch for reference ${refId} — rejecting the callback as unverified`);
    return null;
  }

  return {
    refId,
    status: normalizeStatus(firstString(body.status)),
    sn: firstString(body.sn),
    message: firstString(body.message),
    price: body.price != null ? toDecimalOrNull(body.price) : null,
  };
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    const s = str(v);
    if (s !== null) return s;
  }
  return null;
}

function toDecimalOrZero(v: unknown): Decimal {
  return toDecimalOrNull(v) ?? new Decimal(0);
}

function toDecimalOrNull(v: unknown): Decimal | null {
  if (v == null) return null;
  try {
    return new Decimal(String(v));
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
