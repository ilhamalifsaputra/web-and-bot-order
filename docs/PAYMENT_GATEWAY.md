# Payment Gateway

6 metode bayar, semua auto-confirm (tidak ada approval manual admin kecuali
fallback Binance Pay lama). Ringkasan tabel ada di
[`../DOCS.md` §5](../DOCS.md#5-pembayaran); dokumen ini adalah detail
level-kode: endpoint, signature, idempotency, dan jalur kegagalan.

> ⚠️ **Belum sepenuhnya terverifikasi ke dashboard live**: skema
> request/signature TokoPay, PayDisini, dan sebagian NOWPayments ditandai
> `ASSUMPTION (flagged)` langsung di source (`packages/core/src/payments/*.ts`)
> — disusun dari dokumentasi publik tanpa akses dashboard merchant sungguhan
> saat ditulis. **Verifikasi field name & status string sebelum go-live**
> dengan kredensial gateway asli.

## Ringkasan

| Gateway | Mata uang | Konfirmasi | Idempotency ledger | Klien |
|---|---|---|---|---|
| TokoPay | IDR | Webhook + live re-confirm | `ProcessedTokopayTx` (UNIQUE `trxId`) | `packages/core/src/payments/tokopay.ts` |
| PayDisini | IDR | Webhook + reconcile poller | `ProcessedPaydisiniTx` (UNIQUE `trxId`) | `.../paydisini.ts` |
| NOWPayments | USDT | IPN webhook + reconcile poller | `ProcessedNowpaymentsTx` (UNIQUE `trxId`) | `.../nowpayments.ts` |
| Binance Internal Transfer | USDT | Poller (by-note, fallback by-amount) | `ProcessedBinanceTx` (UNIQUE `binanceTxId`) | `apps/order-bot/src/payments/binanceInternal.ts` |
| Bybit Internal Transfer | USDT | Poller (by unique-amount) | `ProcessedBybitTx` (UNIQUE `bybitTxId`) | `.../bybitDeposit.ts` |
| Bybit BSC (on-chain) | USDT | Poller (by unique-amount + chain/address filter) | `ProcessedBybitTx` (UNIQUE `bybitTxId`, SHARED dengan Internal Transfer) | `.../bybitBscDeposit.ts` |

### Pemetaan status: satu tempat (`paymentStatus.ts`)

Sejak Task E7, jawaban atas "gateway bilang ini sudah dibayar?" tidak lagi
tersebar di enam file. Semuanya ada di
`packages/core/src/payments/paymentStatus.ts`, lewat
`normalizeProviderStatus(provider, raw)` yang mengembalikan
`"paid" | "pending" | "failed" | "expired"` (plus pembungkus `isProviderPaid`
untuk pemanggil yang cuma butuh ya/tidak). Adapter tiap rail sekarang memanggil
itu, bukan mencocokkan string atau angka sendiri.

Dua konsekuensi yang perlu diketahui sebelum mengubah apa pun di situ:

- **Dua rail Bybit sengaja jadi dua provider terpisah**
  (`BYBIT_INTERNAL` dan `BYBIT_BSC`), bukan satu `BYBIT`. Enum status deposit
  Bybit **terbalik** di antara keduanya: pada ledger internal-transfer `2` =
  Success dan `3` = Failed; pada ledger on-chain `3` = Success dan `2` baru
  Processing. Karena provider-nya disebut di call site, memilih yang salah
  tidak lagi diam-diam terkompilasi jadi "kirim barang untuk deposit gagal".
- **Binance Internal sengaja TIDAK ada di sana**, dan tercatat eksplisit di
  `PROVIDERS_WITHOUT_STATUS`. Rail itu tidak punya field status dari gateway
  sama sekali — konfirmasinya murni hasil pencocokan kita sendiri (kode order
  di catatan transfer, atau jumlah unik). Memaksakannya masuk berarti mengarang
  status yang tidak pernah dikirim gateway.

Nilai yang tidak dikenali selalu jatuh ke `pending`, tidak pernah `paid`
(respons rusak tidak boleh menyelesaikan order) dan tidak pernah `failed`
(satu respons kacau tidak boleh menelantarkan pembeli yang benar-benar bayar).

Yang dinormalisasi hanyalah **pemetaan status**. Model kanonik tetap
`OrderStatus` + ledger `Processed*Tx` per gateway; tidak ada kolom
`PaymentStatus`, tabel `Payment`, atau state machine kedua.

Bybit BSC berbagi ledger `ProcessedBybitTx` yang sama dengan Bybit Internal
Transfer (lihat §Bybit BSC di bawah untuk alasan mengapa ini aman) — jadi 6
metode di atas tetap hanya memakai 5 tabel ledger. Semua 5 idempotency ledger
memakai pola yang sama: **insert-first-on-unique**
— SQLite tidak punya row lock, jadi klaim ID transaksi gateway via
`create()` yang gagal pada UNIQUE constraint berarti "sudah pernah
diproses" (`isUniqueViolation`).

## TokoPay (QRIS, IDR)

- **Buat transaksi:** `GET {API_BASE}/v1/order` dengan query
  `merchant`/`secret`/`ref_id`/`nominal`/`metode`. `ref_id` (= `orderCode`)
  **idempoten** — panggilan ulang mengembalikan transaksi yang sama, bukan
  duplikat.
- **Signature webhook:** `md5(merchantId:secret:refId)` — **tidak mencakup
  amount/status**. Karena itu, callback `/pay/tokopay/callback` melakukan
  **re-confirm live** via `checkTransaction` (server-to-server, butuh
  `secret`) SETELAH signature lolos, dan keputusan "paid"+amount yang
  dipakai untuk delivery berasal dari hasil live call itu — **bukan** dari
  field body callback yang tidak ditandatangani (Payment-1 fix, audit
  keamanan 2026-06-23). Body yang dipalsukan penyerang tidak bisa memalsukan
  respons live TokoPay yang sebenarnya.
- **Cek status (reconcile):** `GET {API_BASE}/v1/order` dengan `ref_id` yang
  sama — idempoten, dipakai poller fallback.
- **PAID_STATES:** `paid`, `success`, `completed`, `settlement`, `lunas`,
  `berhasil` (case-insensitive). Daftarnya kini tinggal di
  `paymentStatus.ts` (lihat §Pemetaan status di atas) dan dipakai
  `verifyCallback` (webhook) DAN `checkTransaction` (reconcile poller) lewat
  `isProviderPaid`, persis seperti PayDisini yang berbagi daftar yang sama —
  dulu webhook punya salinan inline lebih pendek tanpa `lunas`/`berhasil`,
  sehingga transaksi yang dilaporkan TokoPay dalam bahasa Indonesia diterima
  poller tapi ditolak webhook.

## PayDisini (QRIS/e-wallet, IDR)

- **Buat transaksi:** `GET {API_BASE}/v1/transaction` dengan
  `user_key`/`api_key`/`ref_id`/`amount`/`service`. Kredensial **berbeda
  bentuk** dari TokoPay (`user_key`+`api_key`, bukan `merchant`+`secret`).
- **Signature webhook:** `md5(apiKey:userKey:refId:amount)` — **tebakan by
  analogi** dengan TokoPay (flagged ASSUMPTION); urutan field/algoritma
  belum dikonfirmasi ke dashboard live.
- **Cek status (reconcile):** `GET {API_BASE}/v1/transaction`, `ref_id` sama.
- Webhook `/pay/paydisini/callback` mengikuti kontrak respons identik
  TokoPay (lihat bagian Webhook di bawah) — **tanpa** live re-confirm
  tambahan (signature mencakup `amount` di skema ini, beda dari TokoPay).

## NOWPayments (hosted invoice, USDT)

- **Buat invoice:** `POST {API_BASE}/v1/invoice`, header `x-api-key`, body
  `price_amount`/`price_currency=usd`/`pay_currency`/`order_id`/
  `ipn_callback_url`. Tidak idempoten by `order_id` (tidak seperti TokoPay/
  PayDisini) — setiap panggilan membuat invoice baru.
- **Signature IPN:** HMAC-SHA512 atas **raw bytes** body request (persis
  seperti yang dikirim NOWPayments, ditangkap lewat `addContentTypeParser`
  yang di-scope hanya ke route ini di `checkout.ts`, sebelum body
  di-parse/JSON-ulang), dikirim via header `x-nowpayments-sig` — skema ini
  **terdokumentasi baik secara publik, bukan tebakan** (beda dari
  TokoPay/PayDisini). Sebelumnya `verifyIpn` meng-hash
  `JSON.stringify(sortKeysDeep(parsedBody))` (re-serialize hasil parse, bukan
  raw bytes) — itu cuma "kebetulan" cocok karena sort key menetralkan
  perbedaan urutan field, tapi divergensi byte-level lain (mis. `1.50` vs
  `1.5` pada angka) akan diam-diam merusak verifikasi signature (Task 2a
  fix). `sortKeysDeep` masih diekspor sebagai utility mandiri tapi TIDAK lagi
  dipakai `verifyIpn`. Hanya status
  `payment_status === "finished"` dianggap `paid` (dicek lewat `isProviderPaid`,
  lihat §Pemetaan status di atas) — status lain
  (`waiting`/`confirming`/`confirmed`/`sending`/`partially_paid`/`failed`/
  `refunded`/`expired`) selalu `"ignored"`, tidak pernah error. Perhatikan
  `confirmed` dan `sending`: keduanya terdengar final padahal dananya belum
  masuk ke akun merchant, dan `partially_paid` terdengar cukup dekat padahal
  itu kurang bayar.
- **Cek status (reconcile):** `GET {API_BASE}/v1/invoice/{invoiceId}` —
  endpoint persis ini **flagged ASSUMPTION** (mungkin NOWPayments
  menyediakan `/v1/payment/{id}` terpisah).
- **Callback URL otomatis** — dikirim per-invoice sebagai `ipn_callback_url`
  saat invoice dibuat, **tidak perlu** didaftarkan manual di dashboard
  (beda dari TokoPay/PayDisini).

## Binance Internal Transfer (UID, USDT)

- **Mekanisme:** Pembeli transfer USDT ke UID merchant **dengan note =
  `paymentRef` order**. Poller (`apps/order-bot/src/payments/binanceInternal.ts`)
  baca riwayat transfer (API **read-only**) tiap `POLL_INTERVAL_SECONDS`
  (default 10s).
- **Matching:** Utama **by-note** (note cocok persis `paymentRef`). Fallback
  **by-amount** (`USE_UNIQUE_CENTS` harus aktif) HANYA dipakai saat note
  kosong/tidak terbaca — gate eksplisit di titik fallback
  (`order = byNote ?? (config.USE_UNIQUE_CENTS ? matchByAmount(...) : undefined)`),
  bukan mematikan seluruh poller bila flag mati.
- **Underpaid:** note cocok tapi amount kurang → `markUnderpaid`, status
  order jadi `UNDERPAID` (lihat [ORDER_STATE_MACHINE.md](ORDER_STATE_MACHINE.md)),
  menunggu keputusan admin (kirim juga / refund ke wallet).

## Bybit Internal Transfer (UID, USDT)

- **Mekanisme:** Pembeli transfer USDT ke UID merchant via fitur Bybit
  "Internal Transfer" (UID→UID, off-chain, instan) — **tidak ada memo/note**
  di jalur ini.
- **Matching:** **Hanya by unique-amount** (`computeUniqueCents`) — wajib
  `USE_UNIQUE_CENTS=1`. `pollOnce` Bybit **menolak proses** (return dini
  sebelum panggilan network apa pun, log error) setiap tick bila
  `USE_UNIQUE_CENTS` mati — pulih otomatis tick berikutnya begitu operator
  menyalakan flag, tanpa restart (Payment-2 fix, audit 2026-06-23).
- **Anti-kolisi amount:** `finalizeOrderPayment` untuk method BYBIT melakukan
  loop (maks 49 percobaan) mengecek `totalAmount` terhadap pool order Bybit
  `PENDING_PAYMENT` aktif — jika bentrok, `cents` dihitung ulang dengan
  `computeUniqueCents(orderId + attempt)` sampai unik (Checkout-4 fix).
- **Interval poll independen** (`BYBIT_POLL_INTERVAL_SECONDS`, default 5s) —
  tidak terpengaruh `POLL_INTERVAL_SECONDS` (Binance).

## Bybit BSC On-chain (BEP20, USDT)

Metode Bybit KEDUA, terpisah dari Internal Transfer di atas — keduanya bisa
diaktifkan bersamaan dan pembeli memilih salah satu saat checkout.

- **Mekanisme:** Pembeli transfer USDT **on-chain** (jaringan BEP20/BSC) ke
  alamat deposit milik merchant di Bybit. Berbeda dari Internal Transfer,
  ini adalah transfer blockchain biasa — **bisa diterima dari exchange/
  wallet apa pun** yang mendukung penarikan BEP20 (termasuk withdrawal dari
  Binance), bukan hanya sesama akun Bybit. Konsekuensinya: butuh menunggu
  konfirmasi blockchain (~1-2 menit) sebelum Bybit menandainya credited —
  lebih lambat dari Internal Transfer yang instan.
- **Endpoint:** `GET /v5/asset/deposit/query-record` (BUKAN
  `query-internal-record` yang dipakai Internal Transfer) — endpoint khusus
  deposit on-chain. Kredensial API key/secret **dibagi** dengan Internal
  Transfer (akun exchange yang sama); hanya alamat deposit yang berbeda.
- **Status sukses:** `status === 3` (on-chain) — **BERBEDA** dari Internal
  Transfer yang sukses di `status === 2`. Jangan disamakan.
- **Filter tambahan:** selain matching by-amount, baris deposit juga
  difilter `chain === "BSC"` (deposit di jaringan lain untuk coin yang sama
  tidak pernah dicocokkan) dan, bila tersedia, `address` dicocokkan ke
  alamat deposit yang dikonfigurasi (belt-and-suspenders, bukan
  disambiguator utama).
- **Matching:** sama seperti Internal Transfer — **hanya by unique-amount**
  (BEP20 juga tidak punya memo/note), wajib `USE_UNIQUE_CENTS=1`.
- **Ledger dibagi:** memakai tabel `ProcessedBybitTx` yang SAMA dengan
  Internal Transfer (tidak ada migrasi/kolom baru) — aman karena format
  `bybitTxId` kedua metode tidak pernah bertabrakan: id Internal Transfer
  berupa angka pendek dari ledger internal Bybit, id on-chain BEP20 berupa
  hash transaksi `0x…` 64-hex-char.
- **Anti-kolisi amount:** sama seperti Internal Transfer, tapi pool
  `PENDING_PAYMENT` yang dicek di-scope ke `paymentMethod: BYBIT_BSC` —
  order BYBIT dan BYBIT_BSC dengan total yang sama tidak saling bentrok,
  karena masing-masing dicocokkan oleh poller-nya sendiri.
- **Interval poll independen** (`BYBIT_BSC_POLL_INTERVAL_SECONDS`, default
  5s) — terpisah dari interval Internal Transfer maupun Binance.
- **Optimasi latensi:** selain timer reguler, sebuah poll tambahan
  (`triggerImmediatePoll`) langsung dipicu begitu order dibuat, supaya
  pengecekan pertama tidak menunggu tick berikutnya. Ini TIDAK mengurangi
  ambang konfirmasi yang disyaratkan Bybit (status 3 tetap wajib) — hanya
  menghilangkan delay interval-poll yang menumpuk di atas lantai konfirmasi
  blockchain itu sendiri.
- **Status 1/2 (belum "Success") TIDAK lagi dibuang begitu saja** (Phase 1
  blockchain tracking) — baris masih-confirming dipakai untuk menandai order
  `PAYMENT_DETECTED`/`CONFIRMING` (live tracking screen di bot, lihat
  [ORDER_STATE_MACHINE.md](ORDER_STATE_MACHINE.md)), lewat poller terpisah
  `bybitBscConfirmationTracker.ts` yang query block explorer
  (BscScan-compatible) untuk hitungan konfirmasi ASLI. Ini murni
  display-only — gerbang delivery TETAP sama persis: hanya status-3 Bybit
  via `deliverPaidBybitBscOrder` yang pernah memicu `approveOrder`.

## Kontrak respons webhook (TokoPay/PayDisini/NOWPayments)

**Identik untuk ketiganya** — supaya gateway berhenti retry terlepas dari
hasilnya:

| Kode | Kondisi |
|---|---|
| `403` | Gateway dimatikan (`*_enabled=false`/kredensial kosong) ATAU signature tidak valid |
| `200 {"status":"ignored"}` | Status belum final (pending/waiting/dll) |
| `200 {"status":"unmatched"}` | `refId`/`orderId` tidak cocok order manapun, ATAU `paymentMethod`/`currency` order tidak cocok gateway ini (cross-check eksplisit, Payment-4 fix) — tetap dicatat ke ledger untuk review admin |
| `200 {"status":"amount mismatch"}` | Dibayar kurang dari `order.totalAmount` |
| `200 {"status":"delivered"}` (TokoPay/PayDisini) atau status dari `deliverPaid*Order` | Sukses |
| `200 {"status":"delivery failed"}` | Pembayaran tercatat TAPI auto-delivery gagal (mis. out-of-stock race) — ditandai `delivery_failed` di ledger, selesaikan manual dari panel order |
| `429 {"status":"rate limited"}` | `webhookRateLimited` — 30 hit/60 detik per route per IP (Payment-3 fix), dicek SEBELUM signature/body diproses |

## Reconcile poller — fallback saat webhook tidak sampai

`apps/order-bot/src/payments/{tokopay,paydisini,nowpayments}Reconcile.ts` —
tiap `POLL_INTERVAL_SECONDS`, untuk setiap order `PENDING_PAYMENT` dalam
jendela bayar: panggil `checkTransaction`/`getPaymentStatus` gateway, jika
`paid` dan amount cukup → jalur `deliverPaid*Order` yang SAMA dengan webhook
(ledger sama → tidak mungkin double-deliver). Read-only ke gateway (tidak
membuat/mengubah apa pun di sisi mereka).

**Kunci ledger (`trxId`) harus sama persis di kedua jalur**, karena kolom
`trxId` yang UNIQUE itulah gate idempotency utamanya. Aturannya per-rail:

- **TokoPay & PayDisini:** `gatewayLedgerTrxId(live.trxId, order.orderCode)`
  (`packages/core/src/payments/ledgerKey.ts`) — id dari hasil `checkTransaction`
  live, fallback ke `orderCode` (yaitu `ref_id` yang kita kirim sendiri saat
  transaksi dibuat). Dipakai identik oleh route webhook storefront dan poller.
  Field `trx_id`/`unique_code` di BODY callback sengaja tidak ikut dipakai:
  signature kedua rail tidak mencakupnya, dan poller tidak punya body sama
  sekali.
- **NOWPayments:** hanya `payment_id` dari gateway, tanpa fallback apa pun.
  `verifyIpn` menolak callback tanpa `payment_id` (fix M-12), jadi poller pun
  **tidak mengirim** order yang `finished` tapi tanpa `payment_id` — ia
  menulis log warn dan membiarkan order tetap `PENDING_PAYMENT`.

Sebelumnya ketiga poller memakai kunci sintetis `reconcile-<orderCode>` saat
gateway tidak memberi id — baris UNIQUE yang berbeda dari apa pun yang bisa
ditulis webhook, sehingga duplikat baru tertangkap satu lapis di bawahnya
(cek status order yang mengembalikan `"stale"`), bukan oleh ledger.

Reconcile poller masing-masing rail (`reconcileOrder`) langsung membalik
bubble QR ke sukses saat POLLER SENDIRI yang mendeteksi pembayaran — jalur
ini tidak lagi menyapu order lain di luar itu (per-rail sweep
`sweepDeliveredAwaitingEdit` sudah dihapus). Untuk kasus webhook sampai lewat
storefront (yang tidak pernah mengedit bubble bot, sesuai aturan "web tidak
pernah kirim Telegram"), job generik terpisah —
`sweepPaidOrderBubbles` (`apps/order-bot/src/jobs/index.ts`, cron di detik
ke-25 tiap menit) — menyapu bubble pembayaran yang masih basi untuk SEMUA
metode pembayaran, bukan cuma tiga rail QRIS/IDR ini.

## Alert kegagalan delivery — "Manual action needed"

Setiap jalur (3 reconcile poller + 2 poller Binance/Bybit) yang berhasil
**mendeteksi pembayaran** tapi gagal di `deliverPaid*Order` (exception, mis.
out-of-stock race) mengirim alert admin dengan pola pesan yang sama:

```
⚠️ <Gateway> paid but delivery FAILED for <order_code> [tx <txId>] — <error>. Manual action needed.
```

Ini **bukan bug** — itu adalah jalur defensif yang disengaja: pembayaran
sudah tercatat di ledger (`outcome: delivery_failed`), order TIDAK hilang,
tapi butuh intervensi admin (resolve manual dari panel `/orders` — cek stok,
deliver manual, atau credit ke saldo via `creditOrderToBalance`). Lihat
contoh investigasi nyata kasus ini di [PATCH_GUIDE.md](PATCH_GUIDE.md) —
root cause yang ditemukan bukan di jalur pembayaran sama sekali, melainkan
schema-drift `notification_outbox` (lihat [TROUBLESHOOTING.md](TROUBLESHOOTING.md)).

## Tes koneksi sebelum go-live

```bash
pnpm exec tsx scripts/binance-probe.ts   # baca riwayat transfer, konfirmasi field note ada
pnpm bybit-probe                          # baca deposit, read-only
```

Tidak ada probe script untuk TokoPay/PayDisini/NOWPayments — verifikasi
ketiganya dengan transaksi kecil sungguhan di sandbox/dashboard merchant.
