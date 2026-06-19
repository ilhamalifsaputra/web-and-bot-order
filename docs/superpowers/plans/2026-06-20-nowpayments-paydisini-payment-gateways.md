# Plan — Integrasi NOWPayments (USDT) & PayDisini (IDR) sebagai metode bayar baru

> **Status:** disetujui (2026-06-19, via Claude Code plan mode). Dieksekusi via
> superpowers:subagent-driven-development.
> **Spec acuan:** lihat `docs/superpowers/specs/2026-06-15-cross-front-payment-methods-design.md`
> untuk pola historis yang sama (Bybit ke storefront, QRIS ke bot) — task di
> bawah mengikuti pola yang sama persis, kali ini untuk dua gateway baru.

## Context

4 metode bayar sudah ada: `BINANCE_PAY` (manual+proof), `BINANCE_INTERNAL`/`BYBIT`
(USDT, auto-confirm via polling unique-amount), `TOKOPAY` (IDR QRIS/VA/e-wallet,
auto-confirm via webhook + reconcile poller). Tugas ini menambah dua opsi BARU
tanpa mengubah metode yang ada:

- **NOWPayments** — rail USDT baru (hosted invoice + IPN webhook). USDT-only,
  satu rail crypto admin-configurable (default `usdttrc20`).
- **PayDisini** — gateway IDR baru (QRIS/e-wallet), berdampingan dengan TokoPay.
  Satu channel default admin-configurable (mirip `tokopay_default_channel`).

Keduanya tersedia di storefront DAN bot, dengan pola ganda TokoPay: webhook
(utama) + reconcile poller (fallback). `OrderCurrency` tetap `{IDR, USDT}`.

## Global Constraints (berlaku di SEMUA task — reviewer pakai ini sebagai lensa)

1. **Tidak ada float untuk uang** — selalu `Decimal` dari `@app/core/money`.
2. **Tidak ada raw SQL di routes/handlers** — semua akses DB lewat `packages/db/src/crud/*`.
3. **UTC di DB** — pakai default Prisma `now()`, jangan timestamp manual.
4. **Audit setiap state change** — pola `approveOrder(tx, orderId, { adminId: 0 })`
   (actor sistem = `adminId: 0`), identik dengan TokoPay/Bybit/Binance-Internal.
5. **Jangan pernah kirim Telegram dari proses web** — webhook route HANYA boleh
   `enqueueNotification(...)`, tidak pernah `bot.api.sendMessage` langsung. Poller
   BOLEH DM admin langsung (jalan di proses bot) — pola `alertAdmins` di
   `tokopayReconcile.ts`, hanya saat delivery GAGAL, bukan tiap siklus.
6. **Jangan pernah log secret** — URL/query yang membawa API key/secret tidak
   boleh di-log (komentar `// never log the query` di `tokopay.ts` adalah pola
   yang harus diikuti).
7. **Idempotency wajib** — setiap gateway baru punya tabel ledger sendiri
   (`Processed<Gw>Tx`) dengan `trxId` UNIQUE; klaim-dulu-baru-proses, persis
   `deliverPaidTokopayOrder`.
8. **i18n key set HARUS identik** antara `packages/core/locales/en.json` dan
   `id.json` (key + placeholder sama) — ini hard rule CLAUDE.md, ada test
   parity (`packages/core/src/locales.test.ts`) yang harus tetap hijau.
9. **Field/endpoint gateway yang belum terverifikasi ke dokumentasi live HARUS
   diberi komentar disclaimer** persis konvensi `tokopay.ts:1-9` (`⚠ ASSUMPTION
   (flagged)` ... `Verify against the live dashboard before go-live.`) — jangan
   menebak nama field dengan percaya diri palsu, terutama untuk PayDisini.
10. **Backward compatible** — caller existing TokoPay/Bybit/Binance-Internal/
    Binance-Pay TIDAK BOLEH berubah perilaku. Setiap perluasan tipe (`PaymentChoice`)
    harus opsional dengan default ke perilaku lama.
11. **Tidak menyentuh** `OrderCurrency` enum, `Order` model schema (selain
    ledger table baru), atau metode bayar lama.
12. Setiap task yang menambah file harus diakhiri `pnpm typecheck` dan
    `pnpm test` hijau (minimal untuk package/app yang disentuh; ideal: dari root).

## Urutan & dependensi

Task 1 → 2 wajib selesai dulu (fondasi bersama, blocking). Task 3-8 (PayDisini)
dan 9-14 (NOWPayments) masing-masing berurutan secara internal (client → crud →
poller+registrasi → storefront → settings → bot UI), tapi grup PayDisini tidak
depend pada grup NOWPayments — boleh dieksekusi grup-PayDisini-dulu (rekomendasi:
lebih rendah risiko, clone TokoPay hampir 1:1) baru grup NOWPayments.

---

## Task 1: Ledger tables — schema Prisma untuk PayDisini & NOWPayments

**Konteks:** fondasi DB bersama yang dibutuhkan task 4 & 10 (crud) — harus
selesai dan migration ter-apply sebelum kode apa pun memanggil
`db.processedPaydisiniTx`/`db.processedNowpaymentsTx`.

**File:** `prisma/schema.prisma`

Tambah dua model baru setelah `ProcessedTokopayTx` (cari model itu — saat ini
berakhir di sekitar baris 531), dengan bentuk **identik** ke `ProcessedTokopayTx`
(baca model itu dulu sebagai referensi bentuk persis: field, `@map`, `@@index`,
`@@map`, comment style):

```prisma
/// Idempotency ledger for PayDisini (QRIS/e-wallet, IDR) webhook callbacks —
/// same insert-first-on-unique pattern as ProcessedTokopayTx.
model ProcessedPaydisiniTx {
  id        Int      @id @default(autoincrement())
  trxId     String   @unique(map: "ix_processed_paydisini_tx_trxid") @map("trx_id")
  orderId   Int?     @map("order_id")
  amount    Decimal?
  // matched | unmatched | delivery_failed | stale
  outcome   String
  createdAt DateTime @default(now()) @map("created_at")

  @@index([orderId], map: "ix_processed_paydisini_tx_order_id")
  @@map("processed_paydisini_tx")
}

/// Idempotency ledger for NOWPayments (USDT crypto invoice) IPN callbacks —
/// same insert-first-on-unique pattern. trxId stores NOWPayments' payment_id.
model ProcessedNowpaymentsTx {
  id        Int      @id @default(autoincrement())
  trxId     String   @unique(map: "ix_processed_nowpayments_tx_trxid") @map("trx_id")
  orderId   Int?     @map("order_id")
  amount    Decimal?
  // matched | unmatched | delivery_failed | stale
  outcome   String
  createdAt DateTime @default(now()) @map("created_at")

  @@index([orderId], map: "ix_processed_nowpayments_tx_order_id")
  @@map("processed_nowpayments_tx")
}
```

