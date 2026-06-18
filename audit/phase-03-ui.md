# Phase 3 — UI Audit

> Read-only. Perlu pemeriksaan visual manual di browser + baca template.

---

## Konteks Proyek
Storefront & web-admin **server-rendered Nunjucks + Tailwind utility classes** (bukan SPA).
Macro bersama:
- Storefront `apps/storefront/views/_shop.njk` — `price`, `stock_badge`, `stars`, `product_card`, `group_card`, `stepper`.
- Web-admin `packages/web-ui/views/_macros.njk` — `page_header`, `flash`, `status_badge`, `csrf_field`, `empty_row`.
Filter harga: `idr`, `usdt(fx)` (jangan pakai `money` untuk storefront).
Template terbesar: `home.njk` (403), `settings.njk` (360), `catalog.njk` (295), `payments.njk` (195), `pay.njk` (174).

---

## Objective
Memastikan konsistensi visual & layout di semua halaman.

## Langkah Investigasi
1. Jalankan storefront dev: `pnpm --filter @app/storefront dev` (port 8100) dan web-admin: `pnpm --filter @app/web-admin dev`.
2. Buka tiap halaman di **2 viewport**: mobile (375px) & desktop (≥1280px).
3. Bandingkan komponen yang sama antar halaman (button, card, chip, form field) untuk inkonsistensi.

## Checklist (tandai ✅/❌ + lokasi)
- [ ] **Typography** — skala heading/teks konsisten antar halaman (cek class `font-display`, ukuran).
- [ ] **Spacing** — margin/padding konsisten (`card-pad`, `gap-*`); tak ada spacing ad-hoc menyimpang.
- [ ] **Border radius** — `rounded-*` seragam pada card/button/input.
- [ ] **Color palette** — pakai token tema (`pine`, `ink`, `sand`, `grass`, `amberx`, `rust`), bukan hex acak.
- [ ] **Button consistency** — varian (`btn-primary`, `btn-soft`, `btn-ghost`, `btn-sm`) dipakai konsisten.
- [ ] **Card consistency** — `product_card` vs `group_card` selaras; kartu admin seragam.
- [ ] **Form field** — `field`, `field-label` konsisten; state error/focus jelas.
- [ ] **Responsive** — grid `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`; tabel admin scroll-x di mobile.
- [ ] **Dark mode** — ADA/TIDAK; bila tak ada, catat sebagai keputusan sadar (bukan bug).

## Yang dicari (per halaman besar: home, pay, settings, catalog, payments)
- Overflow (teks/tabel keluar kontainer di mobile).
- Misalignment (item grid tidak rata, ikon tidak center).
- Inconsistent spacing (jarak beda di komponen sejenis).
- Gambar pecah / aspect-ratio rusak / alt kosong.

## Output → tulis ke `audit/reports/phase-03-ui.md`
Checklist terisi + tabel masalah:
```
ID | Halaman/Template (file njk) | Komponen | Masalah | Viewport | Severity | Saran
```

## Constraint
Analisis & dokumentasi saja — jangan ubah template/CSS.
