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
  if (!rows.length) {
    console.log("(no transactions in window — send a small memo'd test transfer first)");
    return;
  }

  // ── Verdict: does the buyer memo actually surface in a usable field? ────────
  // paymentRef is a 10-char uppercase hex string (generatePaymentRef()).
  const REF = /^[0-9A-F]{10}$/;
  const memoFields = ["note", "remark", "message"] as const;
  const nonEmptyNote = rows.filter((r) => String(r.note ?? "").trim() !== "").length;
  const refLike = rows.filter((r) =>
    memoFields.some((f) => REF.test(String(r[f] ?? "").trim().toUpperCase())),
  );

  console.log("\n── NOTE-FIELD VERDICT ─────────────────────────────");
  console.log(`rows with a non-empty 'note'        : ${nonEmptyNote}/${rows.length}`);
  console.log(`rows whose memo looks like a paymentRef (10-hex): ${refLike.length}`);
  if (refLike.length) {
    console.log("→ PASS: a buyer memo IS captured. note-matching is viable.");
    for (const r of refLike.slice(0, 3)) {
      const carrier = memoFields.find((f) => REF.test(String(r[f] ?? "").trim().toUpperCase()));
      console.log(`   tx=${r.transactionId} amount=${r.amount} ${carrier}=${r[carrier!]}`);
    }
  } else if (nonEmptyNote > 0) {
    console.log("→ PARTIAL: some notes are populated but none match a paymentRef.");
    console.log("   Re-run AFTER sending a transfer whose memo is the order's paymentRef.");
  } else {
    console.log("→ FAIL (so far): every memo field is empty in this window.");
    console.log("   Either the payload doesn't carry the memo, or no memo'd transfer");
    console.log("   has landed yet. Send one (memo = the order's paymentRef) and re-run.");
    console.log("   If it stays empty, rely on the amount fallback + USE_UNIQUE_CENTS=1.");
  }
}

main().catch((e) => {
  console.error("ERR", e.message ?? e);
  process.exit(1);
});
