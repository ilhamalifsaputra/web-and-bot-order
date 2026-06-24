# Order State Machine

Enum sumber kebenaran: `packages/core/src/enums.ts` (`OrderStatus`). Kolom DB:
`orders.status` (string, default `PENDING_PAYMENT`). Setiap transisi terstruktur
lewat `transitionOrderStatus`/`tryTransitionOrderStatus`
(`packages/db/src/crud/orderStatus.ts`), yang memvalidasi `LEGAL_TRANSITIONS` dan
menulis satu baris `OrderStatusHistory` per transisi (audit trail append-only —
lihat §Invariant).

```ts
PENDING_PAYMENT | PAYMENT_DETECTED | CONFIRMING | CONFIRMED | PENDING_VERIFICATION |
PAID | DELIVERED | CANCELLED | REJECTED | REFUNDED | UNDERPAID | FAILED
```

`PAYMENT_DETECTED`/`CONFIRMING`/`CONFIRMED`/`FAILED` HANYA ditulis oleh rail
Bybit BSC on-chain (`bybitBscDeposit.ts` + `bybitBscConfirmationTracker.ts`) —
setiap method pembayaran lain (TokoPay/PayDisini/NOWPayments/Binance
Internal/Bybit Internal Transfer/manual proof) tidak pernah menyentuh keempat
status ini.

## Diagram transisi

```mermaid
stateDiagram-v2
    [*] --> PENDING_PAYMENT: createOrderDirect/createOrderFromCart<br/>(stok DIRESERVASI atomik)

    PENDING_PAYMENT --> PENDING_VERIFICATION: attachPaymentProof (manual proof)<br/>ATAU deliverPaid*Order (auto-confirm, transien)
    PENDING_PAYMENT --> UNDERPAID: markUnderpaid (Binance: note cocok, amount kurang)
    PENDING_PAYMENT --> CANCELLED: autoCancelExpiredOrders (lewat expiresAt)<br/>ATAU user cancel (HANYA jika belum ada proof)
    PENDING_PAYMENT --> CANCELLED: gateway createTransaction gagal (Checkout-3 fix)

    PENDING_VERIFICATION --> DELIVERED: approveOrder (admin ATAU adminId:0 auto)<br/>klaim atomik updateMany
    PENDING_VERIFICATION --> REJECTED: rejectOrder (admin, manual proof palsu/tidak valid)

    UNDERPAID --> PENDING_VERIFICATION: deliverUnderpaidOrder (admin pilih "kirim juga")
    UNDERPAID --> REFUNDED: refundUnderpaidOrder (admin pilih "refund ke wallet")

    PENDING_PAYMENT --> CANCELLED: creditOrderToBalance (paid-but-undeliverable → store credit)
    PENDING_VERIFICATION --> CANCELLED: creditOrderToBalance

    %% --- Bybit BSC on-chain rail ONLY (lihat catatan di atas) ---
    PENDING_PAYMENT --> PAYMENT_DETECTED: bybitBscDeposit.ts processDeposits<br/>(deposit on-chain terlihat, Bybit status 1/2 — belum "Success")
    PAYMENT_DETECTED --> CONFIRMING: bybitBscConfirmationTracker.ts<br/>(konfirmasi block-explorer pertama — DISPLAY-ONLY)
    CONFIRMING --> CONFIRMED: bybitBscConfirmationTracker.ts<br/>(confirmations >= requiredConfirmations — DISPLAY-ONLY)
    PAYMENT_DETECTED --> PENDING_VERIFICATION: deliverPaidBybitBscOrder<br/>(Bybit akhirnya report status 3 "Success")
    CONFIRMING --> PENDING_VERIFICATION: deliverPaidBybitBscOrder
    CONFIRMED --> PENDING_VERIFICATION: deliverPaidBybitBscOrder
    PAYMENT_DETECTED --> FAILED: tracker grace-period habis (tx tak pernah muncul)<br/>ATAU deliverPaidBybitBscOrder throw (delivery_failed)
    CONFIRMING --> FAILED: idem
    CONFIRMED --> FAILED: idem
    FAILED --> CANCELLED: admin resolve manual
    FAILED --> REFUNDED: admin resolve manual

    DELIVERED --> [*]
    CANCELLED --> [*]
    REJECTED --> [*]
    REFUNDED --> [*]
    FAILED --> [*]

    note right of PAID
        Status PAID ADA di enum tapi
        TIDAK PERNAH di-assign di kode manapun
        (hanya dicek sebagai guard di
        checkout.ts:231). Kemungkinan sisa
        skema lama — anggap mati, bukan
        bagian alur aktif.
    end note

    note right of FAILED
        Confirmation count (tracker) bersifat
        DISPLAY-ONLY — tidak pernah memicu
        delivery. Gerbang delivery TETAP hanya
        status-3 Bybit via
        deliverPaidBybitBscOrder, regardless
        of state PAYMENT_DETECTED/CONFIRMING/
        CONFIRMED yang sedang dipegang order.
    end note
```

