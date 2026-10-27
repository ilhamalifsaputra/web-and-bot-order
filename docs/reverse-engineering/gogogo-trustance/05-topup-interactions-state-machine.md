# 05 — State machine top-up

## Variasi per produk (OBSERVED)
| Halaman | Field akun | Cek ID | Tab SKU | Bar saat dibuka |
|---|---|---|---|---|
| Mobile Legends | User ID + Zone ID | ada | 5 | Rp1.667 (nominal pertama otomatis terpilih) |
| PUBG Mobile (UC) | User ID | tidak ada | 1 | Rp80.184 (terpilih otomatis) |
| Honor of Kings | User ID | tidak ada | 1 (Weekly Card), 13 SKU | Rp3.214 (terpilih otomatis) |
| PlayStation (voucher) | tidak ada | tidak ada | tab mata uang IDR/USD, 72 SKU | Rp0 (tidak terpilih) |

## State yang dirancang untuk Trustance
1. `idle`: field kosong, tidak ada nominal terpilih, tombol Lanjutkan nonaktif dengan alasan terbaca.
2. `typing`: validasi format dari konfigurasi field produk; server tetap otoritas.
3. `checking` (hanya jika produk punya dukungan cek nickname): tombol Cek ID dan auto-check memicu `POST /api/v1/topup/check-account`; hasil `found` / `not-found` / `unavailable` / `rate-limited` ditampilkan jelas. Tidak pernah menyatakan ID valid sebelum server menjawab.
4. `selected`: satu nominal terpilih eksplisit (tidak ada preselect), bar menampilkan total dari preview server (`POST /api/v1/topup/preview`).
5. `submitting`: `POST /api/v1/topup/order`; harga dihitung ulang server; error 409 (quote mismatch) menampilkan harga baru.

## UNKNOWN
Respons Cek ID referensi, validasi format, langkah setelah Lanjutkan — tidak diuji (butuh ID valid; larangan enumerasi).
