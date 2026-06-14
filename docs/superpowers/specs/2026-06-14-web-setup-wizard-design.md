# Spec — Web Setup Wizard (onboarding pembeli, near-zero config)

> **Status:** keputusan **final** (§11 dikonfirmasi 2026-06-14) — siap dibuatkan
> plan implementasi. Belum dieksekusi.
> **Tanggal:** 2026-06-14
> **Konteks:** script dijual; tiap pembeli memasang sendiri di Hostinger Node App
> (Passenger, tanpa SSH) dengan **bot Telegram miliknya**. Lihat juga
> [`DOCS.md`](../../../DOCS.md) Bagian 4 (deploy) & Bagian 5 (env).

## 1. Masalah & tujuan

**Masalah.** Setup sekarang menuntut pembeli: edit `.env`, bikin secret 32-char,
cari Telegram ID sendiri, isi DB, lalu `/start` bot → `/bootstrap` → `/login`.
Banyak langkah teknis + satu jebakan tersembunyi (`/start` wajib sebelum login,
`BINANCE_PAY_ID` wajib agar boot). Tidak ramah untuk pembeli awam.

**Tujuan.** Setelah file ter-upload & app jalan, **seluruh konfigurasi aplikasi
dilakukan lewat wizard di browser** — tanpa menyentuh `.env`, tanpa `/start`
manual, tanpa bikin secret. Hasil akhir: bot tersambung + akun admin siap + bisa
masuk dashboard.

**Non-tujuan (di luar lingkup).**
- Bukan mengotomatiskan **deploy** (upload file, set startup file, Run NPM Install,
  UptimeRobot tetap manual — itu ranah hosting).
- Bukan multi-tenant satu-proses. Tetap **satu deploy = satu bot = satu toko**.
- Bukan mengganti login/auth yang sudah ada; wizard hanya **mengisi** state awal.

## 2. Ruang lingkup perubahan (ringkas)

1. **First-run detection + route `/setup`** (di web-admin) — gerbang yang
   mengalihkan semua request ke wizard selama belum di-setup.
2. **Admin berbasis DB** — `isAdmin` & fan-out admin membaca daftar admin
   **gabungan env ∪ DB**, sehingga owner bisa dibuat dari wizard tanpa edit
   `ADMIN_IDS` di env.
3. **Auto-generate `WEB_COOKIE_SECRET`** bila kosong (disimpan & dipakai ulang).
4. **`BINANCE_PAY_ID` jadi opsional** agar boot tidak gagal pada konfigurasi minimal.
5. **View wizard** (3 langkah) + penyelesaian (auto-login + kunci wizard).

Item 2–4 adalah **prasyarat** wizard dan masing-masing berguna sendiri; bisa
dikerjakan lebih dulu sebagai langkah kecil (lihat §9 urutan).

## 3. Deteksi "belum di-setup" (setup mode)

Sumber kebenaran: Setting `setup_completed`.

```
setupNeeded() = getSetting("setup_completed") !== "true"
                && !anyAdminPasswordSet()
```

- `anyAdminPasswordSet()` sudah ada di `web-admin/src/routes/auth.ts` — dipakai
  agar **deploy lama yang sudah punya admin TIDAK pernah dipaksa** masuk wizard
  (kompatibilitas mundur).
- Saat wizard selesai → set `setup_completed = "true"` (sekaligus password admin
  pasti sudah ter-set).

**Penegakan (enforcement).**
- **web-admin**: PreHandler global — bila `setupNeeded()` true → redirect 303 ke
  `/setup`, kecuali path dikecualikan: `/setup*`, `/static*`, `/uploads*`,
  `/healthz`, `/favicon.ico`. Setelah selesai, `/setup*` redirect ke `/login`
  (wizard terkunci).
- **storefront** (app terpisah, bisa beda host/port — `/setup` tidak ada di sini):
  bila `setupNeeded()` true → tampilkan **halaman statis "Toko belum aktif —
  selesaikan setup di panel admin"** (200/503), **bukan** redirect ke route yang
  tak dilayani host toko.

