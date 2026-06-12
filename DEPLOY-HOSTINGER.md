# DEPLOY-HOSTINGER.md — Deploy ke Hostinger Node.js App Manager

Panduan menjalankan `telegram-order-bot` di **Hostinger Node.js App Manager**
(berbasis Passenger), bukan VPS. Ini jalur yang punya batasan, jadi baca bagian
**Konsep & Caveat** dulu sebelum eksekusi.

> Alternatif yang jauh lebih mulus tetap **Hostinger VPS** (`RUN.md`, Docker).
> Dokumen ini khusus untuk yang tetap mau pakai App Manager.

---

## 0. Konsep & Caveat (WAJIB paham dulu)

App Manager (Passenger) berbeda dari VPS. Empat hal yang membentuk seluruh strategi:

1. **Satu aplikasi = satu proses = satu startup file.**
   Project ini punya 3 service: `order-bot`, `web-admin`, `notifier`. Mereka akan
   digabung jadi **satu proses** (satu entry `apps/server`). Karena DB SQLite
   bersifat *single-writer* (lihat `CLAUDE.md`), satu proses justru paling aman.

2. **Install pakai `npm`, bukan `pnpm`.**
   Dependensi internal ditulis `"@app/core": "workspace:*"` — npm tidak paham itu.
   Solusi: kode di-*bundle* dengan esbuild jadi **satu file JS** (`dist/server.cjs`)
   sehingga paket `@app/*` ikut ter-*inline*; npm cukup meng-install dependensi
   eksternal lewat `package.prod.json` yang rata (tanpa workspace).

3. **Runtime = `node`, bukan `tsx`.**
   Passenger menjalankan startup file dengan `node` biasa. Output esbuild adalah
   JS murni, jadi tidak butuh `tsx` saat runtime.

4. **Passenger meng-*idle* aplikasi saat tidak ada traffic HTTP.**
   Web-admin aman (ada request). Tapi **bot Telegram & notifier butuh nyala 24/7**.
   Jika Passenger menidurkan proses, bot ikut mati sampai ada yang membuka web.
   **Mitigasi wajib:** pasang **UptimeRobot** (atau cron-job.org) yang nge-ping
   URL web tiap 1–5 menit agar proses tidak pernah idle. Tanpa ini, bot tidak
   reliabel di App Manager. (Di VPS, masalah ini tidak ada.)

   > **Dua mode transport bot** (env `BOT_MODE`):
   > - `polling` (default) — long polling grammY; **tidak** butuh domain/HTTPS
   >   untuk bot. Paling simpel, tapi sepenuhnya bergantung pada UptimeRobot agar
   >   proses tidak idle.
   > - `webhook` — bot di-*mount* sebagai route `POST /tg/<secret>` di Fastify
   >   yang sama. Telegram nge-POST tiap ada pesan, jadi traffic masuk **ikut
   >   membangunkan** Passenger (mengurangi idle untuk bot). Butuh `PUBLIC_URL`
   >   (domain HTTPS app) + `WEBHOOK_SECRET`. **Tetap** pasang UptimeRobot karena
   >   poller Binance & job croner butuh nyala walau tak ada pesan masuk.

---

## 1. Cek dulu kemampuan paketmu di hPanel

Sebelum mulai, pastikan tiga hal di **hPanel**:

1. **Apakah ada Node.js App Manager?**
   hPanel → cari menu **"Node.js"** / **"Setup Node.js App"**. Kalau tidak ada,
   paketmu (mis. Single/Premium shared lama) belum tentu mendukung Node — perlu
   upgrade ke Business/Cloud, atau pindah ke VPS.

2. **Apakah ada SSH / Terminal?**
   hPanel → **Advanced → SSH Access**. Kalau tombol/akun SSH bisa diaktifkan,
   berarti **punya SSH** → ikuti **Jalur A** (paling fleksibel).
   Kalau hanya ada UI Node App (tombol *Run NPM install*, *Restart*, dropdown
   startup file) tanpa SSH → ikuti **Jalur B**.

