# Fase 1 — Migrasi web-admin ke Next.js (Planning Document)

> **Status: Superseded 2026-06-25** — lihat
> docs/superpowers/specs/2026-06-25-admin-dashboard-redesign-design.md.
> Migrasi Postgres ini tidak pernah dimulai dan tidak lagi menjadi prasyarat
> arah dashboard saat ini.

> **Altitude:** Dokumen perencanaan tingkat-tinggi (bukan plan bite-sized TDD).
> Plan eksekusi rinci ditulis ulang setelah Fase 0 hijau, saat inventory route &
> signature `packages/ui`/Auth.js sudah pasti. Lihat
> `2026-06-18-migrasi-nextjs-postgres-design.md` untuk konteks arsitektur.

**Goal:** Mengganti `apps/web-admin` (Fastify+Nunjucks+HTMX) dengan app Next.js (App
Router) berparitas penuh, dengan panel produk sebagai showcase 14 poin UI/UX, tanpa
mengubah logika bisnis (`packages/db/crud/*`) atau kontrak `notification_outbox`.

**Prasyarat:** Fase 0 selesai — DB di Postgres, suite crud hijau, schema settled.

**Tech Stack:** Next.js (App Router, Server Components + Server Actions), Auth.js
(NextAuth) + adapter Prisma, shadcn/ui + Tailwind, Lucide, `@app/db`, `@app/core`.

## Global Constraints (warisan, berlaku untuk semua task)

- Decimal `@db.Decimal(12,4)` untuk uang; jangan `float`.
- **Jangan kirim Telegram dari web** — hanya enqueue ke `notification_outbox`.
- **Audit setiap perubahan state** lewat `logAdminAction` dengan id admin.
- **Settings edit whitelist-only** — jangan diperlebar tanpa review.
- **No raw SQL di route/action** — lewat `crud/*`.
- i18n en/id: string admin lewat lapisan i18n yang sama (`@app/core` locales).
- `pnpm typecheck` + `pnpm test` wajib hijau.

## Inventory route lama → target (paritas)

Sumber: `apps/web-admin/src/routes/*.ts`. Setiap modul route jadi segmen App Router +
Server Actions yang memanggil crud yang sama.

| Modul lama | Halaman/aksi | Target App Router | crud/util |
|---|---|---|---|
| `auth.ts` | login, logout, forgot, reset | Auth.js route + `/login`,`/forgot`,`/reset` | `webauth`, `web_secret`, mailer |
| `setup.ts` | wizard owner/bot/shop/done | `/setup/*` (guard first-run) | `setup` |
| `dashboard.ts` | ringkasan | `/` (Server Component) | `reports` |
| `catalog.ts` | kategori, denominasi, produk, foto, bulk, import, bulk-pricing | `/catalog` + panel produk **Tabs** | `catalog`, `pricing`, `product_groups`, `bulk_pricing` |
| `stock.ts` | daftar stok, per-produk, tambah/hapus | `/stock`, `/stock/[id]` (tab Inventory) | `stock`, `stock_admin`, `credentials` |
| `orders.ts` | daftar + detail + transisi status | `/orders`, `/orders/[id]` | `orders` |
| `users.ts` | daftar + detail + ban/credit | `/users`, `/users/[id]` | `users`, `wallet` |
| `vouchers.ts` | CRUD voucher | `/vouchers` | `vouchers` |
| `broadcast.ts` | enqueue broadcast | `/broadcast` | `broadcasts` |
| `reviews.ts` | moderasi review | `/reviews` | `reviews` |
| `support.ts` | tiket + balas | `/support`, `/support/[id]` | `support` |
| `reports.ts` | laporan | `/reports` | `reports` |
| `audit.ts` | log audit | `/audit` | `audit` |
| `outbox.ts` | inspeksi outbox | `/outbox` | `notifications` |
| `payments.ts` | metode bayar, QR upload | `/settings/payments` | `settings`, upload |
| `settings.ts` | settings whitelist | `/settings` | `settings` |
| `branding.ts` | upload logo/hero/favicon | `/settings/branding` | `settings`, upload |
| `admins.ts` | kelola admin/role | `/admins` | `admins` |
| `search.ts` | pencarian global | `/search` | lintas-crud |