## 4. Alur wizard (3 langkah, di web-admin)

Route group `/setup` (semua GET menampilkan view, POST memproses lalu lanjut).

### Langkah 1 — Sambungkan bot
- Form: **Bot token** (dari BotFather). Tombol bantu "cara dapat token".
- Submit → validasi `new Bot(token).api.getMe()`.
  - Gagal → tampilkan error ramah ("token salah / bot tidak ditemukan").
  - Sukses → simpan Setting `bot_token`, dan `bot_username` dari hasil `getMe`.
- **Boleh dilewati** ("Atur nanti") — app tetap jalan web-only; bot menyala
  setelah token diisi + restart.
- Catatan UI: jelaskan bahwa **bot baru aktif setelah langkah Selesai memicu
  restart** (grammY tak bisa hot-swap token — lihat §7).

### Langkah 2 — Buat akun owner (admin)
- Form: **Telegram ID** (wajib; tombol "cara cari ID?" → @userinfobot),
  **username** login, **password** (min 8) + konfirmasi.
- Submit (dalam satu `$transaction`):
  1. Validasi: Telegram ID numerik; password ≥ 8 & cocok; username valid.
  2. **Tambah Telegram ID ke daftar admin DB** (Setting `admin_ids`, CSV) +
     update cache runtime (§5) → langsung dianggap admin.
  3. `upsertUser(tx, { telegramId, username, fullName: null })` → membuat baris
     User; karena kini `isAdmin` true, role otomatis **ADMIN**.
  4. Simpan password admin: `setSetting(passwordHashKey(telegramId), hash)`.
- Telegram ID tetap diminta karena **bot mengenali admin via angka ID** (perlu
  agar menu admin di bot berfungsi). Ini satu-satunya nilai yang pembeli salin.

### Langkah 3 — Setelan dasar toko (opsional, ada default)
- Form ringkas: **nama toko** (`shop_name`), **timezone** (default
  `Asia/Jakarta`), **bahasa default** (`id`/`en`), **kurs USDT→IDR**
  (pakai API publik yang gratis).
- Semua punya default; tombol "Lewati" tersedia. (YAGNI: jangan tambah field lain
  di sini — pembayaran/SMTP diatur belakangan di Settings.)

### Selesai
- Set `setup_completed = "true"`.
- **Auto-login owner**: set cookie sesi (pola `makeSession` web-admin) untuk
  Telegram ID owner, rotasi jti.
- Bila token bot diisi di Langkah 1 → tawarkan **"Selesai & nyalakan bot"** yang
  memicu restart terkontrol (§7); jika dilewati → langsung ke dashboard.

## 5. Admin berbasis DB (perubahan inti)

Saat ini `isAdmin` (config.ts:185) hanya membaca `config.ADMIN_IDS` (env), dan
banyak tempat melakukan fan-out ke `config.ADMIN_IDS`. Agar owner bisa dibuat dari
wizard tanpa edit env, daftar admin harus **gabungan env ∪ DB** dan tersedia
secara **sinkron** (banyak pemakai sinkron).

**Desain** (mengikuti pola `runtime.ts` untuk token bot):
- Tambah state di `packages/core/src/runtime.ts`:
  - `setAdminIds(ids: number[])` — distempel saat boot (union env ∪ DB).
  - `addAdminId(id: number)` — penambahan live (dipakai wizard, satu proses).
  - `adminIds(): number[]` — kembalikan set ter-resolve bila distempel, else
    `config.ADMIN_IDS` (fallback = perilaku lama untuk test/standalone).
  - `isAdmin(id): boolean` — `adminIds().includes(Number(id))`.
- **Pindahkan `isAdmin` ke `runtime.ts`** dan ekspor dari sana. `config.isAdmin`
  tetap ada (delegasi/back-compat) **atau** semua import dialihkan ke
  `@app/core/runtime`. Hindari impor melingkar: `runtime` boleh impor `config`
  (untuk fallback), `config` **tidak** impor `runtime`.
