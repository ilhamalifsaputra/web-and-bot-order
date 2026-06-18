# Laporan Phase 4 — UX Audit

Tanggal: 2026-06-18 · Read-only.

## Flow storefront: Home → Group → Denominasi → Detail → Cart → Checkout → Pay → Success
## Flow bot: /start → Products → Group → Denominasi → Checkout → Pay

## Yang baik (terverifikasi)
- ✅ **Hierarki denominasi** (Parent → Denominasi → Order) baru diterapkan di Home & Search → mengurangi kebingungan "produk datar" yang dilaporkan user.
- ✅ **Empty state** ada: `web.catalog_empty`, `web.search_empty` (storefront), `empty_row` (admin).
- ✅ **Bot UX disiplin** (CLAUDE.md): edit bubble (bukan toast menumpuk), satu keyboard aktif, wizard single-bubble, toast(sukses)/alert(error), state `admin.processing` anti double-tap, "never strand the user".
- ✅ **i18n** customer-facing via `t()` (en/id) — minim bocoran bahasa.

## Temuan UX
```
ID | Severity | Flow | Masalah | Rekomendasi
UX-01 | Medium | Checkout (storefront) | Tombol bayar/checkout tidak disable + tanpa spinner saat submit → risiko double-click & user tak tahu sedang proses | Tambah disable + loading state via JS kecil (bot sudah punya anti double-tap; selaraskan di web)
UX-02 | Low | Pay (storefront) | Countdown window pembayaran & status — pastikan pesan jelas saat kedaluwarsa/expired (verifikasi pesan `_pay_status`) | Pesan eksplisit + CTA ulang
UX-03 | Low | Search | Saat query cocok grup, hasil kolaps ke kartu grup (butuh 1 klik ekstra ke denominasi) — trade-off konsistensi vs kecepatan | Pertahankan (konsisten kategori); pertimbangkan tampilkan denominasi inline bila hanya 1 grup cocok |
UX-04 | Low | Error global | Halaman error/404 ramah ada; pastikan pesan actionable (link kembali) | Sudah ada `back_home`; oke |
```

## Rekomendasi prioritas (dampak konversi)
1. **UX-01** loading/disable tombol checkout — cegah order ganda & tingkatkan kepercayaan.
2. UX-02 kejelasan status pembayaran kedaluwarsa.

> Read-only — tidak ada perubahan kode.
