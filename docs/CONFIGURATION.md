# Konfigurasi

Referensi variabel lengkap ada di [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md).
Dokumen ini menjelaskan **bagaimana** konfigurasi di-resolve dan contoh profil
dev/produksi.

## Dua sumber konfigurasi

1. **`.env`** — divalidasi via Zod (`packages/core/src/config.ts`) saat
   proses boot. Salah/hilang nilai wajib → proses **refuse to start** (gagal
   cepat, bukan gagal diam-diam).
2. **`Setting` (tabel DB, key-value)** — diedit lewat web-admin → Settings,
   berlaku **tanpa restart** untuk sebagian besar key.

**`.env` adalah bootstrap/pemulihan; `Setting` adalah sumber kebenaran
operasional** untuk kredensial bot, kurs, dan semua gateway pembayaran.
Tabel resolusi penuh per-key (mana yang menang, kapan butuh restart) sudah
didokumentasikan di [`../DOCS.md` §6](../DOCS.md#6-settings-vs-env) — jangan
duplikasi di sini, rujuk ke sana.

Gateway pembayaran (`tokopay_*`, `paydisini_*`, `nowpayments_*`, `bybit_*`,
`bot_token`, dst.) **hanya** diatur dari Settings setelah setup awal — bukan
`.env` — kecuali sebagai fallback bootstrap sebelum admin pertama login.

## Validasi (`packages/core/src/config.ts`)

Schema Zod (`Env`) memuat default untuk hampir semua variabel opsional
(`z.coerce.number().default(...)`, dll.) — lihat
[ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) untuk nilai default tiap
variabel. Helper khusus:

- `blankableOptional` — `VAR=` (kosong) diperlakukan sama dengan tidak diset
  sama sekali, bukan gagal validasi `.min()`. Penting untuk `BOT_TOKEN=` yang
  sengaja dikosongkan saat token diatur lewat Settings.
- `looseBool` — `"1"/"true"/"yes"/"on"` (case-insensitive) → `true`.
- `csvNumbers` — `"111, 222"` → `[111, 222]` (dipakai `ADMIN_IDS`).

`.env` dicari dengan **berjalan ke atas dari direktori modul** sampai
ketemu `pnpm-workspace.yaml` — jadi `.env` di root repo terbaca walau salah
satu app dijalankan dengan `cwd` workspace-nya sendiri
(`pnpm --filter @app/order-bot dev`).

## Profil Development

```ini
DATABASE_URL_PRISMA=file:../data/bot.db
BOT_TOKEN=                          # kosongkan, isi dari wizard setup
ADMIN_IDS=12345678
WEB_COOKIE_SECRET=dev-only-not-for-production-min-32-chars
WEB_COOKIE_SECURE=false             # http://127.0.0.1, bukan HTTPS
WEB_HOST=127.0.0.1
LOG_LEVEL=debug
TIMEZONE=Asia/Jakarta
DEFAULT_LANGUAGE=id
```

## Profil Produksi

```ini
DATABASE_URL_PRISMA=file:/app/data/bot.db    # path absolut (Docker)
BOT_TOKEN=123456:token-asli
ADMIN_IDS=12345678
WEB_COOKIE_SECRET=<openssl rand -hex 32>     # WAJIB unik & rahasia
WEB_COOKIE_SECURE=true                       # WAJIB di balik HTTPS (nginx)
WEB_HOST=0.0.0.0                             # di-override otomatis oleh docker-compose.yml
LOG_LEVEL=info
TRUST_PROXY=127.0.0.1,::1                    # HANYA alamat nginx di host yang sama
SHOP_PUBLIC_URL=https://shop.contoh.com
WEB_LOGIN_RATE_LIMIT_MAX=5
WEB_LOGIN_RATE_LIMIT_WINDOW_SECONDS=600
```

`WEB_COOKIE_SECURE=false` adalah default schema — **operator wajib
menyalakannya manual di produksi** (lihat catatan risiko di
[SECURITY.md](SECURITY.md)). `TRUST_PROXY` defaultnya **unset** (`X-Forwarded-For`
diabaikan total) — hanya isi dengan alamat reverse-proxy tepercaya, jangan
pernah `"*"`.

## Multi-toko di satu VPS

Variabel yang **wajib berbeda** per instance toko (`COMPOSE_PROJECT_NAME`,
`BOT_TOKEN`, `WEB_PORT`, `STOREFRONT_PORT`, `WEB_COOKIE_SECRET`,
`SHOP_PUBLIC_URL`) didokumentasikan lengkap di
[`../DOCS.md` §11](../DOCS.md#11-banyak-toko-dalam-satu-vps) — termasuk pola
direktori, port, dan nginx multi-domain.