3. **Versi Node** yang tersedia ≥ 20 (project butuh Node ≥ 20 — `package.json`
   `engines.node`). Pilih Node 20/22 di dropdown App Manager.

---

## 2. Perubahan kode (SUDAH diterapkan ✅)

Semua perubahan di bawah sudah dibuat dan diverifikasi (`pnpm -r typecheck` &
`pnpm test` hijau, 218 tests pass; bundle ter-build & smoke-test OK).

| # | File baru/diubah | Tujuan | Status |
|---|---|---|---|
| 1 | **`apps/server/src/index.ts`** (baru) | Composition root gabungan: `initDb()` sekali (1 PrismaClient, WAL), reuse `buildApp()` web-admin, `buildBot()` (polling **atau** webhook via `BOT_MODE`), notifier/poller/croner in-process, `/healthz`, graceful shutdown. Export `buildServer()` murni untuk test. | ✅ |
| 2 | **`apps/server/package.json`** (baru) | Workspace baru `@app/server`. Build dipicu dari root: `pnpm run build:bundle`. | ✅ |
| 3 | **`scripts/build-bundle.ts`** (baru) | Jalankan esbuild: `platform=node`, `format=cjs`, bundling `@app/*` + source, **eksternal** untuk paket yang tak boleh di-bundle (`@prisma/client`, `.prisma/client`, `pino`, `pino-roll`, `thread-stream`, `nunjucks`). Shim `import.meta.url` + `define` `APP_BUNDLED=1` (agar entry order-bot tak auto-start dobel). Output → `dist/server.cjs`. | ✅ |
| 4 | **`package.prod.json`** (baru) | `package.json` rata berisi **hanya** dependensi runtime eksternal + `prisma` (untuk `prisma generate`) + `"postinstall": "prisma generate"` + `engines.node>=20`. Inilah yang di-upload & di-`npm install` di server. | ✅ |
| 5 | **`prisma/schema.prisma`** | **Tidak perlu di-patch.** `postinstall: prisma generate` jalan di host Linux Hostinger → `native` otomatis menghasilkan engine Linux yang benar. Hardcode `binaryTargets` Linux justru memaksa tiap mesin dev/CI mengunduh engine ekstra. | — |
| 6 | **`server.ts` + `views.ts` + `i18n.ts`** (patch) | (a) Combined entry listen `host=0.0.0.0` (override `WEB_HOST`), `port=process.env.PORT ?? WEB_PORT`. (b) `VIEWS_DIR`/`LOCALES_DIR`/`STATIC_DIR` bisa di-override via env (lihat caveat §3) agar tidak `ENOENT` setelah bundling. | ✅ |
| 7 | **`.gitignore`** | Abaikan `dist/`. | ✅ (sudah ada) |

> Selain itu: `apps/{order-bot,web-admin,notifier}/package.json` dapat
> `exports` map (subpath) agar entry gabungan bisa meng-import building block-nya
> (`buildBot`, `buildApp`, `runDispatcher`, dst.); `esbuild` ditambah ke
> devDependencies root; script `build:bundle` ditambah ke root `package.json`.
>
> Tidak ada perubahan skema DB. Aturan main `CLAUDE.md` tetap berlaku (Decimal,
> audit, no-Telegram-from-web, dll).

---

## 3. Yang di-upload ke server

Setelah `npm run build:bundle` menghasilkan `dist/server.cjs`, yang perlu naik ke
folder aplikasi Hostinger hanyalah **artefak runtime**, bukan source TS:

```
dist/server.cjs                 # hasil bundle (startup file)
package.prod.json  → package.json   (rename saat upload)
prisma/schema.prisma            # dibutuhkan `prisma generate`
prisma/migrations/              # (opsional, untuk apply migrasi)
data/bot.db (+ -wal, -shm)      # database SQLite (lihat §6; konversi IDR dulu — CUTOVER-IDR.md)
views/admin/   (file .njk admin)        # template web-admin — DIBACA dari disk
views/shop/    (file .njk storefront)   # template storefront (apps/storefront/views)
views/shared/  (_theme.njk,_macros.njk) # tema bersama (packages/web-ui/views)
locales/       (en.json,id.json)# string i18n — DIBACA dari disk saat runtime
static/        (app.css admin)  # aset statis web admin (/static/*)
static-shop/   (app.css shop)   # aset statis storefront (apps/storefront/static)
.env                            # ATAU set via UI App Manager (lebih aman)
```

> Storefront ikut dalam bundle yang sama (satu proses — plan.md §2 F). Path
> template/staticnya juga bisa di-override: `STOREFRONT_VIEWS_DIR`,
> `STOREFRONT_STATIC_DIR`, dan `SHARED_VIEWS_DIR` (tema bersama web-ui).
> Susunan folder di atas hanya saran — yang penting env menunjuk ke folder
> yang benar.

