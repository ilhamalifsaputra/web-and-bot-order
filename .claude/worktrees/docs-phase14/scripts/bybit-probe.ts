/**
 * Read-only probe for Bybit V5 — answers, before we build anything, whether
 * incoming deposits can drive auto-confirmation the way Binance Internal does:
 *
 *   1. API-key scope   — must be READ-ONLY (no Withdraw permission).
 *   2. USDT chains      — per-chain deposit enabled? confirmations? (we use BEP20).
 *   3. Recent deposits  — do they surface here, and with what fields? In
 *                         particular: is there a usable memo/`tag` for matching,
 *                         or must we match by UNIQUE AMOUNT (as expected on BEP20)?
 *   4. Funding wallet   — deposits land in the FUND account; confirm we can read it.
 *
 * READ-ONLY: only GET endpoints are called. Writes nothing, moves nothing.
 *
 * Setup (root .env):
 *   BYBIT_API_KEY=...
 *   BYBIT_API_SECRET=...
 *   BYBIT_API_BASE=https://api.bybit.com      # optional; testnet: https://api-testnet.bybit.com
 *
 * Run: pnpm exec tsx scripts/bybit-probe.ts
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
    console.log(wallet.length ? "→ OK: Wallet read present (needed for deposit/coin queries)." : "⚠ No Wallet permission — deposit queries below will fail.");
  } else {
    console.log("retCode", perm.retCode, perm.retMsg, "(HTTP", perm.httpStatus + ")", perm.raw ?? "");
  }

  // 2) USDT chains — deposit enabled? confirmations? (BEP20/BSC is our target).
  console.log("\n── 2. USDT CHAINS (deposit / confirmations / Bybit withdraw-fee) ──");
  const info = await get("/v5/asset/coin/query-info", { coin: "USDT" });
  if (info.retCode === 0) {
    const usdt = rowsOf(info).find((x) => x.coin === "USDT");
    const chains = ((usdt?.chains ?? []) as Record<string, unknown>[]);
    for (const c of chains) {
      console.log(
        `chain=${String(c.chain).padEnd(8)} type=${String(c.chainType ?? "").padEnd(16)}` +
          ` deposit=${c.chainDeposit} confirms=${c.confirmation} withdrawFee=${c.withdrawFee} depositMin=${c.depositMin}`,
      );
    }
    const bsc = chains.find((x) => /bsc|bep20|bnb smart/i.test(`${x.chain} ${x.chainType}`));
    console.log(
      bsc
        ? `→ BEP20 row found: chain="${bsc.chain}" deposit=${bsc.chainDeposit} confirms=${bsc.confirmation}`
        : "→ BEP20 chain NOT found by name — check the chain= column above for the right id.",
    );
    console.log(
      "Note: withdrawFee = what Bybit charges to SEND out; the buyer's BEP20 deposit\n" +
        "      fee is paid by the buyer's wallet (BSC gas, ~$0.10–0.30). confirms = blocks\n" +
        "      before Bybit credits the deposit (that's your auto-confirm latency).",
    );
  } else {
    console.log("retCode", info.retCode, info.retMsg, "— needs Wallet read permission.");
  }

  // 3) Recent deposits — do they appear, and is there a memo/tag to match on?
  console.log("\n── 3. RECENT DEPOSITS (last 30 days) ──────────────────────────────");
  const dep = await get("/v5/asset/deposit/query-record", {
    coin: "USDT",
    startTime: String(Date.now() - 30 * 24 * 60 * 60 * 1000),
    limit: "50",
  });
  if (dep.retCode === 0) {
    const rows = rowsOf(dep);
    console.log(`rows: ${rows.length}`);
    for (const r of rows.slice(0, 5)) {
      console.log({
        keys: Object.keys(r),
        coin: r.coin,
        chain: r.chain,
        amount: r.amount,
        txID: r.txID,
        status: r.status, // 3 = success (deliver only on success)
        tag: r.tag,
        toAddress: r.toAddress,
        depositType: r.depositType,
      });
    }
    const withTag = rows.filter((r) => String(r.tag ?? "").trim() !== "").length;
    console.log("\n── MATCHING VERDICT ──");
    console.log(`rows with a non-empty 'tag'/memo: ${withTag}/${rows.length}`);
    console.log(
      withTag === 0
        ? "→ As expected for BEP20 (no memo): match by UNIQUE AMOUNT (matchByAmount + unique-cents)."
        : "→ Some deposits carry a tag — but plain BEP20 USDT normally has none; don't rely on it.",
    );
    if (!rows.length) {
      console.log("(no deposits in window — send a small BEP20 USDT test deposit and re-run.)");
    }
  } else {
    console.log("retCode", dep.retCode, dep.retMsg, "(HTTP", dep.httpStatus + ")", dep.raw ?? "");
    console.log("Hints: 10003 invalid key · 10004 sign error · 10005/permission → key lacks Wallet read.");
  }

  // 4) Funding wallet — deposits land in the FUND account.
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