## Status & makna

| Status | Arti | Stok | Reversibel? |
|---|---|---|---|
| `PENDING_PAYMENT` | Order dibuat, menunggu pembayaran. Default kolom. | **Sudah DIRESERVASI** (Checkout-2 fix, audit 2026-06-23) | Ya → `CANCELLED` (expiry/user) atau → `PAYMENT_DETECTED` (Bybit BSC) |
| `PAYMENT_DETECTED` | **Bybit BSC saja.** Deposit on-chain terlihat (Bybit status 1/2), belum "Success" Bybit sendiri. `bybitTxid`/`network`/`firstDetectedAt` sudah terisi. | RESERVED | Ya → `CONFIRMING`, `PENDING_VERIFICATION`, atau `FAILED` |
| `CONFIRMING` | **Bybit BSC saja.** Tracker block-explorer sudah melihat ≥1 konfirmasi. `confirmations` terisi (angka asli, bukan fabrikasi). | RESERVED | Ya → `CONFIRMED`, `PENDING_VERIFICATION`, atau `FAILED` |
| `CONFIRMED` | **Bybit BSC saja.** `confirmations >= requiredConfirmations` — milestone display-only, BUKAN trigger delivery. `confirmedAt` terisi. | RESERVED | Ya → `PENDING_VERIFICATION` atau `FAILED` |
| `PENDING_VERIFICATION` | Pembayaran terdeteksi (manual proof ATAU auto-confirm gateway) — status **transien**, hampir selalu langsung diikuti `approveOrder` dalam transaksi yang sama. | RESERVED | Ya → `DELIVERED` atau `REJECTED` |
| `UNDERPAID` | (Hanya Binance Internal) Note transfer cocok tapi nominal kurang dari total. Menunggu keputusan admin. | RESERVED (tidak pernah dilepas sampai resolve) | Ya → `PENDING_VERIFICATION` atau `REFUNDED` |
| `DELIVERED` | **Terminal.** Stok `SOLD`, kredensial sudah/akan dikirim via outbox. | SOLD | Tidak — `creditOrderToBalance`/`cancelOrder` menolak (`error.order_already_delivered`) |
| `CANCELLED` | **Terminal.** Stok dilepas (`AVAILABLE`), wallet/voucher di-refund. | Dilepas | Tidak (re-cancel = no-op idempoten) |
| `REJECTED` | **Terminal.** Admin menolak bukti bayar manual. Stok dilepas. | Dilepas | Tidak |
| `REFUNDED` | **Terminal.** Dari `UNDERPAID` (saldo USDT dikembalikan ke wallet) ATAU dari `FAILED` (admin resolve manual). | Tidak pernah direservasi (UNDERPAID) / RESERVED (FAILED, dilepas saat resolve) | Tidak |
| `FAILED` | **Terminal.** **Bybit BSC saja.** Pipeline otomatis gagal setelah `PAYMENT_DETECTED` tanpa resolusi otomatis yang aman (tracker grace-period habis, atau delivery throw post-konfirmasi). Beda dari `CANCELLED`/`REJECTED` — itu selalu inisiatif customer/admin, `FAILED` selalu inisiatif sistem. Admin DM via outbox (`ORDER_PIPELINE_FAILED`). | RESERVED (sampai admin resolve ke `CANCELLED`/`REFUNDED`) | Ya → `CANCELLED` atau `REFUNDED` (admin) |
| `PAID` | **Status mati** — ada di enum, tidak pernah di-set. Anggap tidak digunakan. | — | — |