> ⚠️ **Penting — resolusi path setelah bundling.** Kode meresolusi folder ini
> secara **relatif terhadap lokasi file sumbernya** via `import.meta.url`:
> - Nunjucks: `VIEWS_DIR = <src>/../../views` ([views.ts:16-17](apps/web-admin/src/plugins/views.ts#L16-L17))
> - Locales: `LOCALES_DIR = <src>/../locales` ([i18n.ts:13-15](packages/core/src/i18n.ts#L13-L15))
> - Static: `STATIC_DIR = <src>/../static` ([server.ts:36](apps/web-admin/src/server.ts#L36))
>
> Begitu kode di-*bundle* ke `dist/server.cjs`, `import.meta.url` menunjuk ke
> `dist/`, sehingga path `../..` itu **meleset** → `ENOENT`. Karena itu salah satu
> tugas implementasi (§2 #6) adalah membuat ketiga path ini bisa di-*override*
> lewat env (`VIEWS_DIR`, `LOCALES_DIR`, `STATIC_DIR`) atau diresolusi dari satu
> root yang dapat dikonfigurasi (default `process.cwd()`). Lalu di server cukup
> taruh `views/ locales/ static/` di root aplikasi dan arahkan env-nya ke situ.
>
> Pengecualian lain: jika pakai QR pembayaran, file `BINANCE_QR_PATH` juga berkas
> di disk → upload file itu, set env-nya ke path absolut.

---

## 4. Jalur A — Punya SSH (disarankan)

1. **Lokal:** build bundle, lalu commit/siapkan artefak.
   ```bash
   pnpm install
   pnpm run build:bundle        # menghasilkan dist/server.cjs
   ```
2. **Upload** isi §3 ke folder aplikasi (mis. `~/nodeapp/`) via SFTP/Git.
   Rename `package.prod.json` → `package.json`.
3. **SSH ke server**, masuk virtualenv Node-nya (App Manager biasanya kasih
   perintah `source ~/nodevenv/.../activate`), lalu:
   ```bash
   cd ~/nodeapp
   npm install --omit=dev        # memicu postinstall → prisma generate
   npx prisma generate           # jika postinstall tidak jalan
   ```
4. (Jika DB baru) buat skema:
   ```bash
   npx prisma db push
   ```
   (Jika bawa DB lama dari stack lain, lihat catatan datetime di `RUN.md §1`.)
5. **Set startup file** = `dist/server.cjs` di UI Node App, isi **Environment
   Variables** (§7), lalu **Restart**.
6. Pasang **UptimeRobot** ke URL web (§0 caveat #4).

---

## 5. Jalur B — Hanya panel App Manager (tanpa SSH)

Semua langkah yang butuh terminal dialihkan ke mekanisme panel:

1. **Lokal:** `pnpm run build:bundle`.
2. **Upload** isi §3 lewat **File Manager** hPanel ke folder aplikasi.
   Rename `package.prod.json` → `package.json`.
3. Di UI Node App:
   - **Application root** = folder tadi.
   - **Application startup file** = `dist/server.cjs`.
   - **Node version** = 20/22.
   - Klik **Run NPM Install** → ini menjalankan `npm install` **dan** `postinstall`
     (`prisma generate`) otomatis. Inilah kenapa `prisma generate` ditaruh di
     `postinstall`: supaya jalan tanpa terminal.
4. **DB:** karena tanpa terminal, `prisma db push` tidak bisa dijalankan langsung.
   Dua opsi:
   - **(a)** Buat DB di lokal dengan `pnpm exec prisma db push`, lalu **upload
     file `data/bot.db`** ke server (cara paling gampang untuk App Manager).
   - **(b)** Tambah skrip sekali-jalan `db:push` di `package.json` dan picu lewat
     fitur **"Run JS script"/NPM script** kalau panel menyediakannya.
   → Rekomendasi App Manager: **opsi (a)**.
5. Isi **Environment Variables** (§7) di UI, **Restart**.
6. Pasang **UptimeRobot** ke URL web.

---

## 6. Database (SQLite) di App Manager

- **Lokasi:** taruh `bot.db` di dalam folder aplikasi, mis. `~/nodeapp/data/bot.db`,
  dan set `DATABASE_URL_PRISMA` ke **path absolut**:
  ```
  DATABASE_URL_PRISMA=file:/home/USER/nodeapp/data/bot.db
  ```
  (Path relatif `file:./data/bot.db` rawan ambigu — pakai absolut, sama seperti
  pesan di `RUN.md §0`.)
- **WAL & locking:** project pakai WAL. Di filesystem shared hosting, WAL umumnya
  OK selama hanya **satu proses** yang menulis (dan kita memang satu proses).
  Jangan menjalankan dua instance aplikasi terhadap file yang sama.
- **Backup:** unduh berkala `data/bot.db` (+`-wal`/`-shm`) via File Manager,
  sama semangatnya dengan `RUN.md §4`.

---

## 7. Environment Variables

Isi via **UI App Manager** (lebih aman daripada upload `.env`; jangan commit
rahasia). Kunci minimum (detail lengkap di `README.md` → Configuration):

**Wajib**
```
DATABASE_URL_PRISMA=file:/home/USER/nodeapp/data/bot.db
BOT_TOKEN=...        # bootstrap saja — setelah live, token dikelola di web-admin
BOT_USERNAME=...     # opsional — diisi otomatis via getMe / web-admin
ADMIN_IDS=12345678,9876543
WEB_COOKIE_SECRET=<min 32 karакter acak>
TIMEZONE=Asia/Jakarta
CURRENCY=USDT
DEFAULT_LANGUAGE=id
```

> **Token bot kini bisa dikelola di web-admin** (Settings → Bot & notifications,
> plan.md §16): nilai di DB **menang** atas env; env tinggal jalur bootstrap /
> pemulihan. Ganti token di web → divalidasi `getMe` dulu → **restart** app
> (sentuh `tmp/restart.txt` atau tombol Restart panel) agar berlaku.

**Storefront (toko pelanggan — satu proses yang sama)**
```
SHOP_PUBLIC_URL=https://shop.domainkamu.com   # set ⇒ satu listener, dipisah per Host
                                              # (host ini → toko; host lain → admin+webhook)
# tanpa SHOP_PUBLIC_URL: toko listen di port terpisah STOREFRONT_PORT (default 8100)
```
**Notifier (kalau dipakai)**
```
NOTIF_BOT_TOKEN=...               # atau isi notif_bot_token di web-admin Settings
PUBLIC_CHANNEL_ID=-100xxxxxxxxxx
```
**Pembayaran Binance (sesuai metode yang dipakai)**
```
BINANCE_PAY_ID=...
BINANCE_RECEIVE_UID=...
BINANCE_API_KEY=...        # hanya jika pakai auto-confirm internal transfer
BINANCE_API_SECRET=...
```
**Transport bot (pilih salah satu)**
```
# Opsi A — paling simpel, tanpa domain untuk bot:
BOT_MODE=polling

# Opsi B — webhook (bot jadi route di Fastify yang sama):
BOT_MODE=webhook
PUBLIC_URL=https://<domain-app-kamu>      # tanpa trailing slash
WEBHOOK_SECRET=<string acak panjang>       # dipakai sbg path /tg/<secret> + secret_token
```

**Web/port** — *jangan* set `WEB_PORT` manual; Passenger menyuntik `PORT` sendiri.
Server listen ke `process.env.PORT` (di mode webhook bind `0.0.0.0`).

> Jangan pernah men-*log* token/secret (aturan `CLAUDE.md`). Set lewat UI, bukan
> di file yang ter-commit.

---

## 8. Verifikasi setelah Restart

1. Buka `https://<domain-web>/login` → harus tampil 200 (halaman login).
2. Chat bot di Telegram `/start` → harus membalas. (Jika tidak, cek caveat idle §0
   #4 dan log aplikasi di panel.)
3. Coba satu alur: lihat katalog → Buy Now. Pastikan tidak ada error.
4. Cek **log** di UI App Manager (atau `~/nodeapp/logs` / stderr Passenger) untuk
   baris pino. Waspadai `P2022`/`P2023` (masalah DB) atau `ENOENT` (path views/
   locales salah).

---

## 9. Masalah umum & solusi cepat

| Gejala | Penyebab | Solusi |
|---|---|---|
| `Cannot find module '@app/core'` | bundle tidak meng-inline internal | pastikan build pakai `scripts/build-bundle.ts`, bukan upload source TS |
| `PrismaClientInitializationError` / engine mismatch | client di-generate di OS lain (mis. di-upload dari Windows) | jalankan `prisma generate` **di host** (lewat `npm install`/postinstall), jangan upload `node_modules`. Kalau terpaksa generate lokal, tambah `binaryTargets` Linux yang sesuai lalu generate ulang |
| `P2023` saat query | DB lama dari stack Python belum dikonversi datetime | lihat `RUN.md §1` (konversi datetime) |
| Web 503 / app gagal start | startup file salah / Node < 20 | set startup `dist/server.cjs`, Node 20/22, cek log |
| Bot kadang mati lalu hidup saat web dibuka | Passenger idle (caveat §0 #4) | pasang UptimeRobot ping web tiap 1–5 menit |
| `ENOENT .../views/*.njk` atau `locales/*.json` | resolusi path meleset setelah bundling | upload `views/ locales/ static/`, set env `VIEWS_DIR/LOCALES_DIR/STATIC_DIR` (§2 #6, §3) |
| `ENOENT` QR/file pembayaran | `BINANCE_QR_PATH` menunjuk path yang tak ada di server | upload file QR, set env ke path absolut |

---

## 10. Kapan sebaiknya pindah ke VPS

App Manager bisa, tapi titik lemahnya: idle-shutdown (butuh ping), tidak ada
proses worker sejati, dan tuning terbatas. Pertimbangkan **Hostinger VPS** bila:
- bot sering dilaporkan "telat/mati", atau
- butuh ≥2 penulis DB / pindah ke Postgres (`RUN.md §9`), atau
- mau deploy apa adanya via Docker (`RUN.md`) tanpa bundling.

---

## Status

- [x] Panduan ditulis (dokumen ini).
- [x] Implementasi kode §2 (#1–#7) — **selesai** (typecheck & test hijau).
- [x] Build bundle & uji lokal — `pnpm run build:bundle` → `dist/server.cjs`
      (3.5mb), smoke-test `node dist/server.cjs` load bersih (semua `@app/*`
      ter-inline, eksternal tetap `require`, `import.meta.url` ter-shim).
- [ ] Deploy ke Hostinger + UptimeRobot — **langkah manual kamu** (Jalur A/B §4–5).
