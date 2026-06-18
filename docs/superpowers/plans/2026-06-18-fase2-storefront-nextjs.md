# Fase 2 — Migrasi storefront ke Next.js (Planning Document)

> **Altitude:** Dokumen perencanaan tingkat-tinggi. Plan eksekusi rinci ditulis
> setelah Fase 1 selesai (pola `packages/ui` + Auth.js sudah mapan).

**Goal:** Mengganti `apps/storefront` (Fastify+Nunjucks+HTMX) dengan app Next.js
(App Router, **SSR untuk SEO**) berparitas penuh — toko publik pelanggan — tanpa
mengubah logika bisnis atau kontrak `notification_outbox`.

**Prasyarat:** Fase 1 selesai — `packages/ui` & Auth.js mapan, Postgres jalan.

**Tech Stack:** Next.js App Router (SSR/RSC), Auth.js customer, shadcn/ui, `@app/db`,
`@app/core` (mailer untuk forgot-password).

## Global Constraints

- Storefront = **permukaan publik**: perlakukan auth & forgot-password sebagai input untrusted; butuh review keamanan khusus.
- **Jangan kirim Telegram dari web** — enqueue `notification_outbox`.
- Decimal untuk uang; UTC di DB, `TIMEZONE` saat display.
- SSR + metadata untuk SEO (title, OG, sitemap) — alasan utama pilih Next.js untuk app ini.
- `pnpm typecheck` + `pnpm test` hijau.

## Inventory route lama → target (paritas)

Sumber: `apps/storefront/src/routes/*.ts`.

| Modul lama | Halaman/aksi | Target App Router | crud/util |
|---|---|---|---|
| `home.ts` | beranda + hero + grid grup/produk | `/` (SSR, metadata) | `catalog`, `cards`, `images` |
| `catalog.ts` | kategori, grup `/g/:id`, produk `/p/:id`, search | `/c/[id]`,`/g/[id]`,`/p/[id]`,`/search` | `catalog`, `reviews`, `stock` |
| `cart.ts` | tambah/ubah/hapus keranjang | `/cart` + actions | `cart` |
| `checkout.ts` | buat order, pilih metode bayar, status | `/checkout`, `/pay/[code]` | `orders`, `pricing`, `vouchers`, payments |
| `account.ts` | profil, pesanan, detail, review, referral, support | `/account/*`,`/orders/[code]` | `users`, `orders`, `reviews`, `referrals`, `support` |
| `auth.ts` | register, login, logout | Auth.js + `/login`,`/register` | `webauth` |
| `forgot.ts` | lupa & reset password | `/forgot`,`/reset` | `web_secret`, mailer |
| `settings.ts` | preferensi (bahasa, dll.) | `/account/settings` | `settings`/`users` |

View acuan: `home, catalog, group, product, cart, checkout, pay, orders, order_detail,
account, reviews, referral, support, ticket_detail, login, register, forgot, reset`.

## Urutan task (altitude tinggi)

1. **Scaffold Next.js storefront** + Dockerfile + healthcheck `/healthz`. SSR shell + tema dari `packages/ui`.
2. **Auth customer (Auth.js)**: register/login/logout, session cookie; review keamanan (rate-limit, enumerasi). Forgot/reset via mailer + token (port logika `web_secret`).
3. **Beranda + grid** (`/`): SSR, hero/banner dari Settings, kartu grup/produk (`shapeEntries`), gambar via `images.ts` (rasio 4:3), metadata SEO.
4. **Katalog**: kategori, grup `/g/[id]`, detail produk `/p/[id]` (review/rating, stok, bulk badge), search. SSR + caching wajar.
5. **Cart + checkout**: tambah/ubah cart; checkout (voucher, bulk pricing, unique cents), pilih metode bayar (QRIS/Binance/Bybit), **anti double-submit**, halaman status bayar `/pay/[code]` (polling status). Enqueue `notification_outbox`.
6. **Akun**: pesanan + detail (kredensial terkirim), review pasca-beli, referral, support tiket + balas, settings (bahasa).
7. **Cutover storefront**: Compose ganti service storefront → Next; Caddy front shop host + TLS; verifikasi SEO (metadata/sitemap) + alur beli E2E.

## Paritas perilaku yang wajib direplika

- Anti double-submit checkout (guard idempoten).
- Status bayar live (polling/HTMX → SSR + client poll/Server Action).
- Fallback gambar produk (webImageUrl → kategori → placeholder), rasio 4:3 `object-cover`.
- i18n en/id penuh; tidak ada teks bocor.
- Forgot-password: aman (token hash, single-use, expiry), tidak membocorkan ada/tidaknya akun.
- Referral & wallet/credit balance ditampilkan sesuai logika dual-credit.

## Testing

- Server Actions checkout/cart: unit (seed Postgres test schema).
- E2E Playwright: register → telusuri katalog → checkout (tiap metode bayar mock) → lihat pesanan.
- SEO: assert metadata/OG ada di SSR output.
- Keamanan: test forgot-password (token sekali pakai, expiry), rate-limit login.

## Risiko

- Permukaan publik → prioritas keamanan; jadwalkan review auth khusus.
- Status pembayaran realtime perlu pola polling yang setara HTMX lama.
- SEO/SSR caching vs data stok realtime — tentukan revalidate per halaman.
- Cutover: siapkan rollback; jaga link DM pelanggan (`SHOP_PUBLIC_URL`) tetap valid.