## Siapa yang memicu transisi

| Transisi | Trigger | File |
|---|---|---|
| `→ PENDING_PAYMENT` | Checkout bot/storefront | `packages/db/src/crud/orders.ts` (`createOrderDirect`/`createOrderFromCart`) |
| `PENDING_PAYMENT → PENDING_VERIFICATION` (manual) | Bot: upload bukti+TxID | `attachPaymentProof` |
| `PENDING_PAYMENT → PENDING_VERIFICATION → DELIVERED` (auto, satu transaksi) | Webhook/poller gateway | `deliverPaid{Tokopay,Paydisini,Nowpayments,Internal,Bybit}Order` |
| `PENDING_PAYMENT → UNDERPAID` | Binance poller, note cocok amount kurang | `markUnderpaid` |
| `PENDING_VERIFICATION → DELIVERED` | Admin approve (manual) ATAU sistem (`adminId: 0`, auto-confirm) | `approveOrder` — **chokepoint tunggal** alokasi stok untuk SEMUA jalur |
| `PENDING_VERIFICATION → REJECTED` | Admin reject bukti | `rejectOrder` |
| `UNDERPAID → PENDING_VERIFICATION` | Admin "kirim juga" (terima shortfall) | `deliverUnderpaidOrder` |
| `UNDERPAID → REFUNDED` | Admin "refund ke wallet" | `refundUnderpaidOrder` |
| `→ CANCELLED` (dari PENDING_PAYMENT) | Cron `autoCancelExpiredOrders` (tiap 1 menit, lewat `expiresAt`) | `apps/order-bot/src/jobs/index.ts` + `cancelOrder` |
| `→ CANCELLED` (manual user) | User cancel di storefront/bot | `cancelOrder` — **ditolak** jika sudah `PENDING_VERIFICATION`/`PAYMENT_DETECTED`/`CONFIRMING`/`CONFIRMED` (`error.cannot_cancel_after_proof`, anti fake-proof-then-cancel / anti cancel-saat-deposit-sudah-jalan) |
| `→ CANCELLED` (credit) | Admin "Add to buyer's credit balance" (paid-but-undeliverable) | `creditOrderToBalance` |
| `PENDING_PAYMENT → PAYMENT_DETECTED` | Deposit on-chain terlihat tapi Bybit belum report "Success" (status 1/2) | `apps/order-bot/src/payments/bybitBscDeposit.ts` `processDeposits` → `recordBybitBscPaymentDetected` |
| `PAYMENT_DETECTED → CONFIRMING → CONFIRMED` | Poll terpisah ke block explorer (BscScan-compatible) — display-only, TIDAK PERNAH memanggil `approveOrder`/`deliverPaidBybitBscOrder` | `apps/order-bot/src/payments/bybitBscConfirmationTracker.ts` `pollOnce` → `recordBybitBscConfirmationProgress` |
| `{PAYMENT_DETECTED,CONFIRMING,CONFIRMED} → PENDING_VERIFICATION → DELIVERED` | Bybit akhirnya report status 3 "Success" — gerbang delivery TETAP sama persis, hanya guard pre-delivery yang diperluas | `deliverPaidBybitBscOrder` |
| `{PAYMENT_DETECTED,CONFIRMING,CONFIRMED} → FAILED` | Tracker: grace-period lookup-not-found habis (`MAX_CONSECUTIVE_LOOKUP_FAILURES`) | `bybitBscConfirmationTracker.ts` → `recordBybitBscTrackingFailed` |
| `{PAYMENT_DETECTED,CONFIRMING,CONFIRMED} → FAILED` | Delivery throw setelah ledger diklaim (mis. kehabisan stok) — ledger `processed_bybit_tx` ditandai `delivery_failed` | `deliverPaidBybitBscOrder` (catch block) |
| `FAILED → CANCELLED` / `FAILED → REFUNDED` | Admin resolve manual (belum ada UI khusus di Phase 1 — via cancelOrder/refund flow yang sudah ada) | — |

