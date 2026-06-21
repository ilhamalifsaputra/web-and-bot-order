/**
 * Read-only probe for Bybit V5 OFF-CHAIN INTERNAL deposits — answers, before we
 * build anything, whether Bybit's instant UID→UID transfers can drive
 * auto-confirmation the *instant* way Binance Internal Transfer does (no
 * blockchain confirmation wait, which is the ~10-minute latency you see on the
 * current on-chain BEP20 deposit path).
 *
 * The current Bybit module (apps/order-bot/src/payments/bybitDeposit.ts) polls
 * GET /v5/asset/deposit/query-record — that is the ON-CHAIN deposit ledger, so
 * the bot can only deliver once the BEP20 deposit clears block confirmations and
 * Bybit credits it (status=3). UID→UID internal transfers are OFF-CHAIN and never
 * appear there; Bybit records them in a SEPARATE ledger:
 *
 *   GET /v5/asset/deposit/query-internal-record  ("Get Internal Deposit Records (off-chain)")
 *
 * If incoming internal transfers surface here with a usable `amount` (and ideally
 * a memo to match on), we can point the poller at this endpoint and reuse the
 * existing matchByAmount logic — making Bybit as instant as Binance Internal.
 *
 * This probe answers:
 *   1. API-key scope         — must be READ-ONLY (no Withdraw permission).
 *   2. Internal deposits     — do incoming UID transfers appear here, and with
 *                              what fields? Is there a memo/note for matching, or
 *                              must we match by UNIQUE AMOUNT (matchByAmount)?
 *   3. Status mapping        — internal-deposit `status` differs from on-chain
 *                              (docs: 1=Processing, 2=Success, 3=Failed) — pin the
 *                              real "credited" value so we deliver on the right one.
 *   4. On-chain contrast     — dump the on-chain ledger too, so the two are easy
 *                              to compare side by side.
 *   5. Funding wallet        — internal deposits land in the FUND account.
 *
 * READ-ONLY: only GET endpoints are called. Writes nothing, moves nothing.
 *
 * Setup (root .env):
 *   BYBIT_API_KEY=...
 *   BYBIT_API_SECRET=...
 *   BYBIT_API_BASE=https://api.bybit.com      # optional; testnet: https://api-testnet.bybit.com
 *
 * Run: pnpm exec tsx scripts/bybit-internal-probe.ts
 *
 * To get live rows: have a buyer (or yourself from another Bybit account) send a
 * small USDT INTERNAL transfer to this account's UID, then re-run.
 */
import { createHmac } from "node:crypto";
import "@app/core/config"; // side-effect: loads the monorepo-root .env into process.env

const BASE = process.env.BYBIT_API_BASE || "https://api.bybit.com";
const KEY = process.env.BYBIT_API_KEY || "";
const SECRET = process.env.BYBIT_API_SECRET || "";
const RECV = "5000";

interface BybitResp {
  httpStatus: number;
  retCode?: number;
  retMsg?: string;
  result?: Record<string, unknown>;
  raw?: string;
}

/** Bybit V5 GET auth: sign = HMAC_SHA256(secret, timestamp + apiKey + recvWindow + queryString). */
async function get(path: string, params: Record<string, string> = {}): Promise<BybitResp> {
  const query = new URLSearchParams(params).toString();
  const ts = String(Date.now());
  const sign = createHmac("sha256", SECRET).update(ts + KEY + RECV + query).digest("hex");
  const url = `${BASE}${path}${query ? `?${query}` : ""}`;
  const res = await fetch(url, {
    headers: {
      "X-BAPI-API-KEY": KEY,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-RECV-WINDOW": RECV,
      "X-BAPI-SIGN": sign,
    },
  });
  const text = await res.text();
  try {
    return { httpStatus: res.status, ...(JSON.parse(text) as Record<string, unknown>) };
  } catch {
    return { httpStatus: res.status, raw: text.slice(0, 500) };
  }
}

function rowsOf(r: BybitResp): Record<string, unknown>[] {
  return ((r.result?.rows ?? []) as Record<string, unknown>[]);
}

/** Internal-deposit status mapping per Bybit V5 docs (differs from on-chain!). */
function internalStatusLabel(status: unknown): string {
  switch (Number(status)) {
    case 1:
      return "1=Processing";
    case 2:
      return "2=Success (deliver on this)";
    case 3:
      return "3=Failed";
    default:
      return `${status}=?`;
  }
}

