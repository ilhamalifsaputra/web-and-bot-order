# Spec — Bybit di storefront + QRIS di bot (metode bayar lintas-front)

> **Status:** disetujui untuk dibuatkan plan (2026-06-15). Belum dieksekusi.
> **Tanggal:** 2026-06-15
> **Konteks:** Setiap front kini hanya menawarkan sebagian metode bayar. Bot:
> Binance Pay (manual), Binance Internal (UID, poller), Bybit USDT-BSC (poller).
> Storefront: USDT→Binance Internal, IDR→TokoPay (QRIS, webhook). Tujuan: bawa
> **Bybit** ke storefront dan **QRIS/TokoPay** ke bot, memakai primitive yang
> sudah ada. Lihat `DOCS.md` §15 (harga pusat IDR + metode bayar) & §16.

## 1. Masalah & tujuan

**Masalah.** Metode bayar tidak simetris antar-front. Pembeli web tak bisa pakai
Bybit; pembeli bot tak bisa bayar QRIS (Rupiah). Padahal engine pembayaran
(poller Bybit, webhook TokoPay) dan crud order (`finalizeOrderPayment`,
`createBybitOrder`, `deliverPaid*`) sudah ada — yang kurang hanya **wiring UI +
flow** di tiap front.

**Tujuan.**
1. Storefront checkout menambah opsi **Bybit (USDT-BSC)** di samping
   USDT-Binance dan QRIS.
2. Bot checkout menambah opsi **QRIS (Rupiah/TokoPay)** di samping Binance Pay,
   Binance Internal, Bybit.
3. Tidak menduplikasi kode gateway: klien TokoPay dipindah ke lokasi bersama
   agar bot **dan** storefront memakainya.

**Non-tujuan (di luar lingkup).**
- Tidak menambah polling-reconcile untuk TokoPay (keputusan user: QRIS di bot
  mengandalkan webhook yang sama dengan storefront; ketergantungan callback URL
  publik diterima & ditandai — lihat §7).
- Tidak mengubah engine konfirmasi yang sudah ada (poller Bybit/Binance, webhook
  TokoPay) selain memindah lokasi klien TokoPay.
- Bukan menambah metode/gateway baru di luar Bybit & TokoPay.

## 2. Arsitektur & ekstraksi bersama (Approach A)

**Klien TokoPay dipindah ke rumah bersama** agar bot bisa membuat transaksi QR:

| Fungsi | Dari | Ke | Alasan |
|---|---|---|---|
| `createTransaction(creds, args)` | `apps/storefront/src/payments/tokopay.ts` | `packages/core/src/payments/tokopay.ts` | Murni HTTP+crypto (Decimal, logger). Tak impor `@app/db` → tak ada lingkaran. Dipakai storefront **dan** bot. |
| `verifyCallback(body, creds)` | idem | idem | Murni; tetap dipakai route webhook storefront. |
| `TokopayCreds`, `TokopayOrderInfo`, `TokopayCallback`, `TOKOPAY_*_KEY` | idem | idem | Tipe + konstanta kunci ikut pindah. |
| `getTokopayCreds(db)` | idem | `@app/db` (`packages/db/src/crud/tokopay.ts`, dekat `resolveBybitConfig`) | Membaca Setting → ranah `@app/db`, pola sama dengan `resolveBybitConfig`. |

- Storefront (`routes/checkout.ts`) memperbarui import: `createTransaction`,
  `verifyCallback`, tipe ← `@app/core/payments/tokopay`; `getTokopayCreds` ←
  `@app/db`. **Tanpa perubahan perilaku** — relokasi murni, test TokoPay
  storefront yang ada harus tetap hijau.
- Bot mengimpor `createTransaction` + `getTokopayCreds` dari rumah baru.
- `apps/storefront/src/payments/tokopay.ts` boleh dihapus setelah isinya pindah
  (atau disisakan sebagai re-export tipis bila ada importir lain — cek saat plan).

**Primitive yang dipakai ulang tanpa perubahan:**
`finalizeOrderPayment(db, id, { currency, rate?, method? })` (IDR memaksa
TOKOPAY; USDT memakai `method`), `createOrderFromCart` (web), `createOrderDirect`
(bot), `resolveBybitConfig` (alamat + enabled), poller Bybit
(`listPendingBybitOrders`/`deliverPaidBybitOrder`), webhook TokoPay
(`deliverPaidTokopayOrder`).

## 3. Storefront — Bybit sebagai opsi ke-3

**Pilihan metode (3 opsi, masing-masing ber-gate):**
- **USDT (Binance)** — `binance` → `finalizeOrderPayment({currency:USDT, rate, method:BINANCE_INTERNAL})` (perilaku sekarang).
- **USDT (Bybit / BSC)** — `bybit` → `finalizeOrderPayment({currency:USDT, rate, method:BYBIT})`.
- **Rupiah (QRIS)** — `qris` → `finalizeOrderPayment({currency:IDR})` (perilaku sekarang).

