/**
 * The TokoPay channel code the shop sends as `metode` (default "QRIS").
 * A leaf module — it imports only the settings reader — so crud files that
 * crud/tokopay.ts itself imports (orderStatus.ts, wallet_topup.ts) can read
 * the channel without an import cycle.
 */
import { TOKOPAY_CHANNEL_KEY } from "@app/core/payments/tokopay";
import type { Db } from "./_types";
import { getSetting } from "./settings";

export async function getTokopayChannel(db: Db): Promise<string> {
  return ((await getSetting(db, TOKOPAY_CHANNEL_KEY)) ?? "QRIS").trim() || "QRIS";
}
