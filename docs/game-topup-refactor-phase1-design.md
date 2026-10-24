# Game Top-up Refactor — Phase 1: Arsitektur dan Kontrak

Status: usulan, menunggu persetujuan sebelum Phase 2.
Dasar: laporan Phase 0 (audit AS-IS) dan keputusan pemilik 2026-10-18.
Cakupan: hanya Game Top-up (`CategoryGroup.GAME_TOPUP`), kecuali bagian TTL/reminder yang berlaku untuk semua service. Premium Apps tetap memakai picker aslinya.

## 1. Keputusan yang mengikat desain

| # | Keputusan | Sumber |
|---|---|---|
| D1 | Tidak ada level Server terpisah: pada data Digiflazz region = server, jadi Region menjadi satu-satunya level di bawah edisi (menggantikan usulan awal level Server) | Pemilik |
| D2 | Gift Card tidak dibuat sekarang; desain harus bisa menampung service baru | Pemilik |
| D3 | TTL pembayaran per rail: QRIS/PayDisini 10, Binance Pay 10, Bybit UID 10, Bybit BSC 30, NOWPayments 30 menit | Pemilik |
| D4 | Reminder saat sisa 5 menit, lalu auto-cancel + push pesan batal + edit pesan order | Pemilik |
| D5 | Lifecycle order (PENDING_PAYMENT → ... → DELIVERED), webhook, underpaid, fulfillment Digiflazz tidak diubah | PRD |

Asumsi yang perlu dikonfirmasi: Bybit BSC dihitung "blockchain" (30 menit), dan reminder juga berlaku untuk rail blockchain.

## 2. Pohon katalog metadata-driven

Tidak ada model Game. Tetap: `Category (GAME_TOPUP) → Product → Denomination`.

Level pilihan untuk satu Category dihitung dari data, bukan hardcode:

1. **Variant** (`Product.gameVariant`) — sudah ada.
2. **Region** (`Product.gameRegion`) — sudah ada.
3. **SKU** (`Denomination`).

Aturan tiap level, sama dengan perilaku variant/region sekarang (`browseCategoryEntry`, `customer.ts:491`):

- Level muncul hanya bila kategori punya lebih dari satu nilai non-null pada level itu.
- Kategori "campuran" (sebagian produk punya nilai, sebagian tidak) melewati level itu.
- Hanya satu pilihan → dilewati, dengan flag skip di `scratch` seperti `gameVariantDimensionSkipped`.
- Satu produk tersisa setelah filter → langsung ke SKU picker.
- Pilihan memakai indeks ke snapshot di `scratch`; callback hanya membawa indeks/id numerik (< 64 byte).

Urutan hierarki: Variant → Region → SKU. Region hanya valid di dalam edisi yang dipilih; filter berlaku kumulatif.

Sumber data dari Digiflazz (keadaan akhir Phase 2): tidak ada level Server (`gameServer` dihapus); region = server pada data Digiflazz. Edisi dipisah dari `type` Digiflazz menjadi `gameVariant` (mis. Arena Breakout vs Arena Breakout Infinite). Dua game bernama sama dengan akhiran publisher/distribusi berbeda adalah dua `Product` terpisah dan tidak pernah digabung. `gameRegion` diisi otomatis saat import Digiflazz (create-only, lihat bagian "Hasil akhir Phase 2"). Aturan "kategori campuran melewati level" kini berlaku juga untuk Region di bot, bukan hanya Variant.

## 3. Kontrak input akun (satu pesan)

### 3.1 Kontrak kanonis

Draft menyimpan **field terstruktur bertipe string**, tidak pernah gabungan:

```ts
type AccountInput = Record<string, string>; // kunci = key field SKU, mis. user_id, zone_id, server_id
```

- Sumber kebenaran field: `Denomination.additionalFields` (sudah ada) dan `providerInputMapping`. Tidak ada daftar field per game yang di-hardcode.
- Penggabungan untuk Digiflazz tetap hanya di `buildPlayerTarget` (`packages/core/src/playerInput.ts`); tidak berubah.

### 3.2 Parser satu pesan

Fungsi murni baru di `packages/core` (mis. `parseAccountMessage(fields, text)`), tanpa dependensi DB agar bisa masuk `test:guards` bila perlu.