Tidak ada perubahan lain ke schema — kedua metode reuse `Order.paymentMethod`,
`Order.paymentRef` (kolom JSON cache yang sudah dipakai TokoPay), `Order.currency`,
`Order.fxRate`, `Order.expiresAt`.

**Migration:** jalankan `pnpm prisma migrate dev --name add_paydisini_nowpayments_ledgers`
di root repo (bukan di package tertentu) — ini meng-generate SQL migration,
apply ke dev DB lokal, dan regenerate Prisma Client (supaya `db.processedPaydisiniTx`
dkk dikenal TypeScript). Commit folder migration yang dihasilkan bersama
perubahan schema.

**Done when:**
- `prisma/schema.prisma` punya 2 model baru, format identik referensi.
- Migration folder baru ada di `prisma/migrations/`, sudah di-apply ke dev DB
  (`pnpm prisma migrate dev` jalan tanpa error).
- `pnpm -r typecheck` tetap hijau (Prisma Client baru ke-generate, tidak ada
  import yang memakai tabel baru ini dulu — itu task selanjutnya).
- `pnpm test` tetap hijau (baseline 49 file / 633 test, tidak ada regresi).

---

## Task 2: Enums + config + `pricing.ts` — buka jalan untuk kedua metode baru

**Konteks:** titik fan-in tunggal yang dipakai bot maupun storefront untuk
menetapkan `paymentMethod` sebuah order. **Harus selesai sebelum task 6/12**
(storefront wiring) bisa memanggil `finalizeOrderPayment` dengan method baru,
tapi PayDisini/NOWPayments-specific code (task 3-5, 9-11) tidak depend ke task
ini secara langsung — boleh paralel secara konsep, tapi controller mendispatch
sekuensial.

**File 1: `packages/core/src/enums.ts`**

Tambah ke `PaymentMethod` (setelah `TOKOPAY`), dengan doc comment mengikuti gaya
existing entries:

```ts
/** Indonesian QRIS/e-wallet aggregator (one admin-configured default channel,
 *  e.g. QRIS) — confirmed by webhook callback + reconcile poller, same shape
 *  as TOKOPAY. */
PAYDISINI: "PAYDISINI",
/** USDT crypto via NOWPayments hosted invoice (one admin-configured rail,
 *  e.g. USDT-TRC20) — confirmed by IPN webhook + reconcile poller, same shape
 *  as the other auto-confirm methods. */
NOWPAYMENTS: "NOWPAYMENTS",
```

**File 2: `packages/core/src/config.ts`**

Tambah `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES` ke zod schema `Env`, mirip pola
`BYBIT_PAYMENT_WINDOW_MINUTES`/`INTERNAL_PAYMENT_WINDOW_MINUTES` (cari keduanya
sebagai referensi pola persis: tipe, `.default(...)`, cara di-parse jadi number).
Default value: `"30"` (30 menit — invoice crypto hosted butuh waktu lebih
longgar daripada on-chain matching, karena pembeli perlu keluar dari
Telegram/browser, buka wallet app, lalu balik).

PayDisini TIDAK butuh window minutes baru — order IDR pakai window default yang
sudah ada (lihat baris-baris `PAYMENT_WINDOW_MINUTES`/`expiresAt` umum untuk
order, bukan yang auto-confirm-specific).

**File 3: `packages/db/src/crud/pricing.ts`**

Baca dulu file ini secara penuh (sudah pendek, ~190 baris) sebelum mengubah —
pahami `PaymentChoice` (union tertutup) dan `finalizeOrderPayment` (baris
~92-187 di versi saat ini).

1. Widen `PaymentChoice`:

```ts
export type PaymentChoice =
  | {
      currency: typeof OrderCurrency.IDR;
      /** TOKOPAY (default jika tidak diisi — caller existing TIDAK pass ini,
       *  jadi perilaku TokoPay byte-identik) atau PAYDISINI. */
      method?: typeof PaymentMethod.TOKOPAY | typeof PaymentMethod.PAYDISINI;
    }
  | {
      currency: typeof OrderCurrency.USDT;
      rate: Decimal.Value;
      method?:
        | typeof PaymentMethod.BINANCE_INTERNAL
        | typeof PaymentMethod.BYBIT
        | typeof PaymentMethod.BINANCE_PAY
        | typeof PaymentMethod.NOWPAYMENTS;
    };
```

2. Di branch `IDR` pada `finalizeOrderPayment` (saat ini hardcode
   `paymentMethod: PaymentMethod.TOKOPAY`), ganti jadi:
   `paymentMethod: choice.method ?? PaymentMethod.TOKOPAY` — fully
   backward-compatible, karena semua caller existing memanggil
   `{ currency: OrderCurrency.IDR }` tanpa `method`.

3. Di branch `USDT`, `method` sudah punya default `?? PaymentMethod.BINANCE_INTERNAL`
   — itu tetap. Tambah cabang baru di blok if/else-if yang menentukan
   `paymentRef`/`expiresAt` per method (setelah cabang `BYBIT`):

```ts
} else if (method === PaymentMethod.NOWPAYMENTS) {
  expiresAt = addMinutes(new Date(), config.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES);
  // tidak ada paymentRef di sini — NOWPayments invoice id dibuat & dicache di
  // order.paymentRef oleh caller storefront/bot setelah finalizeOrderPayment,
  // sama seperti TokoPay/PayDisini melakukannya untuk paymentRef JSON cache.
}
```

**Test:** lihat `packages/db/src/crud/pricing.test.ts` yang sudah ada (5 test) —
tambah test case yang membuktikan:
- `finalizeOrderPayment(db, id, { currency: IDR })` (tanpa method) tetap
  menghasilkan `paymentMethod: "TOKOPAY"` (regression guard — perilaku lama
  tidak boleh berubah).
- `finalizeOrderPayment(db, id, { currency: IDR, method: "PAYDISINI" })`
  menghasilkan `paymentMethod: "PAYDISINI"`, `uniqueCents: 0`.
- `finalizeOrderPayment(db, id, { currency: USDT, rate, method: "NOWPAYMENTS" })`
  menghasilkan `paymentMethod: "NOWPAYMENTS"`, `expiresAt` terisi sesuai
  `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES`, tidak ada `paymentRef` (null/unchanged).

**Done when:** `pnpm -r typecheck` & `pnpm test` hijau; test baru di
`pricing.test.ts` lulus; tidak ada caller existing yang berubah perilaku.

