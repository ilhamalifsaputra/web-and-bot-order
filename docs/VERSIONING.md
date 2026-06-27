# Versioning

## Status saat ini

`package.json` masih `"version": "0.1.0"` dan **belum ada git tag** di repo
ini (`git tag` kosong per 2026-06-24). Histori perubahan sampai sejauh ini
dilacak lewat pesan commit Conventional-Commits-style (`feat:`, `fix:`,
`docs:`, `chore:`, `refactor:`, `ops:`, `perf:`, `ci:`), bukan lewat tag rilis.

Dokumen ini menetapkan **skema versi ke depan** dan memetakan histori commit
yang sudah ada ke nomor versi retroaktif untuk mengisi
[CHANGELOG.md](CHANGELOG.md)/[RELEASE_NOTES.md](RELEASE_NOTES.md) — pemetaan
itu adalah **rekonstruksi dokumentasi**, bukan tag git yang sungguhan ada.

## Skema: Semantic Versioning (MAJOR.MINOR.PATCH)

Karena aplikasi ini **server-rendered tanpa API publik** untuk pihak ketiga
(lihat [`../DOCS.md` §1](../DOCS.md#1-arsitektur) dan
[API_REFERENCE.md](API_REFERENCE.md)), "breaking change" di sini berarti
breaking bagi **operator yang mengelola instance sendiri**, bukan bagi
konsumen API eksternal:

- **MAJOR** — perubahan yang butuh tindakan manual operator di luar
  `db push` rutin: migrasi data sekali-jalan non-idempotent (pola
  `migrate-catalog-rename.ts`), perubahan default yang mengubah perilaku
  keamanan (mis. `DEFAULT_WEB_ROLE`), atau penghapusan fitur/env var.
- **MINOR** — fitur baru yang backward-compatible: gateway pembayaran baru,
  halaman admin baru, kolom DB baru (additive). Mayoritas histori commit
  repo ini masuk kategori ini.
- **PATCH** — bugfix tanpa fitur baru, termasuk hardening keamanan yang
  tidak mengubah kontrak (env var/Setting key) yang sudah ada.

## Cara menandai rilis ke depan

```bash
# Setelah CHANGELOG.md diupdate dengan entri rilis baru:
npm version minor -m "chore(release): v%s"   # atau major/patch sesuai skema di atas
git push --follow-tags
```

`npm version` otomatis meng-update `package.json` + membuat git tag anotasi.
Belum ada workflow CI yang membuat GitHub Release otomatis dari tag — itu
langkah manual (`gh release create`) jika diperlukan.

## Riwayat versi (rekonstruksi retroaktif dari git log)

> Commit-level detail penuh: `git log --oneline`. Tabel di bawah
> mengelompokkan ke milestone yang bermakna bagi operator — lihat
> [CHANGELOG.md](CHANGELOG.md) untuk isi tiap versi.

| Versi (rekonstruksi) | Tanggal | Milestone |
|---|---|---|
| v1.0.0 | 2026-05-30 – 05-31 | Migrasi order-bot Python→Node/TS selesai; web-admin Tier 1-3; RBAC/2FA/wallet/broadcast dasar |
| v1.1.0 | 2026-06-12 | Storefront app (toko web pelanggan) + combined server + password auth |
| v1.2.0 | 2026-06-13 | Bybit (awalnya on-chain BEP20) sebagai metode bayar ke-3 |
| v1.3.0 | 2026-06-14 – 06-16 | Setup wizard (tanpa edit `.env`), Branding page, dual credit balance, public channel ID di web |
| v1.4.0 | 2026-06-17 | Manajemen stok (view/download/delete), Binance Internal config DB-driven |
| v1.5.0 | 2026-06-18 | Audit production-readiness round 1; observability (access log); backup/restore WAL-safe; nginx TLS runbook |
| v1.6.0 | 2026-06-19 | Rename katalog 3-tier (Category→Product→Denomination) tuntas; JSON API v1 internal |
| v1.7.0 | 2026-06-20 | Gateway PayDisini + NOWPayments; UI bot inline (Home/Produk Populer/qty stepper) |
| v1.8.0 | 2026-06-21 | Toggle on/off per metode bayar; storefront auth hardening (rate-limit, session rotation) |
| v1.9.0 | 2026-06-22 | Bybit dipindah dari on-chain BEP20 ke Internal Transfer (UID-based, instant) |
| v1.10.0 | 2026-06-23 | Audit keamanan penuh (56 temuan) — semua Critical/High/Medium ditutup |

**Versi berjalan saat ini secara efektif: `v1.10.0`.** Rekomendasi: jalankan
`npm version 1.10.0` sekali untuk menyinkronkan `package.json` dengan
histori ini sebelum tag rilis berikutnya dibuat, supaya `npm version
minor/patch` ke depan menghitung dari basis yang benar.
