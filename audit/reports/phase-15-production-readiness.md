# Laporan Phase 15 — Production Readiness (Final)

Tanggal: 2026-06-18 · Read-only. Sintesis **Phase 0–14 + Phase 16** (`audit/reports/*`).
Skala acuan: **satu toko**, SQLite single-writer.

---

## Ringkasan Eksekutif
**Production-ready untuk skala satu toko.** Tidak ada isu **Critical** maupun **High pada kode**
(web-admin, storefront, maupun bot Telegram per Phase 16). Fondasi keamanan, integritas data,
jalur uang, dan kepatuhan UX kuat. Yang menahan **rilis publik** adalah item **infrastruktur/ops**:
reverse proxy + TLS + access log, upgrade `@fastify/static`, dan CI. Untuk keandalan auto-confirm
pembayaran, set **`USE_UNIQUE_CENTS=1`** di prod. Sisanya peningkatan terjadwal & technical debt
maintainability (god-file).

**Skor rata-rata ≈ 7.4/10.** Verdict: **Go privat** setelah H-1 & H-3; **No-Go publik** sampai H-2.

---

## Critical Issues (wajib sebelum production)
*(tidak ada)* — Phase 1 & Phase 16 keduanya melaporkan Critical = 0.

## High Priority (perbaiki segera)
```
ID  | Isu | Sumber | Fix | Effort
H-1 | @fastify/static@8.3.0 rentan (path traversal + route-guard bypass) | SEC-01 | upgrade ≥9.1.1 + pnpm install + vitest | S
H-2 | Belum ada reverse proxy + TLS + access log untuk publik (502 sulit didiagnosa) | DO-02/SEC-03/L-01/DOC-03 | nginx+TLS, WEB_COOKIE_SECURE=true, aktifkan logger Fastify, checklist 502 | M
H-3 | Tidak ada CI otomatis (typecheck/test) | DO-01 | workflow: pnpm -r typecheck + npx vitest run pada PR | S
H-4 | Audit visual mobile belum dilakukan (dinaikkan ke high) | Phase 3 | uji 375px home/pay/settings/catalog/payments, perbaiki overflow/alignment | M
```

## Medium Priority (dapat dijadwalkan)
```
ID  | Isu | Sumber | Fix
M-1 | Tombol checkout tak disable/loading → risiko double-submit | UX-01 | disable+spinner klien
M-2 | searchCatalogEntries tanpa take (cap di memori) | P5-01 | take: limit*4 di query match
M-3 | Render katalog scan penuh tiap request (tanpa cache) | P5-02 | cache read katalog saat tumbuh
M-4 | Container runtime jalan sebagai root | DO-03 | drop privilege (gosu app) setelah chown
M-5 | Backup file SQLite saat WAL bisa inkonsisten | DO-05/DOC-02 | sqlite3 .backup / stop-copy + uji restore
M-6 | Upload MIME dari header klien (spoofable) | SEC-02 | validasi magic-bytes
M-7 | Presedensi config env-vs-DB tak terdokumentasi | C12-02/DOC-01 | tabel sumber kebenaran per setting
M-8 | CMD Dockerfile vs orkestrasi compose perlu diverifikasi | DO-04 | pastikan semua app (apps/server) jalan
M-9 | USE_UNIQUE_CENTS=1 di prod (auto-confirm Binance bedakan order ber-total sama) | Phase16/B16-03 | set env (bot sudah warn boot bila off; degrade = refuse, bukan mis-deliver)
```

## Low Priority (kosmetik / tindak lanjut ringan)
```
ID  | Isu | Sumber
L-1 | singletruth.txt & postdev.md tercecer di root | P8
L-2 | Duplikasi card() vs shapeEntries | A-04
L-3 | Dark mode tidak ada (keputusan sadar, bukan defect) | Phase 3
L-4 | Verifikasi manual blok catch payments/jobs | E-01
L-5 | Cakupan test tambahan (voucher boundary, wallet negatif, webhook) | F-01..04
L-6 | Dok arsitektur sinkron dgn denominasi terbaru | DOC-04
L-7 | rateLimit Map tanpa housekeeping (memori naik pada uptime panjang) | B16-01
L-8 | bot.catch mencatat teks pesan user (terpotong) — redaksi | B16-02
L-9 | logAdminAction: verifikasi cakupan tiap route mutasi (upload/branding/toggle) | L-02
L-10| Tanpa error-tracking eksternal (Sentry) — opsional saat trafik naik | L-03
```

