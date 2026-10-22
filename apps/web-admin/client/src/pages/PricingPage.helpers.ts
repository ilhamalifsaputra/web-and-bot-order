import { Decimal } from "decimal.js";
import type { ApiError } from "../api/client";

export const marginDisplay = (value: string | null) => value === null ? "—" : `${new Decimal(value).toDecimalPlaces(2).toString()}%`;

/** The Apply-now impact refusal in Indonesian, worded from the `error_args.policy`
 * the pricing route attaches to an unreadable stored policy (review M2). Anything
 * else gets a generic sentence: the server's English text is never shown here. */
export function impactErrorText(err: unknown, prefix = "Tidak dapat menghitung dampak."): string {
  const args = (err as ApiError | null)?.errorArgs;
  if (args?.policy === "category" && args.categories) {
    return `${prefix} Aturan markup tersimpan untuk kategori ${args.categories} tidak terbaca. Hapus atau simpan ulang aturan itu di Category Rules, atau pilih cakupan kategori lain.`;
  }
  if (args?.policy === "markup") return `${prefix} Markup default tersimpan tidak terbaca. Simpan ulang markup default di Global Defaults.`;
  if (args?.policy === "rounding") return `${prefix} Pembulatan harga tersimpan tidak dikenali. Simpan ulang pembulatan di Global Defaults.`;
  return `${prefix} Coba lagi sebentar lagi.`;
}

/** An Apply-now failure on confirm, in Indonesian, from the route's
 * `error_args` (409 `conflict`, 500 `failure`, 400 `policy`); a generic
 * sentence otherwise (round 3b M-1). */
export function applyErrorText(err: unknown): string {
  const e = err as ApiError | null;
  const args = e?.errorArgs;
  if (args?.conflict === "policy_changed") return "Aturan harga berubah setelah dampak diperiksa. Tutup, lalu lihat dampak lagi sebelum menerapkan.";
  if (args?.conflict === "busy") return "Sync katalog Digiflazz atau penerapan lain sedang berjalan. Coba lagi sebentar lagi.";
  if (args?.conflict === "lease_lost") return "Penerapan berhenti di tengah karena sync katalog Digiflazz mengambil alih. SKU yang sudah diperbarui tetap memakai harga baru; jalankan lagi untuk menyelesaikan.";
  if (args?.failure === "audit") return "Harga baru sudah diterapkan, tetapi catatan audit gagal disimpan. Harga tetap seperti yang diterapkan; hubungi developer agar catatan audit dapat dicatat.";
  if (e?.status === 409) return "Harga tidak diterapkan karena ada perubahan atau proses lain yang sedang berjalan. Tutup, lalu lihat dampak lagi.";
  return impactErrorText(err, "Tidak dapat menerapkan harga.");
}
