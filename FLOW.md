# Alur Bisnis (Business Flow)

Diagram ini diverifikasi terhadap kode aktual (`packages/core/src/enums.ts`,
`apps/storefront/src/routes/checkout.ts`, `packages/db/src/crud/orders.ts`,
`digiflazz.ts`, `kokinpay.ts`, `vipreseller.ts`, `melostore.ts`,
`wallet_topup.ts`, `OrderStatusTabs.tsx`) — bukan istilah generik. Ada dua
jalur order yang benar-benar terpisah di kode: **PRODUCT** (beli game
top-up / app premium) dan **WALLET_TOPUP** (isi saldo).

## 1. PRODUCT order (GAME_TOPUP / PREMIUM_APPS)

```
                       CUSTOMER
                          │
                 ┌────────┴────────┐
                 │                 │
                 ▼                 ▼
              WEBSITE          BOT ORDER
            (storefront)      (order-bot)
                 │                 │
                 └────────┬────────┘
                          ▼
          PILIH PRODUK (GAME_TOPUP / PREMIUM_APPS)
                          │
                          ▼
                     INPUT DATA
        (akun/ID game — dicek via KokinPay / VIP-Reseller /
         MeloStore untuk nickname/region, bukan fulfillment)
                          │
                          ▼
              VALIDASI + KONFIRMASI ORDER
       (performCheckout → createOrderFromCart, ada layar
        konfirmasi eksplisit sebelum invoice dibuat)
                          │
                          ▼
                   BUAT INVOICE
        (finalizeOrderPayment, sesuai gateway pembayaran)
                          │
                          ▼
                    PEMBAYARAN
   TOKOPAY / PAYDISINI (QRIS, VA, e-wallet) · BINANCE_PAY /
   BINANCE_INTERNAL · BYBIT / BYBIT_BSC (on-chain) ·
   NOWPAYMENTS (USDT) · WALLET (saldo)
                          │
                          ▼
                  PENDING_PAYMENT
      (khusus rail Bybit BSC: PAYMENT_DETECTED → CONFIRMING →
       CONFIRMED — milestone tampilan saja, tidak memicu
       pengiriman)
                          │
                          ▼
                 PENDING_VERIFICATION
                          │
                          ▼
                         PAID
                          │
                          ▼
        settlePaidOrder — cabang per DeliveryType SKU
                          │
             ┌────────────┴────────────┐
             │                         │
             ▼                         ▼
           AUTO              MANUAL / MANUAL_WITH_INFO
   approveOrder: tarik         PROCESSING → admin
   dari stock lokal,           fulfillManualOrder
   langsung DELIVERED —        (hand-fulfill, tanpa
   TANPA panggilan             stock)
   provider live                     │
             │                       ▼
             │                  DELIVERED
             ▼                       │
        DELIVERED ◄──────────────────┘
             │
             ▼
   NOTIFIKASI USER (notification_outbox → bot pengirim)
```

**Digiflazz — pilot, belum production-wired.** `dispatchPendingDigiflazzOrders`
adalah poller terpisah yang mengambil order berstatus `PROCESSING` dengan
denominasi `autoDeliverySource: "digiflazz"` lalu memanggil Digiflazz sebagai
supplier. Kegagalan dispatch **tidak** membuat order jadi `FAILED` — order
tetap `PROCESSING` dan sistem hanya mengirim `alertDigiflazzDispatchFailed`
ke admin. Ini satu-satunya provider fulfillment nyata di kode; belum ada
caller produksi yang memicunya otomatis dari checkout.

**Cabang lain** yang bisa dicapai dari status menunggu/PAID: `UNDERPAID`
(Binance internal transfer kurang bayar, direview admin) · `FAILED`
(kegagalan pipeline otomatis lain, butuh perhatian admin) · `CANCELLED` /
`REJECTED` / `REFUNDED`.

**"Manual review" bukan satu node generik** — di admin panel semua status
`PENDING_PAYMENT, PAYMENT_DETECTED, CONFIRMING, PENDING_VERIFICATION,
UNDERPAID, PROCESSING` dilebur jadi satu tab **"Awaiting"**; itulah antrian
review manual yang sesungguhnya.

## 2. WALLET_TOPUP order (terpisah, tanpa stock/fulfillment)

```
CUSTOMER → WEBSITE / BOT ORDER → TOP UP SALDO
        → BUAT INVOICE (finalizeOrderPayment, jalur IDR saja)
        → PEMBAYARAN → PAID
        → settleWalletTopup (claim atomik → adjustWallet credit)
        → NOTIFIKASI USER
```

`OrderKind.WALLET_TOPUP` tidak pernah melalui stock atau fulfillment sama
sekali — `approveOrder` dan `settlePaidOrder` (jalur PRODUCT di atas) secara
eksplisit menolak order berkind `WALLET_TOPUP`.

## Catatan penting

- **KokinPay / VIP-Reseller / MeloStore** = layanan cek nickname/region akun
  game saat "input data" — **bukan** metode pembayaran, **bukan** provider
  fulfillment.
- **Digiflazz** = satu-satunya supplier fulfillment eksternal nyata di kode,
  tapi statusnya masih pilot/dormant.
- **Notifikasi** selalu lewat `notification_outbox` (`packages/outbox-dispatcher`)
  — web/admin tidak pernah kirim langsung ke Telegram.