## Technical Debt
- **God-file** (maintainability, A-01..A-05): `order-bot/conversations/admin.ts` (~934), `handlers/checkout.ts` (~809), `crud/orders.ts` (~765), `handlers/customer.ts` (~748), dll.
- **Single-writer SQLite** (D-02) — batas struktural; migrasi Postgres saat ≥2 concurrent writer.
- **Queue berbasis tabel DB** (notification_outbox/broadcasts) — cukup kini; broker khusus saat skala naik.
- **Tanpa cache read** katalog (P5-02).
- **Job croner asumsi single-instance** (B16-04) — selaras single-writer.

## Refactor Recommendation (urut ROI tertinggi)
```
# | Item | Effort | Dampak | ROI
1 | Upgrade @fastify/static (H-1) | S | hilangkan 2 advisory | Tinggi
2 | Tambah CI typecheck+test (H-3) | S | cegah regresi berulang | Tinggi
3 | nginx+TLS+access log+502 guide (H-2) | M | aman & terdiagnosa di publik | Tinggi
4 | take pada search + cache katalog (M-2/M-3) | S–M | skalabilitas baca | Sedang
5 | Pecah checkout.ts & satukan card() (A-02/A-04) | M | maintainability | Sedang
6 | Backup WAL aman + dok (M-5) | S | integritas data | Sedang
```

## Overall Score (1–10)
| Dimensi | Skor | Alasan (rujuk temuan) |
|---|---|---|
| Security | **8** | CSRF/2FA/lockout/no-secret-log/no-raw-SQL + bot bersih (IDOR dijaga, anti salah-kredit, esc HTML); −2: dep rentan (H-1) + butuh TLS publik (H-2) |
| Maintainability | **7** | crud per-domain rapi, test kuat (518 hijau); −: god-file (A-01..05) & duplikasi (A-04) |
| Performance | **8** | sehat skala toko, index lengkap, transaksi pendek, tanpa N+1 grid; −: search unbounded (M-2), tanpa cache (M-3) |
| UX | **8** | hierarki denominasi memperjelas, empty state, bot disiplin (never-strand, single-bubble); −: loading-state checkout (M-1) |
| UI | **7** | design-system konsisten (template); −: audit mobile belum (H-4), dark mode tak ada |
| Scalability | **6** | single-writer + tanpa cache/broker + single-process = batas pada ×100 (Phase 11) |
| Documentation | **8** | README ID lengkap; −: presedensi config (M-7), backup WAL (M-5), panduan TLS/502 (DOC-03) |

**Rata-rata ≈ 7.4/10.**

## Catatan Bot (Phase 16)
Bot Telegram **bersih (0 Critical/High)**: jalur uang aman (`matchByAmount` refuse-on-ambiguity +
idempotensi TxID via `processedBinanceTx`), IDOR order/tiket dijaga (`order.userId !== info.id`),
`adminOnly` di tiap entry, escaping HTML konsisten (`esc()`), **paritas i18n 517/517 sempurna**,
`bot.catch` tak bocor secret. Sisa hanya Low (L-7 rateLimit housekeeping, L-8 redaksi log) +
config M-9.

## Rekomendasi Go/No-Go
- **Go** untuk operasi **privat/skala satu toko** (di jaringan tepercaya) **setelah H-1 & H-3**.
- **No-Go untuk ekspos publik** sampai **H-2** (nginx + TLS + access log) selesai.

### Definition of Done sebelum produksi publik
1. H-1 `@fastify/static` ≥9.1.1 (test hijau).
2. H-2 nginx + TLS + `WEB_COOKIE_SECURE=true` + access log aktif + checklist 502.
3. H-3 CI (typecheck + vitest) jalan di PR.
4. H-4 audit visual mobile selesai (halaman utama).
5. M-5 prosedur backup WAL aman + restore teruji.
6. M-9 `USE_UNIQUE_CENTS=1` di prod (auto-confirm pembayaran andal).

> Read-only — tidak ada perubahan kode. Merangkum `audit/reports/phase-00..14` + `phase-16`.
