/**
 * Input validators — port of bot/utils/validators.py. Each throws the shared
 * ValidationError (carrying an i18n key + format args) on bad input.
 */
import { ValidationError } from "@app/core/errors";

const TXID_RE = /^[A-Za-z0-9-]{10,64}$/;
const VOUCHER_RE = /^[A-Z0-9_-]{3,32}$/;

export function validateTxid(raw: string): string {
  const txid = (raw ?? "").trim();
  if (!TXID_RE.test(txid)) throw new ValidationError("error.invalid_txid");
  return txid;
}

export function validateVoucherCode(raw: string): string {
  const code = (raw ?? "").trim().toUpperCase();
  if (!VOUCHER_RE.test(code)) throw new ValidationError("error.invalid_voucher_code");
  return code;
}

export function validateRating(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new ValidationError("error.invalid_rating");
  return n;
}

export function validateText(raw: string | null | undefined, maxLen = 1000, minLen = 1): string {
  if (raw === null || raw === undefined) throw new ValidationError("error.text_required");
  // Strip control chars except \n and \t.
  const cleaned = [...raw]
    .filter((c) => c === "\n" || c === "\t" || c.charCodeAt(0) >= 32)
    .join("")
    .trim();
  if (cleaned.length < minLen) throw new ValidationError("error.text_too_short", { min: minLen });
  if (cleaned.length > maxLen) throw new ValidationError("error.text_too_long", { max: maxLen });
  return cleaned;
}

export interface StockUploadResult {
  valid: string[];
  skipped: string[];
}

/** Parse pasted stock text / .txt: one credential per line, `:` or `|` separated. */
export function parseStockUpload(text: string): StockUploadResult {
  const valid: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.includes(":") && !line.includes("|")) {
      skipped.push(line);
      continue;
    }
    const sep = line.includes("|") ? "|" : ":";
    const parts = line.split(sep).map((p) => p.trim());
    if (parts.length < 2 || parts[0] === "" || parts[1] === "") {
      skipped.push(line);
      continue;
    }
    if (seen.has(line)) continue;
    seen.add(line);
    valid.push(line);
  }
  return { valid, skipped };
}