Aturan:
- Input dipotong spasi di ujung; string tidak pernah dikonversi ke Number (leading zero dan angka panjang utuh).
- Jumlah field 1: seluruh teks adalah nilai field itu, divalidasi `validateFieldAnswer` yang sudah ada.
- Jumlah field 2 atau lebih: ID dan Zone dikirim dalam **satu pesan, tanpa kurung** (keputusan pemilik). Pemisah yang diterima, dalam urutan field SKU:
  - `A B` (satu atau lebih spasi) — contoh `123456789 1234`
  - `A,B`
  - `A:B`
- Angka menyambung tanpa pemisah (mis. `1234567891234`) ditolak sebagai ambigu, kecuali konfigurasi game menetapkan panjang zone tetap. ID Mobile Legends panjangnya bervariasi sehingga tidak bisa dipecah dengan andal.
- `A(B)` boleh ditoleransi saat parsing, tetapi tidak pernah diiklankan: tidak ada hint, contoh, atau teks bantuan yang memakai kurung.
- Ambigu (token lebih atau kurang dari jumlah field, pemisah campuran, kurung tidak seimbang) → ditolak dengan pesan dan contoh tanpa kurung, tidak ditebak.
- Hasil: `{ ok: true, values }` atau `{ ok: false, reason: "missing_field" | "too_many" | "bad_format" | "invalid_value", field? }`.
- Validasi per field memakai aturan SKU yang sudah ada (pola, min/max); parser tidak membuat aturan baru.

Field bertipe select (mis. server dari daftar) tetap memakai tombol, bukan teks; parser hanya mengurus field teks.

### 3.3 Hasil cek nickname

Status untuk UI: `verified | invalid | not_found | unavailable | unchecked`.
- `unavailable` (timeout, error provider, tidak ada kredensial) tidak menghalangi lanjut ke pembayaran dan tidak ditampilkan sebagai "akun salah".
- Catatan Phase 0: adapter KokinPay memetakan semua `status:false` ke `INVALID_TARGET`. Phase 3 hanya menampilkan apa yang adapter bisa bedakan; jangan mengarang perbedaan. Memisahkan kode galat di adapter adalah perubahan terpisah yang butuh dokumentasi API KokinPay.

## 4. GameCheckoutDraft

Tidak ada tabel baru. Draft tetap di `session.scratch` (Postgres-backed, TTL 24 jam), memakai kunci yang sudah ada (`categoryId`, `resolvedGameVariant`, `resolvedGameRegion`, `productId`, `variantId`, `customerData`, `checkoutIntentId`, `customerInputOwner`) ditambah:

| Kunci baru | Isi |
|---|---|
| `reviewPriceTotal` | total (string Decimal) yang ditampilkan di layar review, untuk `expectedTotal` (Phase 3, belum dibuat) |

Kunci scratch Phase 2 yang kini ikut dipakai: `gameVariantDimensionSkipped` dan `gameRegionDimensionSkipped` (boolean; scope campuran, level dilewati dan semua produk scope itu dicantumkan). Tidak ada kunci untuk level Server karena level itu tidak ada.

Aturan:
- Callback pilihan membawa indeks; indeks dicek terhadap snapshot, tidak cocok → toast "layar usang".
- `customerInputOwner` (sudah ada) membatalkan `customerData` bila SKU/field berubah.
- Draft tidak menyimpan nickname sebagai kebenaran; nickname hanya tampilan.
- Semua nilai di `scratch` harus JSON-serializable.

## 5. Navigasi, back stack, dan siklus pesan

- Back tetap dihitung dari `scratch` (`handleBackButton`, `customer.ts:241`); urutan pengecekan tidak berubah (variant, region, product).
- Satu bubble navigasi aktif: `smartEdit` untuk callback, `menuAnchor`/`editAnchor` untuk input teks. Input yang diterima dihapus dengan `consumeInput`.
- Matriks edit/kirim/hapus (mengikuti "Telegram message budget" di AGENTS.md):

