# Migrasi Web (web-admin + storefront) ke Next.js + Postgres — Design

- **Tanggal:** 2026-06-18
- **Status:** Disetujui (desain), menunggu rencana implementasi
- **Pemicu:** Audit & redesign panel admin produk agar terasa seperti Stripe/Shopify/Linear/Vercel. Keputusan diperluas menjadi migrasi penuh kedua web ke React/Next.js.

## Ringkasan keputusan

| Aspek | Pilihan |
|---|---|
| Cakupan | Migrasi penuh React: `apps/web-admin` **dan** `apps/storefront` |
| Framework | Next.js (App Router) untuk keduanya |
| Akses data | Next.js akses Prisma langsung (Server Components/Server Actions) |
| Database | Migrasi SQLite (`data/bot.db`) → Postgres |
| Auth | Auth.js (NextAuth) + adapter Prisma |
| Strategi cutover | Big-bang per aplikasi (web-admin dulu, lalu storefront) |
| Deploy | Docker Compose + Caddy (reverse proxy + TLS otomatis) |

## Konteks & motivasi

Permintaan awal adalah meredesain panel admin produk (`apps/web-admin/views/catalog.njk`)
dengan 14 poin UI/UX (tab navigation, badge, drag-and-drop foto, sticky table, dsb.) dan
mengadopsi pola komponen shadcn/ui. Karena shadcn/ui hanya untuk React sedangkan panel
saat ini Fastify + Nunjucks + HTMX, pemilik proyek memilih migrasi penuh ke React/Next.js
untuk kedua web. Untuk menghormati batas single-writer SQLite (RUN.md §9 — pemicu pindah
Postgres adalah ≥2 penulis konkuren), Next.js yang memegang PrismaClient sendiri di samping
bot/notifier berarti wajib migrasi ke Postgres.

Dokumen ini adalah **spec arsitektur menyeluruh** untuk seluruh program. Implementasi
dipecah per fase; tiap fase mendapat rencana tersendiri.

## Bagian 1 — Arsitektur target

Layanan (kontainer Docker Compose):

- **web-admin** — Next.js App Router, internal (di belakang Caddy), route-guard admin RBAC.
- **storefront** — Next.js App Router, publik, SSR untuk SEO.
- **bot** — grammY, **tetap** (tidak dimigrasi), bicara ke Postgres via `@app/db`.
- **notifier** — drain `notification_outbox`, **tetap**, bicara ke Postgres.
- **postgres** — DB tunggal menggantikan `data/bot.db`.
- **caddy** — reverse proxy + TLS otomatis; admin & storefront pada host/subdomain berbeda.

Aliran data: semua proses memakai `@app/db` (Prisma) ke Postgres. Aturan
**"Never send Telegram from the web"** tetap berlaku — Next admin/storefront hanya
**enqueue ke `notification_outbox`**; notifier/bot yang mengirim. Audit (`logAdminAction`)
tetap dipanggil dari Server Actions pada setiap perubahan state.

Lestari vs berubah:

- **Lestari:** `packages/core` (money/datetime/i18n/password/mailer/fx), `packages/db/crud/*`
  beserta test Vitest-nya, skema domain, logika bisnis, kontrak `notification_outbox`.
- **Berubah/pensiun:** Nunjucks `apps/web-admin` & `apps/storefront`, `packages/web-ui`
  (tema Nunjucks), `apps/server` sebagai composition-root satu-proses, Fastify/Nunjucks/HTMX,
  Tailwind via CDN.

## Bagian 2 — Struktur monorepo

```
apps/
  web-admin/      → Next.js (isi diganti; nama paket tetap @app/web-admin)
  storefront/     → Next.js
  bot/            → grammY (rename dari order-bot; fungsi tetap)
  notifier/       → tetap
packages/
  core/           → tetap (dipakai Next & bot)
  db/             → Prisma (provider → postgresql) + crud/* tetap
  ui/             → BARU: design system shadcn bersama (menggantikan web-ui)
prisma/
  schema.prisma   → datasource postgresql
docker/           → Dockerfile per app + compose.yaml + Caddyfile
```

`packages/ui` menjadi rumah komponen shadcn bersama (Button, Card, Tabs, Badge, Separator,
Tooltip, DropdownMenu, AlertDialog) + token tema, dipakai admin & storefront agar tetap satu
keluarga visual — peran yang dulu dipegang `packages/web-ui`.

