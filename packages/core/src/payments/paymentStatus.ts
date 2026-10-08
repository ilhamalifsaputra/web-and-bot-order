/**
 * The one place that answers "did the provider say this is paid?" (Task E7).
 *
 * Six rails each answered it their own way, in six different files, in three
 * different type systems — two string allowlists, one exact string match, two
 * magic integers, and one rail with no provider status at all. The sharp edge
 * is the Bybit pair: two rails on the same exchange, sharing one API credential
 * and one ledger table, where the deposit-status enum INVERTS. On the
 * internal-transfer ledger `2` is Success and `3` is Failed; on the on-chain
 * ledger `3` is Success and `2` is merely Processing. Both files carried
 * comments warning about it, which is precisely the sign it should be a fact
 * the compiler holds rather than a warning a reader has to remember.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * This centralises a MAPPING and nothing else. It is not a `PaymentStatus`
 * column on `Order`, not a `Payment` table, and not a second state machine
 * beside `OrderStatus` + the per-gateway `Processed*Tx` ledgers. Those remain
 * the canonical model; building a parallel payment system next to them is
 * explicitly out of bounds for this branch.
 *
 * Nothing here decides whether an order is delivered. `paid` means "the gateway
 * says the money arrived" — the idempotency ledgers decide what is done about
 * that, exactly once.
 *
 * ── DEPENDENCY RULE ────────────────────────────────────────────────────────
 * `packages/core` never imports `packages/db`, `packages/outbox-dispatcher` or
 * any `apps/*`. This module is pure functions over primitives, no I/O.
 */

/**
 * The internal vocabulary every provider status collapses into.
 *
 * Semantic phases rather than the union of every gateway's raw enum: callers
 * only ever branch on "settle this now" versus "not yet" versus "this is over".
 * A rail that reports something outside its known set maps to `pending`, which
 * is the safe default — it means "come back next cycle", never "deliver" and
 * never "give up on the buyer's money".
 */
export type NormalizedPaymentStatus =
  /** The gateway says the money arrived. Settle it. */
  | "paid"
  /** Not settled yet, and not over — in flight, unknown, or unrecognised. */
  | "pending"
  | "detected"
  | "verifying"
  | "underpaid"
  /** The gateway reported a terminal non-success (failed or refunded). */
  | "failed"
  /** The payment window closed at the gateway's end. */
  | "expired";

/**
 * The rails that HAVE a provider status to normalise.
 *
 * `BINANCE_INTERNAL` is deliberately absent, and that absence is the point —
 * see `PROVIDERS_WITHOUT_STATUS` below. The two Bybit rails are separate
 * members precisely because their enums disagree; there is no `BYBIT` that
 * could be passed for either.
 */
export const StatusProvider = {
  TOKOPAY: "TOKOPAY",
  PAYDISINI: "PAYDISINI",
  NOWPAYMENTS: "NOWPAYMENTS",
  /** Bybit internal transfer (UID→UID, off-chain). Success = 2. */
  BYBIT_INTERNAL: "BYBIT_INTERNAL",
  /** Bybit on-chain BSC/BEP20 deposit. Success = 3. */
  BYBIT_BSC: "BYBIT_BSC",
} as const;

export type StatusProvider = (typeof StatusProvider)[keyof typeof StatusProvider];

/**
 * Rails whose confirmation is NOT a provider status at all, documented here so
 * "which rail does this module cover?" has an answer in code rather than by
 * omission.
 *
 * Binance Internal reports no status field. A transfer either appears in the
 * incoming-transfer list or it does not, and confirmation is decided entirely
 * by OUR own matching — the order code in the transfer note, or the unique
 * amount. Forcing it through `normalizeProviderStatus` would mean inventing a
 * status the gateway never sent, so this module refuses to model it and the
 * rail keeps deciding for itself. An explicit gap is safer than a convincing
 * lie.
 */
export const PROVIDERS_WITHOUT_STATUS = ["BINANCE_INTERNAL"] as const;

/**
 * Gateway status strings TokoPay and PayDisini treat as settled.
 *
 * Both gateways are Indonesian and report in either language, hence `lunas`
 * and `berhasil` beside their English equivalents. The two rails have always
 * shared one list; TokoPay's webhook briefly carried a shorter inline copy
 * missing the two Indonesian values, so the same payment settled or not
 * depending on which path saw it first (fixed in Task E4, 37668a9). That is the
 * exact failure this module exists to make impossible.
 */