## File structure (target)

```
apps/web-admin/
  next.config.ts, tsconfig.json, Dockerfile
  src/
    app/
      layout.tsx                  # shell + nav + tema
      (auth)/login, forgot, reset
      setup/[step]
      page.tsx                    # dashboard
      catalog/                    # daftar + komponen panel produk (Tabs)
      stock/[id]
      orders/[id]
      users/[id]
      vouchers, broadcast, reviews, support/[id], reports, audit, outbox
      settings/(payments|branding)
      admins, search
      api/auth/[...nextauth]/route.ts
    actions/                      # Server Actions per domain (catalog.ts, stock.ts, …)
    auth/                         # Auth.js config, RBAC guards (canMutate port)
    lib/                          # upload handler, flash, csrf/origin helpers
packages/ui/                      # shadcn components + token tema (dipakai admin & storefront)
```

## Urutan task (altitude tinggi)

1. **Scaffold Next.js** di `apps/web-admin` + Dockerfile + healthcheck `/login`. Deliverable: app boot kosong, `pnpm --filter @app/web-admin dev` jalan.
2. **`packages/ui`**: init shadcn, port token tema (Outfit/Manrope, biru #2563eb, radius/shadow) ke Tailwind config + CSS vars. Adopsi Card/Tabs/Badge/Button/Separator/Tooltip/DropdownMenu/AlertDialog. Deliverable: storybook/halaman demo komponen.
3. **Auth.js + RBAC**: Credentials provider (bcrypt `@app/core/password`), session cookie, middleware route-guard, port `canMutate` jadi guard Server Action (catalog super-only). Deliverable: login admin + halaman terproteksi, test guard.
4. **Layout + nav + dashboard** (`/`). Deliverable: shell + dashboard render data Postgres.
5. **Panel produk — showcase 14 poin** (`/catalog`): Tabs General/Photos/Discounts/Inventory; hapus panah teks → Chevron beranimasi; aksi → Button+ikon; badge SKU/denominasi/status; price card kanan; drag-drop foto + preview; AlertDialog delete; sticky stock table. Semua aksi → Server Actions → crud sama. Deliverable: katalog paritas + 14 poin, test action.
6. **Paritas halaman sisanya** (batch, per modul tabel di atas): orders, users, vouchers, broadcast, reviews, support, reports, audit, outbox, settings(+payments/branding/whitelist), admins, search, setup wizard. Tiap halaman: happy + auth-fail + bad-origin test.
7. **Cutover admin**: Compose ganti service web-admin lama → Next; Caddy front admin host + TLS; smoke E2E (login, CRUD produk, upload foto, ubah setting whitelist).

## Paritas perilaku yang wajib direplika

- Flash message (success/error) → toast/banner shadcn.
- Anti double-submit pada aksi mutasi lambat.
- Status badge (mapping `_status_labels`) → komponen Badge.
- Empty-state tabel.
- USDT preview di input harga (rate dari Settings).
- Upload: JPG/PNG/WebP, max 5 MB, hint rasio 4:3; hapus file lama saat replace; audit `product_photo_upload`.
- CSV import: dry-run preview → apply (parse ulang, jangan percaya payload).

## Testing

- Server Actions: unit test (mock/seed Postgres test schema via harness Fase 0).
- Guard RBAC: test super-only catalog, auth-fail, bad-origin (pengganti trio CSRF lama).
- E2E Playwright: login → buat/edit produk → upload foto → kelola stok.
- `pnpm typecheck` + `pnpm test` hijau.

## Risiko

- Volume halaman besar (18 modul route) — task 6 di-batch, bukan satu task.
- Upload file di Server Action (streaming multipart) beda dari Fastify multipart — perlu pola Next route handler.
- Paritas i18n: pastikan key admin id/en tetap sinkron.
- Cutover: downtime singkat; siapkan rollback (service lama tetap image-nya sampai verifikasi).
