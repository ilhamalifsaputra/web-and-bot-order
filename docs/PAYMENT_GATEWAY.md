# Payment Gateway

5 metode bayar, semua auto-confirm (tidak ada approval manual admin kecuali
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

Semua 5 idempotency ledger memakai pola yang sama: **insert-first-on-unique**
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
  `berhasil` (case-insensitive).

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
- **Signature IPN:** HMAC-SHA512 atas `JSON.stringify` body yang key-nya
  di-**sort rekursif alfabetis** (`sortKeysDeep`, termasuk objek nested),
  dikirim via header `x-nowpayments-sig` — skema ini **terdokumentasi baik
  secara publik, bukan tebakan** (beda dari TokoPay/PayDisini). Hanya status
  `payment_status === "finished"` dianggap `paid` — status lain
  (`waiting`/`confirming`/`confirmed`/`sending`/`partially_paid`/`failed`/
  `refunded`/`expired`) selalu `"ignored"`, tidak pernah error.
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

Reconcile poller JUGA menyapu (`sweepDeliveredAwaitingEdit`) order
`DELIVERED` yang bubble QR-nya belum di-flip ke sukses — menutup kasus
webhook sampai lewat storefront (yang tidak pernah mengedit bubble bot,
sesuai aturan "web tidak pernah kirim Telegram").

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
