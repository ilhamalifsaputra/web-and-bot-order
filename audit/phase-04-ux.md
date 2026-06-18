# Phase 4 — UX Audit

> Read-only. Telusuri flow nyata sebagai user.

---

## Konteks Proyek
**Storefront flow:** Home → Kategori/Grup → Denominasi (`/g/:id`) → Detail (`/p/:id`) →
Cart → Checkout → Pay → Success. Hierarki denominasi (Parent → Denominasi → Order) baru
diterapkan di Home & Search.
**Bot UX rules (CLAUDE.md):** edit bubble bukan toast; satu keyboard aktif per chat;
wizard single-bubble; toast (sukses) vs alert (error/destruktif); **never strand the
user** (tiap layar terminal ada aksi maju Menu/Pesanan/Back); state `admin.processing`
anti double-tap.

---

## Objective
Memastikan setiap flow mudah dipahami & minim friksi.

## Langkah Investigasi
1. Jalankan storefront + bot (jika token tersedia).
2. Lakukan **end-to-end** sebagai user baru: temukan produk → pilih denominasi → checkout → bayar.
3. Ulangi sebagai user gagal: stok habis, pembayaran batal, voucher invalid, input salah.

## Flow yang ditelusuri
```
Storefront: Home → Product/Group → Detail → Cart → Checkout → Payment → Success
Bot:        /start → Products → Group → Denominasi → Checkout → Pay
```

## Yang dicari (UX problem)
- **Terlalu banyak klik** untuk aksi umum (mis. beli ulang, pilih denominasi).
- **Flow membingungkan** (langkah tak terduga, navigasi buntu, label ambigu).
- **Tidak ada loading state** (klik bayar → tak ada feedback; cek tombol checkout storefront).
- **Tidak ada empty state** (cart kosong, hasil search kosong, kategori kosong) — verifikasi `web.catalog_empty`, `web.search_empty`.
- **Error message tidak jelas** (stok habis, pembayaran gagal, sesi habis).
- **Button tidak disable saat loading** (risiko double-submit di klien; bandingkan dgn anti double-tap bot).
- **Konsistensi bahasa** (campur EN/ID di permukaan customer — cek lewat i18n `t()`).

## Output → tulis ke `audit/reports/phase-04-ux.md`
Per masalah:
```
ID | Flow | Langkah | Masalah | Dampak (friksi/abandon) | Severity | Rekomendasi improvement
```
Urutkan rekomendasi berdasarkan dampak ke konversi.
