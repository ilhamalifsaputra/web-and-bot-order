# Binance Internal Transfer → DB-driven config (like Bybit)

**Tanggal:** 2026-06-17
**Status:** Disetujui (desain)

## Latar belakang

Binance Internal Transfer (UID-based auto-confirm) saat ini **env-only**: enablement
dihitung oleh `isBinanceInternalEnabled()` (sync) di `packages/core/src/config.ts`,
yang mengecek `config.BINANCE_RECEIVE_UID && BINANCE_API_KEY && BINANCE_API_SECRET`.
Pola ini berbeda dari Bybit/TokoPay yang sudah **DB-driven** (`resolveBybitConfig(db)`:
Settings menang, env fallback), sehingga Bybit bisa dikelola di `/settings` tanpa
restart sedangkan Binance Internal tidak.

Tujuan: jadikan Binance Internal DB-driven **persis pola Bybit** (`resolveBybitConfig`
di `packages/db/src/crud/bybit_deposit.ts`, dipakai oleh poller `bybitDeposit.ts` dan
`bybitPollWatchdog`).

## Konteks penting — JANGAN keliru dua metode "Binance"

- `binance_pay_id` + `qr` (kartu "USDT via Binance" di Settings) = Binance Pay
  **manual** (buyer unggah bukti, admin konfirmasi). **TIDAK disentuh** oleh spec ini.
- **Binance Internal Transfer** (UID + read-only API key/secret, **auto-confirm** via
  poller `apps/order-bot/src/payments/binanceInternal.ts`) = yang dibuat DB-driven.

## Non-tujuan

- Tidak mengubah skema Prisma, docker-compose.
- Tidak mengubah logika matching/delivery: `noteMatches`, `classifyTx`, `matchByAmount`,
  `normalizeTx`, `processTransfers`, `deliverPaidInternalOrder`. Hanya sumber config.
- Tidak menyentuh Binance Pay manual (`binance_pay_id`/`qr`).
- Script standalone `scripts/binance-probe.ts` tetap env-only (tak disentuh).
- `apiBase`, poll interval, payment window tetap env-only (jarang berubah), persis
  Bybit yang hanya mem-web-editable address+key+secret.

## Perubahan

### 1. Resolver baru — `packages/db/src/crud/binance_internal.ts`

Tambah `resolveBinanceInternalConfig(db)`, **kembar `resolveBybitConfig`**
(`bybit_deposit.ts:36-78`). Gunakan helper `pick(dbVal, envVal)` yang sama
(first non-empty trimmed; DB menang).

Setting keys (export sebagai konstanta seperti `BYBIT_*_KEY`):
- `BINANCE_UID_KEY = "binance_receive_uid"`
- `BINANCE_API_KEY_KEY = "binance_api_key"`
- `BINANCE_API_SECRET_KEY = "binance_api_secret"`

Interface `BinanceInternalConfig`:
```
enabled: boolean        // Boolean(receiveUid && apiKey && apiSecret)
receiveUid: string
apiKey: string
apiSecret: string
apiBase: string         // config.BINANCE_API_BASE (env-only)
currency: string        // config.CURRENCY
pollIntervalSeconds: number   // config.POLL_INTERVAL_SECONDS
windowMinutes: number   // config.INTERNAL_PAYMENT_WINDOW_MINUTES
```
Env fallback: `config.BINANCE_RECEIVE_UID` / `BINANCE_API_KEY` / `BINANCE_API_SECRET`.
`@app/db` sudah `export * from "./crud/binance_internal"`, jadi resolver otomatis
ter-ekspor — tidak perlu menyentuh `packages/db/src/index.ts`.

### 2. Poller pakai resolver — `apps/order-bot/src/payments/binanceInternal.ts`

- `sign(query)` → `sign(query, apiSecret)`: terima secret sebagai argumen, bukan
  `config.BINANCE_API_SECRET`.
- `fetchIncomingTransfers()` → `fetchIncomingTransfers(cfg)`: pakai `cfg.apiBase`,
  `cfg.apiKey`, `cfg.apiSecret`, `cfg.currency` (gantikan `config.BINANCE_API_BASE/
  API_KEY/API_SECRET/CURRENCY`).
- `pollOnce(api)`: di awal, `const cfg = await resolveBinanceInternalConfig(prisma);
  if (!cfg.enabled) return;` lalu thread `cfg` ke `fetchIncomingTransfers(cfg)`.
  (Gantikan `if (!isBinanceInternalEnabled()) return;`.)
- `startPolling(api)`: **selalu menjalankan loop** dan self-gate tiap siklus via
  `pollOnce` (mirror `bybitDeposit.ts:269-293`). Hapus gate sync di awal. Log boot
  melaporkan state CURRENT via `void resolveBinanceInternalConfig(prisma).then(cfg => …)`,
  termasuk peringatan `USE_UNIQUE_CENTS` (pindahkan ke dalam `.then`, hanya saat
  `cfg.enabled && !config.USE_UNIQUE_CENTS`). Interval `config.POLL_INTERVAL_SECONDS`
  tetap.
  **Efek perilaku (disetujui):** aktif/nonaktif Binance Internal via Settings berlaku
  tanpa restart, sama seperti Bybit/TokoPay.