> Field `method` di POST `/checkout` berubah dari token mata-uang (`USDT`/`IDR`)
> menjadi token metode eksplisit (`binance`|`bybit`|`qris`) agar dua jalur USDT
> bisa dibedakan. `checkoutView`/template menyertakan flag enable per opsi:
> `usdt_enabled` (Binance internal) → `binance_enabled`, tambah `bybit_enabled`
> (`resolveBybitConfig().enabled && rate`), `idr_enabled` (tetap).

**Pembuatan order (`POST /checkout`, dalam `$transaction` yang sama):**
- Validasi: `binance` butuh `isBinanceInternalEnabled() && rate`; `bybit` butuh
  `resolveBybitConfig().enabled && rate`; `qris` butuh `getTokopayCreds()`.
  Gagal → `rerender("web.pay_method_unavailable")`.
- `createOrderFromCart` lalu `finalizeOrderPayment` dengan currency+method sesuai.

**Halaman bayar (`GET /checkout/:code/pay`):**
- `paymentMethod === BYBIT` → tampilkan **alamat deposit + jumlah USDT eksak**
  (dari `resolveBybitConfig().depositAddress` + `order.totalAmount`), meniru
  `checkout.bybit_instructions` bot. Tidak memanggil API Bybit apa pun.
- Cabang `is_usdt` yang ada (Binance UID) tetap untuk `BINANCE_INTERNAL`; cabang
  TokoPay (QR) tetap untuk `TOKOPAY`. Tambah cabang ketiga untuk `BYBIT`.
- Polling status (`/checkout/:code/status`) tak berubah: membaca `order.status`;
  poller Bybit (jalan di combined-server) yang menaikkan status → halaman
  auto-redirect saat DELIVERED.

**Konfirmasi:** poller Bybit yang sudah ada (`deliverPaidBybitOrder`). Pembeli
web-only (telegramId null) cukup melihat order di storefront — sudah didukung.

## 4. Bot — QRIS sebagai opsi ke-4

**Tombol konfirmasi:** `keyboards/customer.ts` `orderConfirmKb(...)` menambah
tombol **"Bayar QRIS (Rupiah)"**, ber-gate `tokopayEnabled` (param baru, dihitung
dari `getTokopayCreds(prisma) != null`). `showOrderConfirmation` &
`renderOrderConfirmation` menghitung `tokopayEnabled` dan meneruskannya (pola
sama dengan `bybitEnabled`).

**Handler baru `buyNowTokopay(ctx, productId, quantity)`** (di
`handlers/checkout.ts`), pola seperti `buyNowBybit`:
1. Gate: `getTokopayCreds(prisma)` ada; cek `MAX_PENDING_ORDERS`.
2. `prisma.$transaction`: `createOrderDirect(tx, {...})` lalu
   `finalizeOrderPayment(tx, id, { currency: IDR })` → order TOKOPAY, Rupiah,
   `totalAmount` = harga pusat IDR eksak (tanpa unique cents).
3. `createTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount })`
   (klien bersama). Simpan hasil JSON ke `order.paymentRef` (idempoten saat
   refresh — `createTransaction` memperlakukan `ref_id` idempoten).
4. Kirim **QR sebagai foto** (`ctx.api.sendPhoto` memakai `gateway.qrLink` PNG)
   dengan caption = jumlah Rupiah + countdown. Keyboard memakai **`ckb.qrisWaitingKb(orderId, lang)`
   baru** — Cancel-only, TANPA tombol "Saya sudah bayar" (QRIS auto-confirm, tak
   ada upload bukti). Lacak `qrMsgId` agar cancel bisa menghapus foto QR (pola
   `sendPaymentInstructions`).
5. Order ditandai active-payment + countdown timer (pola `sendPaymentInstructions`).
   Tak perlu `setOrderPaymentMessage` (webhook tak meng-edit bubble bot; pembeli
   diberi tahu via DM + melihat kredensial di My Orders — §5).

**Tidak ada alur "Saya sudah bayar / upload bukti"** untuk QRIS — konfirmasi
otomatis lewat webhook. Bot menampilkan QR + status menunggu; pembeli scan dengan
e-wallet apa pun.

**Format angka:** bot sudah menampilkan Rupiah (`formatIdr`/`priceIdr`), jadi
caption QRIS natural dalam Rupiah (tanpa konversi USDT).

## 5. Pengantaran kredensial untuk pembeli QRIS Telegram (perbaikan celah)

**Celah:** QRIS dikonfirmasi oleh **webhook** (`deliverPaidTokopayOrder`), bukan
poller bot. Path itu meng-enqueue `ORDER_DELIVERED_DM` yang — sesuai aturan —
**tidak** memuat kredensial dan menunjuk ke **website** ("credentials ready on
the website / My orders"). Pembeli **bot-only** (punya telegramId, mungkin tanpa
akun web) jadi tak punya cara mengambil kredensial: `viewOrder` bot saat ini
TIDAK menampilkan kredensial untuk order DELIVERED.