| Kejadian | Aksi |
|---|---|
| Pilih level (variant/region/SKU) | edit bubble aktif |
| Input akun valid | hapus pesan user, edit prompt menjadi review |
| Input akun salah | hapus pesan user, edit prompt dengan galat + contoh |
| Change details | edit review kembali ke prompt input |
| Continue to payment | edit review menjadi layar order/rail (alur `showOrderConfirmation` yang ada) |
| Callback usang | `answerCallbackQuery` dengan toast, tidak ada pesan baru |
| Reminder bayar | `sendMessage` baru (push, pengecualian sah) |
| Order batal otomatis | push pesan batal + edit pesan order/QR (jalur `notifyAutoCancelled` yang ada) |

- Tes Phase 2/3 menyatakan jumlah persis `sendMessage`/`edit*`/`deleteMessage`.

## 6. Layar review dan handoff checkout

Teks review (lokal sesuai bahasa pembeli) menampilkan: game, variant/region/server bila ada, paket, field akun (ID, zone/server), nickname bila `verified`, harga total final dan mata uang. Harga lewat formatter bahasa pembeli (`ctxPriceFormatter` / `formatIdrFor`), tidak ada format manual.

Tombol:
- `Continue to payment` → alur existing `showOrderConfirmation` (voucher, wallet, rail), tanpa state machine kedua.
- `Change details` → kembali ke prompt input akun (data lama tidak dihapus sampai diganti).
- `Back` → satu level.

Panjang label mengikuti `buttonLimits.ts` dan `keyboard-label-guard`.

### 6.1 Cek harga (uang)

- Bot mengirim `expectedTotal` (dari `reviewPriceTotal`) ke `createOrderDirect` pada semua `buyNow*` dan `completeOrderWithWallet`.
- `QuoteMismatchError` ditangkap: tampilkan total baru dan minta konfirmasi ulang; tidak membuat order.
- Idempotensi memakai `checkoutIntentId` yang sudah ada; `refuseDuplicateCheckout` dan `claimGatewaySlot` tidak diubah.
- Karena menyangkut uang, logika ini dikerjakan dan direview dengan model Opus.

## 7. Search

- Mode input `search` eksplisit; hanya pesan teks pada sesi pencarian dianggap query.
- Normalisasi huruf besar/kecil dan spasi; ranking exact → prefix → substring.
- Alias: tabel/konfigurasi alias per Product perlu keputusan. Usulan Phase 2: pakai kosakata deteksi yang ada (`detectionKnowledge.ts`) bila sudah memuat alias game; jika tidak, tunda alias dan catat sebagai batasan.
- Pagination dan "Search again"; kosong/galat punya layar sendiri.
- Hasil diberi label tipe layanan berdasarkan registry `services.ts` / `CategoryGroup`, sehingga service baru (mis. Gift Card) cukup mendaftar entri baru. Tidak ada tipe Gift Card sekarang.
- Satu query ke DB per pencarian dengan `take` terbatas; tombol halaman memakai snapshot di `scratch`, tanpa query ulang yang berat.

## 8. Label harga `From`

- Dihitung dari denominasi aktif dan benar-benar bisa dibeli (`isActive`, tidak diarsipkan, tersedia), memakai `effectiveUnitPrice` (`packages/core/src/flash.ts`), mengikuti `shapeProducts` di storefront.
- Ditampilkan hanya pada daftar produk Game Top-up (bukan Premium Apps), dengan formatter bahasa pembeli.
- Harga dibaca per render dari DB; tidak di-cache lintas pengguna kecuali cache ringan dengan TTL pendek yang disetujui di Phase 2.

## 9. TTL pembayaran dan reminder

### 9.1 TTL per rail

Sumber tunggal tetap `packages/core/src/config.ts` (env), tanpa hardcode di handler.

Tabel final (keputusan pemilik, diterapkan di Phase 4 Task 4). Berlaku untuk semua layanan (Game Top-up dan Premium Apps), bot dan storefront, termasuk top-up saldo wallet karena memakai config yang sama.

| Variabel | Rail | Default lama | Default final |
|---|---|---|---|
| `PAYMENT_WINDOW_MINUTES` | TokoPay QRIS, PayDisini, juga stempel awal setiap order | 30 | 10 |
| `INTERNAL_PAYMENT_WINDOW_MINUTES` | Binance Pay | 15 | 10 |
| `BYBIT_PAYMENT_WINDOW_MINUTES` | Bybit UID | 30 | 10 |
| `BYBIT_BSC_PAYMENT_WINDOW_MINUTES` | Bybit BSC on-chain | 15 | 30 |
| `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES` | NOWPayments | 30 | 30 |

