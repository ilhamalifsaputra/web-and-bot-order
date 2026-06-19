# Order Bot — Bot Telegram + Panel Admin + Toko Web

Toko digital lengkap dalam satu aplikasi:

- **Bot Telegram** — katalog, pemesanan, dan pembayaran untuk pelanggan.
- **Panel admin web** — kelola produk, stok, pesanan, dan pengaturan.
- **Toko web** — etalase untuk berjualan lewat website/domain sendiri.

Pembayaran lewat **QRIS (TokoPay)**, **Binance Internal**, atau **Bybit
(USDT-BEP20)** — ketiganya **terkonfirmasi otomatis**, akun langsung terkirim
tanpa cek manual.

Dibangun dengan **Node.js + TypeScript** (monorepo pnpm). Bot, panel admin, toko
web, dan notifier berbagi **satu database SQLite** — tanpa server database
terpisah.

> 📌 Panduan ini ramah pemula: ikuti dari atas ke bawah. Alur cepat:
> **Sebelum Mulai → pilih satu Jalur Instalasi → Buat Admin Pertama**.

---

## Daftar Isi

1. [Sebelum Mulai](#1-sebelum-mulai)
2. [File `.env`](#2-file-env)
3. [Jalur A — Docker (disarankan)](#3-jalur-a--docker-disarankan)
4. [Jalur B — tanpa Docker](#4-jalur-b--tanpa-docker)
5. [Buat Admin Pertama](#5-buat-admin-pertama)
6. [Pembayaran & Branding](#6-pembayaran--branding)
7. [Update, Backup, Perawatan](#7-update-backup-perawatan)
8. [Masalah Umum](#8-masalah-umum)
9. [Untuk Developer](#9-untuk-developer)

---

## 1. Sebelum Mulai

**Yang perlu disiapkan:** VPS dengan akses SSH (mis. Hostinger, DigitalOcean).
Node.js ≥ 20 + pnpm 9 hanya untuk jalur non-Docker (`npm install -g pnpm@9`).

**Tiga hal wajib:**

- **Token bot** — [@BotFather](https://t.me/BotFather) → `/newbot` → ikuti
  langkahnya → dapat token `123456789:AAE...`.
- **ID Telegram-mu** — [@userinfobot](https://t.me/userinfobot) → `/start` → ia
  mengirim angka ID-mu, mis. `12345678`.
- **Kunci rahasia cookie** untuk login panel admin — string acak ≥ 32 karakter:
  ```bash
  openssl rand -hex 32
  ```
  Tanpa `openssl`, ketik sembarang 40+ huruf/angka acak.

---

## 2. File `.env`

`.env` menyimpan pengaturan rahasia — **jangan** dibagikan atau di-commit. Mulai
dari contoh, lalu isi minimal berikut:

```bash
cp .env.example .env
```

```ini
DATABASE_URL_PRISMA=file:./data/bot.db        # biarkan default kalau pakai Docker
BOT_TOKEN=123456789:AAE...                    # dari @BotFather (bisa diisi nanti)
ADMIN_IDS=12345678                            # ID Telegram-mu; pisah koma kalau >1
WEB_COOKIE_SECRET=hasil_openssl_rand_hex_32   # kunci login panel admin
TIMEZONE=Asia/Jakarta
DEFAULT_LANGUAGE=id
```

> 💡 **Token bot bisa diisi nanti** lewat wizard panel admin (DB menang atas
> `.env`). Jika diatur lewat panel, **hapus/comment** baris `BOT_TOKEN` —
> **jangan** dikosongkan jadi `BOT_TOKEN=` (gagal validasi).

Pengaturan pembayaran **tidak wajib** sekarang — bisa diisi belakangan dari panel
admin ([bagian 6](#6-pembayaran--branding)). Daftar lengkap variabel ada di
**`.env.example`** dan [`DOCS.md`](DOCS.md).

---

## 3. Jalur A — Docker (disarankan)

Cara paling mudah dan stabil: Docker mengurus Node, dependensi, dan database.

**1. Install Docker** (sekali saja, Ubuntu/Debian):

```bash
curl -fsSL https://get.docker.com | sh
```

**2. Ambil kode & buat `.env`** (ikuti [bagian 2](#2-file-env)):

```bash
git clone https://github.com/ilhamalifsaputra/web-and-bot-order.git
cd web-and-bot-order
cp .env.example .env   # lalu isi sesuai bagian 2
```

**3. Bangun image & siapkan database:**

```bash
docker compose build
docker compose run --rm order-bot pnpm exec prisma db push
```

**4. Nyalakan layanan** (urutan penting):

```bash
docker compose up -d notifier      # 1. pengirim notifikasi
docker compose up -d web-admin     # 2. panel admin (port 8000)
docker compose up -d order-bot     # 3. bot Telegram
docker compose up -d storefront    # 4. toko web (port 8100) — opsional
```

> 🛍️ **`storefront` opsional** — nyalakan hanya kalau berjualan lewat website.
> Atau nyalakan semua sekaligus: `docker compose up -d`.

**5. Cek:**

```bash
docker compose ps                  # semua "running"/"healthy"
docker compose logs -f order-bot   # log bot (Ctrl+C keluar)
```

- Panel admin: `http://IP-VPS-KAMU:8000/login`
- Toko web (jika dinyalakan): `http://IP-VPS-KAMU:8100/`
- Bot: chat botmu, ketik `/start` → harus membalas.

✅ Lanjut ke [Buat Admin Pertama](#5-buat-admin-pertama).

> 🔒 Untuk produksi, pasang **reverse proxy + HTTPS** (Nginx/Caddy + domain) lalu
> set `WEB_COOKIE_SECURE=true`. Toko web biasanya pakai domain sendiri via
> `SHOP_PUBLIC_URL`.

**Perintah harian:** `docker compose logs -f order-bot` (log) ·
`docker compose restart order-bot` (restart, mis. setelah ganti token) ·
`docker compose down` / `up -d` (matikan / nyalakan).

---

## 4. Jalur B — tanpa Docker

Butuh **Node.js ≥ 20** + **pnpm 9** di VPS.

```bash
# Install Node & pnpm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 20 && npm install -g pnpm@9

# Ambil kode & dependensi
git clone https://github.com/ilhamalifsaputra/web-and-bot-order.git
cd web-and-bot-order
pnpm install

# Buat .env & siapkan database
cp .env.example .env            # isi sesuai bagian 2
pnpm prisma:generate
pnpm exec prisma db push

# Jalankan (bot + panel admin + toko web + notifier dalam satu proses)
pnpm start
```

- Panel admin: `http://IP-VPS-KAMU:8000/login` · Toko web: `…:8100/`

> 🛍️ `pnpm start` menjalankan **satu proses** berisi bot + panel admin
> (`WEB_PORT`, 8000) + toko web (`STOREFRONT_PORT`, 8100) + notifier. Agar diakses
> dari luar VPS set `WEB_HOST=0.0.0.0` (default `127.0.0.1`; idealnya di balik
> HTTPS). Punya domain toko? Set `SHOP_PUBLIC_URL` + `SHOP_HOST`.

**Jaga tetap hidup dengan PM2** (`pnpm start` mati saat logout):

```bash
npm install -g pm2
pm2 start "pnpm start" --name bot-order
pm2 save && pm2 startup          # ikuti perintah yang ditampilkan
```

Berguna: `pm2 logs bot-order` · `pm2 restart bot-order` · `pm2 stop bot-order`.

---

## 5. Buat Admin Pertama

Setelah aplikasi jalan dan panel admin bisa dibuka:

1. Buka `http://SERVER-KAMU:8000/` di browser.
2. Instalasi baru otomatis diarahkan ke **wizard setup** — ikuti 3 langkah: **bot
   token** (boleh "Atur nanti") → **ID Telegram + password** login → **nama toko**
   (opsional).
3. Selesai → **otomatis login**. Jika token diisi, klik **"Nyalakan bot
   sekarang"**.

> Lupa password? Jalankan pemulihan di server, lalu buka `/bootstrap` untuk set
> password baru:
> ```bash
> docker compose run --rm order-bot pnpm reset-admin-password <ID-telegram>   # Docker
> pnpm reset-admin-password <ID-telegram>                                     # non-Docker
> ```

Detail alur setup & jalur manual `/bootstrap` ada di [`DOCS.md`](DOCS.md).

---

## 6. Pembayaran & Branding

Semua diatur dari **panel admin → Settings** — tanpa edit `.env`, tanpa restart
untuk sebagian besar. Pembeli memilih **QRIS** atau **USDT** (Binance / Bybit)
saat membeli, di bot maupun website. Ketiganya auto-confirm:

| Metode | Mata uang | Konfirmasi | Yang diisi |
|---|---|---|---|
| **QRIS (TokoPay)** | Rupiah | Otomatis (webhook) | Merchant ID + Secret |
| **Binance Internal** | USDT | Otomatis (transfer antar-UID) | UID + API key/secret read-only |
| **Bybit USDT-BEP20** | USDT | Otomatis (deposit on-chain BEP20) | Alamat deposit + API key/secret |

> **Binance Pay manual** (upload bukti, approve manual) hanya muncul sebagai
> *fallback* bila belum ada metode otomatis. **Bybit:** API key harus **Wallet
> READ-ONLY**; tes koneksi `pnpm bybit-probe`. BEP20 tanpa memo → pencocokan pakai
> **nominal unik**, jaga `USE_UNIQUE_CENTS=1` dan pembeli kirim **jumlah persis**.

**Branding** (Settings → Branding): upload favicon, logo, hero toko, banner bot,
plus ubah nama toko, tagline, sambutan — berlaku tanpa restart. Detail tiap metode
di [`DOCS.md`](DOCS.md).

---

## 7. Update, Backup, Perawatan

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
> kode baru — kalau terbalik muncul `P2022: column does not exist` (atau
> `P2021: table does not exist` bila tabelnya berganti nama).

> 🛠️ **Cek dulu `scripts/migrate-*.ts` sebelum `git pull` dieksekusi ulang ke
> produksi.** Beberapa rilis menyertakan migrasi data **sekali-jalan** (bukan
> `prisma db push` biasa) — mis. `migrate-catalog-rename` (Category → Product →
> Denomination). Skrip ini **tidak idempotent**: matikan semua service dulu,
> backup `data/bot.db` (+ `-wal`/`-shm`), baru jalankan `pnpm <nama-skrip>`
> sesuai komentar di kepala filenya, lalu `pnpm prisma generate` sebelum start
> ulang. Lewati langkah ini kalau skrip yang sama sudah pernah dijalankan di DB
> ini.

**Backup database** (rutin — semua data di satu file SQLite):

> ⚠️ Database memakai mode **WAL**, jadi transaksi terbaru bisa masih ada di
> `bot.db-wal` yang belum di-checkpoint. **Jangan `cp data/bot.db`** saat layanan
> jalan — bisa kehilangan data. Pakai online backup `sqlite3 .backup` yang
> mengambil snapshot konsisten (sudah disediakan skripnya):

```bash
deploy/backup/backup.sh        # .backup + integrity_check + gzip + retensi
# restore (rollback): stop writer → swap → integrity → restart → smoke /healthz
deploy/backup/restore.sh data/backups/bot-<stamp>.db
```

Detail (cron tiap 6 jam, RTO/RPO, off-box, uji restore): **`deploy/backup/README.md`**.

**Kelola stok** (panel admin → Stock → pilih produk): tambah stok (satu baris per
akun, `email:password`), lihat status item, download sisa stok `.txt`, hapus /
tandai rusak. Item terjual otomatis dilindungi dari penghapusan.

> 🔒 File unduhan berisi kredensial asli — hanya admin login yang bisa mengunduh.

**Reverse proxy, TLS & rilis publik:** app bind `127.0.0.1`; ekspos publik lewat
nginx + TLS (terminasi HTTPS, proxy ke app), lalu set `WEB_COOKIE_SECURE=true`.
Config nginx siap pakai + checklist deploy + **runbook 502** ada di
**`deploy/README.md`** dan **`deploy/nginx/telegram-shop.conf`**.

---

## 8. Masalah Umum

| Gejala | Solusi |
|---|---|
| `P2022: column does not exist` | `prisma db push` lalu restart |
| HTTP 500 / `readonly database` | `sudo chown -R 999:999 data` lalu `docker compose restart web-admin order-bot` |
| Bot crash: `String must contain at least 20 character(s)` | Hapus/comment baris `BOT_TOKEN=` di `.env` (jangan dikosongkan) |
| Bot tak membalas `/start` | Cek `BOT_TOKEN`; cek `docker compose logs order-bot` / `pm2 logs` |
| Tak bisa login / loop login | HTTP lokal: `WEB_COOKIE_SECURE=false`; produksi: HTTPS + `WEB_COOKIE_SECURE=true` |
| Pembayaran Bybit tak otomatis | Kirim **jumlah persis** via **BEP20**; pastikan `USE_UNIQUE_CENTS=1` |
| Panel tak bisa diakses dari luar | Non-Docker set `WEB_HOST=0.0.0.0` (di balik HTTPS); Docker sudah `0.0.0.0` |

Masih bingung? Lihat log: `docker compose logs -f order-bot` atau
`pm2 logs bot-order`.

---

## 9. Untuk Developer

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

**Dokumen lain:** [`DOCS.md`](DOCS.md) (arsitektur, fitur, env lengkap) ·
[`CLAUDE.md`](CLAUDE.md) (konvensi koding) · `.env.example` (semua variabel).

---

Selamat berjualan! 🚀