**Perbaikan (terbatas):**
1. **Tampilkan kredensial di detail order bot** (`handlers/customer.ts`
   `viewOrder`, owner-only) untuk order berstatus DELIVERED — dibaca live dari
   DB (stock items milik order), bukan dari outbox. Pakai blok seperti
   `order.delivered_credentials` / `buildCredentialsBlob`. Kunci i18n baru
   (mis. `order.detail_credentials`).
2. **Wording DM** (`apps/notifier/src/templates.ts` `ORDER_DELIVERED_DM`):
   `deliverPaidTokopayOrder` hanya meng-enqueue DM ini saat `user.telegramId != null`
   (pembeli web-only melihat kredensial di storefront, tanpa DM). Karena semua
   penerima DM ini adalah pembeli Telegram, ubah wording agar menunjuk ke
   **My Orders di bot** (bukan website). Pertahankan `order_url` website sebagai
   tautan opsional. Tak perlu flag baru — gating telegramId sudah menentukan.

> Tetap patuh aturan: kredensial **tak pernah** masuk payload outbox/log;
> hanya ditarik dari DB saat pemiliknya membuka order-nya sendiri.

## 6. Gating, i18n, keamanan

- **Gate per metode** (kedua front): Binance-internal (`isBinanceInternalEnabled`),
  Bybit (`resolveBybitConfig().enabled` + alamat), TokoPay (`getTokopayCreds`).
  Opsi yang mati tak ditampilkan.
- **i18n:** semua string baru (caption QRIS bot, blok kredensial detail, label
  tombol, instruksi Bybit web) lewat `t()`/`coreT()` terhadap
  `packages/core/locales/{en,id}.json` — set kunci & placeholder identik di
  kedua file (aturan CLAUDE.md).
- **Jangan log rahasia:** query `createTransaction` membawa `secret` → jangan
  log URL/query (sudah ditangani di klien). Kredensial & token tak masuk log.
- **CSRF/auth:** route storefront tetap pakai pola yang ada (`csrfProtect` untuk
  POST checkout). Tak ada route baru di web (Bybit pakai checkout + pay yang ada).

## 7. Ketergantungan webhook (ditandai)

QRIS di bot **otomatis** hanya jika webhook TokoPay sampai ke app:
- App harus terjangkau publik (HTTPS) dan **Callback URL** diset di dashboard
  TokoPay ke `https://<host-storefront>/pay/tokopay/callback` (route ada di app
  storefront; di combined-server dilayani host toko).
- Bila tidak: order QRIS (bot & web) mentok `PENDING_PAYMENT` lalu auto-cancel
  saat kedaluwarsa (perilaku yang sudah teramati). Ini **diterima untuk v1**
  (keputusan user) dan didokumentasikan; perbaikan polling-reconcile di luar
  lingkup spec ini.
- Binance Pay/Internal/Bybit di bot **tak terpengaruh** (berbasis poller).

## 8. Testing (ikut CLAUDE.md)

- **Relokasi klien TokoPay:** test TokoPay storefront yang ada tetap hijau
  (mengimpor dari rumah baru). Bila ada unit test untuk `verifyCallback`, pindah
  ikut ke `@app/core`.
- **Storefront Bybit (`app.inject`):**
  - `POST /checkout` method=`bybit` (Bybit enabled) → order dibuat
    `paymentMethod=BYBIT`, `currency=USDT`; redirect ke `/pay`.
  - `GET /checkout/:code/pay` order BYBIT → body memuat alamat deposit + jumlah
    USDT; tidak memanggil API Bybit.
  - method=`bybit` saat Bybit disabled → `web.pay_method_unavailable`.
- **Bot QRIS (handler test, `createTransaction` di-stub):**
  - `buyNowTokopay` → order `TOKOPAY`/`IDR` dibuat; `sendPhoto` dipanggil dengan
    `qrLink`; `paymentRef` menyimpan gateway JSON.
  - Tombol QRIS muncul hanya saat `getTokopayCreds` ada.
- **Detail order bot:** order DELIVERED milik pembeli → `viewOrder` menampilkan
  kredensial; bukan-pemilik → tidak.
- **i18n:** set kunci `en.json`/`id.json` identik (test paritas locale yang ada).
- `pnpm -r typecheck` & `pnpm test` hijau.

## 9. Urutan implementasi (untuk plan)

1. **Ekstraksi klien TokoPay** → `@app/core` (klien) + `@app/db`
   (`getTokopayCreds`); update import storefront; suite hijau (relokasi murni).
2. **Storefront Bybit** — token metode `binance|bybit|qris`, gate, pembuatan
   order, cabang pay-page Bybit, test.
3. **Bot QRIS** — `getTokopayCreds`/`createTransaction` di bot, `buyNowTokopay`,
   tombol `orderConfirmKb`, keyboard QRIS-waiting, i18n, test.
4. **Perbaikan kredensial bot** — `viewOrder` menampilkan kredensial DELIVERED +
   wording DM untuk pembeli telegram; test.
5. **Docs** — `DOCS.md` §15/§16: metode bayar kini simetris; catat dependensi
   callback URL untuk QRIS bot.
