import { Decimal } from "../money";
import { fetchWithTimeoutSafe, HTTP_TIMEOUT_MS } from "../http";

const API_BASE = process.env.COINGECKO_API_BASE ?? "https://api.coingecko.com/api/v3";

// Note: This client supports only CoinGecko's demo-tier API key (x-cg-demo-api-key header).
// Pro-tier keys (x-cg-pro-api-key, pro-api.coingecko.com) are not supported.

/**
 * Fetch tether's current IDR spot price from CoinGecko's `/simple/price`
 * endpoint. Throws on any failure — timeout, non-2xx (429 included), a
 * malformed body, or a missing/non-positive `tether.idr` figure. The caller
 * (`fx.ts`'s `fetchUsdIdrMarketRate`) treats every throw identically: the
 * previously saved `usd_idr_rate` stays in effect.
 */
export async function fetchTetherIdrPrice(apiKey?: string): Promise<Decimal> {
  const url = `${API_BASE}/simple/price?ids=tether&vs_currencies=idr`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-cg-demo-api-key"] = apiKey;

  const res = await fetchWithTimeoutSafe(
    url,
    { method: "GET", headers, timeoutMs: HTTP_TIMEOUT_MS.priceRead },
    "CoinGecko price lookup",
  );
  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? "CoinGecko price lookup was rate-limited (HTTP 429)"
        : `CoinGecko price lookup answered HTTP ${res.status}`,
    );
  }
  let data: { tether?: { idr?: unknown } };
  try {
    data = (await res.json()) as { tether?: { idr?: unknown } };
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("CoinGecko price lookup response body read timed out");
    }
    throw new Error("CoinGecko price lookup returned an unparseable response");
  }
  const idr = data.tether?.idr;
  if (typeof idr !== "number" || !Number.isFinite(idr) || idr <= 0) {
    throw new Error("CoinGecko price lookup returned no usable tether.idr figure");
  }
  return new Decimal(idr);
}
