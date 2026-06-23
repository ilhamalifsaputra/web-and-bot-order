# Instalasi

> Panduan ramah-pemula (Docker vs non-Docker, buat admin pertama) ada di
> [`../README.md`](../README.md). Dokumen ini adalah referensi teknis yang
> lebih ringkas + detail verifikasi untuk developer/operator yang sudah paham
> Node/Docker.

## Requirement

| Komponen | Versi | Wajib? |
|---|---|---|
| Node.js | ≥ 20 (image Docker: `node:20-slim`) | Ya (non-Docker) |
| pnpm | `9.15.9` (pinned via `packageManager` di `package.json`) | Ya (non-Docker) |
| Database | SQLite (file tunggal, mode WAL) — **tidak ada server DB terpisah** | Bawaan |
| Redis | **Tidak dipakai** — tidak ada di stack ini | — |
| Docker | Engine terbaru, untuk Jalur A | Opsional |
| OS | Linux (VPS) untuk produksi; Windows/macOS untuk dev lokal | — |

`engines.node` di `package.json` mensyaratkan `>=20`. Versi `prisma`/
`@prisma/client` terkunci ke `5.22.0`; `typescript` ke `^5.6.3`; `vitest` ke
`^2.1.5` — lihat [Root `package.json`](#scripts-root-packagejson) di bawah.

## Langkah instalasi

### Jalur A — Docker (disarankan untuk produksi)

```bash
git clone https://github.com/ilhamalifsaputra/web-and-bot-order.git
cd web-and-bot-order
cp .env.example .env                          # isi sesuai docs/CONFIGURATION.md
docker compose build
docker compose run --rm server pnpm exec prisma db push   # buat skema
docker compose up -d                          # admin :8000, storefront :8100
docker compose ps                             # tunggu "healthy"
```

### Jalur B — tanpa Docker (dev lokal / VPS manual)

```bash
nvm install 20 && npm install -g pnpm@9
git clone https://github.com/ilhamalifsaputra/web-and-bot-order.git
cd web-and-bot-order
pnpm install
cp .env.example .env
pnpm prisma:generate
pnpm exec prisma db push
pnpm start                                    # satu proses: bot+admin+storefront+worker
```

### Generate Prisma client

```bash
pnpm prisma:generate        # = `prisma generate` — wajib setelah install/clone
```

`prisma generate` HARUS dijalankan sebelum `pnpm start`/`pnpm dev:*` — tanpa
ini, `@prisma/client` tidak punya kode yang digenerate dan setiap import dari
`@app/db` gagal. Di Docker ini berjalan otomatis di tahap build image (lihat
`Dockerfile`).

### Migrasi/schema

```bash
pnpm exec prisma db push    # non-Docker
docker compose run --rm server pnpm exec prisma db push   # Docker
```

Detail kapan harus `db push` vs `migrate deploy`, dan cara menutup gap kolom
yang hilang (`P2022`), ada di [MIGRATIONS.md](MIGRATIONS.md).

### Seed database

**Tidak ada seed script** — repo ini tidak menyediakan data contoh (produk,
kategori, dsb). Database baru dimulai kosong; admin pertama dibuat lewat
**setup wizard** (`/setup`, default) atau jalur manual `/bootstrap` — lihat
DOCS.md §10. Katalog (Category/Product/Denomination) dan stok diisi manual
lewat panel admin setelah login.

### Build aplikasi

```bash
pnpm build           # = `pnpm -r build` — build semua workspace yang punya skrip build
pnpm build:bundle     # bundle esbuild kustom (scripts/build-bundle.ts) — opsional, lihat headernya
```

Catatan: jalur produksi default (`pnpm start`, juga `CMD` di Dockerfile)
menjalankan source TypeScript langsung lewat `tsx` (tidak ada step compile
wajib) — `pnpm build`/`build:bundle` bukan prasyarat untuk `pnpm start`.

### Start services

```bash
pnpm start            # SATU proses: web-admin + storefront + order-bot + outbox dispatcher + payment pollers
```

Tidak ada proses worker terpisah yang perlu dinyalakan manual — semua
in-process di dalam `apps/server` (composition root). Lihat
[ARCHITECTURE.md](ARCHITECTURE.md).

### Run workers

Tidak relevan untuk stack ini — "worker" (outbox dispatcher, payment poller,
cron job) berjalan otomatis sebagai bagian dari `pnpm start`, bukan proses OS
terpisah. Untuk dev, masing-masing app punya entrypoint standalone (tanpa
worker, tanpa outbox delivery):

```bash
pnpm dev:bot          # hanya bot, tsx watch
pnpm dev:web          # hanya web-admin, tsx watch (http://127.0.0.1:8000)
pnpm dev:store        # hanya storefront, tsx watch
```

### Verifikasi instalasi

```bash
curl -i http://127.0.0.1:8000/healthz     # admin → {"status":"ok"}
curl -i http://127.0.0.1:8100/healthz     # storefront → sama
curl -i http://127.0.0.1:8000/login       # → 200 (atau redirect ke /setup pada instal baru)
```

Lalu di Telegram: chat bot, kirim `/start` — harus membalas (jika `BOT_TOKEN`
sudah diisi). Checklist verifikasi penuh ada di `deploy/README.md` bagian
"Deployment checklist".

## Scripts (root `package.json`)

```json
"prisma:pull": "prisma db pull",
"prisma:generate": "prisma generate",
"build": "pnpm -r build",
"build:bundle": "tsx scripts/build-bundle.ts",
"reset-admin-password": "tsx scripts/reset-admin-password.ts",
"migrate-catalog-rename": "tsx scripts/migrate-catalog-rename.ts",
"backfill-catalog-slugs": "tsx scripts/backfill-catalog-slugs.ts",
"bybit-probe": "tsx scripts/bybit-internal-probe.ts",
"start": "tsx apps/server/src/index.ts",
"typecheck": "pnpm -r typecheck && tsc -p tsconfig.test.json",
"test": "vitest run",
"dev:web": "pnpm --filter @app/web-admin dev",
"dev:store": "pnpm --filter @app/storefront dev",
"dev:bot": "pnpm --filter @app/order-bot dev"
```

> **Catatan:** `scripts/binance-probe.ts` ADA di repo dan didokumentasikan di
> README/`.env.example` sebagai `pnpm binance-probe`, tapi **tidak terdaftar**
> di `package.json` `scripts` — jalankan langsung: `pnpm exec tsx
> scripts/binance-probe.ts`. (`bybit-probe` sebaliknya SUDAH terdaftar dan
> bekerja sebagai `pnpm bybit-probe`.)

## Script maintenance lain (`scripts/*.ts`)

| Script | Fungsi |
|---|---|
| `scripts/reset-admin-password.ts` | Reset password admin via Telegram ID, tanpa lewat bot/web (darurat lupa password) |
| `scripts/bybit-internal-probe.ts` | Probe read-only API Bybit — cek koneksi sebelum mengaktifkan auto-confirm |
| `scripts/binance-probe.ts` | Probe read-only API Binance — cek transfer masuk punya field note |
| `scripts/migrate-catalog-rename.ts` | Migrasi data SEKALI-JALAN (rename tabel lama → Category/Product/Denomination) — **tidak idempotent**, lihat README.md §7 sebelum jalankan ulang di produksi |
| `scripts/backfill-catalog-slugs.ts` | Backfill kolom `slug` untuk baris katalog lama |
| `scripts/convert-prices-to-idr.ts` | Migrasi data SEKALI-JALAN era konversi USDT→IDR (legacy, kemungkinan tidak relevan untuk instalasi baru) |
| `scripts/build-bundle.ts` | Bundler esbuild kustom (opsional, di luar jalur `tsx` default) |

## CI

`.github/workflows/ci.yml` menjalankan pada setiap PR + push ke `master`:
`pnpm install --frozen-lockfile` → `pnpm exec prisma generate` →
`pnpm -r typecheck` → `npx vitest run`. Tidak ada deploy otomatis — CI murni
gate regresi.