## Bagian 3 — Data layer & migrasi Postgres

- Ubah `datasource` Prisma ke `postgresql`. Review tiap kolom untuk perbedaan tipe
  SQLite→Postgres (Decimal/money, datetime UTC, boolean, enum).
- **Enum:** nilai yang kini disimpan UPPERCASE sebagai string **tetap string** pada fase awal
  agar `crud/*` dan testnya tak berubah; konversi ke native Postgres enum adalah optimasi
  opsional di kemudian hari.
- **Skrip migrasi data satu kali:** ekspor dari SQLite → impor ke Postgres. Urut sesuai FK,
  jaga Decimal sebagai `numeric`, datetime sebagai UTC. Verifikasi dengan hitung baris per
  tabel + cek sampel nilai uang/tanggal.
- **Test paritas:** `crud/*` Vitest dijalankan ulang terhadap Postgres test container untuk
  membuktikan paritas perilaku.
- **Backup:** skrip backup WAL-SQLite (M-5) diganti `pg_dump` + restore terjadwal.

## Bagian 4 — Auth (Auth.js / NextAuth)

- **Admin:** Credentials provider memakai `verifyPassword` bcrypt dari `@app/core/password`
  (hash lama tetap valid). Session cookie. RBAC dibawa melalui callback `jwt`/`session`
  (membawa `role`). Middleware Next menjaga route; padanan `canMutate` menjadi guard di
  Server Action (catalog tetap super-only).
- **Customer (storefront):** Credentials provider terpisah. Forgot-password memakai `mailer`
  yang ada + token. Input diperlakukan untrusted (CLAUDE.md — storefront permukaan publik).
- **CSRF:** ditangani Auth.js + origin check Server Actions, menggantikan preHandler
  `csrfProtect`.
- **Whitelist Settings edit** (guardrail "jangan bikin bot brick") tetap diberlakukan di
  Server Action; tidak diperlebar tanpa review.

## Bagian 5 — Design system (shadcn) + redesign panel produk (14 poin)

Pemetaan token tema saat ini → Tailwind config + CSS variables shadcn (dipertahankan agar
identitas visual konsisten):

- Font: Outfit (display) + Manrope (body) + JetBrains Mono (kode/ID).
- Aksen: biru `#2563eb` (pine), sukses hijau `#16a34a`, warning amber `#b45c0a`,
  danger rust `#dc2626` → token shadcn (`--primary`, `--muted`, `--destructive`, dst.).
- Radius ~`0.75–1rem`; shadow `soft`/`lift`.

Komponen shadcn yang diadopsi: Card, Tabs, Badge, Button, Separator, Tooltip, DropdownMenu,
AlertDialog + ikon Lucide.

Panel admin produk (layar acuan 14 poin) — rancangan:

1. **Hapus panah teks** `► ▼ →` → **Lucide Chevron** dengan animasi rotate halus.
2. **Tab navigation** menggantikan section collapsible `<details>`:
   **General · Photos · Discounts · Inventory**.
3. **Link aksi → Button** + ikon Lucide.
4. **Hierarki visual:** judul produk lebih besar; SKU/denominasi/status sebagai **badge**;
   **price card** di kanan.
5. **Upload foto → kartu drag-and-drop + preview** (mengganti `<input type=file>` polos),
   memakai endpoint upload yang sama (jadi route handler/Server Action). JPG/PNG/WebP,
   maks 5 MB, hint rasio 4:3 (800×600 / 1200×900).
6. **Tabel stok (Inventory):** spacing lebih baik, badge status, tombol ikon, **sticky header**.
7. **Kurangi link biru & teks berlebih.**
8. **Tipografi & spacing** dirapikan.
9. **Komponen shadcn** seperti di atas.
10. **Chevron Lucide beranimasi** menggantikan panah teks.
11. **Aksesibilitas keyboard** (Tabs/Dialog/Tooltip shadcn ARIA-compliant) + responsif.
12. **Hapus CSS mati & duplikat** (tema Nunjucks lama tidak dibawa).
13. **Rencana BEFORE vs AFTER** (lihat lampiran) dibuat sebelum mengubah file.
14. **Pertahankan setiap fitur & endpoint** — tanpa perubahan logika bisnis.