---

## Task 3: PayDisini gateway client — `packages/core/src/payments/paydisini.ts`

**Konteks:** lapisan HTTP+signature murni (tanpa `@app/db`), dipakai bersama
oleh storefront route, bot handler, dan poller. Mirror 1:1 struktur
`packages/core/src/payments/tokopay.ts` — **baca file itu lebih dulu**, file
baru ini punya bentuk yang sama persis, hanya nama gateway & field yang beda.

**Requirements:**

- Doc comment di atas file: jelaskan tujuan (mirror baris 1-9 `tokopay.ts`),
  WAJIB sertakan blok disclaimer:
  > ⚠ ASSUMPTION (flagged): endpoint shape + signature scheme below follow
  > PayDisini's public docs as understood at plan-writing time, NOT verified
  > against a live merchant dashboard. PayDisini's API uses a `user_key` +
  > `api_key` pair (not TokoPay's `merchant`+`secret`). Verify every field name
  > below against the live dashboard before go-live.
- Export konstanta key Settings: `PAYDISINI_USERKEY_KEY = "paydisini_userkey"`,
  `PAYDISINI_APIKEY_KEY = "paydisini_apikey"`, `PAYDISINI_ENABLED_KEY = "paydisini_enabled"`,
  `PAYDISINI_CHANNEL_KEY = "paydisini_default_channel"` (mirror 4 konstanta
  `TOKOPAY_*_KEY`).
- `export interface PaydisiniCreds { userKey: string; apiKey: string; channel: string }`.
- `export interface PaydisiniOrderInfo { trxId: string; qrString: string | null; qrUrl: string | null; checkoutUrl: string | null; totalBayar: string | null }`.
- `createTransaction(creds: PaydisiniCreds, args: { refId: string; amountIdr: Decimal.Value }): Promise<PaydisiniOrderInfo>`
  — bentuk fungsi (params, return shape, error throw `new Error(...)` saat
  `!res.ok` atau gateway reject) mirror `createTransaction` TokoPay persis;
  **JANGAN log query string** (sama seperti komentar `tokopay.ts` baris 49).
- `export interface PaydisiniStatus { paid: boolean; amount: Decimal; trxId: string | null }`
  dan `checkTransaction(creds, args: { refId, amountIdr }): Promise<PaydisiniStatus>`
  — re-hit endpoint status idempoten, mirror `checkTransaction` TokoPay.
- `export interface PaydisiniCallback { refId: string; trxId: string; amount: Decimal; paid: boolean }`
  dan `verifyCallback(body: Record<string, unknown>, creds: Pick<PaydisiniCreds, "userKey"|"apiKey">): PaydisiniCallback | null`
  — verifikasi signature (md5/sha256 atas kombinasi field — flag exact scheme
  sebagai unverified di komentar fungsi ini juga), constant-time compare pakai
  `timingSafeEqual` (helper lokal sama seperti `constantTimeEqual` di
  `tokopay.ts`, duplikat ~10 baris, JANGAN buat util cross-gateway baru —
  konsisten dengan pola file-mandiri yang sudah ada).
- `API_BASE` dari `process.env.PAYDISINI_API_BASE ?? "https://api.paydisini.co.id"`
  (placeholder URL, flag sebagai unverified juga).

**Test:** `packages/core/src/payments/paydisini.test.ts`, mirror
`packages/core/src/payments/tokopay.test.ts` 1:1 — baca file itu sebagai
referensi struktur test (stub `global.fetch`). Cover:
- `verifyCallback`: signature valid → payload ternormalisasi; signature salah →
  null; field wajib (ref/signature) hilang → null; status bukan "paid" → `paid:false`.
- `checkTransaction`: kasus paid, unpaid, HTTP non-2xx (throw), gateway reject
  (`status` bukan success, throw).
- `createTransaction`: happy path; HTTP non-2xx (throw); gateway reject (throw).

**Done when:** file baru + test baru ada; `pnpm --filter @app/core test` (atau
`pnpm test` dari root) hijau; `pnpm -r typecheck` hijau.

---

## Task 4: PayDisini DB crud — `packages/db/src/crud/paydisini.ts`

**Konteks:** lapisan yang menyentuh DB — resolusi credentials dari Settings +
ledger idempotency. Mirror 1:1 `packages/db/src/crud/tokopay.ts` — **baca file
itu lebih dulu**.

**Requirements (file baru `packages/db/src/crud/paydisini.ts`):**

- `getPaydisiniCreds(db: Db): Promise<PaydisiniCreds | null>` — baca 4 Settings
  keys (`PAYDISINI_USERKEY_KEY`, `PAYDISINI_APIKEY_KEY`, `PAYDISINI_ENABLED_KEY`,
  `PAYDISINI_CHANNEL_KEY` dari task 3), null jika userKey/apiKey kosong atau
  `*_enabled === "false"`. Default channel `"QRIS"` jika kosong (mirror
  `getTokopayCreds` persis).
- `listPendingPaydisiniOrders(db: Db, now: Date)` — query `db.order.findMany`
  dengan `status: PENDING_PAYMENT`, `paymentMethod: PAYDISINI`, `expiresAt: {gt: now}`,
  `include: { user: true }` (mirror `listPendingTokopayOrders` persis).
- `export type PaydisiniDeliverResult = | {status:"delivered"; order; credentials} | {status:"already_processed"} | {status:"stale"}`.
- `deliverPaidPaydisiniOrder(db: PrismaClient, args: {orderId, trxId, amount, shopUrl?})`
  — **copy alur `deliverPaidTokopayOrder` persis**, ganti `processedTokopayTx`→
  `processedPaydisiniTx`, `PaymentMethod.TOKOPAY`→`PaymentMethod.PAYDISINI`:
  1. Claim `trxId` via insert ke `processedPaydisiniTx` (catch `isUniqueViolation`
     → `{status:"already_processed"}`).
  2. Dalam `$transaction`: re-check order masih `PENDING_PAYMENT` +
     `paymentMethod === PAYDISINI` (else update ledger row jadi `"stale"`,
     return `{status:"stale"}`); update order → `PENDING_VERIFICATION` +
     `paidAt: new Date()`; `approveOrder(tx, orderId, {adminId: 0})`; jika
     `user.telegramId != null`, `enqueueNotification(tx, ORDER_DELIVERED_DM, ...)`
     dengan payload `{chat_id, order_code, order_url, buyer_language}` —
     **TIDAK PERNAH credentials di payload**.
  3. Catch di luar: update ledger row jadi `"delivery_failed"`, rethrow.
- `recordUnmatchedPaydisiniTx(db: Db, args: {trxId, amount}): Promise<boolean>`
  — copy `recordUnmatchedTokopayTx` persis, ganti nama tabel.

**Edit:** `packages/db/src/index.ts` — tambah
`export * from "./crud/paydisini";` di samping `export * from "./crud/tokopay";`.

**Test:** `packages/db/src/crud/paydisini.test.ts`. Tidak ada `tokopay.test.ts`
colocated yang bisa di-mirror langsung di folder `crud/` ini — precedent
terdekat untuk pola test idempotency-ledger ada di
`packages/db/src/crud/reconciliation.test.ts` (ledger Binance) — baca itu untuk
pola setup-db/sampleData. Cover 3 cabang `deliverPaidPaydisiniOrder`
(`delivered`/`already_processed`/`stale`) + `recordUnmatchedPaydisiniTx`
(insert pertama → true, duplicate trxId → false).

**Done when:** file baru + test baru ada, export wiring selesai; `pnpm test`
& `pnpm -r typecheck` hijau.

---

## Task 5: PayDisini reconcile poller + registrasi di DUA composition root

**Konteks:** safety net kalau webhook PayDisini tidak sampai. **Temuan
penting:** ada DUA composition root terpisah yang masing-masing
import+start+stop poller TokoPay secara independen — `apps/server/src/index.ts`
(combined-server) DAN `apps/order-bot/src/main.ts` (standalone order-bot entry
point). **Keduanya harus diupdate** atau mode standalone order-bot diam-diam
tidak menjalankan poller baru ini.

**File baru: `apps/order-bot/src/payments/paydisiniReconcile.ts`**

Copy struktur `apps/order-bot/src/payments/tokopayReconcile.ts` persis (baca
file itu dulu) — ganti setiap identifier `Tokopay`→`Paydisini`/`TOKOPAY`→`PAYDISINI`:
- `reconcileOrder(api, creds, order)` — panggil `checkTransaction` (dari task 3),
  skip jika belum paid, **jangan deliver** jika `amount < order.totalAmount`
  (log warning, return), else `deliverPaidPaydisiniOrder` + `alertAdmins` HANYA
  saat hasil bukan `"delivered"`/`"already_processed"` (yaitu saat exception
  dilempar — delivery gagal, mis. stok habis).
- `pollOnce(api)` — ambil creds, jika null return; ambil
  `listPendingPaydisiniOrders`, loop `reconcileOrder`.
- `startPolling(api)`/`stopPolling()` — self-scheduling `setTimeout` loop,
  guard `isRunning`/`stopped`, interval `config.POLL_INTERVAL_SECONDS * 1000`
  (reuse constant yang sama dipakai TokoPay, BUKAN bikin baru).

**Test:** `apps/order-bot/test/paydisini-reconcile.test.ts`, mirror
`apps/order-bot/test/tokopay-reconcile.test.ts` (3 test): delivers saat paid,
leaves pending saat unpaid, never delivers saat underpaid.

**Edit `apps/server/src/index.ts`:**
- Tambah import: `import { startPolling as startPaydisiniPolling, stopPolling as stopPaydisiniPolling } from "@app/order-bot/payments/paydisiniReconcile";`
  (di samping import TokoPay yang sudah ada).
- Di dalam blok `if (bot) { ... }`, tambah `startPaydisiniPolling(bot.api);` di
  samping `startTokopayPolling(bot.api);`.
- Di dalam `shutdown()`, tambah `stopPaydisiniPolling();` di samping
  `stopTokopayPolling();`.

**Edit `apps/order-bot/src/main.ts`:** persis pola yang sama (import dengan
path relatif `./payments/paydisiniReconcile`, start & stop di lokasi yang sama
dengan poller TokoPay di file ini).

**Done when:** poller baru ada + test; **kedua** composition root start & stop
poller baru ini; `pnpm test` & `pnpm -r typecheck` hijau.

---

## Task 6: PayDisini di storefront — checkout, pay page, webhook

**Konteks:** mengaktifkan PayDisini sebagai opsi ke-2 untuk IDR di website,
berdampingan dengan TokoPay (bukan pengganti). Satu file utama:
`apps/storefront/src/routes/checkout.ts` — **baca seluruh file ini dulu**,
terutama `checkoutView()`, `performCheckout()`, handler `GET /checkout/:code/pay`,
dan blok `POST /pay/tokopay/callback` (baris ~372-410) — semuanya akan ditiru.

**Requirements:**

1. **Import** (alias untuk hindari collision dengan import TokoPay yang
   unaliased di file ini): `getPaydisiniCreds`, `deliverPaidPaydisiniOrder`,
   `recordUnmatchedPaydisiniTx` dari `@app/db`; `createTransaction as createPaydisiniTransaction`,
   `verifyCallback as verifyPaydisiniCallback`, tipe `PaydisiniOrderInfo` dari
   `@app/core/payments/paydisini`.
2. **`checkoutView()`** — tambah `getPaydisiniCreds(prisma)` ke `Promise.all`
   fetch list; tambah field baru di return object: `paydisini_enabled: Boolean(paydisini)`
   (di samping `idr_enabled` TokoPay yang tetap ada — dua opsi IDR aktif
   bersamaan adalah tujuan, bukan exclusive).
3. **`performCheckout()`** — tambah `else if (method === "paydisini")` branch:
   gate `if (!paydisini) throw new ValidationError("web.pay_method_unavailable")`,
   lalu `choice = { currency: OrderCurrency.IDR, method: PaymentMethod.PAYDISINI }`.
4. **`GET /checkout/:code/pay` handler** — tambah `isPaydisini = method === PaymentMethod.PAYDISINI`.
   Karena TokoPay dan PayDisini berbagi kolom `order.paymentRef` untuk cache
   JSON gateway info, widen `parseCachedGateway` (atau buat parser sejenis)
   supaya membaca/menulis field diskriminator (`gateway: "tokopay"` vs
   `"paydisini"`) di JSON yang dicache, supaya halaman tahu cabang render mana
   yang dipakai meski keduanya numpang di kolom yang sama. Tambah blok lazy
   `createPaydisiniTransaction` + cache (copy blok `isQris` yang ada, ganti
   client call).
5. **Route baru `POST /pay/paydisini/callback`** — copy blok
   `/pay/tokopay/callback` PERSIS (kontrak response code sama: 403 disabled,
   403 bad signature, 200 untuk semua outcome lain termasuk delivery-failed
   supaya gateway berhenti retry), ganti semua identifier TokoPay→PayDisini.

**Edit templates:**
- `apps/storefront/views/checkout.njk` — tambah radio option ke-4 (setelah
  blok QRIS) `value="paydisini"`, gated `paydisini_enabled`, pakai i18n key
  baru `web.pay_paydisini_title`/`_sub`/`_disabled` (tambahkan di task 8
  bersama i18n PayDisini lainnya — di task ini cukup reference key-nya, jangan
  duplikat penambahan i18n di dua task berbeda; JANGAN tambah key i18n di task
  ini, itu domain task 8).
- `apps/storefront/views/pay.njk` — tambah branch `is_paydisini` (setelah
  branch `is_qris`), render QR/checkout-url sama seperti cabang TokoPay.

**Test:** `apps/storefront/test/paydisini-webhook.test.ts` — trio
happy/bad-signature/unmatched via `app.inject({method:"POST", url:"/pay/paydisini/callback", payload})`,
ikuti pola setup `apps/storefront/test/storefront.test.ts`/`api.test.ts` (cari
`setup-db`/`sampleData`/`setSetting` helper yang dipakai di sana). Juga
tambahkan case `method: "paydisini"` ke describe block checkout yang sudah ada
di `storefront.test.ts` (mirror struktur describe block Bybit yang sudah ada di
situ) — cover: enabled→create order; disabled→`web.pay_method_unavailable`;
pay-page render QR.

**Catatan koordinasi i18n:** task ini memakai key `web.pay_paydisini_*` di
template tapi TIDAK menambahkannya ke locale files — itu dilakukan di task 8.
Jika dijalankan sebelum task 8 selesai, template akan render key literal
(bukan error) — ini OK karena Nunjucks/`t()` biasanya fallback ke key string;
pastikan task 8 menambah key yang SAMA persis dengan yang dipakai di template
ini.

**Done when:** semua di atas + test baru lulus; `pnpm test` & `pnpm -r typecheck` hijau.

---

## Task 7: PayDisini — admin settings whitelist + card UI

**File 1: `apps/web-admin/src/routes/settings.ts`** — baca dulu, khususnya
`EDITABLE`, `PAY_QRIS_KEYS`, `SECRET_KEYS`, `grouped` set, dan bagian
`reply.view(...)` context (semua sekitar baris 46-189 di versi saat ini).

- Tambah 4 entries ke `EDITABLE`: `paydisini_userkey` (label: "PayDisini user key"),
  `paydisini_apikey` (label: "PayDisini API key"), `paydisini_enabled` (label:
  "Rupiah payments via PayDisini on the website — true / false"),
  `paydisini_default_channel` (label: "PayDisini channel/service code — default QRIS").
- Tambah `const PAY_PAYDISINI_KEYS = new Set(["paydisini_userkey", "paydisini_apikey", "paydisini_enabled", "paydisini_default_channel"]);`
  di samping `PAY_QRIS_KEYS`.
- Tambah `paydisini_apikey` ke `SECRET_KEYS` (apikey adalah credential rahasia;
  `userkey` biasanya identifier publik mirip `merchant_id` TokoPay — TIDAK
  perlu masuk `SECRET_KEYS`, mirror perlakuan `tokopay_merchant_id` vs
  `tokopay_secret`).
- Tambah `PAY_PAYDISINI_KEYS` ke `grouped` Set (supaya tidak jatuh ke leftover
  list generik).
- Tambah `pay_paydisini_fields: pick(PAY_PAYDISINI_KEYS)` ke context yang
  dikirim ke `reply.view(...)` (di samping `pay_qris_fields`).

**File 2: `apps/web-admin/views/settings.njk`** — baca dulu blok card QRIS/
TokoPay yang sudah ada (cari "QRIS"/"tokopay_merchant_id" di file ini) sebagai
referensi markup persis (pakai macro `setting_form` yang sama). Tambah card
baru, judul "Rupiah (QRIS/e-wallet) via PayDisini di website", loop
`pay_paydisini_fields` lewat macro yang sama, ditempatkan setelah card TokoPay.

**Test:** cek apakah ada test untuk route settings (`apps/web-admin/test/*settings*`)
— jika ada, tambah case yang membuktikan `paydisini_*` keys bisa di-edit via
`POST /settings/edit` dan key non-whitelist tetap ditolak (pola test yang
sudah ada untuk key lain). Jika tidak ada test settings sama sekali untuk
gateway lain (TokoPay/Bybit) di file ini, jangan buat test baru sendirian
(tetap konsisten — laporkan temuan ini di report task, controller akan
adjudicate).

**Done when:** `pnpm -r typecheck` hijau, halaman settings tidak crash (jika
ada test render, harus lulus), `pnpm test` hijau.

---

## Task 8: PayDisini — bot UI (keyboard, handler, dispatcher) + i18n

**Konteks:** baca dulu spec historis `docs/superpowers/specs/2026-06-15-cross-front-payment-methods-design.md`
§4 — ini persis pola `buyNowTokopay` yang sudah dibangun di sana; task ini
mengulang pola yang SAMA untuk PayDisini (bukan menggantikan TokoPay).

**File 1: `apps/order-bot/src/keyboards/customer.ts`**
- `orderConfirmKb(...)` — tambah parameter `paydisiniEnabled = false` setelah
  `tokopayEnabled`. Di logic tombol IDR (cari baris yang merender tombol QRIS),
  tambah baris tombol kedua saat `paydisiniEnabled` true, callback data prefix
  **`"payd"`** (verifikasi dulu prefix ini belum dipakai — `payb`=Bybit,
  `payx`=Binance Internal, `payq`=TokoPay, sesuai temuan eksplorasi).

**File 2: `apps/order-bot/src/handlers/checkout.ts`**
- Di `showOrderConfirmation` & `renderOrderConfirmation` (dua call site yang
  menghitung `tokopayEnabled` via `getTokopayCreds`), tambah penghitungan
  `paydisiniEnabled` via `getPaydisiniCreds(prisma) != null` dan teruskan ke
  `orderConfirmKb(...)`.
- Tambah fungsi baru `buyNowPaydisini(ctx, productId, quantity)` — copy
  `buyNowTokopay` PERSIS (cari fungsi ini di file ini sebagai referensi
  lengkap), ganti setiap identifier TokoPay/QRIS→PayDisini, pakai locale key
  baru `checkout.paydisini_instructions` (BUKAN reuse `checkout.qris_instructions`
  — dua metode IDR ini boleh punya copy berbeda ke pembeli).

**File 3: `apps/order-bot/src/handlers/callbacks.ts`**
- Tambah dispatcher baru (cari `dispatchPayTokopay` sebagai referensi bentuk
  persis) terdaftar di dispatch table pada key `"payd"`, memanggil
  `buyNowPaydisini`.

**File 4 & 5: `packages/core/locales/en.json` dan `id.json`** — tambah key BARU
yang identik di kedua file (placeholder sama):
- `checkout.pay_paydisini_btn` — label tombol bot.
- `checkout.paydisini_instructions` — caption screen QR (mirror placeholder
  `checkout.qris_instructions`: kode order, jumlah, expiry).
- `web.pay_paydisini_title`, `web.pay_paydisini_sub`, `web.pay_paydisini_disabled`
  — dipakai task 6 di `checkout.njk` (pastikan key SAMA PERSIS dengan yang
  sudah direferensikan di template task 6).
- `web.paydisini_auto_note` — dipakai task 6 di `pay.njk` (mirror
  `web.tokopay_auto_note`).

**Test:**
- Extend/cek `apps/order-bot/test/payment-menu.test.ts` (cari scope-nya dulu)
  — tambah case `paydisiniEnabled` mempengaruhi render `orderConfirmKb`.
- Cek `apps/order-bot/test/wiring.test.ts` — pastikan dispatcher baru di key
  `"payd"` ter-cover oleh assertion generik di situ (file ini sepertinya
  mengecek dispatch table well-formed); jika tidak otomatis ter-cover, tambah
  case eksplisit.
- `packages/core/src/locales.test.ts` (parity en/id) harus tetap hijau —
  ini otomatis menangkap key yang lupa ditambah di salah satu file.

**Done when:** semua di atas; `pnpm test` & `pnpm -r typecheck` hijau; bot
manual flow (cek lewat code review, tidak perlu live Telegram) menunjukkan
tombol PayDisini hanya muncul saat `getPaydisiniCreds` mengembalikan non-null.

---

## Task 9: NOWPayments gateway client — `packages/core/src/payments/nowpayments.ts`

**Konteks:** sama seperti task 3 tapi untuk NOWPayments. API NOWPayments lebih
terdokumentasi publik dibanding PayDisini, tapi tetap perlu disclaimer untuk
detail yang bisa berubah (slug `pay_currency`, endpoint status-check persis).

**Requirements:**

- Doc comment + disclaimer (mirror konvensi task 3, tapi nada lebih percaya
  diri untuk skema signature IPN — itu bagian yang paling solid terdokumentasi
  publik; tetap flag exact `pay_currency` slug & endpoint status sebagai perlu
  verifikasi live).
- Export konstanta Settings keys: `NOWPAYMENTS_API_KEY_KEY = "nowpayments_api_key"`,
  `NOWPAYMENTS_IPN_SECRET_KEY = "nowpayments_ipn_secret"`,
  `NOWPAYMENTS_ENABLED_KEY = "nowpayments_enabled"`,
  `NOWPAYMENTS_PAY_CURRENCY_KEY = "nowpayments_pay_currency"`.
- `export interface NowpaymentsCreds { apiKey: string; ipnSecret: string; payCurrency: string }`.
- `export interface NowpaymentsInvoice { invoiceId: string; invoiceUrl: string }`.
- `createInvoice(creds: NowpaymentsCreds, args: { orderId: string; amountUsd: Decimal.Value; ipnCallbackUrl: string; successUrl?: string; cancelUrl?: string }): Promise<NowpaymentsInvoice>`
  — `POST https://api.nowpayments.io/v1/invoice`, header `x-api-key: creds.apiKey`,
  body `{ price_amount: amountUsd.toFixed(2), price_currency: "usd", pay_currency: creds.payCurrency, order_id: args.orderId, ipn_callback_url: args.ipnCallbackUrl, success_url: args.successUrl, cancel_url: args.cancelUrl }`,
  response `{ id, invoice_url }` → map ke `{invoiceId: id, invoiceUrl: invoice_url}`.
  Throw `Error` saat `!res.ok` atau response tidak punya `id`/`invoice_url`.
  **Jangan log body request** (membawa api key di header, tapi body tidak
  rahasia — tetap jangan log header).
- `export interface NowpaymentsStatus { paid: boolean; amount: Decimal; trxId: string | null; status: string }`
  dan `getPaymentStatus(creds, args: { invoiceId: string }): Promise<NowpaymentsStatus>`
  — `GET https://api.nowpayments.io/v1/invoice/{invoiceId}` (atau endpoint
  payment status yang sesuai — flag exact path sebagai unverified), `paid: true`
  hanya jika `payment_status === "finished"`.
- `export interface NowpaymentsIpn { orderId: string; trxId: string; amount: Decimal; paid: boolean; status: string }`
  dan `verifyIpn(body: Record<string, unknown>, signatureHeader: string | undefined, creds: Pick<NowpaymentsCreds, "ipnSecret">): NowpaymentsIpn | null`:
  - Jika `signatureHeader` kosong → null.
  - Sort key body secara **rekursif alfabetis** (termasuk nested object),
    `JSON.stringify` hasil sorted, `createHmac("sha512", creds.ipnSecret).update(sorted).digest("hex")`,
    bandingkan **timing-safe** terhadap `signatureHeader`. Signature salah → null.
  - `paid: body.payment_status === "finished"`.
  - Map field: `orderId` dari `body.order_id`, `trxId` dari `body.payment_id`
    (coerce ke string), `amount` dari `body.actually_paid ?? body.pay_amount`.
- Helper `sortKeysDeep(obj: unknown): unknown` lokal (rekursif, sort
  `Object.keys` alfabetis, array tetap urut elemen tapi tiap elemen object di
  dalamnya juga di-sort) — ini bagian PALING kritis, tulis dengan teliti karena
  salah sort akan diam-diam membuat semua webhook gagal verifikasi.

**Test:** `packages/core/src/payments/nowpayments.test.ts`, mirror struktur
`tokopay.test.ts` (stub `global.fetch` untuk `createInvoice`/`getPaymentStatus`).
Untuk `verifyIpn`: **wajib** ada test yang menghitung HMAC-SHA512 yang benar
dengan tangan (atau via `crypto` langsung di test) atas sebuah fixture object
yang key-nya SENGAJA tidak alfabetis di literal (mis. `{c:1, a:2, b:{z:1,y:2}}`),
untuk membuktikan implementasi benar-benar sort sebelum hash — ini regression
test paling penting di task ini.

**Done when:** file + test ada; `pnpm test` & `pnpm -r typecheck` hijau.

---

## Task 10: NOWPayments DB crud — `packages/db/src/crud/nowpayments.ts`

**Konteks:** identik task 4, untuk NOWPayments. Mirror
`packages/db/src/crud/tokopay.ts` (dan task 4's `paydisini.ts` sebagai
precedent kedua).

**Requirements (file baru `packages/db/src/crud/nowpayments.ts`):**
- `getNowpaymentsCreds(db): Promise<NowpaymentsCreds | null>` — baca 4 Settings
  keys dari task 9, null jika `apiKey`/`ipnSecret` kosong atau
  `*_enabled === "false"`. Default `payCurrency` ke `"usdttrc20"` jika kosong.
- `listPendingNowpaymentsOrders(db, now)` — sama pola, `paymentMethod: NOWPAYMENTS`.
- `deliverPaidNowpaymentsOrder(db, args: {orderId, trxId, amount, shopUrl?})` —
  copy alur `deliverPaidPaydisiniOrder`/`deliverPaidTokopayOrder` persis, ganti
  ke `processedNowpaymentsTx`/`PaymentMethod.NOWPAYMENTS`. `trxId` di sini
  adalah NOWPayments `payment_id` (string).
- `recordUnmatchedNowpaymentsTx(db, args: {trxId, amount})` — copy verbatim.

**Edit:** `packages/db/src/index.ts` — tambah
`export * from "./crud/nowpayments";`.

**Test:** `packages/db/src/crud/nowpayments.test.ts`, sama pola task 4 (3
cabang deliver + recordUnmatched).

**Done when:** file + test + export wiring; `pnpm test` & `pnpm -r typecheck` hijau.

---

## Task 11: NOWPayments reconcile poller + registrasi di DUA composition root

**Konteks:** sama seperti task 5, untuk NOWPayments. Poller di sini memanggil
`getPaymentStatus` (bukan `checkTransaction`), dan "paid" berarti
`status === "finished"` (bukan string-allowlist seperti TokoPay/PayDisini).

**File baru: `apps/order-bot/src/payments/nowpaymentsReconcile.ts`** — struktur
sama persis `tokopayReconcile.ts`/`paydisiniReconcile.ts` (self-scheduling
`setTimeout`, guard `isRunning`/`stopped`, `alertAdmins` hanya saat delivery
gagal), tapi cek status via `getPaymentStatus` dari task 9, dan **jangan
deliver** saat status `partially_paid`/`waiting`/`confirming`/`confirmed`/`sending`
(treat semua non-`finished` sebagai "belum siap", bukan error).

**Test:** `apps/order-bot/test/nowpayments-reconcile.test.ts` — 3 case:
delivers saat `finished`, leaves pending saat `waiting`/`confirming`, never
delivers saat `partially_paid`.

**Edit `apps/server/src/index.ts` dan `apps/order-bot/src/main.ts`:** pola
identik task 5 (import alias `startNowpaymentsPolling`/`stopNowpaymentsPolling`,
start di blok `if (bot)`, stop di `shutdown()`/equivalent) — **di KEDUA file**.

**Done when:** poller + test ada; kedua composition root start & stop poller
ini; `pnpm test` & `pnpm -r typecheck` hijau.

---

## Task 12: NOWPayments di storefront — checkout, pay page, webhook IPN

**Konteks:** sama seperti task 6, tapi UX-nya redirect ke hosted invoice page
(bukan QR inline), dan signature webhook dibaca dari **HTTP header**
(`x-nowpayments-sig`), bukan dari field body. Order masuk branch **USDT**
`PaymentChoice` (bukan IDR).

**File:** `apps/storefront/src/routes/checkout.ts`

1. Import (alias) `getNowpaymentsCreds`, `deliverPaidNowpaymentsOrder`,
   `recordUnmatchedNowpaymentsTx` dari `@app/db`; `createInvoice as createNowpaymentsInvoice`,
   `getPaymentStatus as getNowpaymentsStatus`, `verifyIpn` dari
   `@app/core/payments/nowpayments`.
2. **`checkoutView()`** — tambah `nowpayments` ke `Promise.all`; tambah
   `nowpayments_enabled: haveRate && Boolean(nowpayments)` (gated `fxRate` juga,
   karena konversi IDR→USD butuh rate, mirror `binance_enabled`/`bybit_enabled`).
3. **`performCheckout()`** — tambah `else if (method === "nowpayments")`: gate
   `if (!fxRate || !nowpayments) throw new ValidationError("web.pay_method_unavailable")`,
   `choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.NOWPAYMENTS }`.
4. **`GET /checkout/:code/pay` handler** — tambah `isNowpayments = method === PaymentMethod.NOWPAYMENTS`.
   Karena ini redirect-UX (bukan QR), object yang dicache di `order.paymentRef`
   cukup `{invoiceId, invoiceUrl}` (JSON.stringify) — TIDAK perlu field
   diskriminator gateway yang dipakai task 6 (NOWPayments tidak share kolom
   dengan gateway IDR manapun, currency-nya beda/USDT). Amount yang dikirim ke
   `createNowpaymentsInvoice` adalah `usdtFromIdr(order.totalAmount-equivalent, ...)`
   — TAPI `order.totalAmount` untuk order USDT SUDAH dalam USDT (lihat
   `finalizeOrderPayment` task 2) — jadi langsung pakai `order.totalAmount`
   sebagai `amountUsd`, JANGAN konversi dua kali.
5. **Route baru `POST /pay/nowpayments/callback`** — BEDA dari pola TokoPay/
   PayDisini: baca `req.headers["x-nowpayments-sig"]` (bukan field body), pass
   header + `req.body` (sudah di-parse Fastify, tidak perlu raw body) ke
   `verifyIpn`. Jika null → 403. Jika `!paid` → 200 ignored (status
   waiting/confirming/dll). Lookup order by `verifyIpn` result `orderId` (ini
   adalah `order.orderCode`, BUKAN numeric order.id — pastikan `createInvoice`
   di langkah 4 mengirim `order_id: order.orderCode` sebagai `args.orderId`
   supaya lookup konsisten dengan `getOrderByCode`). Amount sanity check sama
   (never deliver short payment → `recordUnmatchedNowpaymentsTx`). Selalu balas
   200 kecuali bad signature (403)/disabled (403).

**Edit templates:**
- `apps/storefront/views/checkout.njk` — radio option ke-5, `value="nowpayments"`,
  gated `nowpayments_enabled`, key i18n `web.pay_nowpayments_*` (ditambahkan di
  task 14 — jangan duplikat di sini, sama seperti catatan koordinasi task 6).
- `apps/storefront/views/pay.njk` — branch `is_nowpayments`: tombol/link besar
  ke `gateway.invoiceUrl` (mirror blok `payUrl` TokoPay yang sudah ada — ANCHOR
  sederhana, BUKAN markup QR).

**Test:** `apps/storefront/test/nowpayments-webhook.test.ts` — trio happy/
bad-signature/unmatched, tapi signature di test harus dihitung benar via
HMAC-SHA512-sorted-keys nyata (reuse helper sort dari task 9 lewat import, atau
tulis ulang versi test-only kecil — tapi LEBIH BAIK import dari
`@app/core/payments/nowpayments` jika diekspos, supaya test gagal kalau
implementasi sort-nya berubah/rusak). Tambah juga case `method: "nowpayments"`
ke describe checkout di `storefront.test.ts` (mirror Bybit).

**Done when:** semua di atas + test lulus; `pnpm test` & `pnpm -r typecheck` hijau.

---

## Task 13: NOWPayments — admin settings whitelist + card UI

**File 1: `apps/web-admin/src/routes/settings.ts`**
- Tambah 4 entries `EDITABLE`: `nowpayments_api_key`, `nowpayments_ipn_secret`,
  `nowpayments_enabled`, `nowpayments_pay_currency` (label jelaskan ini rail
  crypto, mis. "Underlying crypto network for NOWPayments — e.g. usdttrc20
  (USDT on TRON), usdtbsc, usdterc20").
- `const PAY_NOWPAYMENTS_KEYS = new Set([...4 keys di atas])`.
- Tambah **KEDUA** `nowpayments_api_key` DAN `nowpayments_ipn_secret` ke
  `SECRET_KEYS` (beda dari PayDisini — di sini dua-duanya genuine secret).
- Tambah ke `grouped`, wire `pay_nowpayments_fields: pick(PAY_NOWPAYMENTS_KEYS)`
  ke context view.

**File 2: `apps/web-admin/views/settings.njk`** — card baru, judul "USDT via
NOWPayments (hosted crypto invoice)", field `nowpayments_pay_currency` sebagai
text input biasa (placeholder `"usdttrc20"`) — konsisten dengan macro
`setting_form` yang sudah ada (jangan buat dropdown/select baru, di luar
lingkup).

**Test:** sama catatan seperti task 7 — extend test settings yang sudah ada
jika ada, atau laporkan di report jika memang belum ada precedent test untuk
route ini sama sekali.

**Done when:** `pnpm -r typecheck` & `pnpm test` hijau.

---

## Task 14: NOWPayments — bot UI (keyboard, handler, dispatcher) + i18n

**Konteks:** NOWPayments masuk sebagai rail USDT ketiga (di samping Binance
Internal & Bybit) di submenu USDT bot, BUKAN tombol top-level seperti PayDisini/
TokoPay (yang IDR). Baca `apps/order-bot/src/keyboards/customer.ts` bagian
`usdtMethodsKb` (submenu USDT) dan `orderConfirmKb` bagian yang menentukan
apakah tombol top-level "USDT" muncul (gabungan OR dari semua rail USDT
enabled).

**File 1: `apps/order-bot/src/keyboards/customer.ts`**
- `usdtMethodsKb(...)` — tambah parameter `nowpaymentsEnabled = false`, tambah
  tombol baru (label key `checkout.pay_nowpayments_btn`, callback prefix
  **`"payn"`** — verifikasi belum dipakai) di samping tombol Binance
  Internal/Bybit yang sudah ada di submenu ini.
- `orderConfirmKb(...)` — boolean yang menentukan tombol top-level "USDT"
  muncul (kombinasi `internalEnabled || bybitEnabled`) harus di-OR dengan
  `nowpaymentsEnabled` juga, supaya tombol USDT tetap muncul walau NOWPayments
  satu-satunya rail USDT yang aktif.

**File 2: `apps/order-bot/src/handlers/checkout.ts`**
- Update kedua call site (`showOrderConfirmation`/`renderOrderConfirmation`)
  untuk menghitung `nowpaymentsEnabled` via `getNowpaymentsCreds(prisma) != null`
  dan teruskan ke `orderConfirmKb`/`usdtMethodsKb`.
- Tambah fungsi `buyNowNowpayments(ctx, productId, quantity)`: buat order via
  `createOrderDirect` lalu `finalizeOrderPayment(tx, id, {currency: USDT, rate, method: NOWPAYMENTS})`
  (mirror `buyNowInternal`/`buyNowBybit` — order-creation shape USDT, BUKAN
  `buyNowTokopay` yang shape-nya IDR), lalu panggil `createNowpaymentsInvoice`
  dan render hasil sebagai `InlineKeyboard.url(...)` button "Buka halaman
  pembayaran" (grammY mendukung tombol URL langsung — TIDAK perlu
  `sendPhoto`/QR seperti jalur TokoPay/PayDisini), pakai `smartEdit` dengan
  keyboard berisi tombol URL + baris cancel/menu standar.

**File 3: `apps/order-bot/src/handlers/callbacks.ts`** — dispatcher baru
terdaftar di key `"payn"`, memanggil `buyNowNowpayments`.

**File 4 & 5: `packages/core/locales/en.json`/`id.json`** — key baru identik
kedua file:
- `checkout.pay_nowpayments_btn` — label tombol submenu USDT.
- `checkout.nowpayments_instructions` — teks bubble di samping tombol URL
  (jelaskan ini hosted page, sebutkan window waktu).
- `web.pay_nowpayments_title`, `_sub`, `_disabled` — dipakai task 12 di
  `checkout.njk` (key harus SAMA PERSIS).
- `web.nowpayments_open_invoice` — label tombol di `pay.njk` (mis. "Buka
  halaman pembayaran").

**Test:** extend `apps/order-bot/test/payment-menu.test.ts` (case
`nowpaymentsEnabled`), cek `apps/order-bot/test/wiring.test.ts` (dispatcher
`"payn"`), pastikan `packages/core/src/locales.test.ts` tetap hijau.

**Done when:** semua di atas; `pnpm test` & `pnpm -r typecheck` hijau.

---

## Verifikasi akhir (setelah Task 14, sebelum whole-branch review)

- `.env.example` — tambah catatan singkat untuk PayDisini & NOWPayments di
  bagian footer "diatur dari web-admin Settings, bukan di sini" (mirror baris
  TokoPay yang sudah ada) — boleh disisipkan sebagai bagian dari task 7/13,
  TIDAK perlu task tersendiri.
- Jalankan `pnpm typecheck` dan `pnpm test` dari root sekali lagi penuh.
- Manual smoke test (didokumentasikan, dijalankan terpisah dari subagent —
  butuh sandbox credentials & ngrok, di luar lingkup subagent dispatch):
  daftar order test dari storefront & bot untuk kedua gateway, bayar via
  sandbox, pastikan auto-deliver via webhook dalam hitungan detik; matikan
  tunnel sebelum bayar sekali lagi untuk membuktikan reconcile poller
  menangkap sebagai fallback.
