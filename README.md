# Telegram Order Bot — Panduan Instalasi

Toko digital lengkap dalam satu aplikasi: **bot Telegram** untuk pelanggan,
**panel admin web** untuk mengelola produk & pesanan, dan **website toko**
opsional. Pelanggan melihat katalog, memesan, dan membayar lewat **QRIS (TokoPay),
Binance Internal, atau Bybit (USDT-BEP20)** — dari Telegram maupun website.
Ketiganya **terkonfirmasi otomatis**: akun langsung terkirim tanpa cek manual.

Dibangun dengan **Node.js + TypeScript** (monorepo pnpm). Semua layanan (bot,
panel admin, toko web, notifier) berbagi **satu database SQLite** — tanpa server
database terpisah.

> 📌 Ditulis untuk pemula — ikuti dari atas ke bawah, semua perintah bisa
> di-*copy-paste*. Alur cepat: **Sebelum Mulai → pilih satu Jalur Instalasi →
> Buat Admin Pertama**.

---

## Daftar Isi

1. [Sebelum Mulai](#1-sebelum-mulai)
2. [Mengisi File `.env`](#2-mengisi-file-env)
3. [Jalur A — VPS dengan Docker (disarankan)](#3-jalur-a--vps-dengan-docker-disarankan)
4. [Jalur B — VPS tanpa Docker](#4-jalur-b--vps-tanpa-docker)
5. [Buat Admin Pertama](#5-buat-admin-pertama)
6. [Mengatur Pembayaran](#6-mengatur-pembayaran)
7. [Update, Backup, dan Perawatan](#7-update-backup-dan-perawatan)
8. [Masalah Umum & Solusi](#8-masalah-umum--solusi)
9. [Referensi Variabel `.env`](#9-referensi-variabel-env)
10. [Untuk Developer](#10-untuk-developer)

---

## 1. Sebelum Mulai

### 1.1. Yang perlu disiapkan

| Kebutuhan | Keterangan |
|---|---|
| **Server** | VPS (mis. Hostinger VPS, DigitalOcean) dengan akses root/SSH |
| **Node.js ≥ 20** | Otomatis bila pakai Docker. Cek: `node -v` |
| **pnpm 9** | Hanya untuk jalur non-Docker. Install: `npm install -g pnpm@9` |
| **Akun Telegram** | Untuk membuat bot dan menjadi admin |

### 1.2. Tiga hal wajib

**a) Token Bot** — buka [@BotFather](https://t.me/BotFather) → ketik `/newbot` →
ikuti langkahnya → dapat token seperti `123456789:AAE...`. **Simpan.**

**b) ID Telegram-mu** — buka [@userinfobot](https://t.me/userinfobot) → `/start` →
ia mengirim angka ID-mu, mis. `12345678`. **Simpan.**

**c) Kunci rahasia cookie** (`WEB_COOKIE_SECRET`) — string acak ≥ 32 karakter
untuk mengamankan login panel admin:

```bash
openssl rand -hex 32
```

Tanpa `openssl`, ketik sembarang 40+ huruf/angka acak.

---

## 2. Mengisi File `.env`

`.env` menyimpan pengaturan rahasia. **Jangan** dibagikan atau di-commit. Mulai
dari contoh:

```bash
cp .env.example .env
```

Isi minimal:

```ini
# Database — biarkan default kalau pakai Docker
DATABASE_URL_PRISMA=file:./data/bot.db

# Bot Telegram
BOT_TOKEN=123456789:AAE...        # dari @BotFather (1.2.a)
ADMIN_IDS=12345678                # ID Telegram-mu (1.2.b); pisah koma kalau >1

# Panel admin
WEB_COOKIE_SECRET=hasil_openssl_rand_hex_32   # (1.2.c)

# Tampilan
TIMEZONE=Asia/Jakarta
DEFAULT_LANGUAGE=id
```

> 💡 **Token bot juga bisa diisi nanti** lewat wizard/panel admin (DB menang atas
> `.env`). Jika diatur lewat panel, **hapus atau _comment_** baris `BOT_TOKEN` di
> `.env` — **jangan** dikosongkan jadi `BOT_TOKEN=` (string kosong gagal
> validasi). `ADMIN_IDS` aman dikosongkan, tapi jangan biarkan ID contoh
> tertinggal: nilainya **digabung** dengan daftar admin di DB, bukan menimpa.

Pengaturan pembayaran **tidak wajib** sekarang — bisa diisi belakangan dari panel
admin ([bagian 6](#6-mengatur-pembayaran)). Daftar lengkap variabel ada di
[bagian 9](#9-referensi-variabel-env).

---

## 3. Jalur A — VPS dengan Docker (disarankan)

Cara paling mudah dan stabil: Docker mengurus Node, dependensi, dan database.
Butuh VPS dengan **Docker** + **Docker Compose**.

**1. Install Docker** (sekali saja, Ubuntu/Debian):

```bash
curl -fsSL https://get.docker.com | sh
```

Cek: `docker --version` dan `docker compose version`.

**2. Ambil kode:**

```bash
git clone <url-repo-kamu> telegram-order-bot
cd telegram-order-bot
```

**3. Buat `.env`** mengikuti [bagian 2](#2-mengisi-file-env). Untuk Docker, pakai
path relatif: `DATABASE_URL_PRISMA=file:./data/bot.db`.

**4. Bangun image** (beberapa menit pertama kali):

```bash
docker compose build
```

**5. Siapkan database:**

```bash
docker compose run --rm order-bot pnpm exec prisma db push
```

**6. Nyalakan layanan** (urutan penting):

```bash
docker compose up -d notifier      # 1. pengirim notifikasi
docker compose up -d web-admin     # 2. panel admin (port 8000)
docker compose up -d order-bot     # 3. bot Telegram
docker compose up -d storefront    # 4. toko web (port 8100) — opsional
```

> 🛍️ **`storefront` opsional** — nyalakan hanya kalau berjualan lewat website.
> Bot, panel admin, dan notifier tetap jalan tanpanya. Atau nyalakan semua
> sekaligus: `docker compose up -d`.

**7. Cek:**

```bash
docker compose ps                  # semua "running"/"healthy"
docker compose logs -f order-bot   # log bot (Ctrl+C keluar)
```

- Panel admin: `http://IP-VPS-KAMU:8000/login`
- Toko web (jika dinyalakan): `http://IP-VPS-KAMU:8100/`
- Bot: chat botmu, ketik `/start` → harus membalas.

✅ Lanjut ke [Buat Admin Pertama](#5-buat-admin-pertama).

> 🔒 **Keamanan:** port 8000 & 8100 di atas terbuka lewat HTTP biasa. Untuk
> produksi, pasang **reverse proxy + HTTPS** (Nginx/Caddy + domain) lalu set
> `WEB_COOKIE_SECURE=true`. Toko web biasanya pakai domain sendiri via
> `SHOP_PUBLIC_URL` ([bagian 9](#9-referensi-variabel-env)).

**Perintah harian:**

```bash
docker compose logs -f order-bot   # lihat log
docker compose restart order-bot   # restart (mis. setelah ganti token)
docker compose down                # matikan semua
docker compose up -d               # nyalakan lagi
```

---

## 4. Jalur B — VPS tanpa Docker

Butuh **Node.js ≥ 20** + **pnpm 9** di VPS.

**1. Install Node & pnpm:**

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20
npm install -g pnpm@9
```

**2. Ambil kode & dependensi:**

```bash
git clone <url-repo-kamu> telegram-order-bot
cd telegram-order-bot
pnpm install
```

**3. Buat `.env` & siapkan database:**

```bash
cp .env.example .env
nano .env                       # isi sesuai bagian 2
pnpm prisma:generate
pnpm exec prisma db push
```

**4. Jalankan** (satu proses gabungan):

```bash
pnpm start
```

- Panel admin: `http://IP-VPS-KAMU:8000/login`
- Toko web: `http://IP-VPS-KAMU:8100/`

> 🛍️ `pnpm start` menjalankan **satu proses** berisi bot + panel admin
> (`WEB_PORT`, 8000) + toko web (`STOREFRONT_PORT`, 8100) + notifier. Tak mau
> jualan via web? Abaikan port 8100. Agar diakses dari luar VPS set
> `WEB_HOST=0.0.0.0` (default `127.0.0.1`; idealnya di balik HTTPS). Punya domain
> toko? Set `SHOP_PUBLIC_URL` + `SHOP_HOST` agar toko & admin berbagi satu port
> per-domain.

**5. Jaga tetap hidup dengan PM2** (`pnpm start` mati saat logout):

```bash
npm install -g pm2
pm2 start "pnpm start" --name bot-order
pm2 save
pm2 startup                     # ikuti perintah yang ditampilkan
```

Berguna: `pm2 logs bot-order`, `pm2 restart bot-order`, `pm2 stop bot-order`.

> 🔒 Pasang HTTPS (reverse proxy) untuk panel admin sebelum dibuka ke publik.

---

## 5. Buat Admin Pertama

Setelah aplikasi jalan dan panel admin bisa dibuka:

1. Buka `http://SERVER-KAMU:8000/` di browser.
2. Instalasi baru otomatis diarahkan ke **wizard setup** — ikuti **3 langkah**:
   - **Bot token** dari @BotFather (boleh "Atur nanti").
   - **ID Telegram**-mu + **password** login.
   - **Nama toko** (opsional).
3. Selesai → **otomatis login**. Jika token diisi, klik **"Nyalakan bot
   sekarang"**.

> Lupa password? Jalankan pemulihan di server, lalu buka `/bootstrap` untuk set
> password baru:
> ```bash
> # Docker:
> docker compose run --rm order-bot pnpm reset-admin-password <ID-telegram>
> # Non-Docker:
> pnpm reset-admin-password <ID-telegram>
> ```

Detail alur setup & jalur manual `/bootstrap` ada di [`DOCS.md`](DOCS.md).

---

## 6. Mengatur Pembayaran

Semua diatur dari **panel admin → Settings → Payments** (tanpa edit `.env`, tanpa
restart untuk sebagian besar). Pembeli memilih **QRIS** atau **USDT** (Binance /
Bybit) saat membeli — di bot maupun website. Ketiganya auto-confirm:

| Metode | Mata uang | Konfirmasi | Yang diisi |
|---|---|---|---|
| **QRIS (TokoPay)** | Rupiah | Otomatis (webhook) | Merchant ID + Secret |
| **Binance Internal** | USDT | Otomatis (transfer antar-UID) | UID + API key/secret read-only |
| **Bybit USDT-BEP20** | USDT | Otomatis (deposit on-chain BEP20) | Alamat deposit + API key/secret |

> **Binance Pay manual** (upload bukti, approve manual) hanya muncul sebagai
> *fallback* bila belum ada satu pun metode otomatis. Perlu `BINANCE_PAY_ID`.

**Catatan Bybit:** API key harus **Wallet READ-ONLY** (tanpa Withdraw). Tes
koneksi: `pnpm bybit-probe`. BEP20 tanpa memo → pencocokan pakai **nominal unik**,
jaga `USE_UNIQUE_CENTS=1` dan pembeli kirim **jumlah persis**.

> 🎨 **Branding** — dari **Settings → Branding**: upload **favicon**, **logo**,
> **hero** toko, dan **banner bot**, plus ubah **nama toko, tagline, sambutan**.
> Langsung berlaku tanpa restart. Saran ukuran: favicon 512×512, logo ~240×64,
> hero 1600×900, banner 1280×720.

Detail teknis tiap metode di [`DOCS.md`](DOCS.md).

---

## 7. Update, Backup, dan Perawatan

**Update ke versi baru:**

```bash
git pull

# Docker:
docker compose build
docker compose run --rm order-bot pnpm exec prisma db push   # jika skema berubah
docker compose up -d

# Non-Docker:
pnpm install && pnpm prisma:generate && pnpm exec prisma db push
pm2 restart bot-order
```

> ⚠️ Bila ada perubahan struktur database, jalankan `prisma db push` **dulu** baru
> kode baru — kalau terbalik muncul `P2022: column does not exist`.

**Backup database** (lakukan rutin — semua data di satu file):

```bash
cp data/bot.db data/bot.db.bak-$(date +%Y%m%d)
```

**Mengelola stok** (panel admin → Stock → pilih produk):

- **Tambah stok** — tempel kredensial, satu baris per akun (`email:password`).
- **Lihat stok** — tabel item + statusnya (siap jual / terpakai / terjual / rusak).
- **Download remaining** — unduh `.txt` semua akun yang masih siap dijual.
- **Delete selected** — hapus permanen; item terjual otomatis dilindungi. Untuk
  menandai rusak tanpa hapus, pakai **Mark as bad**.

> 🔒 File unduhan berisi kredensial asli — simpan aman, hanya admin login yang
> bisa mengunduh.

---

## 8. Masalah Umum & Solusi

| Gejala | Penyebab | Solusi |
|---|---|---|
| `P2022: column does not exist` | Struktur DB belum diperbarui | `prisma db push` lalu restart |
| HTTP 500 / `attempt to write a readonly database` | Folder `data/` tak bisa ditulis container | `sudo chown -R 999:999 data` lalu `docker compose restart web-admin order-bot` |
| Bot crash: `String must contain at least 20 character(s)` | Baris `BOT_TOKEN=` dikosongkan, bukan dihapus | Hapus/_comment_ baris `BOT_TOKEN` di `.env` |
| Bot tak membalas `/start` | Token salah / proses mati | Cek `BOT_TOKEN`; cek `docker compose logs order-bot` / `pm2 logs` |
| Tak bisa login / loop login | Cookie tak tersimpan | HTTP lokal: `WEB_COOKIE_SECURE=false`; produksi: HTTPS + `WEB_COOKIE_SECURE=true` |
| Pembayaran Bybit tak otomatis | Nominal dibulatkan / jaringan salah | Kirim **jumlah persis** via **BEP20**; pastikan `USE_UNIQUE_CENTS=1` |
| Panel tak bisa diakses dari luar | Bind ke `127.0.0.1` | Docker sudah `0.0.0.0`; non-Docker set `WEB_HOST=0.0.0.0` (di balik HTTPS) |

Masih bingung? Lihat log dulu: `docker compose logs -f order-bot` atau
`pm2 logs bot-order`.

---

## 9. Referensi Variabel `.env`

Semua divalidasi saat start oleh Zod (`packages/core/src/config.ts`). Yang
**wajib** ditandai ✅.

### Inti / Bersama

| Variabel | Keterangan | Wajib | Default |
|---|---|---|---|
| `DATABASE_URL_PRISMA` | Path SQLite. Di container pakai path absolut (`file:/app/data/bot.db`) | ✅ | `file:../data/bot.db` |
| `ADMIN_IDS` | ID Telegram admin, dipisah koma | ✅ | — |
| `TIMEZONE` | Zona waktu tampilan (mis. `Asia/Jakarta`) | ✅ | — |
| `DEFAULT_LANGUAGE` | Bahasa default user baru (`en`/`id`) | | `en` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | | `info` |

### Bot Telegram

| Variabel | Keterangan | Wajib |
|---|---|---|
| `BOT_TOKEN` | Token @BotFather. Bisa diatur di panel (DB menang atas env) | ✅ |
| `BOT_USERNAME` | Username bot tanpa `@`. Terisi otomatis via `getMe()` bila kosong | |
| `SUPPORT_GROUP_ID` | ID grup tujuan tiket support (negatif untuk grup) | |
| `RATE_LIMIT_MAX` | Maks pesan per user per jendela waktu (default 5) | |
| `LOW_STOCK_THRESHOLD` | Peringatan stok bila ≤ angka ini (default 3) | |
| `REFERRAL_COMMISSION_PERCENT` | Komisi referral pembelian pertama (default 10) | |

### Panel Admin (Web)

| Variabel | Keterangan | Default |
|---|---|---|
| `WEB_COOKIE_SECRET` | Kunci HMAC cookie sesi (≥ 32 karakter) ✅ | — |
| `WEB_HOST` | Alamat bind. `0.0.0.0` di balik reverse proxy | `127.0.0.1` |
| `WEB_PORT` | Port panel admin | `8000` |
| `WEB_SESSION_TTL_HOURS` | Masa berlaku sesi (jam) | `12` |
| `WEB_COOKIE_SECURE` | `true` di produksi (di balik HTTPS) | `false` |

### Toko / Storefront (opsional)

| Variabel | Keterangan | Default |
|---|---|---|
| `STOREFRONT_PORT` | Port website toko | `8100` |
| `SHOP_PUBLIC_URL` | URL publik toko (mis. `https://shop.domain.com`). Bila diisi, satu listener memisah per `Host` | — |

### Pembayaran

Tiga field Bybit & TokoPay sebaiknya diisi di **panel admin → Settings**
(panel menang atas `.env`, tanpa restart). Env hanya bootstrap.

| Variabel | Keterangan | Default |
|---|---|---|
| `BINANCE_RECEIVE_UID` | UID Binance penerima (Binance Internal). Kosong = nonaktif | — |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | API **read-only** riwayat transfer | — |
| `INTERNAL_PAYMENT_WINDOW_MINUTES` | Menit sebelum order Binance Internal kedaluwarsa | `15` |
| `BYBIT_DEPOSIT_ADDRESS` | Alamat deposit USDT BEP20. Kosong = nonaktif | — |
| `BYBIT_API_KEY` / `BYBIT_API_SECRET` | API Bybit **Wallet READ-ONLY** | — |
| `BYBIT_DEPOSIT_CHAIN` | ID jaringan deposit | `BSC` |
| `BYBIT_PAYMENT_WINDOW_MINUTES` | Menit sebelum order Bybit kedaluwarsa | `30` |
| `BINANCE_PAY_ID` | Binance Pay ID (fallback manual). Kosong = nonaktif | — |
| `USE_UNIQUE_CENTS` | Sen unik untuk pencocokan otomatis (`1` = aktif) | `1` |
| `PAYMENT_WINDOW_MINUTES` | Menit sebelum order bukti-manual auto-batal | `30` |

> QRIS/TokoPay (`tokopay_merchant_id`, `tokopay_secret`, `tokopay_enabled`) dan
> kurs (`usd_idr_rate`) **hanya** diatur di Settings, bukan env.

### Mode Webhook (opsional)

Default `polling` tak butuh domain. `webhook` berguna bila sudah ada domain +
reverse proxy HTTPS.

| Variabel | Keterangan |
|---|---|
| `BOT_MODE` | `polling` (default) atau `webhook` |
| `PUBLIC_URL` | URL HTTPS publik (wajib di mode webhook) |
| `WEBHOOK_SECRET` | String acak panjang — path + header rahasia Telegram |

> Variabel lengkap (notifier, SMTP, dll.) ada di **`.env.example`**.

---

## 10. Untuk Developer

```bash
pnpm dev:bot        # bot Telegram (watch)
pnpm dev:web        # panel admin → http://127.0.0.1:8000
pnpm dev:notifier   # notifier
pnpm start          # semua dalam satu proses

pnpm typecheck      # cek TypeScript semua paket
pnpm test           # seluruh tes (Vitest)
```

`pnpm typecheck` dan `pnpm test` harus selalu hijau sebelum commit.

**Struktur:**

```
apps/
  order-bot/    Bot Telegram (grammY) — alur pelanggan + admin
  web-admin/    Panel admin (Fastify + Nunjucks + HTMX)
  storefront/   Website toko pelanggan
  notifier/     Pengirim notifikasi (drain notification_outbox)
  server/       Composition root satu-proses (dipakai oleh pnpm start)
packages/
  core/         Config, money (Decimal), i18n, password, mailer, fx
  db/           Prisma client + CRUD per-domain (+ tes Vitest)
  web-ui/       Tema & template bersama
prisma/schema.prisma   Skema database (SQLite, WAL)
data/bot.db            Database (di-gitignore)
```

**Dokumen lain:**

| File | Isi |
|---|---|
| [`DOCS.md`](DOCS.md) | Arsitektur, fitur, dan setup env lengkap |
| [`CLAUDE.md`](CLAUDE.md) | Konvensi & aturan koding |
| `.env.example` | Daftar semua variabel lingkungan |

---

Selamat berjualan! 🚀