Keputusan pemilik yang mengikat:
- Order yang sudah dibuat tetap memakai `expiresAt` lamanya; default baru hanya berlaku untuk order baru.
- Rail deposit (Binance Pay, Bybit UID, Bybit BSC) tetap ketat: deposit setelah `expiresAt` tidak dicocokkan.
- Rail webhook (TokoPay, PayDisini, NOWPayments): pembayaran yang datang setelah auto-cancel tetap memakai alur "pembayaran basi → alert admin" yang sudah ada; tanpa grace tambahan dan tanpa kredit wallet otomatis.

Anggaran siklus poller rekonsiliasi QRIS/IDR kini diturunkan dari jendela rail-nya (`reconcileBudgetForWindow`, `packages/core/src/payments/reconcileCycleBudget.ts`): satu siklus maksimal 40% jendela, sehingga deadline siklus tetap di bawah setengah jendela (invarian yang diuji di `poll-loop-wiring.test.ts`). Jendela 10 menit → 14 order per siklus, 240 detik; jendela 30 menit → 46 order per siklus, 720 detik. Anggaran tetap lama 780 detik akan menjadi 130% jendela 10 menit.

Peringatan deploy: bila `.env` produksi sudah menetapkan variabel ini, default baru tidak berlaku sampai `.env` diubah. Order lama membawa `expiresAt` lama dan tidak terpengaruh. Perubahan ini masuk checklist deploy dan `docs/ENVIRONMENT_VARIABLES.md`.

Risiko yang diaudit di Phase 4 sebelum default diubah: pembayaran yang terdeteksi setelah expiry (jalur `status === "stale"` dan `enqueueAdminStalePayment`), balapan webhook vs `autoCancelExpiredOrders` (job per menit, granularitas hingga sekitar 1 menit), dan rail QRIS/PayDisini yang kode QR-nya mungkin masih hidup di sisi gateway setelah order dibatalkan.

#### Pemulihan klaim "matched" yang macet (Phase 4 Task 4b)

Keenam rail auto-confirm meng-commit klaim `processed_*_tx` (outcome `matched`) **sebelum** transaksi delivery; `paymentState: "PAID"` dan transisi status baru ditulis di dalam transaksi itu. Bila proses mati di antara keduanya, order tetap `PENDING_PAYMENT` dan `autoCancelExpiredOrders` membatalkannya saat `expiresAt`. Satu-satunya pemulihan adalah `reclaimStaleMatchedClaim` (`packages/db/src/crud/_staleClaim.ts`), yang hanya berlaku untuk klaim yang lebih tua dari `STALE_MATCHED_CLAIM_MS` dan order yang masih `PENDING_PAYMENT` (atau top-up wallet yang dibatalkan).

- `STALE_MATCHED_CLAIM_MS` diturunkan dari 10 menit ke **2 menit**. Batas bawah: delivery paling lama memegang klaimnya sekitar 20 detik (`maxWait` 5 s di `packages/db/src/client.ts` + `{ timeout: 15000 }` transaksi delivery; query engine me-rollback transaksi yang melewati timeout), jadi 2 menit = enam kali lipat. Batas atas (invarian, diuji di `stale_matched_claim.test.ts` terhadap default `Env`): harus jauh di bawah setengah jendela terpendek (10 menit).
- Pemanggil terjadwal yang memicu pemulihan: poller rekonsiliasi TokoPay/PayDisini/NOWPayments (tiap `POLL_INTERVAL_SECONDS` = 10 s, ≤14 order per siklus dengan cursor berputar) dan poller deposit Binance (10 s), Bybit UID dan Bybit BSC (5 s), yang mengambil ulang riwayat transfer setiap siklus; plus retry webhook gateway (jadwalnya milik gateway). Klaim yang macet pulih sekitar 2 menit + satu siklus poll (+ backoff 429 sampai 30 s, + putaran cursor bila backlog > 14). Pada jendela 10 menit, crash di ~7,5 menit pertama jendela masih pulih; crash di menit-menit terakhir tetap tidak pulih sebelum auto-cancel.

