# Order State Machine

Enum sumber kebenaran: `packages/core/src/enums.ts` (`OrderStatus`). Kolom DB:
`orders.status` (string, default `PENDING_PAYMENT`).

```ts
PENDING_PAYMENT | PENDING_VERIFICATION | PAID | DELIVERED | CANCELLED |
REJECTED | REFUNDED | UNDERPAID
```

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

    DELIVERED --> [*]
    CANCELLED --> [*]
    REJECTED --> [*]
    REFUNDED --> [*]

    note right of PAID
        Status PAID ADA di enum tapi
        TIDAK PERNAH di-assign di kode manapun
        (hanya dicek sebagai guard di
        checkout.ts:231). Kemungkinan sisa
        skema lama — anggap mati, bukan
        bagian alur aktif.
    end note
```

## Status & makna

| Status | Arti | Stok | Reversibel? |
|---|---|---|---|
| `PENDING_PAYMENT` | Order dibuat, menunggu pembayaran. Default kolom. | **Sudah DIRESERVASI** (Checkout-2 fix, audit 2026-06-23) | Ya → `CANCELLED` (expiry/user) |
| `PENDING_VERIFICATION` | Pembayaran terdeteksi (manual proof ATAU auto-confirm gateway) — status **transien**, hampir selalu langsung diikuti `approveOrder` dalam transaksi yang sama. | RESERVED | Ya → `DELIVERED` atau `REJECTED` |
| `UNDERPAID` | (Hanya Binance Internal) Note transfer cocok tapi nominal kurang dari total. Menunggu keputusan admin. | RESERVED (tidak pernah dilepas sampai resolve) | Ya → `PENDING_VERIFICATION` atau `REFUNDED` |
| `DELIVERED` | **Terminal.** Stok `SOLD`, kredensial sudah/akan dikirim via outbox. | SOLD | Tidak — `creditOrderToBalance`/`cancelOrder` menolak (`error.order_already_delivered`) |
| `CANCELLED` | **Terminal.** Stok dilepas (`AVAILABLE`), wallet/voucher di-refund. | Dilepas | Tidak (re-cancel = no-op idempoten) |
| `REJECTED` | **Terminal.** Admin menolak bukti bayar manual. Stok dilepas. | Dilepas | Tidak |
| `REFUNDED` | **Terminal.** Hanya dari `UNDERPAID` — saldo USDT diterima dikembalikan ke wallet. | Tidak pernah direservasi (UNDERPAID tidak pernah lolos reservasi) | Tidak |
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
| `→ CANCELLED` (manual user) | User cancel di storefront/bot | `cancelOrder` — **ditolak** jika sudah `PENDING_VERIFICATION` (`error.cannot_cancel_after_proof`, anti fake-proof-then-cancel) |
| `→ CANCELLED` (credit) | Admin "Add to buyer's credit balance" (paid-but-undeliverable) | `creditOrderToBalance` |

## Invariant penting

- **`approveOrder` adalah satu-satunya jalur ke `DELIVERED`** — dipanggil
  baik oleh admin manual maupun oleh setiap `deliverPaid*Order` gateway
  (dengan `adminId: 0` untuk membedakan audit otomatis vs manual). Klaim
  atomik (`updateMany WHERE status=PENDING_VERIFICATION`) menjamin tidak ada
  double-delivery meski dipanggil dua kali bersamaan (Bot-2 fix, audit
  keamanan 2026-06-23).
- **Reservasi stok terjadi di `PENDING_PAYMENT`**, bukan menunggu sampai
  `DELIVERED` — order kedua untuk stok yang sama gagal saat creation
  (`error.out_of_stock`), bukan setelah pembeli kedua sudah bayar
  (Checkout-2 fix). Detail: [INVENTORY_SYSTEM.md](INVENTORY_SYSTEM.md).
- **Status terminal (`DELIVERED`/`CANCELLED`/`REJECTED`/`REFUNDED`) tidak
  bisa ditransisikan lagi** — `cancelOrder`/`creditOrderToBalance` keduanya
  cek daftar status terminal dan menolak (atau no-op idempoten untuk
  `CANCELLED`/`REJECTED`/`REFUNDED` yang di-cancel ulang).
- **`UNDERPAID` eksklusif untuk Binance Internal Transfer** — gateway lain
  (webhook-based) menolak pembayaran kurang sebagai `"amount mismatch"` tanpa
  pernah mengubah status order (order tetap `PENDING_PAYMENT`, baris ledger
  ditandai `unmatched`) — lihat [PAYMENT_GATEWAY.md](PAYMENT_GATEWAY.md).
