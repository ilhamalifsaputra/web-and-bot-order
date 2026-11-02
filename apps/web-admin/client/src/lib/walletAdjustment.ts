import { normalizeMoneyInput } from "./moneyInput";

export type WalletCurrency = "IDR" | "USDT";

/** What the typed amount means, or why it cannot be confirmed. `hint` is null
 * when there is nothing to say yet: the field is simply empty. */
export type WalletDelta =
  | { ok: true; amount: string; credit: boolean }
  | { ok: false; hint: string | null };

/**
 * Reads the adjustment field the way the server will (`readMoneyField` with
 * `signed`, then `isValidWalletAdjustment`), so the confirmation states the
 * amount that will really move: `10.000` is ten thousand rupiah, and a shape the
 * server would refuse never reaches a dialog. The raw text is still what gets
 * sent; this reading is only what the admin is shown and agrees to.
 */
export function readWalletDelta(raw: string, currency: WalletCurrency): WalletDelta {
  let text = raw.trim();
  if (!text) return { ok: false, hint: null };
  let negative = false;
  if (/^[+\-−]/.test(text)) {
    negative = text[0] !== "+";
    text = text.slice(1).trimStart();
  }
  const plain = normalizeMoneyInput(text, currency);
  if (plain === null) {
    return {
      ok: false,
      hint: currency === "IDR"
        ? "Amount must be written like 10000 or 10.000."
        : "Amount must be written like 5, 5.07 or 1,000.50. 1.000 is ambiguous, so write 1000 or 1,000.00.",
    };
  }
  if (plain === "0") return { ok: false, hint: "Amount cannot be zero." };
  const decimals = plain.split(".")[1]?.length ?? 0;
  if (currency === "IDR" && decimals > 0) return { ok: false, hint: "IDR adjustments must be whole rupiah." };
  if (currency === "USDT" && decimals > 4) return { ok: false, hint: "USDT adjustments must have at most 4 decimal places." };
  return { ok: true, amount: negative ? `-${plain}` : plain, credit: !negative };
}