**OPEN OWNER FOLLOW-UP (belum dibangun):** klaim `matched` yang order produknya sudah `CANCELLED` tidak punya alert admin maupun jalur kredit.
- `_staleClaim.ts:88` menolak reclaim untuk order produk yang bukan `PENDING_PAYMENT`, jadi retry webhook/poller berikutnya hanya mengembalikan `already_processed` (log info, mis. `tokopay.ts:193-208`), tidak pernah `stale`, sehingga `enqueueAdminStalePayment` tidak terpanggil.
- `customerPaymentOutstanding` (`packages/db/src/crud/orders.ts:1506-1511`) tidak melindungi order ini karena `paymentState` masih `WAITING`/null; `autoCancelExpiredOrders` (`apps/order-bot/src/jobs/index.ts:493`) membatalkannya.
- `canCreditCancelled` (`orders.ts:3242-3253`, `3332-3336`) bergantung pada `orderHasIncomingLedgerPayment` (`packages/db/src/crud/reports.ts:454`), yang hanya menghitung outcome `delivery_failed`/`unmatched` (`ACTIONABLE_LEDGER_OUTCOMES`), bukan `matched`.
- Pilihan untuk pemilik: alert admin (job/sweeper) untuk baris `matched` yang order-nya `CANCELLED`, dan/atau memasukkan kasus itu ke jalur kredit dengan bukti tambahan bahwa delivery tidak pernah commit.

### 9.2 Reminder

Keputusan final (Phase 4 Task 5 + perbaikan review T5b):
- Event `NotificationEvent.PAYMENT_REMINDER_DM`, bukan status order. Job `sendPaymentReminders` (order-bot, croner `47 * * * * *`, `protect: true`) memanggil `listExpiringPendingPayments(db, now, now + lead)`; tidak ada timer per order. Job hanya enqueue; dispatcher outbox yang mengirim.
- `lead` = env `PAYMENT_REMINDER_LEAD_MINUTES` (bukan Settings), default 5, `0` mematikan. Nilai yang tidak terpakai (negatif, bukan angka, < 1) juga mematikan tanpa menggagalkan boot, dan order-bot menulis satu `logger.warn` saat start (`unusablePaymentReminderLeadWarning`, `packages/core/src/config.ts`). Hanya order dengan `expiresAt − createdAt` lebih besar dari `lead` dan sisa waktu ≥ 60 detik (`paymentReminderHasTimeLeft`, satu pembanding untuk enqueue dan kirim).
- Dedupe: `dedupeKey = payment_reminder:<orderId>` pada `NotificationOutbox` (unik) → satu reminder per order walau job ganda atau restart. Baris yang dilewati tetap memegang key.
- Kelayakan dicek dua kali dengan predikat yang sama, `awaitingPaymentNothingObserved` (`packages/core/src/paymentReminder.ts`): saat enqueue (`isPaymentReminderCandidate`) dan saat kirim (`paymentReminderSkipReason`, baca ulang order). Hanya `paymentState` null atau `WAITING_PAYMENT`, tanpa `paidAt`, dan `walletCreditState` bukan `NEEDS_REVIEW` yang boleh diingatkan. Semua state lain (`PAYMENT_DETECTED`, `VERIFYING`, `PAID`, `UNDERPAID`, `FAILED`, `EXPIRED`, `REFUNDED`, state baru) menekan reminder: pembeli yang transfernya sudah terlihat lalu membaca "sisa N menit, setelah itu dibatalkan" bisa membayar dua kali. Alasan skip: `ORDER_NOT_FOUND`, `ORDER_NOT_AWAITING_PAYMENT`, `PAYMENT_WINDOW_CLOSING`, `PAYMENT_ALREADY_RECEIVED` (PAID/`paidAt`/`NEEDS_REVIEW`), `PAYMENT_IN_PROGRESS` (state lain yang sudah dilaporkan provider).
- Deadline di pesan berasal dari `expires_at` payload = `expiresAt` order saat enqueue. `expiresAt` hanya distempel saat pembuatan order (stempel awal + jendela rail dari `finalizeOrderPayment`/`finalizeWalletTopupPayment` di transaksi pembuatan yang sama) dan tidak pernah digeser.