async function main(): Promise<void> {
  if (!KEY || !SECRET) {
    console.error("Set BYBIT_API_KEY / BYBIT_API_SECRET in the root .env first.");
    process.exit(1);
  }
  console.log(`Base: ${BASE}\n`);

  // 1) Permission scope — the key must NOT be able to withdraw.
  console.log("── 1. API-KEY PERMISSIONS (must NOT include Withdraw) ─────────────");
  const perm = await get("/v5/user/query-api");
  if (perm.retCode === 0 && perm.result) {
    const r = perm.result as { readOnly?: number; permissions?: Record<string, string[]> };
    console.log("readOnly:", r.readOnly, "| permissions:", JSON.stringify(r.permissions));
    const withdraw = r.permissions?.Withdraw ?? [];
    const wallet = r.permissions?.Wallet ?? [];
    console.log(
      withdraw.length
        ? "⚠ WARNING: key HAS Withdraw permission — create a read-only (Wallet) key instead."
        : "→ OK: no Withdraw permission.",
    );
    console.log(wallet.length ? "→ OK: Wallet read present (needed for deposit queries)." : "⚠ No Wallet permission — deposit queries below will fail.");
  } else {
    console.log("retCode", perm.retCode, perm.retMsg, "(HTTP", perm.httpStatus + ")", perm.raw ?? "");
  }

  // 2) INTERNAL (off-chain) deposits — the instant UID→UID path. THE KEY QUESTION.
  console.log("\n── 2. INTERNAL (OFF-CHAIN) DEPOSITS — last 30 days ────────────────");
  console.log("Endpoint: GET /v5/asset/deposit/query-internal-record (UID→UID, no blockchain wait)\n");
  const intl = await get("/v5/asset/deposit/query-internal-record", {
    coin: "USDT",
    startTime: String(Date.now() - 30 * 24 * 60 * 60 * 1000),
    endTime: String(Date.now()),
    limit: "50",
  });
  if (intl.retCode === 0) {
    const rows = rowsOf(intl);
    console.log(`rows: ${rows.length}`);
    for (const r of rows.slice(0, 5)) {
      console.log({
        keys: Object.keys(r), // ← inspect for any memo/note-carrying field
        coin: r.coin,
        amount: r.amount,
        txID: r.txID,
        status: internalStatusLabel(r.status),
        type: r.type,
        address: r.address, // sender info (likely masked email/uid)
        createdTime: r.createdTime,
      });
    }
    // Internal deposits normally carry NO buyer memo — flag any field that does.
    const memoKeys = ["tag", "memo", "note", "remark", "message"];
    const withMemo = rows.filter((r) => memoKeys.some((k) => String((r as Record<string, unknown>)[k] ?? "").trim() !== "")).length;
    console.log("\n── MATCHING VERDICT (internal) ──");
    console.log(`rows with any memo-like field populated: ${withMemo}/${rows.length}`);
    console.log(
      withMemo === 0
        ? "→ No memo (expected): match by UNIQUE AMOUNT (reuse matchByAmount + USE_UNIQUE_CENTS), same as on-chain."
        : "→ A memo field is populated — note which key above; could match by note like Binance.",
    );
    if (!rows.length) {
      console.log("(no internal deposits in window — send a small USDT INTERNAL transfer to this UID and re-run.)");
    }
    console.log(
      "\n→ If rows DO appear here once you test, Bybit can be made INSTANT: point the\n" +
        "  poller at this endpoint, map fields in normalizeInternalDeposit(), deliver on status=2.",
    );
  } else {
    console.log("retCode", intl.retCode, intl.retMsg, "(HTTP", intl.httpStatus + ")", intl.raw ?? "");
    console.log(
      "If this endpoint 404s / errors on retCode: this Bybit account/region may not\n" +
        "expose off-chain internal deposits via API — then the instant scheme isn't possible\n" +
        "and on-chain (with its confirmation latency) stays the only option.",
    );
  }

  // 3) ON-CHAIN deposits — for side-by-side contrast with the current behaviour.
  console.log("\n── 3. ON-CHAIN DEPOSITS (current path) — last 30 days ─────────────");
  console.log("Endpoint: GET /v5/asset/deposit/query-record (status 3 = success; has confirmation latency)\n");
  // query-record caps the window at ~30 days and wants an explicit endTime;
  // a full 30-day span (or an open-ended startTime) trips retCode 131002, so
  // keep the contrast window comfortably under the cap.
  const dep = await get("/v5/asset/deposit/query-record", {
    coin: "USDT",
    startTime: String(Date.now() - 7 * 24 * 60 * 60 * 1000),
    endTime: String(Date.now()),
    limit: "50",
  });
  if (dep.retCode === 0) {
    const rows = rowsOf(dep);
    console.log(`rows: ${rows.length}`);
    for (const r of rows.slice(0, 3)) {
      console.log({ coin: r.coin, chain: r.chain, amount: r.amount, txID: r.txID, status: r.status, tag: r.tag });
    }
  } else {
    console.log("retCode", dep.retCode, dep.retMsg, "(HTTP", dep.httpStatus + ")", dep.raw ?? "");
  }

  // 4) Funding wallet — both deposit kinds land in the FUND account.
  console.log("\n── 4. FUNDING WALLET (deposits land here) ─────────────────────────");
  const bal = await get("/v5/asset/transfer/query-account-coins-balance", { accountType: "FUND", coin: "USDT" });
  if (bal.retCode === 0) {
    const list = ((bal.result?.balance ?? []) as Record<string, unknown>[]);
    const b = list[0];
    console.log(b ? `USDT funding balance: ${b.walletBalance} (transferable ${b.transferBalance})` : "no USDT balance row yet.");
  } else {
    console.log("retCode", bal.retCode, bal.retMsg);
  }

  console.log("\nDone. Every call above was read-only (GET).");
}

main().catch((e: unknown) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
