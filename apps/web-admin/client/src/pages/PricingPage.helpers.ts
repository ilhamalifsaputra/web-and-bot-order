import { Decimal } from "decimal.js";
import type { ApiError } from "../api/client";

export const marginDisplay = (value: string | null) => value === null ? "—" : `${new Decimal(value).toDecimalPlaces(2).toString()}%`;

/** The Apply-now impact refusal in Indonesian, worded from the `error_args.policy`
 * the pricing route attaches to an unreadable stored policy (review M2). Anything
 * else gets a generic sentence: the server's English text is never shown here. */
export function impactErrorText(err: unknown): string {
  const args = (err as ApiError | null)?.errorArgs;
  const prefix = "Tidak dapat menghitung dampak.";
  if (args?.policy === "category" && args.categories) {
    return `${prefix} Aturan markup tersimpan untuk kategori ${args.categories} tidak terbaca. Hapus atau simpan ulang aturan itu di Category Rules, atau pilih cakupan kategori lain.`;
  }
  if (args?.policy === "markup") return `${prefix} Markup default tersimpan tidak terbaca. Simpan ulang markup default di Global Defaults.`;
  if (args?.policy === "rounding") return `${prefix} Pembulatan harga tersimpan tidak dikenali. Simpan ulang pembulatan di Global Defaults.`;
  return `${prefix} Coba lagi sebentar lagi.`;
}