const IDR_GATEWAY_PAID_STATES: readonly string[] = [
  "paid",
  "success",
  "completed",
  "settlement",
  "lunas",
  "berhasil",
];

/**
 * NOWPayments' lifecycle. Only an exact `finished` settles.
 *
 * `confirmed` and `sending` are the trap: both sound final and neither is —
 * the funds have not landed in the merchant account yet. `partially_paid` is
 * the other one: it sounds close enough to paid, and treating it as such would
 * deliver goods for an underpayment.
 */
const NOWPAYMENTS_FAILED_STATES: readonly string[] = ["failed", "refunded"];

/** Bybit V5 deposit status, INTERNAL TRANSFER ledger: 1=Processing, 2=Success,
 *  3=Failed. Note 3 is a FAILURE here and a SUCCESS on the on-chain ledger
 *  below — this pair is the whole reason the two rails are separate providers
 *  in `StatusProvider` rather than one `BYBIT`. */
const BYBIT_INTERNAL_SUCCESS = 2;
const BYBIT_INTERNAL_FAILED = 3;

/** Bybit V5 deposit status, ON-CHAIN (BSC/BEP20) ledger: 1=ToBeConfirmed,
 *  2=Processing, 3=Success. Inverted relative to the internal-transfer ledger
 *  above. Anything outside 1–3 is treated as "nothing actionable yet". */
const BYBIT_BSC_SUCCESS = 3;

/**
 * Map one provider's raw status into the internal vocabulary.
 *
 * `raw` is typed as `string | number | null | undefined` on purpose: it is
 * whatever came off a gateway's JSON, and a rail that expects a number can
 * receive a string (or nothing) from a malformed response. Every such case
 * lands on `pending` — never `paid`, so a garbled response can never settle an
 * order, and never `failed`, so it cannot strand a buyer who did pay.
 *
 * String comparison is case-insensitive and trimmed, matching what the
 * adapters did before; the integer rails compare strictly and a numeric string
 * like `"2"` is NOT accepted, because a Bybit response whose status arrived as
 * text is a response we do not understand.
 */
export function normalizeProviderStatus(
  provider: StatusProvider,
  raw: string | number | null | undefined,
): NormalizedPaymentStatus {
  switch (provider) {
    case StatusProvider.TOKOPAY:
    case StatusProvider.PAYDISINI: {
      const status = normalizeString(raw);
      if (status === null) return "pending";
      if (IDR_GATEWAY_PAID_STATES.includes(status)) return "paid";
      if (status === "expired") return "expired";
      if (status === "failed" || status === "cancelled" || status === "canceled" || status === "gagal") {
        return "failed";
      }
      return "pending";
    }
    case StatusProvider.NOWPAYMENTS: {
      const status = normalizeString(raw);
      if (status === null) return "pending";
      if (status === "finished") return "paid";
      if (status === "partially_paid") return "underpaid";
      if (status === "confirming") return "detected";
      if (status === "confirmed" || status === "sending") return "verifying";
      if (status === "expired") return "expired";
      if (NOWPAYMENTS_FAILED_STATES.includes(status)) return "failed";
      return "pending";
    }
    case StatusProvider.BYBIT_INTERNAL: {
      if (typeof raw !== "number") return "pending";
      if (raw === BYBIT_INTERNAL_SUCCESS) return "paid";
      if (raw === BYBIT_INTERNAL_FAILED) return "failed";
      return "pending";
    }
    case StatusProvider.BYBIT_BSC: {
      if (typeof raw !== "number") return "pending";
      if (raw === BYBIT_BSC_SUCCESS) return "paid";
      if (raw === 1) return "detected";
      if (raw === 2) return "verifying";
      return "pending";
    }
  }
}

/**
 * `normalizeProviderStatus(...) === "paid"`, for the call sites that only need
 * the yes/no. Exists so an adapter never has to write the string `"paid"`
 * itself — a typo in a string comparison fails open to "not paid", which is
 * silent, and the compiler cannot see it.
 */
export function isProviderPaid(provider: StatusProvider, raw: string | number | null | undefined): boolean {
  return normalizeProviderStatus(provider, raw) === "paid";
}

/** Lowercase + trim, or null for anything that is not a usable string. */
function normalizeString(raw: string | number | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === "" ? null : trimmed;
}