**OPEN OWNER ITEM (belum dibangun):** `autoCancelExpiredOrders` (`apps/order-bot/src/jobs/index.ts:542-544`) memakai `listExpiredPendingOrders` dengan predikat longgar `customerPaymentOutstanding` (`packages/db/src/crud/orders.ts:1508-1513`, hanya mengecualikan `PAID` dan `NEEDS_REVIEW`). Order NOWPayments yang `PENDING_PAYMENT` dengan `paymentState` `PAYMENT_DETECTED`/`VERIFYING` (ditulis oleh `recordProviderPaymentObservation`, `packages/db/src/crud/orderStatus.ts:234-249`; dipanggil dari `apps/order-bot/src/payments/nowpaymentsReconcile.ts:241` dan `apps/storefront/src/routes/checkout.ts:1588`) tetap dibatalkan otomatis saat `expiresAt`. Sudah ada sebelum Phase 4; jendela yang lebih pendek membuatnya lebih sering. Reminder sudah menekan kasus ini, tetapi auto-cancel tidak diubah tanpa keputusan pemilik (pilihan: tunda cancel selama pembayaran terdeteksi, atau beri grace/alert admin).
- Isi pesan: nomor order lengkap, sisa waktu aktual, deadline dengan format `yyyy-LL-dd HH:mm WIB` seperti builder rail, plus kalimat bahwa pesanan dibatalkan otomatis setelah batas waktu (auto-cancel memang ada). Tanpa kredensial. Dua bahasa (`en.json`, `id.json`).
- Kegagalan Telegram: retry dan backoff outbox yang ada (maks. 10 percobaan, DEAD_LETTER); blokir/403 tidak mengubah status order.
- Saat expiry: jalur `autoCancelExpiredOrders` → `cancelOrder` → `notifyAutoCancelled` dipertahankan. Phase 4 memverifikasi bahwa pesan order/QR ikut diedit menjadi "dibatalkan" (`editPaymentBubble`, `ownsTransactionMessage`, `wakeFulfillmentMessage`); bila belum, tambahkan di jalur itu.
- Kode mati `handlers/checkout/timers.ts` (`timersByOrder` tidak pernah ditulis) sudah dihapus di Phase 4 Task 4 dan tidak dihidupkan kembali.

**Perilaku final dua push (Phase 4 Task 5/6 + perbaikan T5b/T6b).** Keduanya dicek ulang saat kirim oleh dispatcher outbox; baris yang dilewati tetap memegang dedupe key (satu push per order).

| Push | Dikirim bila | Dilewati bila |
|---|---|---|
| Reminder (`PAYMENT_REMINDER_DM`, `payment_reminder:<id>`) | order `PENDING_PAYMENT`, sisa ≥ 60 detik, dan belum ada pembayaran yang terlihat (`awaitingPaymentNothingObserved`) | pembayaran apa pun sudah terlihat (`PAYMENT_DETECTED`, `VERIFYING`, `UNDERPAID`, `PAID`, `paidAt`, `NEEDS_REVIEW`, dll.) |
| Expiry push (`ORDER_EXPIRED_DM`, `order_expired:<id>`) | order masih `CANCELLED` — termasuk bila provider sudah melihat pembayaran (`PAYMENT_DETECTED`/`VERIFYING`/`UNDERPAID`): justru pembeli ini yang perlu "jika sudah bayar, hubungi Bantuan" | order keluar dari `CANCELLED` (top up terlambat yang diselesaikan → `DELIVERED`), `paymentState` `PAID` atau `paidAt` terisi, atau `walletCreditState` `CREDITED`/`NEEDS_REVIEW` (`orderExpiredDmSkipReason`) |

Expiry push hanya diantrikan bila pembatalan tidak mengirim pesan baru ke chat pembeli (edit pesan tidak berbunyi). Teks top up berbeda dari order produk: tanpa baris "stok dilepas" (`order.auto_cancelled_topup`), dan push top up mengatakan pembayaran terlambat masuk ke saldo otomatis; hubungi Bantuan bila saldo belum bertambah.

Celah yang diterima (didokumentasikan, tidak dikompensasi):
- Worker gagal mengirim pesan pengganti saat memensiunkan foto QR (400 → `STOPPED`, gangguan transport → `UNCERTAIN`): pembeli bisa tidak menerima pemberitahuan, dan tidak ada push.
- Baris koordinator lama dengan `messageKind` null dianggap mungkin foto → tidak ada push (bila sebenarnya teks, pembeli hanya mendapat edit tanpa bunyi).
- Crash di antara commit pembatalan dan `queueExpiryPush` pada rute anchor/tanpa-anchor menghilangkan push (jendela yang sama seperti sebelum Phase 4).
- Push dan edit oleh worker berjalan asinkron, jadi urutannya bisa terbalik.