## Invariant penting

- **`approveOrder` adalah satu-satunya jalur ke `DELIVERED`** — dipanggil
  baik oleh admin manual maupun oleh setiap `deliverPaid*Order` gateway
  (dengan `adminId: 0` untuk membedakan audit otomatis vs manual). Klaim
  atomik (`updateMany WHERE status=PENDING_VERIFICATION`) menjamin tidak ada
  double-delivery meski dipanggil dua kali bersamaan (Bot-2 fix, audit
  keamanan 2026-06-23). Ini **satu-satunya** call site yang TIDAK lewat
  `transitionOrderStatus` (lihat poin berikutnya) — klaim atomiknya sendiri
  sudah jadi mekanisme keamanan konkurensi; ia menambahkan baris
  `OrderStatusHistory` sendiri tepat setelah klaim berhasil.
- **`transitionOrderStatus`/`tryTransitionOrderStatus`
  (`packages/db/src/crud/orderStatus.ts`) adalah satu-satunya jalur penulisan
  status untuk SEMUA fungsi lain** — memvalidasi bentuk transisi terhadap
  `LEGAL_TRANSITIONS` (status terminal punya nol transisi keluar), mengklaim
  baris secara atomik (`updateMany WHERE status=from`) sehingga caller yang
  stale/race gagal dengan aman, dan menulis satu baris `OrderStatusHistory`
  per transisi sukses. `tryTransitionOrderStatus` adalah varian yang
  menganggap race-loss sebagai no-op (bukan error) — dipakai ketika dua
  poller independen (deposit poller + confirmation tracker) bisa menyentuh
  order yang sama.
- **Reservasi stok terjadi di `PENDING_PAYMENT`**, bukan menunggu sampai
  `DELIVERED` — order kedua untuk stok yang sama gagal saat creation
  (`error.out_of_stock`), bukan setelah pembeli kedua sudah bayar
  (Checkout-2 fix). Detail: [INVENTORY_SYSTEM.md](INVENTORY_SYSTEM.md).
- **Status terminal (`DELIVERED`/`CANCELLED`/`REJECTED`/`REFUNDED`/`FAILED`)
  tidak bisa ditransisikan lagi** kecuali `FAILED`, yang punya dua transisi
  keluar manual (`CANCELLED`/`REFUNDED`, admin resolve) — `cancelOrder`/
  `creditOrderToBalance` keduanya cek daftar status terminal dan menolak
  (atau no-op idempoten untuk `CANCELLED`/`REJECTED`/`REFUNDED` yang
  di-cancel ulang).
- **`UNDERPAID` eksklusif untuk Binance Internal Transfer** — gateway lain
  (webhook-based) menolak pembayaran kurang sebagai `"amount mismatch"` tanpa
  pernah mengubah status order (order tetap `PENDING_PAYMENT`, baris ledger
  ditandai `unmatched`) — lihat [PAYMENT_GATEWAY.md](PAYMENT_GATEWAY.md).
- **Confirmation count pada `PAYMENT_DETECTED`/`CONFIRMING`/`CONFIRMED` murni
  display** — dihitung dari block explorer (BscScan-compatible) yang
  terpisah total dari API Bybit sendiri, dan TIDAK PERNAH menjadi gerbang
  delivery. `deliverPaidBybitBscOrder` tetap satu-satunya jalur ke
  `PENDING_VERIFICATION`/`DELIVERED` untuk rail ini, digerbangi murni oleh
  status-3 ("Success") yang dilaporkan Bybit sendiri — dua sumber kebenaran
  yang independen, tidak ada risiko delivery ganda/kurang akibat keduanya
  tidak sepakat.
- **`FAILED` reserved untuk kegagalan pipeline otomatis** (tracker
  grace-period habis, atau delivery throw setelah `PAYMENT_DETECTED`) —
  berbeda dari `CANCELLED`/`REJECTED` yang selalu inisiatif customer/admin.
  Setiap transisi ke `FAILED` mengantre satu DM admin per admin
  (`ORDER_PIPELINE_FAILED`) lewat `notification_outbox` — bukan kirim
  langsung — supaya tahan proses-restart dan retry otomatis.