## Bagian 6 — Pemetaan fitur/endpoint (paritas, tanpa ubah logika)

Setiap route Fastify lama dipetakan ke Server Action / Route Handler Next yang memanggil
`crud/*` yang sama. Contoh (panel produk):

| Lama (Fastify) | Baru (Next) | crud dipakai |
|---|---|---|
| `POST /catalog/product` | action `createProductAction` | `createProduct` |
| `POST /catalog/product/:id/update` | `updateProductAction` | `updateProduct`, `assignProductToGroup` |
| `POST /catalog/product/:id/photo` | route handler upload | `updateProduct` + fs |
| `POST /catalog/product/:id/bulk-pricing` | `bulkPricingAction` | `upsert/deleteBulkPricing` |
| `POST /catalog/products/bulk` | `bulkActiveAction` | `bulkSetProductsActive` |
| `POST /catalog/products/bulk-price[/apply]` | `bulkPriceAction` | `getProductsByIds`, `bulkSetPrices` |
| `POST /catalog/products/import[/apply]` | `importAction` | `createProduct` (transaksi) |
| `POST /catalog/category[...]` | category actions | `create/updateCategory` |
| `POST /catalog/group[...]` | group actions | `create/update/deleteGroup` |
| `GET /stock/:id` + mutasi stok | route + actions inventory | crud stock |

Spec implementasi akan memuat tabel paritas **lengkap** untuk semua route admin & storefront.
Audit (`logAdminAction`) dan i18n en/id dipertahankan. Perilaku UX kecil yang harus direplika:
flash message, anti double-submit checkout, status badge, empty-state.

## Bagian 7 — Urutan kerja (big-bang per app) & testing

1. **Fase 0 — Fondasi:** Postgres + migrasi skema/data; Auth.js; `packages/ui` (shadcn + token);
   Docker Compose + Caddy. Alihkan bot & notifier ke Postgres.
2. **Fase 1 — web-admin:** Next.js penuh, paritas semua halaman; panel produk = showcase 14 poin.
   → cutover admin.
3. **Fase 2 — storefront:** Next.js SSR penuh, paritas. → cutover storefront.
4. **Fase 3 — bersih-bersih:** hapus Nunjucks/Fastify/`web-ui`, `apps/server` composition-root,
   dependency mati.

Testing: `crud/*` Vitest tetap (kini di Postgres); tambah test Server Actions; smoke E2E
(Playwright) untuk alur kritis (login admin, CRUD produk, checkout). `pnpm typecheck` +
`pnpm test` tetap gerbang hijau.

## Bagian 8 — Risiko

- **Skala:** rewrite berminggu-minggu, bukan UI tweak (disepakati).
- **Paritas tersembunyi:** perilaku kecil HTMX/Nunjucks (flash, anti double-submit,
  retire keyboard) harus direplika.
- **Postgres drift:** perbedaan tipe/koleksi vs SQLite; dikunci lewat test crud.
- **Auth publik storefront:** permukaan serangan — butuh review keamanan khusus.
- **Deploy VPS:** butuh Docker; ada downtime saat tiap cutover.

## Lampiran — BEFORE vs AFTER panel produk

| Elemen | BEFORE (Nunjucks/HTMX) | AFTER (Next.js/shadcn) |
|---|---|---|
| Navigasi seksi | `<details>` collapsible + panah teks `► ▼` | shadcn **Tabs**: General/Photos/Discounts/Inventory |
| Aksi | link biru `Edit`, `Manage stock →` | **Button** + ikon Lucide, DropdownMenu untuk aksi sekunder |
| Status/denominasi | teks `· Denominasi: …` + chip | **Badge** shadcn |
| Harga | teks rata-kanan | **price card** di kanan |
| Foto | `<input type=file>` polos + tombol Upload | **kartu drag-and-drop + preview** |
| Tabel kategori/stok | `data-table` statis | spacing lega, **sticky header**, badge, tombol ikon |
| Hapus | `confirm()` JS | **AlertDialog** shadcn |
| Panah | karakter `►`/`▼`/`→` | **Chevron Lucide** beranimasi |
| Tema | CSS kustom di `_theme.njk` (CDN Tailwind) | token shadcn di `packages/ui` (Tailwind build) |