- **Boot resolver** (`@app/db`, pola `resolveBotCredentials`):
  `resolveAdminIds(prisma)` = `union(config.ADMIN_IDS, parseCsv(getSetting("admin_ids")))`.
  Composition root (`apps/server/src/index.ts`) memanggilnya saat boot lalu
  `setAdminIds(...)` — sebelum bot/worker dijalankan.
- **Storage**: Setting `admin_ids` (CSV). Konsisten dengan komentar di config.ts
  ("Mirrors Settings.admin_ids"). Manajemen via `/admins` (lihat di bawah).

**Titik yang harus diubah** (hasil pemetaan grep):
- *Gerbang izin* `isAdmin(...)`: `config.ts` (definisi), `web-admin/routes/auth.ts`,
  `order-bot/middleware.ts`, `handlers/admin.ts`, `conversations/admin.ts`,
  `conversations/reject.ts`, `db/crud/users.ts` (promosi role saat upsert).
- *Fan-out ke semua admin* `config.ADMIN_IDS` → `adminIds()`:
  `order-bot/jobs/index.ts`, `conversations/checkout.ts`,
  `handlers/verification.ts`, `main.ts`, `payments/binanceInternal.ts`,
  `payments/bybitDeposit.ts`, fallback support di `conversations/{support,customer}.ts`
  & `handlers/callbacks.ts`.
- `web-admin/routes/admins.ts` & `reset-admin-password.ts`: iterasi/validasi
  `config.ADMIN_IDS` → `adminIds()` agar admin DB ikut terlihat & bisa dikelola.

**Catatan hot vs restart.** Karena satu proses (composition root) berbagi modul
`runtime`, `addAdminId` saat wizard **langsung** dilihat web **dan** bot yang
sedang jalan. Token bot tetap perlu restart (tak berubah).

## 6. Prasyarat env yang dilonggarkan

- **`WEB_COOKIE_SECRET`**: bila kosong, generate 32+ byte acak saat boot, simpan
  Setting `web_cookie_secret`, pakai ulang berikutnya. Tambah resolver +
  konsumsi di web-admin & storefront (yang kini baca `config.WEB_COOKIE_SECRET`).
  Tanpa ini, sesi tak bisa ditandatangani → wizard mustahil tanpa edit env.
- **`BINANCE_PAY_ID`**: ubah dari `z.string()` (wajib) → `z.string().default("")`
  (atau `.optional()`), supaya boot tidak gagal pada konfigurasi minimal. Pastikan
  pemakai `BINANCE_PAY_ID` menangani nilai kosong (sembunyikan opsi Binance Pay
  manual bila kosong, selaras pola `isBinanceInternalEnabled`).

## 7. Restart terkontrol (mengaktifkan bot)

grammY membangun `Bot` sekali saat boot; token baru perlu restart.
- Di Hostinger Passenger: restart = sentuh `tmp/restart.txt`.
- Wizard Langkah Selesai (bila token diisi) menampilkan tombol **"Nyalakan bot
  sekarang"** yang menulis `tmp/restart.txt` (best-effort; bila gagal, tampilkan
  instruksi manual tombol Restart di panel).
- Setelah restart, `resolveBotCredentials` + `resolveAdminIds` membaca DB → bot
  online dengan owner sebagai admin.

## 8. Keamanan & edge cases

- **Jendela setup terbuka**: selama `setupNeeded()`, `/setup` bisa diakses tanpa
  auth (sama sifatnya dengan `/bootstrap` sekarang). Mitigasi: default bind
  `127.0.0.1`; selesaikan setup segera setelah deploy; setelah selesai wizard
  terkunci permanen (`setup_completed`). *(Opsi tambahan, bila diinginkan nanti:
  `SETUP_TOKEN` env yang wajib dicocokkan — tapi itu mengembalikan edit env, jadi
  default-nya tidak dipakai.)*
