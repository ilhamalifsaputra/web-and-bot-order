/**
 * Read-only probe: signed GET /sapi/v1/pay/transactions, print what Binance
 * returns so we can confirm incoming transfers appear here WITH a note field.
 * Does not write anything. Run: pnpm exec tsx scripts/binance-probe.ts
 */
import { createHmac } from "node:crypto";
import { config } from "@app/core/config";

async function main() {
  if (!config.BINANCE_API_KEY || !config.BINANCE_API_SECRET) {
    console.error("BINANCE_API_KEY/SECRET not set in .env");
    process.exit(1);
  }
  const params = new URLSearchParams({
    startTime: String(Date.now() - 30 * 24 * 60 * 60 * 1000), // last 30 days
    limit: "100",
    timestamp: String(Date.now()),
    recvWindow: "5000",
  });
  const qs = params.toString();
  const sig = createHmac("sha256", config.BINANCE_API_SECRET).update(qs).digest("hex");
  const url = `${config.BINANCE_API_BASE}/sapi/v1/pay/transactions?${qs}&signature=${sig}`;

  const res = await fetch(url, { headers: { "X-MBX-APIKEY": config.BINANCE_API_KEY } });
  console.log("HTTP", res.status);
  const text = await res.text();
  let body: { data?: unknown[] };
  try {
    body = JSON.parse(text);
  } catch {
    console.log("non-JSON response:", text.slice(0, 500));
    return;
  }
  const rows = (body.data ?? []) as Record<string, unknown>[];
  console.log(`rows: ${rows.length}`);
  for (const r of rows.slice(0, 5)) {
    // Show the fields the matcher cares about + the full key set for mapping.
    console.log({
      keys: Object.keys(r),
      transactionId: r.transactionId,
      amount: r.amount,
      currency: r.currency,
      note: r.note,
      orderId: r.orderId,
      transactionType: r.transactionType ?? r.orderType,
    });
  }
  if (!rows.length) console.log("(no transactions in window — try sending a small test transfer first)");
}

main().catch((e) => {
  console.error("ERR", e.message ?? e);
  process.exit(1);
});
