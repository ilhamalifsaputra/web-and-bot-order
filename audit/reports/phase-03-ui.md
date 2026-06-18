# Laporan Phase 3 — UI Audit

Tanggal: 2026-06-18 · Read-only.

> **Catatan kejujuran:** audit visual penuh (overflow/alignment/responsive nyata) butuh mata manusia di browser. Bagian di bawah = analisis **level template** + daftar cek manual yang masih perlu dilakukan. Tidak diklaim sebagai hasil inspeksi piksel.

## Analisis level template (terverifikasi dari kode)
- **Komponen tersentralisasi → konsisten by design.** Storefront pakai macro `_shop.njk` (`price`, `stock_badge`, `stars`, `product_card`, `group_card`, `stepper`); web-admin pakai `_macros.njk` (`page_header`, `flash`, `status_badge`, `csrf_field`, `empty_row`). Kartu produk & grup memakai struktur sama → spacing/radius seragam.
- **Token warna tema** dipakai konsisten (`pine`, `ink`, `sand`, `grass`, `amberx`, `rust`) — tak ada hex acak ditemukan.
- **Grid responsif** seragam: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4` (home, catalog, search).
- **Gambar** `loading="lazy" decoding="async"`; hero `fetchpriority="high"`.

## Checklist
| Item | Status | Catatan |
|---|---|---|
| Typography konsisten | ✅ (template) | `font-display` + skala util seragam |
| Margin/padding | ✅ (template) | `card-pad`, `gap-*` konsisten |
| Border radius | ✅ (template) | `rounded-*` via macro |
| Color palette | ✅ | token tema, bukan hex |
| Button consistency | ✅ (template) | `btn-primary/soft/ghost/sm` |
| Card consistency | ✅ | product_card vs group_card selaras |
| Responsive layout | ⚠️ manual | grid benar; cek nyata di mobile belum |
| Dark mode | ❌ tidak ada | keputusan sadar (bukan bug); di luar scope toko |

## Cek manual yang masih perlu dilakukan
```
ID | Halaman (njk) | Yang dicek
U-01 | home.njk (403 baris) | hero & section di 375px; counter stats; FAQ accordion
U-02 | pay.njk / _pay_status.njk | alamat deposit panjang (overflow?), QR, countdown
U-03 | settings.njk (360) | form panjang di mobile; grouping field
U-04 | catalog.njk (admin 295) | tabel data scroll-x di mobile
U-05 | payments.njk (195) | tabel transaksi di mobile
```

## Temuan
Tidak ada inkonsistensi UI tingkat-template. **Dark mode tidak ada** (catat sebagai keputusan, bukan defect). Audit visual mobile = **tindak lanjut manual** (prioritas high).

---

## Tindak lanjut — execution/04 (2026-06-18)

Hasil cek level-kode terhadap U-01..U-05 + perbaikan minimal (Tailwind CDN JIT, jadi
util class apa pun ter-render). **Belum** diverifikasi piksel di 375px — itu tetap
langkah manual di browser.

| ID | Halaman | Hasil cek kode | Tindakan |
|---|---|---|---|
| U-01 | `home.njk` | grid `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`, hero responsif | — (perlu cek visual) |
| U-02 | `pay.njk` / `_pay_status.njk` | alamat Bybit sudah `break-all`; UID/ref Binance belum | **Fix:** tambah `break-all` pada UID & `payment_ref` Binance |
| U-03 | `settings.njk` | form panjang, field grouping | — (perlu cek visual) |
| U-04 | admin `catalog.njk` | tabel **sudah** dibungkus `overflow-x-auto` (baris 12, 53) | — tidak perlu ubah |
| U-05 | admin `payments.njk` | tabel **sudah** dibungkus `overflow-x-auto` (baris 45, 153) | — tidak perlu ubah |

### M-1 — anti double-submit checkout/pay (UX-01)
- **Mekanisme:** listener `submit` global di `base.njk` untuk `form[data-submit-once]`.
  Submit pertama lolos; tombol yang diklik (`e.submitter`) di-`disable` + spinner
  (di-`setTimeout` agar name/value tetap ikut POST); submit berikutnya di-`preventDefault`.
- **Progressive enhancement:** tanpa JS form tetap POST normal (no-JS fallback aman).
- **Titik pasang:** `checkout.njk` (form place-order/voucher), `pay.njk` (form cancel).
  `cart.njk` "to checkout" adalah `<a href>` (bukan submit) → tak berisiko ganda.
- **Verifikasi:** `pnpm -r typecheck` hijau + `npx vitest run` 518/518 (render test tak rusak).
  Uji double-click cepat & no-JS = **manual di browser** (belum dijalankan di sini).

### Sisa cek manual (butuh mata di browser 375px)
U-01 hero/stats/FAQ · U-03 form settings panjang · uji double-click M-1 · uji no-JS.

> Catatan: perubahan = util class minimal (`break-all`) + 1 skrip progressive-enhancement;
> tak ada perubahan design token / struktur.
