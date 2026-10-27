# 02 — Rekonaisans top-up (Mobile Legends dan PUBG Mobile)

Bukti: `assets/ref-mlbb-1440.png`, `assets/ref-mlbb-390-viewport.png`, snapshot, computed style. OBSERVED kecuali dinyatakan lain.

## Tata letak desktop (1440)
- Breadcrumb: Beranda > Top Up > nama produk (dipotong dengan elipsis).
- **Kolom kiri**: banner + logo + label tipe ("topup") + h1, lencana "Resmi dan Terpercaya" / "Garansi Uang Kembali", "Cara Top Up" 5 langkah, deskripsi SEO.
- **Kolom kanan (x ≈ 628–1191)**: (1) kartu "Masukkan User ID dan Zone ID" dengan tanda wajib; (2) "Pilih Nominal atau Paket" dengan catatan region; (3) tab SKU; (4) grid kartu nominal.
- Section FAQ dan footer di bawah.

## Field akun berbeda per produk
| Produk | Field | `inputmode` | Tombol "Cek ID" |
|---|---|---|---|
| Mobile Legends | User ID + Zone ID | numeric | **ada**, enabled saat kosong (h 46 px) |
| PUBG Mobile (UC) | User ID saja | tidak diset | **tidak ada** |

Kesimpulan: field dan tombol cek harus dari konfigurasi produk, bukan hardcode.

## Tab SKU
Baris tombol pill (radius penuh, tinggi 28 px, latar rgb(54,54,54)), bisa meluber ke samping (satu tab di x=1391 melewati kontainer → scroll horizontal di dalam baris). ML punya 5 tab: judul grup, Flash Sale!, Top Up ML Termurah, Weekly Diamond Pass, Diamonds. PUBG punya 1 tab. Heading grup `sticky top-0 z-10` di dalam daftar.

## Kartu nominal
Latar rgb(66,66,66), radius 8 px, lebar 179 px, 3 kolom di desktop (x = 640 / 832 / 1024), 2 kolom di mobile 390 (x = 45 / 206). Isi: ikon, nama "N Diamonds ( a + b Bonus )", harga, harga coret + lencana "% OFF" bila diskon. Tinggi kartu berbeda (144 vs 124 px) saat ada diskon.

## Bar checkout
`position: fixed; bottom: 0; inset-x: 0; z-index: 20`, di desktop `max-width: 1024px` di tengah dengan margin bawah 16 px, tinggi 99 px; isi "Harga", "Hemat Rp…", tombol "Lanjutkan". **Sama di semua viewport; bukan kolom sticky.** Nominal pertama sudah terpilih otomatis (bar langsung menampilkan harganya) — risiko salah beli, jangan ditiru.

## Mobile (390)
Tanpa overflow horizontal (scrollWidth 383), bar fixed y=731 tinggi 98.

## UNKNOWN (belum diuji)
Hasil Cek ID (loading/sukses/gagal/rate limit — butuh ID valid, tanpa enumerasi), validasi format, perilaku tombol Lanjutkan tanpa ID/nominal, langkah setelah Lanjutkan, keyboard virtual mobile.