### 3. Pemanggil lain `isBinanceInternalEnabled()` (sync → resolver async)

- `apps/order-bot/src/jobs/index.ts` `binancePollWatchdog` (baris ~155):
  `if (!(await resolveBinanceInternalConfig(prisma)).enabled) return;` — kembar
  `bybitPollWatchdog` (baris 189). Tambah import resolver dari `@app/db`.
- `apps/web-admin/src/routes/dashboard.ts` (baris ~81): ganti `if (isBinanceInternalEnabled())`
  dengan `if ((await resolveBinanceInternalConfig(prisma)).enabled)` (handler sudah async).
  Ganti import.
- `apps/order-bot/src/handlers/checkout.ts` — 4 titik (baris 409, 434, 467, 531).
  Di tiap fungsi, resolve sekali `const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;`
  **sejajar `bybitEnabled = (await resolveBybitConfig(prisma)).enabled`** yang sudah ada
  di fungsi yang sama (baris 398, 423, 457), lalu pakai `binanceEnabled && rate !== null`
  menggantikan `isBinanceInternalEnabled() && rate !== null`. Untuk `enterBinanceInternal`
  (baris ~531): `const cfg = await resolveBinanceInternalConfig(prisma); if (!cfg.enabled || !rate) {…}`.
- `packages/core/src/config.ts`: **hapus** `isBinanceInternalEnabled()` (baris 200-201)
  karena tak ada lagi pemakai. Pertahankan field env `BINANCE_RECEIVE_UID/API_KEY/
  API_SECRET/API_BASE` (dipakai sebagai fallback oleh resolver + probe script).
  Perbarui komentar di sekitarnya menjadi "resolved at runtime from Settings (env
  fallback) — see resolveBinanceInternalConfig() in @app/db", meniru komentar Bybit
  (baris 203-205).

### 4. Web admin Settings — whitelist + UI

- `apps/web-admin/src/routes/settings.ts`:
  - `EDITABLE`: tambah `binance_receive_uid`, `binance_api_key`, `binance_api_secret`
    dengan label jelas (UID; "Binance API key — READ-ONLY (no trading/withdraw)";
    "Binance API secret").
  - `SECRET_KEYS`: tambah `binance_api_key`, `binance_api_secret` (write-only; tak
    pernah di-echo; audit "(updated)" tanpa nilai).
  - Grup baru `PAY_BINANCE_INTERNAL_KEYS = new Set([... tiga key ...])`; masukkan ke
    `grouped`/view-model `pay_binance_internal_fields` (pakai `pick`), seperti
    `pay_bybit_fields`.
- `apps/web-admin/views/settings.njk`: kartu baru di tab Payments **kembar kartu Bybit**
  ("USDT on BSC via Bybit", baris ~118-137): judul "USDT via Binance Internal Transfer
  (auto-confirm)", teks penjelas (isi ketiganya untuk mengaktifkan; API key READ-ONLY,
  tanpa withdraw; saved secrets hidden; berlaku dalam detik tanpa restart), lalu
  `{% for fld in pay_binance_internal_fields %}{{ setting_form(fld) }}{% endfor %}`.

### 5. Tes

- **Unit** (`packages/db` atau dekat tes resolver yang ada): `resolveBinanceInternalConfig`
  — DB menang atas env; env fallback saat DB kosong; `enabled` true hanya saat ketiga
  nilai ada, false bila salah satu kosong. Mirror tes resolver Bybit bila ada; jika
  belum ada, tulis baru mengikuti gaya tes crud.
- **Web** (`apps/web-admin/test/web.test.ts`): `/settings/edit` menerima ketiga key
  baru; `binance_api_key`/`binance_api_secret` write-only (submit kosong = keep,
  tak ter-echo). Mirror tes settings/secret yang ada untuk Bybit.
- `pnpm -r typecheck` dan `pnpm test` harus hijau.

## Risiko & catatan

- **Jalur uang (auto-confirm):** perubahan hanya mengganti SUMBER config; logika
  matching/delivery tak berubah. Resolver dibaca per-siklus poll (seperti Bybit),
  jadi edit Settings berlaku siklus berikutnya tanpa restart.
- **Jangan log rahasia (CLAUDE.md):** `binance_api_key`/`binance_api_secret` adalah
  SECRET_KEYS → write-only, audit tanpa nilai, tak pernah di-echo ke form.
- **Settings whitelist-only:** ketiga key masuk `EDITABLE`; tak ada pelebaran lain.
- **Single-writer SQLite:** resolver hanya membaca (`getSetting`), aman.
- **Ripple sync→async** sudah dipetakan lengkap di §3; tak ada pemanggil
  `isBinanceInternalEnabled()` lain di luar daftar itu (diverifikasi via grep).
