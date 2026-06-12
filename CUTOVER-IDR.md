# CUTOVER-IDR.md — pindah basis harga USDT → Rupiah (sekali jalan)

Langkah cutover untuk model **harga pusat IDR** (plan.md §15 / §17.2 #4).
Sebelum cutover, `Product.price` dkk. bermakna **USDT**; sesudahnya kolom yang
sama berisi **Rupiah**, dan angka USDT diturunkan otomatis dari setting
`usd_idr_rate`. Kode di repo ini sudah memakai basis IDR — **DB lama wajib
dikonversi sebelum kode baru jalan**, kalau tidak semua harga tampil salah
(murah 16.000×) dan kolom baru memicu `P2022`.

## Apa yang dikonversi (oleh `scripts/convert-prices-to-idr.ts`)

| Data | Perlakuan |
|---|---|
| `Product.price`, `Product.resellerPrice` | × kurs, dibulatkan ke Rupiah utuh |
| `Voucher.value` (hanya type `FIXED`) | × kurs |
| `Voucher.minPurchase` (semua voucher) | × kurs |
| `Setting usd_idr_rate` | di-set = kurs yang dipakai |
| `BulkPricing` (persen) | tidak diubah |
| Order / wallet historis | tidak diubah — snapshot USDT (plan.md §15.1) |

Script menolak jalan dua kali (`usd_idr_rate` sudah terisi = sudah dikonversi)
dan membungkus semuanya dalam satu `$transaction`.

## Urutan eksekusi (WAJIB urut)

1. **Stop** bot/server (single-writer SQLite — script harus jadi penulis satu-satunya).
2. **Backup**: salin `data/bot.db` + `bot.db-wal` + `bot.db-shm`
   (mis. `bot.db.bak-pre-idr-YYYYMMDD`).
3. **Push skema baru** (kolom `web_image_url`, `orders.currency`, `orders.fx_rate`,
   tabel `processed_tokopay_tx`):
   ```bash
   pnpm exec prisma db push
   ```
4. **Konversi** dengan kurs awal (Rupiah per 1 USDT) yang kamu pilih:
   ```bash
   pnpm tsx scripts/convert-prices-to-idr.ts 16000
   ```
5. **Deploy/start kode baru** (basis IDR) — urutan "migrasi dulu, kode belakangan"
   sesuai CLAUDE.md.
6. Cek hasil: buka web-admin → Catalog (harga tampil `Rp…` + preview USDT),
   dan bot → katalog (harga `Rp… ≈ $…`).

## Gladi resik dulu (disarankan)

Jalankan dulu ke salinan DB persis seperti di atas tapi dengan
`DATABASE_URL_PRISMA` menunjuk file salinan (ingat: path `file:` relatif ke
folder `prisma/`), lalu periksa angkanya sebelum menyentuh DB asli.

## Rollback

Stop proses → kembalikan file backup (`bot.db*`) → start kode lama. Tidak ada
rollback parsial; itulah kenapa backup di langkah 2 wajib.

> Setelah cutover, kurs **otomatis mengikuti kurs pasar asli** (di-update tiap
> jam, dibulatkan ke kelipatan `usd_idr_rate_rounding`, default Rp100) — jadi
> angka kurs yang kamu pakai di langkah 4 hanya menentukan **konversi harga
> katalog** sekali itu; sesudahnya `usd_idr_rate` akan tertimpa kurs pasar.
> Pakailah kurs pasar hari itu agar konsisten. Auto-update bisa dimatikan via
> Settings → Payments → `usd_idr_rate_auto=false`. Order lama tidak berubah:
> tiap order USDT menyimpan snapshot `fxRate`-nya sendiri.
