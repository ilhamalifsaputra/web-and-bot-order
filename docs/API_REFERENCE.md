# API Reference

**Tidak ada REST/GraphQL API publik untuk konsumsi pihak ketiga.** Kedua app
(`apps/web-admin`, `apps/storefront`) server-rendered HTML penuh
(Fastify+Nunjucks+HTMX) — lihat [`../DOCS.md` §1](../DOCS.md#1-arsitektur).
Tabel di bawah mendaftar **semua** route Fastify yang sungguhan terdaftar,
dibaca langsung dari `apps/*/src/routes/*.ts` (2026-06-24). Satu-satunya
endpoint non-HTML untuk integrasi eksternal: `/healthz`, webhook gateway
pembayaran, dan webhook Telegram — detail lengkap di
[`../DOCS.md` §12](../DOCS.md#12-api--webhook).

## Mekanisme guard

### web-admin (`apps/web-admin/src/plugins/auth.ts`)

- **`currentAdmin`** — preHandler: tanpa sesi valid → redirect `303 /login`.
- **`csrfProtect`** — array preHandler berurutan: `[currentAdmin, csrfCheck,
  roleGate]`. `csrfCheck` membandingkan `body.csrf_token` dengan klaim di
  sesi; gagal → `403`. `roleGate` memanggil `canMutate(role, path)`.
- **`requireSuper`** — `[currentAdmin, role==="super" check]` → `403` jika
  bukan super.
- **RBAC (`canMutate`)** — peran `super`/`support`/`readonly`. **Baca (GET)
  selalu terbuka** untuk admin terautentikasi apa pun; hanya **mutasi**
  digerbang:
  - `super` → boleh semua.
  - Siapa pun yang terautentikasi → boleh self-service `/settings/password`
    dan `/settings/2fa/*` (ganti password/2FA sendiri).
  - `readonly` → tidak boleh mutasi apa pun selain self-service di atas.
  - `support` → boleh mutasi di `OPS_PREFIXES`
    (`/orders /support /outbox /payments /reviews`) **kecuali** juga masuk
    `CONFIG_PREFIXES` (`/catalog /vouchers /users /settings /stock /admins
    /broadcast`) — default-deny di luar whitelist.

### storefront (`apps/storefront/src/plugins/auth.ts`)

- **`currentCustomer`** — sama seperti `currentAdmin` tapi untuk pembeli,
  redirect `303 /login`.
- **`csrfProtect`** — `[currentCustomer, csrfCheck]`. Tidak ada RBAC (satu
  peran: customer).
- Endpoint publik (katalog, home, webhook) tidak pakai preHandler apa pun.

## web-admin — semua route

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| GET | `/healthz` | — | Health check (ping DB) |
| GET/POST | `/bootstrap` | — (pre-auth) | Jalur manual set password admin pertama (deploy lama, non-wizard) |
| GET/POST | `/login` | — | Login admin (Telegram ID + password [+2FA]) |
| GET/POST | `/forgot`, `/reset` | — | Reset password admin |
| POST | `/logout` | — | Rotasi JTI sesi |
| GET/POST | `/setup`, `/setup/bot`, `/setup/owner`, `/setup/shop`, `/setup/done`, `/setup/restart` | — (pre-auth, terkunci pasca-setup) | Wizard instalasi awal |
| GET | `/` | `currentAdmin` | Dashboard |
| GET | `/partials/dashboard-sla` | `currentAdmin` | Partial HTMX SLA widget |
| GET | `/search` | `currentAdmin` | Pencarian global |
| GET | `/catalog`, `/catalog/product/:id` | `currentAdmin` | Lihat katalog |
| POST | `/catalog/category[...]`, `/catalog/product[...]`, `/catalog/products/[...]`, `/catalog/denomination/[...]` | `csrfProtect` | Mutasi katalog (CRUD Category/Product/Denomination, bulk import, bulk-pricing) |
| GET | `/stock`, `/stock/:productId` | `currentAdmin` | Lihat stok |
| GET | `/stock/:productId/download` | `currentAdmin` | Download kredensial AVAILABLE (`.txt`) |
| POST | `/stock/:productId/add`, `/stock/:productId/bulk-dead`, `/stock/:productId/bulk-delete`, `/stock/item/:id/dead`, `/stock/item/:id/note` | `csrfProtect` | Mutasi stok |
| GET | `/orders`, `/orders/:id` | `currentAdmin` | Lihat order |
| POST | `/orders/:id/approve`, `/orders/:id/reject`, `/orders/:id/credit-balance` | `csrfProtect` | Mutasi order |
| GET | `/users`, `/users/:id` | `currentAdmin` | Lihat user |
| POST | `/users/:id/role`, `/users/:id/ban`, `/users/:id/wallet` | `csrfProtect` | Mutasi user (role TIDAK bisa di-set ke ADMIN dari sini — lihat SECURITY.md) |
| GET | `/payments` | `currentAdmin` | Panel ledger pembayaran (semua gateway) |
| POST | `/payments/order/:id/deliver`, `/:id/refund`, `/:id/cancel`, `/match`, `/credit`, `/dismiss` | `csrfProtect` | Resolusi manual pembayaran (unmatched/underpaid) |
| GET | `/vouchers` | `currentAdmin` | Lihat voucher |
| POST | `/vouchers`, `/vouchers/:id/toggle`, `/vouchers/:id/delete` | `csrfProtect` | Mutasi voucher |
| GET | `/reviews` | `currentAdmin` | Moderasi review |
| POST | `/reviews/:id/hide` | `csrfProtect` | Sembunyikan review |
| GET | `/outbox` | `currentAdmin` | Monitor `notification_outbox` |
| POST | `/outbox/:id/retry` | `csrfProtect` | Requeue notifikasi gagal |
| GET | `/support`, `/support/:id` | `currentAdmin` | Lihat tiket |
| POST | `/support/:id/reply`, `/:id/close` | `csrfProtect` | Balas/tutup tiket |
| GET | `/broadcast` | `currentAdmin` | Lihat antrian broadcast |
| POST | `/broadcast`, `/broadcast/:id/cancel` | `csrfProtect` | Enqueue/batalkan broadcast (web TIDAK kirim Telegram — bot yang drain) |
| GET | `/reports` | `currentAdmin` | Laporan finansial |
| GET | `/audit` | `currentAdmin` | Audit log (immutable) |
| GET | `/admins` | `requireSuper` | Daftar admin |
| POST | `/admins/add`, `/:tgId/role`, `/:tgId/logout`, `/admins/remove` | `csrfProtect` | Kelola admin (role default `readonly` saat ditambah) |
| GET | `/settings` | `currentAdmin` | Lihat Settings |
| POST | `/settings/edit`, `/settings/password`, `/settings/payments/toggle`, `/settings/fx/refresh`, `/settings/2fa/*` | `csrfProtect` | Edit Settings (whitelist-only — lihat [SECURITY.md](SECURITY.md)) |
| GET | `/branding` | `currentAdmin` | Lihat Branding |
| POST | `/branding/favicon`, `/logo`, `/hero`, `/banner` | `currentAdmin` (upload, lihat catatan) | Upload aset |
| POST | `/branding/banner/clear`, `/branding/text` | `csrfProtect` | Mutasi non-upload |

> Upload branding (`favicon`/`logo`/`hero`/`banner`) memakai `currentAdmin`
> saja (bukan `csrfProtect` penuh) di registrasi route — multipart body tidak
> cocok dengan pengecekan `body.csrf_token` JSON biasa; verifikasi CSRF untuk
> upload ditangani di lapisan lain (`lib/upload.ts`, dicek lewat `canMutate`
> dengan path yang dinormalisasi). Lihat Admin-4 fix di
> `docs/audit-security-2026-06-23.md` untuk konteks normalisasi path ini.

## storefront — semua route

| Method | Path | Guard | Fungsi |
|---|---|---|---|
| GET | `/healthz` | — | Health check |
| GET | `/` | — | Beranda |
| GET | `/lang` | — | Ganti bahasa (cookie) |
| GET | `/c/:slug` | — | Halaman kategori |
| GET | `/p/:slug` | — | Detail produk (denominasi) |
| GET | `/search` | — | Pencarian |
| GET/POST | `/login` | — | Login password |
| GET | `/auth/telegram` | — | Verifikasi Telegram Login Widget (lookup-only) |
| GET/POST | `/register` | — | Registrasi akun web |
| POST | `/logout` | — | Rotasi JTI sesi |
| GET/POST | `/forgot` | — | Minta token reset (email) |
| GET/POST | `/reset/:token` | — | Set password baru dari token |
| GET | `/cart` | — (optionalCustomer) | Lihat keranjang (cookie tamu atau DB) |
| POST | `/cart/add`, `/cart/update`, `/cart/remove` | — (guest-allowed, lihat catatan) | Mutasi keranjang |
| GET | `/checkout` | `currentCustomer` | Halaman checkout |
| POST | `/checkout` | `csrfProtect` | Submit pilihan metode bayar + voucher |
| GET | `/checkout/:code/pay` | `currentCustomer` | Instruksi bayar (QR/alamat) |
| GET | `/checkout/:code/status` | `currentCustomer` | Partial HTMX di-poll ~5 detik |
| POST | `/checkout/:code/cancel` | `csrfProtect` | Batalkan order pending |
| POST | `/pay/tokopay/callback`, `/pay/paydisini/callback`, `/pay/nowpayments/callback` | — (signature gateway sebagai auth) | Webhook konfirmasi bayar — lihat [PAYMENT_GATEWAY.md](PAYMENT_GATEWAY.md) |
| GET | `/account` | `currentCustomer` | Ringkasan akun |
| GET | `/account/orders`, `/account/orders/:code` | `currentCustomer` | Riwayat order + kredensial (jika DELIVERED) |
| GET/POST | `/account/settings` | `currentCustomer`/`csrfProtect` | Identitas dasar |
| POST | `/account/settings/credentials` | `csrfProtect` | Ganti username/email/password (wajib `current_password`) |
| POST | `/account/settings/link-telegram` | `currentCustomer` | Tautkan akun Telegram |
| GET | `/account/referral` | `currentCustomer` | Kode & statistik referral |
| GET/POST | `/account/reviews` | `currentCustomer`/`csrfProtect` | Lihat/tulis review |
| GET/POST | `/account/support`, `/account/support/:id`, `/account/support/:id/reply` | `currentCustomer`/`csrfProtect` | Tiket dukungan |
| GET/POST | `/categories`, `/categories/:slug/products`, `/products`, `/products/:slug`, `/products/:slug/denominations`, `/cart` (POST), `/checkout` (POST) | — | `/api/v1/*` internal — dipakai **fetch/HTMX dari halaman storefront sendiri**, BUKAN API publik pihak ketiga (lihat `apps/storefront/src/routes/api.ts`) |

> **Cart guest tidak pakai CSRF** (mengandalkan `SameSite=Lax` saja) —
> risiko diterima karena cart bebas-uang dan harga selalu di-recompute
> server-side saat checkout (Storefront-7, audit keamanan 2026-06-23, Low).

## Webhook publik (di luar kedua app HTML)

| Endpoint | Auth | Detail |
|---|---|---|
| `POST /tg/<WEBHOOK_SECRET>` | Path secret + header `X-Telegram-Bot-Api-Secret-Token` | Hanya ada jika `BOT_MODE=webhook` |
| `POST /pay/{tokopay,paydisini,nowpayments}/callback` | Signature gateway | Lihat [PAYMENT_GATEWAY.md](PAYMENT_GATEWAY.md) |
| `GET /healthz` (admin & storefront) | — | Uptime monitor / reverse proxy |

Kontrak request/respons penuh webhook ada di
[`../DOCS.md` §12](../DOCS.md#12-api--webhook) dan
[PAYMENT_GATEWAY.md](PAYMENT_GATEWAY.md).