- **getMe sebelum simpan token** — tolak token ngawur (cegah brick).
- **Jangan pernah log** token/password/hash (aturan CLAUDE.md).
- **Idempotensi**: jika owner re-submit Langkah 2, gunakan upsert (tak menduplikasi
  user); password terakhir menang.
- **Validasi**: Telegram ID integer; username sesuai `LOGIN_USERNAME_RE`;
  password ≥ 8.
- **Kompat mundur**: deploy lama (sudah ada admin / `ADMIN_IDS` env) →
  `setupNeeded()` false → wizard tak pernah muncul; `adminIds()` = env (+ DB bila
  ada) → perilaku identik.

## 9. Urutan implementasi (dua fase — keputusan E)

Tiap langkah berdiri sendiri & menjaga test hijau.

**Fase 1 — perbaikan kecil (rilis duluan, berguna sendiri):**
1. `BINANCE_PAY_ID` opsional (+ sesuaikan pemakai). *(kecil)*
2. Auto-generate & persist `WEB_COOKIE_SECRET`. *(kecil)*
3. Admin berbasis DB: runtime `adminIds`/`isAdmin`, `resolveAdminIds`, alihkan
   semua titik (§5), kelola di `/admins`. *(inti, paling sensitif — banyak test)*

**Fase 2 — wizard:**
4. First-run detection + preHandler `/setup` (web-admin) + halaman "toko belum
   aktif" (storefront).
5. View & route wizard 3 langkah + penyelesaian (auto-login, kunci).
6. Tombol restart terkontrol (Passenger `tmp/restart.txt`).
7. Dokumentasi: perbarui DOCS.md Bagian 5 ("kalau wizard: pembeli tak perlu env").

## 10. Testing (ikut CLAUDE.md)

- **Unit**: `resolveAdminIds` (union env∪DB, dedup), `isAdmin` DB-aware,
  WEB_COOKIE_SECRET resolver (generate sekali, stabil).
- **web-admin (`app.inject`)**:
  - `setupNeeded` true → request apa pun redirect ke `/setup`.
  - Wizard L1 token invalid (getMe gagal) → error, tak menyimpan.
  - Wizard L2 → admin dibuat: User role ADMIN, ada di `adminIds()`, password set.
  - Selesai → `setup_completed=true`, cookie sesi terpasang, `/setup` terkunci.
  - Deploy lama (admin sudah ada) → wizard TIDAK muncul (regресi guard).
- **Bot**: admin DB-only (tak di env) dikenali `isAdmin` setelah `setAdminIds`.
- `pnpm -r typecheck` & `pnpm test` hijau.

## 11. Keputusan (FINAL — dikonfirmasi 2026-06-14)

| # | Pertanyaan | Keputusan |
|---|---|---|
| A | Telegram ID di Langkah 2: isi manual atau "klaim /start pertama"? | ✅ **Isi ID manual** (copy dari @userinfobot). |
| B | Langkah 3 (setelan toko) disertakan? | ✅ **Ada, tapi skippable** (semua field punya default). |
| C | Tombol restart Passenger (`tmp/restart.txt`) masuk lingkup? | ✅ **Masuk** (best-effort + fallback instruksi). |
| D | `SETUP_TOKEN` untuk mengunci jendela setup? | ✅ **Tidak** untuk v1 (andalkan bind 127.0.0.1 + selesai cepat). |
| E | Item 1–3 (env longgar + admin DB) dirilis duluan? | ✅ **Duluan** — dua fase: **Fase 1** (item 1–3, perbaikan kecil) lalu **Fase 2** (wizard, item 4–5 + restart). |

> **Catatan kurs (Langkah 3):** field kurs USDT→IDR memakai **API publik gratis**
> (auto-update pasar — selaras `scheduleFxRefresh`/`packages/core/src/fx.ts` yang
> sudah ada); pembeli tak wajib mengisi angka manual.