### 9.3 Feature flag

Tidak ada feature flag:
- ~~Flag alur Game Top-up v2~~ — flag ini dihapus pada 2026-10-19 atas keputusan pemilik; alur katalog Game Top-up (label `From`, hint, `/search`) menjadi bawaan dan tidak ada saklarnya lagi.
- ~~`payment_reminder_enabled`~~ — tidak dibuat; reminder dimatikan lewat env `PAYMENT_REMINDER_LEAD_MINUTES=0` (lihat 9.2).

TTL baru juga tidak di bawah flag (konfigurasi env); rollback = kembalikan nilai env.

## 10. Fixture dan rencana tes

Fixture di `apps/order-bot/test/helpers` / `__fixtures__` (perubahan fixture memicu seluruh suite):
- Mobile Legends: dua field (User ID + Zone), satu region.
- Free Fire: satu field, region.
- Delta Force: satu field, tanpa region.
- Kategori campuran (sebagian produk tanpa region), satu region saja (dilewati), nol SKU aktif.
- Kategori Premium Apps sebagai kontrol: tidak ada kontrol game yang muncul.

Tes yang harus ada, per fase:
- Phase 2: pohon level (variant/region), skip, kategori campuran, stale callback, search (exact/prefix/kosong/panjang), `From`, jumlah panggilan Telegram.
- Phase 3: parser (`123456789 1234`, `123456789,1234`, `123456789:1234`, leading zero, angka panjang, angka menyambung ditolak, `A(B)` ditoleransi tetapi tidak muncul di teks apa pun, ambigu, kurang field, bukan angka), nickname `unavailable` tidak memblokir, tap ganda Continue tidak membuat dua order, harga berubah → reconfirm, user lain menekan callback.
- Phase 4: reminder untuk pending, dibayar sebelum jadwal, dibayar saat dikirim, expired, cancelled, worker ganda, restart, Telegram gagal, sisa waktu < lead, per rail TTL.
- Guard baru: parser murni (tanpa DB) masuk `test:guards`; pengecekan panjang `callback_data` ≤ 64 byte untuk callback baru.

Perintah verifikasi mengikuti AGENTS.md: `pnpm exec vitest run <path>` / `pnpm test:changed` per tugas, `pnpm typecheck && pnpm test` penuh sekali sebelum merge, dan `pnpm doctor:full` bersih bila ada perubahan klien React.

## 11. Urutan implementasi dan model

| Fase | Isi | Catatan |
|---|---|---|
| 2 | Label `From`, hint, search | Tanpa perubahan skema |
| 3 | Parser, review, Continue/Change details, `expectedTotal` | Logika uang → Opus untuk implementasi dan review akhir |
| 4 | TTL per rail, reminder, verifikasi edit pesan batal | Menyentuh pembayaran → Opus; audit race sebelum ubah default |
| 5 | Regresi penuh, stub E2E, runbook migrasi dan rollback | Tidak ada deploy otomatis |

## 12. Hal yang belum terjawab

1. Bybit BSC dan NOWPayments dianggap "blockchain" (30 menit) dengan reminder juga: konfirmasi pemilik.
2. Alias search: sumber data alias belum diputuskan (kosakata deteksi vs tabel baru).
3. Format kawat Digiflazz dan KokinPay masih ⚠ UNVERIFIED di kode; Phase 3 tidak mengubah kontraknya dan tidak bisa membuktikannya tanpa akun live.
4. Apakah rail wallet (saldo) punya TTL sendiri: tidak ada pembayaran menunggu, jadi tidak terpengaruh; perlu dicek di Phase 4.

## 13. Hasil Phase 2

Catatan 2026-10-19: flag alur Game Top-up v2 dihapus atas keputusan pemilik; label `From`, hint, dan `/search` baru kini selalu aktif untuk Game Top-up (dipilih lewat `category.group`) dan tidak pernah muncul untuk Premium Apps. Tidak ada perubahan skema atau kontrak data pada Phase 2: pada data Digiflazz region = server, jadi tidak ada level Server terpisah.

