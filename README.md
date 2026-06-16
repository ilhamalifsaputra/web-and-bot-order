# Telegram Order Bot — Panduan Instalasi (Ramah Pemula)

Aplikasi toko digital lengkap: **bot Telegram** untuk pelanggan, **panel admin web**
untuk kamu mengelola produk/pesanan, dan **website toko** opsional. Pelanggan
melihat katalog, memesan, dan membayar lewat **Binance, Bybit (USDT-BSC), atau
TokoPay (QRIS)** — langsung dari Telegram atau dari website. Pembayaran kripto
bisa **terkonfirmasi otomatis** (akun langsung terkirim tanpa kamu cek manual).

Dibuat dengan **Node.js + TypeScript** (monorepo pnpm). Tiga layanan (bot, panel
admin, notifier) berbagi **satu database SQLite** — tidak perlu server database
terpisah.

> 📌 Panduan ini ditulis untuk pemula. Ikuti dari atas ke bawah. Semua perintah
> bisa di-*copy-paste*. Kalau hanya mau cepat: baca **Sebelum Mulai** →
> pilih satu **Jalur Instalasi** → **Buat Admin Pertama**.

---

## Daftar Isi

1. [Sebelum Mulai (yang harus disiapkan)](#1-sebelum-mulai)
2. [Mengisi File `.env`](#2-mengisi-file-env)
3. [Jalur Instalasi A — VPS dengan Docker (disarankan)](#3-jalur-a--vps-dengan-docker-disarankan)
4. [Jalur Instalasi B — VPS tanpa Docker](#4-jalur-b--vps-tanpa-docker-langsung-nodejs)
5. [Jalur Instalasi C — Hostinger Node.js App Manager](#5-jalur-c--hostinger-nodejs-app-manager-hosting-biasa)
6. [Buat Admin Pertama](#6-buat-admin-pertama)
7. [Mengatur Pembayaran](#7-mengatur-pembayaran)
8. [Update, Backup, dan Perawatan](#8-update-backup-dan-perawatan)
9. [Masalah Umum & Solusi](#9-masalah-umum--solusi)
10. [Referensi Lengkap Variabel `.env`](#10-referensi-lengkap-variabel-env)
11. [Untuk Developer](#11-untuk-developer)

---

## 1. Sebelum Mulai

### 1.1. Yang perlu kamu punya

| Kebutuhan | Keterangan |
|---|---|
| **Server** | VPS (mis. Hostinger VPS, DigitalOcean) **atau** hosting Node.js (Hostinger Node App Manager) |
| **Node.js ≥ 20** | Sudah otomatis kalau pakai Docker. Cek versi: `node -v` |
| **pnpm 9** | Hanya untuk jalur non-Docker. Install: `npm install -g pnpm@9` |
| **Akun Telegram** | Untuk membuat bot dan menjadi admin |

### 1.2. Siapkan 3 hal ini dulu (wajib)

**a) Token Bot** — buka [@BotFather](https://t.me/BotFather) di Telegram →
ketik `/newbot` → ikuti langkahnya → kamu dapat token seperti
`123456789:AAE...`. **Simpan token ini.**

**b) ID Telegram-mu** (untuk jadi admin) — buka
[@userinfobot](https://t.me/userinfobot) → ketik `/start` → ia mengirim angka
ID kamu, mis. `12345678`. **Simpan angka ini.**

**c) Kunci rahasia cookie** (`WEB_COOKIE_SECRET`) — string acak minimal 32
karakter untuk mengamankan login panel admin. Buat dengan:

```bash
openssl rand -hex 32
```

Kalau di Windows tanpa `openssl`, ketik sembarang 40+ huruf/angka acak.

---

## 2. Mengisi File `.env`

`.env` adalah file pengaturan rahasia. **Jangan pernah** membagikan atau
meng-commit-nya ke Git. Mulai dari contoh:

```bash
cp .env.example .env
```

Lalu buka `.env` dengan editor teks dan isi minimal ini:

```ini
# Database — biarkan default kalau pakai Docker
DATABASE_URL_PRISMA=file:./data/bot.db

# Bot Telegram
BOT_TOKEN=123456789:AAE...        # dari @BotFather (langkah 1.2.a)
ADMIN_IDS=12345678                # ID Telegram-mu (langkah 1.2.b); pisahkan dgn koma kalau >1 admin

# Panel admin
WEB_COOKIE_SECRET=hasil_openssl_rand_hex_32_tadi   # langkah 1.2.c

# Tampilan
TIMEZONE=Asia/Jakarta
DEFAULT_LANGUAGE=id
CURRENCY=USDT
```

> 💡 **Token bot juga bisa diganti nanti dari panel admin** (Settings → Bot),
> tanpa mengedit `.env`. Nilai di panel akan menang atas `.env`. `.env` cukup
> untuk pertama kali (bootstrap).

Pengaturan pembayaran (Binance/Bybit/TokoPay) **tidak wajib** sekarang — bisa
diisi belakangan lewat panel admin (lihat [bagian 7](#7-mengatur-pembayaran)).
Daftar lengkap semua variabel ada di [bagian 10](#10-referensi-lengkap-variabel-env).

---

## 3. Jalur A — VPS dengan Docker (disarankan)

Ini cara paling mudah dan stabil. Docker mengurus Node, dependensi, dan database
otomatis. Kamu hanya perlu VPS dengan **Docker** dan **Docker Compose** terpasang.

### Langkah 1 — Install Docker (sekali saja)

Di VPS Ubuntu/Debian:

```bash
curl -fsSL https://get.docker.com | sh
```

Cek: `docker --version` dan `docker compose version` harus muncul.

### Langkah 2 — Ambil kode & masuk foldernya

```bash
git clone <url-repo-kamu> telegram-order-bot
cd telegram-order-bot
```

### Langkah 3 — Buat file `.env`

Ikuti [bagian 2](#2-mengisi-file-env) di atas. Untuk Docker, pakai path relatif:

```ini
DATABASE_URL_PRISMA=file:./data/bot.db
```

### Langkah 4 — Bangun image

```bash
docker compose build
```

(Perlu beberapa menit pertama kali — wajar.)

### Langkah 5 — Siapkan database

```bash
docker compose run --rm order-bot pnpm exec prisma db push
```

Ini membuat file database `data/bot.db` dengan struktur tabel yang benar.

### Langkah 6 — Nyalakan layanan (urutan ini penting)

```bash
docker compose up -d notifier      # 1. pengirim notifikasi
docker compose up -d web-admin     # 2. panel admin (port 8000)
docker compose up -d order-bot     # 3. bot Telegram (terakhir)
```

### Langkah 7 — Cek jalan atau tidak

```bash
docker compose ps                  # semua harus "running"/"healthy"
docker compose logs -f order-bot   # lihat log bot (Ctrl+C untuk keluar)
```

- Panel admin: buka `http://IP-VPS-KAMU:8000/login` di browser.
- Bot: chat botmu di Telegram, ketik `/start` → harus membalas.

✅ Selesai. Lanjut ke [Buat Admin Pertama](#6-buat-admin-pertama).

> 🔒 **Penting untuk keamanan:** panel admin di atas terbuka di port 8000 lewat
> HTTP biasa. Untuk produksi, taruh di belakang **reverse proxy + HTTPS**
> (mis. Nginx/Caddy + domain), lalu set `WEB_COOKIE_SECURE=true` di `.env`.
> Jangan biarkan panel admin telanjang di internet tanpa HTTPS.

### Perintah Docker yang sering dipakai

```bash
docker compose logs -f order-bot   # lihat log
docker compose restart order-bot   # restart bot (mis. setelah ganti token di panel)
docker compose down                # matikan semua
docker compose up -d               # nyalakan semua lagi
```

---

## 4. Jalur B — VPS tanpa Docker (langsung Node.js)

Kalau tidak mau pakai Docker. Butuh **Node.js ≥ 20** dan **pnpm 9** di VPS.

### Langkah 1 — Install Node & pnpm

```bash
# Install Node 20 (contoh via nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20
npm install -g pnpm@9
```

### Langkah 2 — Ambil kode & dependensi

```bash
git clone <url-repo-kamu> telegram-order-bot
cd telegram-order-bot
pnpm install
```

### Langkah 3 — Buat `.env`, siapkan database

```bash
cp .env.example .env
nano .env                       # isi sesuai bagian 2
pnpm prisma:generate            # siapkan Prisma client
pnpm exec prisma db push        # buat tabel database
```

### Langkah 4 — Jalankan (mode gabungan, satu proses)

```bash
pnpm start                      # bot + panel admin + toko + notifier sekaligus
```

- Panel admin: `http://IP-VPS-KAMU:8000/login`
- Toko (opsional): `http://IP-VPS-KAMU:8100`

### Langkah 5 — Supaya tetap hidup setelah SSH ditutup

`pnpm start` berhenti begitu kamu logout. Pakai **PM2** agar berjalan terus dan
auto-restart kalau crash atau VPS reboot:

```bash
npm install -g pm2
pm2 start "pnpm start" --name bot-order
pm2 save
pm2 startup                     # ikuti perintah yang ditampilkan agar auto-start saat boot
```

Perintah PM2 berguna: `pm2 logs bot-order`, `pm2 restart bot-order`,
`pm2 stop bot-order`.

> Catatan keamanan yang sama berlaku: pasang HTTPS (reverse proxy) untuk panel
> admin sebelum dibuka ke publik.

---

## 5. Jalur C — Hostinger Node.js App Manager (hosting biasa)

Kalau kamu **tidak** punya VPS, tapi punya hosting Hostinger dengan fitur
**"Setup Node.js App"** (berbasis Passenger). Jalur ini sedikit lebih rumit
karena kode harus di-*bundle* jadi satu file dulu.

**Panduan lengkap langkah-demi-langkah ada di [`DOCS.md` → Bagian 4 (Deploy Hostinger)](DOCS.md#bagian-4--deploy-ke-hostinger-node-app-manager).**
Ringkasannya:

1. **Di komputermu**, bangun bundle satu file:
   ```bash
   pnpm install
   pnpm run build:bundle          # menghasilkan dist/server.cjs
   ```
2. **Upload** ke folder aplikasi Hostinger (via File Manager atau SFTP):
   `dist/server.cjs`, `package.prod.json` (rename jadi `package.json`),
   `prisma/schema.prisma`, folder `views/ locales/ static/`, dan
   `data/bot.db` (database — buat dulu di lokal dengan `pnpm exec prisma db push`).
3. **Di panel Node App Hostinger**: set *startup file* = `dist/server.cjs`,
   pilih Node 20/22, klik **Run NPM Install**, isi Environment Variables
   (lihat bagian 7 di `DOCS.md` Bagian 4), lalu **Restart**.
4. **Wajib:** pasang **UptimeRobot** yang nge-ping URL webmu tiap 1–5 menit.
   Tanpa ini, Hostinger menidurkan aplikasi saat sepi dan **bot ikut mati**.

> Karena keterbatasan idle-shutdown ini, **VPS (Jalur A) lebih disarankan** kalau
> botmu harus selalu responsif. Detail trade-off ada di `DOCS.md` Bagian 4 §0 & §10.

---

## 6. Buat Admin Pertama

Setelah aplikasi jalan dan panel admin bisa dibuka:

1. Buka panel admin di browser: `http://SERVER-KAMU:8000/`
2. Karena ini instalasi baru, kamu otomatis diarahkan ke **wizard setup**.
   Ikuti **3 langkah** singkat:
   - **Bot token** dari @BotFather (boleh pilih **"Atur nanti"**).
   - **ID Telegram**-mu (dari @userinfobot) + **password** login.
   - **Nama toko** (opsional, boleh dilewati).
3. Selesai — kamu **otomatis login**. Kalau token bot diisi, klik tombol
   **"Nyalakan bot sekarang"** untuk menyalakan bot.

> Deploy lama? Cara manual **`/bootstrap`** (set password untuk ID di `ADMIN_IDS`)
> masih ada — lihat `DOCS.md` Bagian 5.

> Lupa password nanti? Jalankan perintah pemulihan di server:
> ```bash
> # Docker:
> docker compose run --rm order-bot pnpm reset-admin-password <ID-telegram-mu>
> # Non-Docker:
> pnpm reset-admin-password <ID-telegram-mu>
> ```
> Lalu buka `/bootstrap` lagi untuk set password baru.

---

## 7. Mengatur Pembayaran

Semua pembayaran bisa diatur dari **panel admin → Settings → Payments**
(tidak perlu edit `.env` dan tidak perlu restart untuk sebagian besar).

| Metode | Cara konfirmasi | Yang perlu diisi |
|---|---|---|
| **Binance Pay** | Manual (pembeli upload bukti, kamu setujui) | `Binance Pay ID` + QR |
| **Binance Internal Transfer** | **Otomatis** (transfer antar-UID, dicek bot) | UID + API key/secret read-only (di `.env`) |
| **Bybit USDT-BSC** | **Otomatis** (deposit on-chain BEP20, dicek bot) | Alamat deposit + API key/secret (di panel atau `.env`) |
| **TokoPay (QRIS)** | **Otomatis** (webhook) — untuk pembayaran Rupiah di website | Merchant ID + Secret (di panel) |

**Untuk Bybit** (auto-confirm USDT di jaringan BSC):
- Buat API key Bybit yang **Wallet READ-ONLY** (tanpa izin Withdraw).
- Cek dulu koneksi API: `pnpm bybit-probe` (atau lihat `scripts/bybit-probe.ts`).
- Isi **alamat deposit BEP20**, **API key**, **API secret** di
  panel → Settings → Payments. Berlaku dalam beberapa detik, tanpa restart.
- Penting: cocok-pembayaran Bybit pakai **nominal unik**, jadi pastikan
  `USE_UNIQUE_CENTS=1` tetap aktif, dan pembeli mengirim **jumlah persis**.

Detail teknis tiap metode ada di [bagian 10](#10-referensi-lengkap-variabel-env).

> 🎨 **Personalisasi tampilan toko** — dari **panel admin → Settings → Branding**
> kamu bisa **upload favicon** (ikon tab, PNG/ICO/SVG), **logo toko** (tampil di
> header website, PNG/SVG/WebP), **gambar hero** halaman depan website, dan
> **banner bot** (muncul di atas menu utama & daftar produk), plus mengubah **nama
> toko, tagline, dan pesan sambutan**. Semua langsung berlaku tanpa restart.
> Ukuran yang disarankan: favicon 512×512, logo tinggi ~64px (mis. 240×64), hero
> 1600×900, banner 1280×720.

---

## 8. Update, Backup, dan Perawatan

### Update ke versi baru

```bash
git pull                                  # ambil kode terbaru

# Docker:
docker compose build
docker compose run --rm order-bot pnpm exec prisma db push   # kalau ada perubahan database
docker compose up -d

# Non-Docker:
pnpm install
pnpm prisma:generate
pnpm exec prisma db push
pm2 restart bot-order
```

> ⚠️ **Aturan penting:** kalau ada perubahan struktur database, jalankan
> `prisma db push` **dulu**, baru jalankan kode baru. Kalau terbalik, akan
> muncul error `P2022: column does not exist`.

### Backup database (lakukan rutin!)

Seluruh data ada di satu file. Salin berkala:

```bash
cp data/bot.db data/bot.db.bak-$(date +%Y%m%d)
```

Simpan salinannya di tempat aman (download ke komputer / cloud).

### Mengelola stok (panel admin → Stock)

Buka **panel admin → Stock → pilih produk** untuk mengurus akun/kredensial:

- **Tambah stok** — tempel kredensial, satu baris per akun (`email:password`).
- **Lihat stok** — tabel semua item beserta statusnya (siap jual / terpakai /
  terjual / rusak).
- **Unduh stok tersisa** — tombol **"Download remaining"** mengunduh file `.txt`
  berisi semua akun **yang masih siap dijual** (satu per baris, sama seperti
  format upload). Berguna untuk cadangan atau pindah stok.
- **Hapus terpilih** — centang beberapa item lalu **"Delete selected"** untuk
  **menghapus permanen**. Item yang **sudah terjual otomatis dilindungi** (tidak
  ikut terhapus) agar riwayat pesanan tetap utuh. Kalau hanya ingin menandai akun
  rusak tanpa menghapus, pakai **"Mark as bad"**.

> 🔒 File unduhan berisi kredensial asli — simpan dengan aman dan jangan
> dibagikan. Hanya admin yang sudah login bisa mengunduhnya.

---

## 9. Masalah Umum & Solusi

| Gejala | Penyebab | Solusi |
|---|---|---|
| `P2022: column does not exist` | Struktur database belum diperbarui | `prisma db push` lalu restart |
| Bot tidak membalas `/start` | Token salah, atau proses mati | Cek `BOT_TOKEN`; cek `docker compose logs order-bot` / `pm2 logs` |
| Bot di Hostinger kadang mati | App di-idle-kan Passenger saat sepi | Pasang UptimeRobot ping URL web tiap 1–5 menit |
| Tidak bisa login / muncul loop login | Cookie tidak tersimpan | Untuk HTTP lokal set `WEB_COOKIE_SECURE=false`; untuk produksi pakai HTTPS + `WEB_COOKIE_SECURE=true` |
| Pembayaran Bybit tidak otomatis | Nominal dibulatkan / jaringan salah | Pembeli harus kirim **jumlah persis** via **BEP20**; pastikan `USE_UNIQUE_CENTS=1` |
| `Cannot find module '@app/core'` (Hostinger) | Upload source mentah, bukan bundle | Pakai `pnpm run build:bundle`, upload `dist/server.cjs` |
| Panel admin tak bisa diakses dari luar | Bind ke `127.0.0.1` | Di Docker sudah `0.0.0.0`; non-Docker set `WEB_HOST=0.0.0.0` (di balik HTTPS) |

Masih bingung? Lihat log dulu — hampir semua masalah kelihatan di sana:
`docker compose logs -f order-bot` (Docker) atau `pm2 logs bot-order` (PM2).

---

## 10. Referensi Lengkap Variabel `.env`

Semua variabel divalidasi saat start oleh Zod (`packages/core/src/config.ts`).
Yang **wajib** ditandai ✅.

### Inti / Bersama

| Variabel | Keterangan | Wajib | Default |
|---|---|---|---|
| `DATABASE_URL_PRISMA` | Path file SQLite. Di container/Hostinger pakai path absolut, mis. `file:/app/data/bot.db` | ✅ | `file:../data/bot.db` |
| `ADMIN_IDS` | ID Telegram admin, dipisah koma | ✅ | — |
| `TIMEZONE` | Zona waktu tampilan (mis. `Asia/Jakarta`) | ✅ | — |
| `DEFAULT_LANGUAGE` | Bahasa default user baru (`en`/`id`) | | `en` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | | `info` |

### Bot Telegram

| Variabel | Keterangan | Wajib |
|---|---|---|
| `BOT_TOKEN` | Token dari @BotFather. Bisa juga diatur di panel admin (DB menang atas env) | ✅ |
| `BOT_USERNAME` | Username bot tanpa `@`. Terisi otomatis via `getMe()` bila kosong | |
| `SUPPORT_GROUP_ID` | ID grup tujuan tiket support (negatif untuk grup) | |
| `RATE_LIMIT_MAX` | Maks pesan per user per jendela waktu | (5) |
| `LOW_STOCK_THRESHOLD` | Peringatan stok bila ≤ angka ini | (3) |
| `REFERRAL_COMMISSION_PERCENT` | Komisi referral pembelian pertama (mis. `10`) | (10) |

### Panel Admin (Web)

| Variabel | Keterangan | Wajib | Default |
|---|---|---|---|
| `WEB_COOKIE_SECRET` | Kunci HMAC cookie sesi (≥ 32 karakter) | ✅ | — |
| `WEB_HOST` | Alamat bind. `0.0.0.0` di balik reverse proxy | | `127.0.0.1` |
| `WEB_PORT` | Port panel admin | | `8000` |
| `WEB_SESSION_TTL_HOURS` | Masa berlaku sesi (jam) | | `12` |
| `WEB_COOKIE_SECURE` | `true` di produksi (di balik HTTPS) | | `false` |

### Toko / Storefront (opsional)

| Variabel | Keterangan | Default |
|---|---|---|
| `STOREFRONT_PORT` | Port website toko | `8100` |
| `SHOP_PUBLIC_URL` | URL publik toko (mis. `https://shop.domain.com`). Bila diisi, satu listener memisah per `Host` | — |

### Pembayaran — Binance Pay (bukti manual)

| Variabel | Keterangan | Default |
|---|---|---|
| `BINANCE_PAY_ID` | Binance Pay ID yang ditampilkan ke pembeli (wajib jika dipakai) | — |
| `CURRENCY` | Label mata uang (mis. `USDT`) | `USDT` |
| `PAYMENT_WINDOW_MINUTES` | Menit sebelum order bukti-manual auto-batal | `30` |
| `USE_UNIQUE_CENTS` | Tambah sen unik untuk pencocokan otomatis (`1` = aktif) | `1` |

### Pembayaran — Binance Internal Transfer (otomatis)

| Variabel | Keterangan | Default |
|---|---|---|
| `BINANCE_RECEIVE_UID` | UID Binance penerima. Kosongkan untuk menonaktifkan | — |
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | API **read-only** untuk membaca riwayat transfer | — |
| `INTERNAL_PAYMENT_WINDOW_MINUTES` | Menit sebelum order auto-confirm kedaluwarsa | `15` |

### Pembayaran — Bybit USDT-BSC (otomatis, on-chain BEP20)

BEP20 tidak punya memo, jadi deposit dicocokkan ke order lewat **nominal unik**
(jaga `USE_UNIQUE_CENTS=1`). Bot mengantar hanya saat deposit sudah dikonfirmasi
Bybit (status 3, ~1–2 menit). Tiga field di bawah **bisa diatur di panel admin →
Settings → Payments** (panel menang atas `.env`, tanpa restart).

| Variabel | Keterangan | Default |
|---|---|---|
| `BYBIT_DEPOSIT_ADDRESS` | Alamat deposit USDT BEP20 di Bybit. Kosongkan untuk menonaktifkan | — |
| `BYBIT_API_KEY` / `BYBIT_API_SECRET` | API Bybit **Wallet READ-ONLY** (tanpa Withdraw) | — |
| `BYBIT_DEPOSIT_CHAIN` | ID jaringan deposit di Bybit | `BSC` |
| `BYBIT_API_BASE` | Base URL API Bybit | `https://api.bybit.com` |
| `BYBIT_PAYMENT_WINDOW_MINUTES` | Menit sebelum order deposit kedaluwarsa | `30` |

### Mode Webhook (opsional, untuk Hostinger)

| Variabel | Keterangan |
|---|---|
| `BOT_MODE` | `polling` (default) atau `webhook` |
| `PUBLIC_URL` | URL HTTPS publik (wajib di mode webhook) |
| `WEBHOOK_SECRET` | String acak panjang — dipakai sebagai path + header rahasia Telegram |

> Daftar variabel lebih lengkap (notifier, logging, dll.) ada di file
> **`.env.example`**.

---

## 11. Untuk Developer

### Menjalankan saat ngoding (proses terpisah)

```bash
pnpm dev:bot        # bot Telegram (mode watch)
pnpm dev:web        # panel admin → http://127.0.0.1:8000
pnpm dev:notifier   # pengirim notifikasi
# atau semua sekaligus dalam satu proses:
pnpm start
```

### Tes & pemeriksaan tipe

```bash
pnpm typecheck      # cek TypeScript semua paket
pnpm test           # jalankan seluruh tes (Vitest)
```

`pnpm typecheck` dan `pnpm test` harus selalu hijau sebelum commit.

### Struktur singkat

```
apps/
  order-bot/    Bot Telegram (grammY) — alur pelanggan + admin
  web-admin/    Panel admin (Fastify + Nunjucks + HTMX)
  storefront/   Website toko pelanggan
  notifier/     Pengirim notifikasi (menguras notification_outbox)
  server/       Entry gabungan satu proses (untuk Hostinger)
packages/
  core/         Util bersama (config, money, i18n, logging) + locale en/id
  db/           Prisma client + CRUD per-domain (+ tes Vitest)
  web-ui/       Template & aset bersama
prisma/schema.prisma   Skema database (SQLite, WAL)
data/bot.db            Database (di-gitignore)
```

### Dokumen lain

| File | Isi |
|---|---|
| `DOCS.md` | Dokumentasi gabungan: rencana & desain storefront, cutover IDR, deploy Hostinger |
| `CLAUDE.md` | Konvensi & aturan koding (Decimal untuk uang, audit, dll.) |
| `.env.example` | Daftar semua variabel lingkungan |

---

Butuh bantuan lebih detail untuk Hostinger? Buka **`DOCS.md` Bagian 4**.
Selamat berjualan! 🚀
