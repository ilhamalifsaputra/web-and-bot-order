# Phase 1: Bybit BSC Confirmation Tracking (status model + live tracking screen)

> **Status:** selesai & merged — PR #17 (`blockchain-order-tracking` → `master`,
> commit `a5378f4`, merge commit `4e6e2d5`). Dieksekusi langsung di sesi Claude
> Code (tanpa subagent-driven-development), TDD per modul.

## Context

Toko ini jual barang digital (`StockItem.credentials`) — bukan crypto. Tidak
ada custody wallet, tidak ada smart contract, tidak ada "blockchain" di sisi
toko sama sekali. Yang ada cuma **satu** rail pembayaran yang kebetulan
on-chain: **Bybit BSC** (USDT BEP20) — pembeli kirim USDT ke alamat deposit
yang dikustodi Bybit, dan Bybit sendiri yang melaporkan status depositnya
(1/2 = belum final, 3 = "Success") lewat `GET /v5/asset/deposit/query-record`
yang sudah dipoll oleh `bybitBscDeposit.ts` (lihat PR #16, "restore Bybit BSC
on-chain deposit").

Sebelum Phase 1, poller itu **membuang** baris deposit yang belum status 3
(`normalizeOnchainDeposit` men-filter `status !== STATUS_SUCCESS`) — pembeli
yang sudah kirim USDT tidak melihat apa-apa sama sekali sampai Bybit akhirnya
melaporkan "Success" (bisa 1-2 menit, kadang lebih kalau jaringan BSC padat).
Selama jendela itu, bubble pembayaran masih menunjukkan instruksi
"kirim ke alamat ini" yang sudah basi — tidak ada sinyal bahwa sistem sudah
"melihat" pembayarannya.

**Tujuan Phase 1:** kasih pembeli sinyal progres yang JUJUR (bukan animasi
palsu) antara "saya sudah kirim" dan "barang sudah dikirim", dengan menambah
poller kedua yang baca *block explorer* (BscScan-compatible JSON-RPC, publik,
read-only) untuk hitungan konfirmasi on-chain yang ASLI — murni tampilan,
tidak pernah jadi gerbang pengiriman barang.

## Non-goals (sengaja TIDAK dikerjakan di Phase 1)

- **Tidak custody wallet apa pun** — toko tetap tidak pernah menyentuh kunci
  privat/saldo on-chain. Bybit tetap satu-satunya pihak yang menerima dana.
- **Tidak mengganti gerbang pengiriman** — `deliverPaidBybitBscOrder` (gated
  status-3 Bybit) tetap satu-satunya jalan ke `PENDING_VERIFICATION` →
  `DELIVERED` untuk rail ini. Confirmation count dari tracker baru ini cuma
  dekorasi UI.
- **Tidak menyentuh rail pembayaran lain** (TokoPay/PayDisini/NOWPayments/
  Binance Internal/Bybit Internal Transfer/manual proof) — keempat status
  baru (`PAYMENT_DETECTED`/`CONFIRMING`/`CONFIRMED`/`FAILED`) eksklusif Bybit
  BSC.
- **Tidak menangani chain reorg secara eksplisit** — tracker baca block
  terbaru tiap tick; kalau terjadi reorg yang membuat tx "hilang" lagi,
  perilakunya sama dengan "belum ketemu" (masuk grace period lookup-failure),
  bukan downgrade status yang sudah maju.

## Keputusan desain inti

1. **State machine terpusat, bukan `status: ...` tersebar.** Sebelumnya
   setiap fungsi crud (`deliverPaidTokopayOrder`, `cancelOrder`, dst.) menulis
   `order.status` langsung di tengah query Prisma lain. Phase 1 menambah
   `packages/db/src/crud/orderStatus.ts`:
   - `LEGAL_TRANSITIONS`: peta `from -> to[]` yang sah; status terminal punya
     array kosong.
   - `transitionOrderStatus(db, { orderId, from, to, meta })`: validasi
     bentuk transisi, klaim baris atomik (`updateMany WHERE status=from`,
     pola yang sama dengan klaim `approveOrder`), tulis satu baris
     `OrderStatusHistory` per transisi sukses.
   - `tryTransitionOrderStatus(...)`: varian yang menganggap race-loss (order
     sudah dipindah poller lain) sebagai no-op, bukan error — dipakai setiap
     kali dua poller independen (deposit poller + confirmation tracker) bisa
     menyentuh order yang sama.
   - **Satu pengecualian:** `approveOrder`'s `PENDING_VERIFICATION ->
     DELIVERED` tetap pakai klaim atomiknya sendiri (alasan konkurensi yang
     sudah ada sebelum helper ini lahir) — cuma menambahkan satu baris
     `OrderStatusHistory` manual tepat setelah klaim berhasil.
   - Setiap rail pembayaran lama (`binance_internal.ts`, `bybit_deposit.ts`,
     `tokopay.ts`, `paydisini.ts`, `nowpayments.ts`, `orders.ts` —
     cancel/reject/credit-to-balance) di-retrofit untuk rute lewat fungsi ini,
     supaya satu audit trail (`OrderStatusHistory`) konsisten di semua rail,
     bukan cuma yang baru.

2. **`OrderStatusHistory` adalah tabel terpisah, bukan kolom JSON di
   `Order`** — SQLite tidak bisa index ke dalam array JSON, dan
   `[orderId, occurredAt]` butuh index asli untuk render timeline live
   tracking. `onDelete: Restrict` (bukan `Cascade`) — sama dengan
   `Review`/`Referral`, supaya tidak ada code path yang bisa menghapus order
   sekaligus diam-diam menghapus jejak auditnya.

3. **Dua sumber kebenaran yang independen, sengaja tidak disatukan.**
   `bybitBscDeposit.ts` (status 1/2/3 dari API Bybit sendiri) dan
   `bybitBscConfirmationTracker.ts` (block depth dari block explorer publik)
   tidak pernah saling memanggil fungsi pengiriman satu sama lain. Tracker
   bisa saja melaporkan "15/15 confirmed" sementara Bybit masih status 2 (atau
   sebaliknya) — itu DITERIMA, karena tracker murni dekoratif. Ini juga
   kenapa `CONFIRMED` bukan status yang memicu apa pun selain render ulang
   bubble.

4. **`FAILED` sebagai status terminal-tapi-bisa-di-resolve-admin**, beda dari
   `CANCELLED`/`REJECTED` (selalu inisiatif customer/admin). Dipicu cuma oleh
   dua hal: (a) tracker kehabisan grace period lookup-not-found
   (`MAX_CONSECUTIVE_LOOKUP_FAILURES = 10` tick berurutan tx tidak ketemu di
   chain), atau (b) `deliverPaidBybitBscOrder` throw setelah order sempat
   `PAYMENT_DETECTED`/lebih. Setiap masuk `FAILED` antre satu DM admin per
   admin (`ORDER_PIPELINE_FAILED`) lewat `notification_outbox` (bukan kirim
   langsung dari poller) — tahan restart proses, dan retry otomatis lewat
   dispatcher yang sudah ada.

5. **Confirmation count: `null` artinya "belum ada angka asli", bukan 0.**
   `BybitBscTrackedOrder.confirmations: number | null` — renderer
   (`renderBybitBscTrackingScreen`) menampilkan baris "menunggu konfirmasi
   pertama" persis saat `confirmations == null`, bukan fallback ke `0/15`
   yang akan terlihat seperti angka asli tapi sebenarnya fabrikasi.

## Yang dibangun

### 1. Status model (`packages/core/src/enums.ts`, `prisma/schema.prisma`)

- `OrderStatus` baru: `PAYMENT_DETECTED`, `CONFIRMING`, `CONFIRMED`, `FAILED`.
- `Order` kolom baru: `network`, `confirmations`, `requiredConfirmations`,
  `firstDetectedAt`, `confirmedAt`.
- Model baru `OrderStatusHistory` (`order_id`, `status`, `occurred_at`,
  `meta`), index `[orderId, occurredAt]`.
- Migration: `prisma/migrations/20260624160712_add_order_status_history/`.
- `customerStatusLabel(status)`: helper i18n-key mapping satu tempat untuk
  label kasar yang dilihat pembeli (storefront + bot pakai mapping yang
  sama, bukan switch paralel masing-masing).

### 2. Deposit poller — sekarang menangkap status 1/2 juga (`packages/db/src/crud/bybit_bsc_deposit.ts`, `apps/order-bot/src/payments/bybitBscDeposit.ts`)

- `recordBybitBscPaymentDetected`: `PENDING_PAYMENT -> PAYMENT_DETECTED`
  begitu deposit on-chain terlihat (status 1/2), simpan `bybitTxid`/`network`/
  `firstDetectedAt`.
- `listInFlightBybitBscOrders`: re-match deposit yang sudah pernah tertaut ke
  order by txid (status 1/2 di poll sebelumnya), supaya tidak jatuh ke
  amount-matching lagi (yang seharusnya cuma untuk `PENDING_PAYMENT` murni).
- `deliverPaidBybitBscOrder`: guard diperluas dari "hanya `PENDING_PAYMENT`"
  jadi `PRE_DELIVERY_STATUSES` (`PENDING_PAYMENT`/`PAYMENT_DETECTED`/
  `CONFIRMING`/`CONFIRMED`) — supaya status-3 Bybit tetap bisa mengirim
  barang berapa pun jauhnya tracker sudah memajukan status tampilan.

### 3. Confirmation tracker — poller baru (`apps/order-bot/src/payments/bybitBscConfirmationTracker.ts`)

- 2 call BscScan "proxy" (Ethereum-JSON-RPC-compatible) per order ter-track
  per cycle: `eth_blockNumber` (head terbaru) + `eth_getTransactionByHash`
  (block tx sendiri). `confirmations = latestBlock - txBlock + 1` (tx di
  block terbaru sendiri = 1 konfirmasi, sama seperti tampilan explorer pada
  umumnya).
- `recordBybitBscConfirmationProgress`: `PAYMENT_DETECTED -> CONFIRMING` di
  konfirmasi pertama, `CONFIRMING -> CONFIRMED` begitu mencapai
  `requiredConfirmations` (default 15, override via Settings/`.env`).
- `recordBybitBscTrackingFailed`: eskalasi ke `FAILED` setelah
  `MAX_CONSECUTIVE_LOOKUP_FAILURES` (10) tick tx tidak ketemu di chain
  berturut-turut (bukan error transient — itu cuma `continue`, tidak
  menghitung grace period).
- Push update live: setiap tick sukses (bukan cuma saat status pindah) edit
  bubble yang sudah di-anchor (`paymentMsgChatId`/`paymentMsgId`) lewat
  `editMessageText` — sama persis pola `onDelivered()` rail lain.
- Backoff rate-limit terpisah dari deposit poller (`createBackoffGate()`
  sendiri) — interval poll juga independen
  (`BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS`, default 10s, vs
  `BYBIT_BSC_POLL_INTERVAL_SECONDS` punya deposit poller, default 5s).

### 4. Live tracking screen (bot + storefront)

- `renderBybitBscTrackingScreen` (`apps/order-bot/src/util/format.ts`):
  timeline 4 baris (Payment Detected → Confirming → Confirmed → Delivered)
  dengan glyph ✅/⏳/⬜ berdasar posisi `order.status`, plus progress bar
  blok karakter (`██████░░░░░░░░`) dan baris `x/y` kalau `confirmations`
  sudah terisi.
- `bybitBscTrackingKb` (`apps/order-bot/src/keyboards/customer.ts`): tombol
  Refresh selalu ada, Cancel cuma kalau status masih `PENDING_PAYMENT` (defensif
  — screen ini sendiri tidak pernah dirender untuk status itu).
- `viewOrder()` (`apps/order-bot/src/handlers/customer.ts`) rute ke screen
  ini untuk order Bybit BSC yang masih `PAYMENT_DETECTED`/`CONFIRMING`/
  `CONFIRMED` — status lain tetap lewat path `order.detail` yang sudah ada.
- `refreshPaymentStatus` (`apps/order-bot/src/handlers/checkout.ts`): tombol
  "🔄 Refresh Status" sekarang trigger poll untuk keempat status pre-delivery
  (dulu cuma `PENDING_PAYMENT`), dan untuk Bybit BSC juga memicu
  `bybitBscTrackerImmediatePoll` (fire-and-forget) supaya hitungan konfirmasi
  ikut nge-nudge, bukan cuma status deposit.
- Storefront (`apps/storefront/src/routes/checkout.ts`): `payState()`
  memetakan `PAYMENT_DETECTED`/`CONFIRMING`/`CONFIRMED` ke chip "confirming"
  yang sudah ada (bukan jatuh ke catch-all "closed" yang terlihat seperti
  order mati).

### 5. Notifikasi, locale, settings, docs

- `NotificationEvent.ORDER_PIPELINE_FAILED` (admin DM) + template di
  `packages/outbox-dispatcher/src/templates.ts` (bilingual EN+ID dalam satu
  body, sama pola `ADMIN_OVERPAID`).
- Locale key baru (`order.tracking_*`, `error.illegal_status_transition`)
  ditambah simetris di `en.json`/`id.json` (parity test
  `packages/core/src/locales.test.ts` tetap hijau).
- Settings web-admin (`apps/web-admin/src/routes/settings.ts`):
  `bscscan_api_key` (secret, opsional — BscScan tier gratis jalan tanpa key
  di rate limit lebih rendah) + `bybit_bsc_required_confirmations` (validasi
  whole-number positif, kosong = pakai default 15), keduanya masuk whitelist
  `PAY_BYBIT_BSC_KEYS`.
- Env var baru (`.env.example`): `BSCSCAN_API_BASE`, `BSCSCAN_API_KEY`,
  `BYBIT_BSC_REQUIRED_CONFIRMATIONS`, `BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS`.
- `docs/ORDER_STATE_MACHINE.md` + `docs/PAYMENT_GATEWAY.md` diperbarui dengan
  diagram transisi, tabel status, dan penjelasan "siapa yang memicu" untuk
  keempat status baru.

## Testing

TDD per modul, semua test baru + retrofit lama dijalankan dari root:

- `packages/db/src/crud/orderStatus.test.ts` — state machine helper murni.
- `packages/db/src/crud/bybit_bsc_confirmation.test.ts` — crud tracker
  (`listTrackedBybitBscOrders`/`recordBybitBscConfirmationProgress`/
  `recordBybitBscTrackingFailed`).
- `apps/order-bot/test/bybit-bsc-confirmation-tracker.test.ts` — poller
  (fungsi murni `computeConfirmations`, fetch dengan BscScan di-mock,
  integrasi `pollOnce` ke DB test asli, termasuk skenario rate-limit dan
  grace-period exhaustion).
- `apps/order-bot/test/bybit-bsc-tracking-screen.test.ts` — renderer +
  keyboard, semua kombinasi status/lang.
- Retrofit: `bybit_bsc_deposit.test.ts`, `bybit_deposit.test.ts` (via
  `binance_internal.ts`), `credit_order_to_balance.test.ts`,
  `notifications.test.ts`, `stock_deduction.test.ts`,
  `storefront.test.ts`, `web.test.ts`, `handlers.test.ts`,
  `templates.test.ts` — semua disesuaikan ke status baru tanpa mengubah
  perilaku yang sudah ada.
- Hasil akhir sebelum merge: `pnpm typecheck` hijau di semua workspace,
  `pnpm test` — **79 file test / 1093 test, semua lolos**.

## Catatan deploy

Schema berubah (`orders` kolom baru + tabel `order_status_history` baru) —
sesuai konvensi `CLAUDE.md`: jalankan migration (`pnpm prisma db push` atau
apply migration `20260624160712_add_order_status_history`) dan restart
order-bot **sebelum** kode baru jalan, supaya tidak kena `P2022 column …
does not exist`.

## Bug yang ditemukan setelah Phase 1 merge (belum di-fix)

Saat verifikasi manual end-to-end (lihat screenshot 2026-06-25): bubble
instruksi pembayaran Bybit BSC tidak pernah berubah sama sekali (tetap
"Refresh Status"/"Cancel Order"), dan tracking screen tidak pernah muncul,
walau log poller menunjukkan order sudah ter-deteksi dan ter-deliver. Dua
kecurigaan yang sedang ditelusuri:

1. Sesi tes itu menjalankan `pnpm dev:bot` dari checkout `master` lokal yang
   **belum** `git pull` setelah merge PR #17 (`git log` menunjukkan local
   `master` tertinggal 2 commit dari `origin/master` saat screenshot
   diambil) — log `"Matched by amount — delivered Bybit BSC order ..."`
   persis baris lama di `master` sebelum merge, bukan kode baru.
2. **Independen dari #1** — anchor bubble (`setOrderPaymentMessage`) di
   `buyNowBybitBsc` (`apps/order-bot/src/handlers/checkout.ts:556`) digerbangi
   `if (ctx.session.menuMsgId)`. Kalau `menuMsgId` falsy di titik itu,
   `paymentMsgChatId`/`paymentMsgId` order tidak pernah terisi — yang berarti
   BAIK `onDelivered()`'s edit-in-place (rail lama) MAUPUN
   `pushTrackingUpdate()` tracker baru (sama-sama early-return saat
   `paymentMsgChatId == null`) tidak akan pernah punya bubble untuk di-edit,
   apa pun versi kode yang jalan. Belum dikonfirmasi apakah ini benar-benar
   terjadi di kasus screenshot atau cuma kecurigaan #1 yang cukup untuk
   menjelaskan semuanya — perlu lanjut investigasi dengan kode `origin/master`
   yang sudah ter-pull.

## Phase berikutnya

Lihat **Phase 2** di bawah — sudah discoped (status: *didesain, belum
diimplementasi*).

---

# Phase 2: Real-time BSC confirmation push (WebSocket block watcher)

> **Status:** didesain (2026-06-25, via Claude Code plan mode), **belum
> diimplementasi**. Dokumen ini cuma desain — belum ada kode yang berubah.

## Context

Phase 1 menampilkan hitungan konfirmasi asli, tapi sumber datanya
`bybitBscConfirmationTracker.ts` poll BscScan-compatible API tiap
`BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS` (default 10 detik) per order yang
di-track — 2 HTTP call (`eth_blockNumber` + `eth_getTransactionByHash`) per
order per siklus. Buyer baru lihat angka konfirmasi naik paling cepat 10
detik setelah block baru benar-benar ditambang di BSC (~3 detik), jadi ada
delay tambahan di atas delay blockchain itu sendiri yang sebenarnya bisa
dihilangkan.

**Tujuan Phase 2:** dapat update konfirmasi secepat block baru muncul
(push-based), bukan nunggu interval poll — tanpa endpoint publik baru, tanpa
signature verification, tanpa hand-off antar proses.

## Alternatif yang dipertimbangkan dan TIDAK dipilih

Dua alternatif yang lebih murah sempat dibahas dan ditolak user demi
solusi yang benar-benar real-time di dalam Telegram:

- **Tombol link langsung ke BscScan** (`https://bscscan.com/tx/{bybitTxid}`)
  — paling murah (1 tombol keyboard, BscScan yang nanggung real-time-nya),
  tapi user harus keluar dari Telegram untuk lihat update.
- **Percepat `BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS`** (10s → 3-5s) — tetap
  polling, cuma kurang delay-nya, tidak benar-benar push-based, dan
  melipatgandakan beban HTTP call ke BscScan per order.
- **Inbound webhook dari provider pihak ketiga** (Alchemy Notify/QuickNode
  Streams/Moralis Streams) sempat diusulkan sebagai "webhook" literal, tapi
  ditolak karena: butuh endpoint publik baru di storefront, signature
  verification per-provider, secret di Settings, DAN tetap butuh pola
  hand-off `sweepDeliveredAwaitingEdit` (`packages/db/src/crud/binance_internal.ts:128-151`,
  `apps/order-bot/src/payments/tokopayReconcile.ts:53-81`) karena
  `CLAUDE.md` melarang proses web mengirim Telegram langsung — lebih banyak
  bagian bergerak dibanding WebSocket yang jalan langsung di proses bot
  (yang sudah punya `Api` instance sendiri, tidak perlu hand-off apa pun).

## Keputusan desain

1. **WebSocket subscription dari proses BOT ke node RPC BSC, bukan webhook
   masuk.** Bot buka satu koneksi `wss://` persisten, subscribe
   `eth_subscribe("newHeads")` (notifikasi tiap block baru, ~3 detik sekali
   di BSC). Karena bot adalah proses yang sudah punya `Api` Telegram sendiri
   (`apps/server/src/index.ts` — composition root satu proses untuk bot +
   web-admin + storefront + semua poller), tidak ada batas proses yang harus
   dilewati sama sekali — beda dari webhook pihak ketiga yang HARUS mendarat
   di proses storefront (`apps/storefront`, "permukaan publik") lalu nge-relay
   lewat DB ke proses bot.

2. **Pakai `viem`, bukan raw `ws` + JSON-RPC manual.** Repo ini belum punya
   dependency blockchain SDK apa pun (`apps/order-bot/package.json` /
   root `package.json` dicek — tidak ada `ws`/`ethers`/`viem`; Phase 1
   sengaja pakai raw `fetch`). Untuk Phase 2, **direkomendasikan menambah
   `viem`** khusus karena WebSocket transport-nya sudah punya reconnect
   bawaan + helper `watchBlocks` — mengurangi kode hand-rolled (reconnect +
   parsing subscription notification) yang justru jadi sumber risiko/effort
   utama kalau dibangun manual. Alternatif zero-dependency (raw `ws`) tetap
   dicatat sebagai opsi, tapi BUKAN rekomendasi — keputusan nambah dependency
   baru ini perlu di-approve ulang saat sesi implementasi nanti, bukan
   diam-diam lewat perubahan dokumentasi ini.

3. **Tidak ada fungsi crud baru — semua sudah transport-agnostic dari
   Phase 1.** `listTrackedBybitBscOrders`, `recordBybitBscConfirmationProgress`,
   `recordBybitBscTrackingFailed` (`packages/db/src/crud/bybit_bsc_deposit.ts`)
   dan `transitionOrderStatus`/`tryTransitionOrderStatus`
   (`packages/db/src/crud/orderStatus.ts`) menerima nilai polos (angka,
   string), bukan bentuk row BscScan — jadi block watcher tinggal memanggil
   fungsi yang sama persis dengan yang dipanggil poller BscScan hari ini.

4. **Poller BscScan Phase 1 TETAP JALAN sebagai fallback, bukan diganti.**
   Pola yang sama dengan webhook+reconcile-poller TokoPay/PayDisini/
   NOWPayments: kalau koneksi WebSocket putus/provider down, poll 10 detik
   tetap menjaga fitur ini di level layanan Phase 1 — tidak pernah turun di
   bawah itu. Sengaja TIDAK dibangun logika staleness-detection untuk
   mematikan poll yang jadi redundan saat WebSocket sehat — push ganda itu
   aman (tulisan crud idempotent, `editMessageText` yang isinya sama
   otomatis no-op "message is not modified" di sisi Telegram), dan
   menghindari state tambahan yang harus dijaga cuma demi efisiensi marginal.

5. **Grace period lookup-failure pindah dari hitungan tick ke jendela waktu
   nyata.** `MAX_CONSECUTIVE_LOOKUP_FAILURES = 10` di Phase 1 itu 10 siklus
   poll (≈100 detik di interval 10s). Kemunculan block tidak berinterval
   tetap (~3 detik tapi bisa lebih), jadi versi block-watcher-nya melacak
   `firstNotFoundAt` per order dan eskalasi ke `FAILED` setelah durasi tetap
   terlewati (bukan jumlah tick) — supaya perilakunya sama persis berapa pun
   cepatnya block muncul.

## Yang akan dibangun

- **File baru:** `apps/order-bot/src/payments/bybitBscBlockWatcher.ts` —
  dipisah dari `bybitBscConfirmationTracker.ts` (transport & lifecycle beda
  total; cuma berbagi pemanggilan crud yang sama).
- `startWatching(api)` / `stopWatching()` — bentuk mirip
  `startPolling`/`stopPolling` yang sudah ada, supaya wiring di
  `apps/server/src/index.ts` konsisten dengan 7 poller lain (import/call
  pattern sama, masuk ke blok graceful-shutdown yang sama, sejajar dengan
  `stopBybitBscTracker()`).
- Tiap block baru masuk: `listTrackedBybitBscOrders(prisma)` (dipakai
  ulang), lalu untuk tiap order — kalau block tx-nya sudah pernah diketahui
  (cache in-memory `Map<orderId, bigint>`), hitung
  `confirmations = blockBaru - blockTx + 1` **murni aritmatika, tanpa RPC
  call**; kalau belum, satu kali `getTransactionReceipt` untuk cari block
  tx-nya (lalu di-cache). Ini malah LEBIH efisien dari Phase 1 ("2 HTTP call
  per order per tick") — kebanyakan block tidak butuh call tambahan sama
  sekali.
- Ekstrak `pushTrackingUpdate` (saat ini private di
  `bybitBscConfirmationTracker.ts`) jadi helper kecil yang dibagi
  (mis. `bybitBscTrackingPush.ts`) — dipanggil baik dari poller BscScan
  maupun watcher baru, supaya cara push bubble identik dari dua sumber data.
- **Config baru:** `BSC_WS_RPC_URL` (env var baru + key Settings-overridable,
  masuk whitelist `PAY_BYBIT_BSC_KEYS` sejajar dengan `bscscan_api_key`).
  **⚠ ASSUMPTION (flagged)** — belum ada provider WS publik BSC spesifik yang
  diverifikasi uptime/ToS-nya di dokumen ini; pilih & verifikasi provider
  konkret saat sesi implementasi, jangan anggap ada default yang sudah pasti
  benar.
- `stopWatching()` menutup koneksi WS saat graceful shutdown
  (`apps/server/src/index.ts`, sejajar `stopBybitBscTracker()`).

## Strategi testing

Susun logika penanganan block sebagai fungsi yang (hampir) murni:
`onNewBlock(api, blockNumber, getTxBlock: (hash) => Promise<bigint | null>)`
— test inject `getTxBlock` palsu, tidak perlu koneksi WebSocket nyata sama
sekali. Ini mengikuti pola yang sudah dipakai Phase 1 sendiri
(`computeConfirmations` murni vs `fetchConfirmations` yang benar-benar
manggil network di `bybitBscConfirmationTracker.ts`) — supaya tidak ada test
yang butuh koneksi WS hidup di CI.

## Yang belum diputuskan (perlu diputuskan saat implementasi, bukan di sini)

- Provider WS BSC konkret yang dipakai (lihat ⚠ ASSUMPTION di atas).
- Apakah `viem` benar-benar di-approve sebagai dependency baru, atau
  implementer memilih raw `ws` setelah menimbang ulang.
- Nilai pasti jendela grace-period berbasis waktu (poin desain #5) —
  belum ada angka final, cuma keputusan "berbasis waktu, bukan tick".