Selesai:
- Label harga pada daftar produk Game Top-up (bot menampilkan `mulai <harga>` / `from <price>` sesuai bahasa pembeli).
- Hint satu baris `hint.*` per layar (tabel di bawah).
- `/search` khusus Game Top-up: berperingkat, label tipe layanan, halaman, "Search again". Alias dibaca dari tabel basis pengetahuan deteksi `detection_aliases`; daftar bawaannya **kosong**, jadi alias baru bekerja setelah admin menambahkan baris.

| Layar | Kunci locale | Contoh (tanpa kurung) |
|---|---|---|
| Daftar game | `hint.game_list` | `Pick a game, or type /search to look one up.` |
| Variant | `hint.variant` | `Choose the game edition.` |
| Region | `hint.region` | `Choose your account region.` |
| Paket | `hint.packs` | `Pick a pack to see its details.` |
| Search | `hint.search`, `hint.search_empty` | `Type a game name, then pick a result.` |
| Input akun (Phase 3) | belum ada | `123456789 1234` |

Ditunda:
- Parser input akun satu pesan (bagian 3.2, Phase 3).
- Layar review dan `expectedTotal` (bagian 6, Phase 3).
- TTL per rail dan reminder pembayaran (bagian 9, Phase 4).

## 14. Hasil akhir Phase 2

Keadaan akhir cabang `worktree-game-topup-refactor` (diverifikasi terhadap kode, 2026-10-19):

- **Level server dihapus.** Region = server pada data Digiflazz, satu level. Edisi dipisah dari `type` Digiflazz ke `gameVariant`. Game bernama sama dengan akhiran publisher/distribusi berbeda tetap `Product` terpisah, tidak pernah digabung.
- **Flag dihapus.** Label `mulai …` (`From`), hint satu baris, dan `/search` baru (khusus Game Top-up, berperingkat, label layanan, halaman, "Search again", alias dari `detection_aliases` yang bawaannya kosong) selalu aktif untuk Game Top-up. Hint daftar game pada daftar produk datar hanya ditambahkan bila setiap produk di halaman itu Game Top-up.
- **Isi region otomatis saat import Digiflazz**: create-only, dari akhiran region grup lewat `gameRegionLabel` (`packages/core/src/regionLabel.ts`, tabel putih DRAFT berlabel emoji bendera; singkatan `id`/`sg`/`my` asumsi; menambah negara = satu baris; kata publisher tidak pernah menjadi label). Respons apply memuat `regions[]` (`written`, `skippedReason`: `product_exists`, `no_suffix`, `unrecognized_suffix`, `no_matching_group`, `no_price_list`, `not_game_topup_category`) dan toast admin hanya melaporkan skip yang bisa ditindak.
- **Guard scope campuran di bot**: bila ada produk layak tampil di scope (kategori + edisi) tanpa region, level Region dilewati dan semua produk dicantumkan; tidak ada yang menghilang.
- **Backfill produk lama**: `pnpm exec tsx scripts/fill-game-regions.ts` (dry run default, `--apply`, `--category-ids=`; menolak DB non-lokal tanpa `--i-know-this-is-not-local`). Semua-atau-tidak per scope (kategori GAME_TOPUP, `gameVariant`), compare-and-set, audit per produk, `bumpCatalogRevision`. Risiko sisa: READ COMMITTED, saudara yang di-commit antara hitung ulang dan COMMIT tidak terlihat; jalankan saat tidak ada sync/import. Pemilik sebaiknya dry run dan meninjau laporan sebelum `--apply`. Rincian operator ada di `DOCS.md` (bagian katalog Game Top-up).
- **Deploy**: tidak ada perubahan skema dibanding `master` (skema `Product` identik), tidak ada migrasi untuk cabang ini.

Belum dikerjakan dan tidak boleh dianggap selesai:
- Phase 3 (parser input akun satu pesan, layar review, `expectedTotal`) belum dibuat.
- Phase 4 (TTL per rail, reminder, verifikasi edit pesan batal) belum dibuat.
- Format kawat Digiflazz dan KokinPay yang live tetap belum terverifikasi (butuh akun live); bentuk akhiran region di data nyata juga belum dilihat, jadi tabel label dan heuristik `possible_doubled_suffix` perlu ditinjau pemilik.
