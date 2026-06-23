# Audit Keamanan & Business-Logic — Full Repo

**Tanggal:** 2026-06-23
**Cakupan:** `apps/order-bot`, `apps/web-admin`, `apps/storefront`, `apps/server`,
`packages/core`, `packages/db`, `packages/outbox-dispatcher`, `prisma/schema.prisma`,
infrastruktur (`Dockerfile`, `docker-compose.yml`, `.env.example`).
**Di luar cakupan:** `.claude/worktrees/*` (worktree basi/ditinggalkan).
**Sifat:** READ-ONLY — tidak ada kode yang diubah selama audit ini.
**Metodologi:** 8 agen paralel (model Opus) masing-masing meng-audit satu slice
arsitektur secara independen (checkout/ghost-order, payment gateway, pricing/voucher/wallet,
stock/delivery, admin-web, storefront auth, bot concurrency/admin-bot, infra/secrets/DB
schema), dengan instruksi roleplay sebagai penyerang/fraudster/rogue-staff dan "assume
nothing is safe". Total **56 temuan** dikonsolidasikan dan di-deduplikasi di bawah.

Format tiap temuan: **SEVERITY · FILE · PROBLEM · ATTACK SCENARIO · BUSINESS IMPACT · FIX ·
CODE EXAMPLE · CONFIDENCE**, sesuai brief.

---

## Ringkasan Eksekutif

| Severity | Jumlah |
|---|---|
| Critical | 1 |
| High | 9 |
| Medium | 24 |
| Low | 22 |

### 5 hal yang harus diperbaiki SEGERA (urutan dampak finansial)

1. ✅ **[CRITICAL] `/admin` dan `/wallet` di bot tidak punya gate otorisasi** — siapa pun bisa
   kredit saldo wallet sendiri tak terbatas dan membuka panel admin penuh. → §Bot-1 (DIPERBAIKI 2026-06-23)
2. ✅ **[HIGH] Setup wizard bisa diakses ulang pasca-bootstrap** — pengambilalihan panel admin
   tanpa otentikasi pada deploy yang di-bootstrap via `/bootstrap` bukan wizard. → §Admin-1
   (DIPERBAIKI 2026-06-23)
3. ✅ **[HIGH] `DEFAULT_WEB_ROLE=super` + admin DB tak bisa diturunkan** — setiap admin baru
   yang ditambahkan via web otomatis super, dan UI tidak bisa menurunkan haknya. → §Admin-2
   (DIPERBAIKI 2026-06-23)
4. ✅ **[HIGH] Tanda tangan callback TokoPay tidak mengikat `amount`/`status`** — bila secret
   bocor sekali, penyerang bisa memalsukan "paid" untuk order siapa pun. → §Payment-1
   (DIPERBAIKI 2026-06-23)
5. ✅ **[HIGH] Tidak ada batas voucher per-user** — satu pelanggan bisa memakai voucher diskon
   berkali-kali sampai kuota global habis. → §Pricing-1 (DIPERBAIKI 2026-06-23)
6. ✅ **[HIGH] Stok tidak direservasi saat checkout** — banyak order bisa dibuat untuk stok yang
   sama; pembeli kedua bayar tapi tidak bisa di-deliver (oversell). → §Checkout-2 / §Stock-1
   (DIPERBAIKI 2026-06-23 — catatan: §Stock-1 di badan dokumen adalah temuan TERPISAH [MEDIUM]
   soal dedup kredensial di `bulkAddStock`, kini JUGA sudah diperbaiki 2026-06-23 di luar
   batch Critical/High ini, sebagai bagian dari penyelesaian seluruh 25 temuan Medium)

### Catatan lintas-domain (root cause yang sama, muncul di >1 slice)

- **Ketergantungan implisit pada `BEGIN IMMEDIATE` SQLite.** Beberapa transisi state
  (`approveOrder`, increment `usedCount` voucher, `uniqueOrderCode`) aman HARI INI hanya
  karena Prisma `$transaction` pada SQLite mengambil write-lock di awal (serialisasi nyata).
  Begitu proyek migrasi ke Postgres (trigger resmi: ≥2 concurrent writer, lihat RUN.md §9),
  isolation level default (Read Committed) membuat pola read-then-write ini menjadi race
  yang benar-benar eksploitable. Lihat §Bot-2, §Pricing-2, §Checkout-7.
- **`X-Forwarded-For` dipercaya tanpa daftar proxy tepercaya** muncul independen di
  `apps/web-admin/src/routes/auth.ts` (login/forgot) DAN `apps/storefront/src/rateLimit.ts`
  (login/forgot) — keduanya memungkinkan bypass rate-limit per-IP. Lihat §Admin-8 / §Storefront-4.
- **Default role admin "unset ⇒ super"** ditemukan independen oleh slice admin-web dan
  slice infrastruktur dari dua sudut (UI yang tidak bisa menurunkan role vs. konstanta
  default itu sendiri). Digabung sebagai satu temuan High. Lihat §Admin-2.
- **Pola "klaim atomik sebelum eksekusi" tidak konsisten.** `allocateOneAvailableStock` dan
  `claimNextDueBroadcast`/`drainBroadcasts` (dengan Cron `{protect:true}`) adalah referensi
  yang benar. Tapi outbox dispatcher, broadcast in-bot, `closeTicket`, dan beberapa cron lain
  TIDAK memakai pola ini. Lihat §Infra-2, §Bot-5, §Bot-3, §Bot-4.

---

## A. Slice Checkout & Order Creation (Ghost Orders)

### Checkout-1 [HIGH] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/handlers/checkout.ts:551-573` (buyNowTokopay), `:658-680`
(buyNowPaydisini), `:286-345` (buyNowInternal), `:352-410` (buyNowBybit), `:425-521`
(buyNowNowpayments)
**PROBLEM:** Tidak ada idempotency/debounce untuk double-tap tombol bayar. Setiap tap
membuat order baru (orderCode & paymentRef unik) sehingga lolos semua unique constraint.
Tidak ada anti-replay pada `callbackQuery.id`.
**ATTACK SCENARIO:** User tap "Bayar QRIS" 5x cepat (atau retry grammY akibat koneksi
lambat) → 5 order PENDING_PAYMENT berbeda, 5 QR/invoice gateway berbeda terbentuk untuk
niat beli yang sama.
**BUSINESS IMPACT:** Banjir order hantu PENDING (hingga `MAX_PENDING_ORDERS=10`), reconciliation
gateway berantakan, risiko pembeli membayar dua QR berbeda → kelebihan bayar/refund manual.
Memperburuk Checkout-2 (oversell).
**FIX:** (a) Tolak replay `callbackQuery.id`; (b) sebelum `createOrderDirect`, cek order
PENDING_PAYMENT existing untuk (productId, quantity, paymentMethod) dalam N detik terakhir
dan re-render bubble itu; (c) render `admin.processing`-equivalent buttonless segera
setelah tap pertama.
**CODE EXAMPLE:**
```ts
const dupe = await prisma.order.findFirst({
  where: { userId: info.id, status: OrderStatus.PENDING_PAYMENT,
    items: { some: { productId } }, createdAt: { gt: new Date(Date.now() - 30_000) } },
  orderBy: { createdAt: "desc" },
});
if (dupe) { /* re-render bubble pembayaran dupe ini */ return; }
```
**CONFIDENCE:** High

**Implementasi aktual:** Opsi (b) dari FIX diimplementasikan (helper `refuseDuplicateCheckout`
dipanggil di kelima `buyNow*`), TAPI dengan dua perbedaan dari contoh kode di atas: (1) cek
JUGA mencocokkan `paymentMethod`, bukan hanya `productId` — supaya user yang sengaja ganti
rail setelah percobaan pertama macet tidak ikut terblokir; (2) bukan "re-render bubble dupe
ini" (yang butuh merekonstruksi tampilan spesifik per-rail dari cache, kerja besar untuk 5
rail berbeda), melainkan `answerCallbackQuery({show_alert:true})` dengan pesan
`checkout.duplicate_pending` (key baru, en+id) yang mengarahkan user ke "Pesanan Saya" —
layar yang sudah ada tetap utuh dengan keyboard aksi-lanjut (tidak melanggar "never strand").
Opsi (a) (anti-replay `callbackQuery.id`) dan (c) (`admin.processing`-equivalent buttonless)
TIDAK diimplementasikan — di luar scope minimal untuk menutup celah ghost-order; bisa jadi
hardening lanjutan. Window dedup 30 detik. 3 test regresi baru di
`apps/order-bot/test/handlers.test.ts`: double-tap pada produk+rail sama diblokir (order
count tetap 1, alert ditampilkan), produk berbeda tidak diblokir (per-product/per-rail bukan
global), dan test limit pending-order existing diberi stok cukup pasca fix Checkout-2.

### Checkout-2 [HIGH] — digabung dengan Stock-1 ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/db/src/crud/orders.ts:249-281` (createOrderDirect), `:162-181`
(createOrderFromCart); `packages/db/src/crud/stock.ts:89-93` (countAvailableStock)
**PROBLEM:** Stok hanya divalidasi (`countAvailableStock >= quantity`) saat order dibuat,
TIDAK direservasi. Reservasi/SOLD hanya terjadi nanti di `approveOrder`. N order untuk
produk berstok 1 semuanya lolos validasi creation.
**ATTACK SCENARIO:** Produk X stok=1. Dua pembeli checkout qty 1 hampir bersamaan, keduanya
lolos `countAvailableStock`. Keduanya membayar (gateway auto-confirm). Poller approve order
pertama → SOLD. Order kedua: `allocateOneAvailableStock` return null →
`error.cannot_deliver_out_of_stock` — **pembeli kedua sudah bayar, tidak dapat barang**.
**BUSINESS IMPACT:** Oversell terstruktur, butuh refund/credit manual; pada produk langka
bisa menumpuk banyak "paid but undeliverable". Mitigasi parsial: `creditOrderToBalance`
sudah ada (jadi kerugian operasional, bukan kehilangan dana permanen).
**FIX:** Reservasi stok atomik saat creation dengan `allocateOneAvailableStock` di dalam
`$transaction` (sudah ada guard optimistic-lock `updateMany WHERE status=AVAILABLE`), lepas
via `releaseOrderHolds` saat cancel/expire (jalur release sudah ada).
**CODE EXAMPLE:**
```ts
for (let k = 0; k < args.quantity; k++) {
  const reserved = await allocateOneAvailableStock(db, args.productId, order.id);
  if (!reserved) throw new ValidationError("error.out_of_stock", { product: product.name });
  await db.orderItem.create({ data: { orderId: order.id, productId: args.productId,
    stockItemId: reserved.id, quantity: 1, unitPrice: q4(unit),
    warrantyDaysSnapshot: product.warrantyDays } });
}
```
**CONFIDENCE:** High (dikonfirmasi oleh dua agen independen dari dua sudut — checkout &
stock; `stock_deduction.test.ts` mengonfirmasi "checkout does not reserve stock" sebagai
behaviour saat ini, bukan jaminan keamanan).

**Implementasi aktual:** Diimplementasikan persis seperti FIX di kedua `createOrderFromCart`
dan `createOrderDirect`, PLUS pre-check `countAvailableStock` per line SEBELUM loop reservasi
(fast-fail agar kasus umum "minta lebih dari stok" tidak meninggalkan reservasi parsial saat
fungsi dipanggil tanpa `$transaction` pembungkus eksplisit — semua caller produksi nyata
SUDAH membungkus dalam `tx`, tapi banyak test memanggil langsung lewat `prisma` mentah).
`approveOrder` TIDAK perlu diubah sama sekali — `if (!stock || stock.status !== RESERVED)`
yang sudah ada otomatis menangani baris yang sudah RESERVED (tinggal flip ke SOLD) maupun
kasus replacement-allocation untuk skenario residual (baris RESERVED hilang lewat cara lain
di luar app). `releaseOrderHolds` (dipakai cancel/reject/creditOrderToBalance) juga sudah
benar melepas RESERVED→AVAILABLE tanpa perubahan.

Test diupdate: `stock_deduction.test.ts` (judul + assertion dibalik dari "does not reserve"
ke "reserves", +1 test out-of-stock fail-fast), `order_creation.test.ts` (item.stockItem kini
non-null di happy path), `apps/web-admin/test/web.test.ts` (test atomicity approveOrder
dirombak total — skenario asli "stok habis ANTARA creation dan approval" sudah TERTUTUP oleh
fix ini, diganti test untuk skenario residual: baris RESERVED hilang lewat intervensi DB
langsung di luar app), `apps/order-bot/test/handlers.test.ts` (top-up stock pada test limit
pending-order yang sebelumnya mengandalkan stok tak-pernah-berkurang), dan stock pool bersama
di `apps/storefront/test/storefront.test.ts` dinaikkan dari 5→100 (banyak test checkout di
file itu kini benar-benar mengonsumsi stok). Seluruh 851 test repo + typecheck semua package
hijau setelah perubahan.

### Checkout-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/handlers/checkout.ts:570-577, :677-684, :476-488`
**PROBLEM:** Order sudah di-commit sebelum `createTransaction(...)` gateway dipanggil. Jika
gateway gagal, order yatim (PENDING_PAYMENT tanpa QR) tetap ada, menghabiskan slot pending.
**ATTACK SCENARIO:** Gateway down saat checkout → order dibuat tanpa instruksi bayar →
menumpuk hingga `autoCancelExpiredOrders`, mempersempit kuota 10-pending user sah.
**BUSINESS IMPACT:** Noise reconciliation, user sah tertolak `error.too_many_pending`.
**FIX:** Batalkan order di `catch` saat gateway gagal, sebelum menampilkan
`payment_unavailable`.
**CODE EXAMPLE:**
```ts
} catch (err) {
  await prisma.$transaction((tx) => cancelOrder(tx, order.id, "gateway_create_failed")).catch(() => {});
  await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
  return;
}
```
**CONFIDENCE:** High

**Implementasi aktual:** Diimplementasikan persis seperti CODE EXAMPLE di ketiga rail yang
memanggil gateway eksternal (`buyNowTokopay`, `buyNowPaydisini`, `buyNowNowpayments`) — di
`catch` block-nya, `cancelOrder` dipanggil dalam `$transaction` terpisah dan errornya
di-swallow (`.catch(() => {})`) supaya kegagalan cancel tidak menyembunyikan pesan
`payment_unavailable` yang lebih penting bagi user. `buyNowInternal`/`buyNowBybit` tidak
butuh fix ini (tidak ada panggilan gateway eksternal yang bisa gagal setelah order dibuat).
Sebagai bonus, fix ini sekaligus menggeser titik `delete ctx.session.scratch.appliedVoucherCode`
ke SETELAH order berhasil dibuat di SEMUA lima `buyNow*` (lihat §Pricing-3 — temuan terpisah
yang diperbaiki bersamaan karena titik kodenya bertumpuk). 1 test regresi baru di
`apps/order-bot/test/handlers.test.ts`: order yang gagal di tahap `createTransaction` (TokoPay)
berakhir CANCELLED, bukan PENDING_PAYMENT yatim.

### Checkout-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/core/src/formatters.ts:99-102` (computeUniqueCents) dengan
`apps/order-bot/src/handlers/checkout.ts:352-410` (buyNowBybit)
**PROBLEM:** Disambiguator amount Bybit (`(orderId % 49) + 1`) hanya punya 49 bucket
berbeda. Dua order pending dengan base amount sama dan `orderId % 49` sama akan punya
total identik → ambigu saat matching.
**ATTACK SCENARIO:** Dua order Bybit base-amount sama dengan id kongruen mod 49 punya total
sama persis; satu deposit masuk, matcher bisa menolak keduanya atau salah-kaitkan.
**BUSINESS IMPACT:** Pada produk populer, kolisi mod-49 sering terjadi → pembayaran sah
tidak ter-match, atau (skenario terburuk) deposit mengonfirmasi order yang salah.
**FIX:** Perbesar ruang bucket jauh di atas 49, atau jamin `totalAmount` unik di antara
order PENDING_PAYMENT Bybit aktif (loop sampai bentrok hilang, seperti pola `paymentRef`).
**CONFIDENCE:** Medium (perilaku matcher final di slice payment; ruang kolisi pasti sempit).

**Implementasi aktual:** Opsi kedua dari FIX dipilih: `finalizeOrderPayment`
(`packages/db/src/crud/pricing.ts`) untuk method BYBIT sekarang melakukan loop (maks 49
percobaan) mengecek `totalAmount` terhadap pool YANG SAMA yang dibaca matcher
(`listPendingBybitOrders`: status PENDING_PAYMENT, method BYBIT, belum expired) — jika
bentrok, `cents` dihitung ulang dengan `computeUniqueCents(order.id + attempt)` sampai unik.
49-bucket space-nya sendiri TIDAK diperbesar (computeUniqueCents tetap dipakai bersama oleh
rail lain) — pendekatan ini menjamin keunikan terhadap pool aktif tanpa mengubah kontrak
fungsi murni itu. 1 test regresi baru di `apps/order-bot/test/bybit-deposit.test.ts`:
20 order Bybit berurutan untuk produk yang sama (base amount identik) semuanya mendapat
`totalAmount` yang berbeda.

### Checkout-5 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/handlers/callbacks.ts:75-108` → `checkout.ts` (param qty)
**PROBLEM:** Quantity dari callback data `v1:payq:<pid>:<qty>` langsung `parseInt` tanpa
validasi server-side (≥1, integer) di `createOrderDirect`. Clamp hanya ada di jalur UI.
**ATTACK SCENARIO:** Callback data ter-craft `v1:payq:42:0` atau `:-5` → order dengan total
0/negatif lolos creation (qty 0 → tanpa item; qty negatif → subtotal negatif).
**BUSINESS IMPACT:** Order ghost/free jika lolos sampai pembayaran (invoice nol/aneh).
**FIX:** Validasi qty integer ≥1 dan ≤batas wajar di `createOrderDirect`/`createOrderFromCart`,
jangan andalkan UI clamp.
**CODE EXAMPLE:**
```ts
if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > MAX_QTY_PER_ORDER) {
  throw new ValidationError("error.invalid_quantity");
}
```
**CONFIDENCE:** High (gap validasi pasti; eksploitasi butuh kemampuan kirim callback arbitrer).

**Implementasi aktual:** Diimplementasikan persis seperti CODE EXAMPLE — guard
`assertValidQuantity` (integer, 1 ≤ qty ≤ 99, batas sama dengan cap cart yang sudah ada di
`cart.ts`) ditambahkan di `createOrderDirect` DAN di loop per-baris `createOrderFromCart`
(`packages/db/src/crud/orders.ts`), melempar `error.invalid_quantity` (key locale baru,
en+id). 3 test regresi baru di `packages/db/src/crud/purchase_flow.test.ts`: qty 0/negatif/
desimal ditolak sebelum stok tersentuh, qty di atas 99 ditolak.

### Checkout-6 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/db/src/crud/orders.ts:638-724` (approveOrder), dipanggil dengan
`adminId: 0` dari poller (`binanceInternal.ts:192`)
**PROBLEM:** Auto-deliver (poller membayar→approve) tidak meninggalkan baris
`logAdminAction`. Melanggar konvensi "Audit every state change with the acting admin id".
**BUSINESS IMPACT:** Celah jejak audit pada transisi paling sensitif (paid→delivered,
stok→SOLD); menyulitkan forensik klaim "bayar tapi tidak dapat barang".
**FIX:** Tambahkan baris audit sistem (pola `adminId: null, action: "order.auto_deliver"`
sudah dipakai di `jobs/index.ts:129`).
**CODE EXAMPLE:**
```ts
await logAdminAction(tx, { adminId: null, action: "order.auto_deliver",
  targetType: "order", targetId: order.id, details: `tx=${args.binanceTxId} code=${order.orderCode}` });
```
**CONFIDENCE:** Medium

**Implementasi aktual:** Diimplementasikan persis seperti CODE EXAMPLE, langsung di dalam
`approveOrder` itu sendiri (bukan di tiap caller) dengan guard `if (args.adminId === 0)` —
caller manusia (verification.ts, web-admin `/orders/:id/approve`) sudah menulis baris audit
`approve_order` mereka sendiri dengan admin id asli, jadi guard ini mencegah baris ganda.
Detailnya `code=${order.orderCode}` saja (tanpa `tx=`, karena `approveOrder` sendiri tidak
menerima parameter txId — txId sudah ada di ledger `processed*Tx` masing-masing gateway).
2 test regresi baru: `packages/db/src/crud/tokopay.test.ts` (auto-deliver TokoPay menulis
baris `order.auto_deliver` dengan `adminId: null`) dan `packages/db/src/crud/stock_deduction.test.ts`
(approve dengan admin id asli TIDAK menulis baris auto_deliver ganda).

### Checkout-7 [LOW]
**FILE:** `packages/db/src/crud/orders.ts:72-82` (uniqueOrderCode)
**PROBLEM:** SELECT-lalu-INSERT non-atomik untuk orderCode; UNIQUE constraint jadi jaring
pengaman terakhir (gagal-loud, bukan duplikat diam-diam).
**BUSINESS IMPACT:** Minimal — hanya UX error pada kasus sangat jarang.
**FIX:** Tangkap P2002 pada `order.create` dan retry generate ulang kode.
**CONFIDENCE:** High

### Checkout-8 [LOW]
**FILE:** `apps/order-bot/src/jobs/index.ts:68-93` + `packages/db/src/crud/orders.ts:498-526`
**PROBLEM:** Window race antara `autoCancelExpiredOrders` dan deposit auto-confirm tepat
saat expiry. `cancelOrder` idempoten untuk status terminal sehingga aman di satu arah, tapi
arah sebaliknya (cancel duluan, deposit telat) membuat deposit jadi unmatched.
**BUSINESS IMPACT:** Edge kecil: user bayar tepat di detik expiry → butuh credit manual.
**FIX:** Beri grace period (mis. `expiresAt < now - 60s`) sebelum auto-cancel benar-benar
mengeksekusi.
**CONFIDENCE:** Medium

---

## B. Slice Payment Gateway & Callback Security

### Payment-1 [HIGH] ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/core/src/payments/tokopay.ts:144-150`;
`apps/storefront/src/routes/checkout.ts:543-580`
**PROBLEM:** Tanda tangan callback TokoPay = `md5(merchantId:secret:refId)` — **tidak
menyertakan `amount`/`status`/`trx_id`**. Untuk satu `refId`, signature konstan, tidak
terikat isi pembayaran. Gerbang amount-check di webhook memakai `cb.amount` dari body yang
TIDAK ditandatangani.
**ATTACK SCENARIO:** Bila `secret` bocor sekali (log, third party, dsb), penyerang dapat
menempa callback untuk **order siapa pun** dengan `nominal` & `status:"success"` palsu →
`deliverPaidTokopayOrder` mengirim produk digital tanpa uang masuk.
**BUSINESS IMPACT:** Pengiriman produk digital gratis untuk order mana pun; skema md5
tanpa amount mengubah "kebocoran sekali" jadi "pemalsuan tak terbatas".
**FIX:** (a) Sertakan amount & status dalam material signature; (b) pertahanan berlapis:
verifikasi server-to-server (`checkTransaction`) ke provider sebelum deliver, jangan percaya
`cb.amount` dari body; (c) verifikasi skema asli TokoPay (kode sendiri menandainya ASUMSI).
**CODE EXAMPLE:**
```ts
const expected = createHash("md5")
  .update(`${creds.merchantId}:${creds.secret}:${refId}:${amountRaw}:${status}`)
  .digest("hex");
const live = await checkTransaction(creds, { refId: cb.refId, amountIdr: order.totalAmount });
if (!live.paid || live.amount.lessThan(order.totalAmount)) return reply.send({ status: "ignored" });
```
**CONFIDENCE:** Medium (skema ditandai ASUMSI di kode; jika TokoPay asli menyertakan amount,
severity turun — tapi pola "signature tidak menutupi amount" tetap kelemahan desain nyata).

**Implementasi aktual:** Skema signature MD5 TIDAK diubah — mengubahnya tanpa konfirmasi
terhadap dokumentasi/dashboard TokoPay yang sebenarnya berisiko mematahkan verifikasi
signature pada callback PRODUKSI yang sah (downtime total pada rail TokoPay). Sebagai
gantinya dipakai opsi pertahanan berlapis dari FIX (b) di atas: `apps/storefront/src/routes/checkout.ts`
sekarang memanggil `checkTransaction` (yang sudah ada di `tokopay.ts`, request
server-to-server ke API TokoPay memakai `secret`) SETELAH signature lolos, dan keputusan
"paid"/amount yang dipakai untuk delivery berasal dari hasil live call itu — bukan lagi dari
field body callback yang tidak ditandatangani. Penyerang yang menempa body (`nominal`/`status`
palsu) tidak bisa memalsukan respons live TokoPay yang sebenarnya. 10 test regresi baru di
`apps/storefront/test/tokopay-webhook.test.ts` (meng-mock `checkTransaction`) menutup: callback
sah, callback dipalsukan dengan live-check menolak, live-check melaporkan amount lebih kecil
dari body, kegagalan live-check (network) tidak pernah delivery, serta semua jalur lain yang
sudah ada (disabled/bad-signature/idempotent/unmatched/wrong-method/ignored).

### Payment-2 [HIGH] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/payments/bybitDeposit.ts:238-261` (matchByAmount);
`apps/order-bot/src/payments/binanceInternal.ts:105-114, 300-347`
**PROBLEM:** Bybit (dan fallback Binance tanpa memo) mencocokkan deposit HANYA berdasarkan
amount unik (±0.001 USDT), tanpa pengikatan ke identitas pengirim. Keamanan 100% bergantung
`USE_UNIQUE_CENTS`, yang hanya WARNING saat mati (bukan hard-fail).
**ATTACK SCENARIO:** Siapa pun yang tahu total USDT unik order korban dapat mentransfer
nominal itu dari akunnya sendiri → poller men-deliver order korban ke pengirim yang salah
(confused-deputy; bisa disalahgunakan untuk referral/reputasi).
**BUSINESS IMPACT:** Mis-attribution pembayaran; risiko finansial langsung pada rail
tanpa-memo, terutama jika `USE_UNIQUE_CENTS` lalai dimatikan di produksi.
**FIX:** Jadikan `USE_UNIQUE_CENTS` hard requirement (refuse-to-start) untuk Bybit/Binance
amount-matching, bukan sekadar warning.
**CODE EXAMPLE:**
```ts
if (cfg.enabled && !config.USE_UNIQUE_CENTS) {
  throw new Error("Bybit/Binance amount-matching requires USE_UNIQUE_CENTS=1");
}
```
**CONFIDENCE:** Medium (desain sadar-risiko: kolisi ditolak bukan ditebak; tapi
ketiadaan pengikatan pengirim + warning-bukan-hard-fail membuat ini layak High).

**Implementasi aktual:** TIDAK melempar `throw` di dalam `.then()` yang tidak ter-`await`
(`startPolling` memanggil `resolveBybitConfig(prisma).then(...)` dengan `void` — melempar di
sana akan jadi unhandled rejection yang, tanpa handler global yang sudah diketahui hilang
di Infra-6, akan mematikan SELURUH proses single-process termasuk web-admin & storefront,
disproporsional terhadap kesalahan-konfigurasi satu gateway). Sebagai gantinya, hard gate
dipasang pada titik yang benar-benar berulang: `pollOnce` Bybit (satu-satunya jalur match
untuk Internal Transfer, tanpa memo sama sekali) menolak memproses deposit setiap tick bila
`USE_UNIQUE_CENTS` mati — `return` dini sebelum panggilan network apa pun, log `error`, dan
otomatis pulih live tick berikutnya begitu operator menyalakan flag (tanpa restart). Untuk
Binance, fallback amount HANYA dipakai saat memo/note kosong; matching by-note tidak
terpengaruh sama sekali. Gate diterapkan tepat di titik fallback itu di `processTransfers`
(`order = byNote ?? (config.USE_UNIQUE_CENTS ? matchByAmount(tx, orders) : undefined)`),
bukan mematikan seluruh poller Binance. 1 test regresi baru untuk `pollOnce` Bybit
(memverifikasi tidak ada panggilan network) + 2 test baru untuk fallback Binance
(amount-fallback berhasil HANYA saat flag aktif; tetap unmatched, bukan delivered, saat
mati) — lihat `apps/order-bot/test/bybit-deposit.test.ts` dan `binance-internal.test.ts`.

### Payment-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/storefront/src/routes/checkout.ts:543, 587, 636` (tiga webhook)
**PROBLEM:** Tidak ada rate limiting di endpoint webhook publik. `orderCode` hanya ~1.68
juta kombinasi/hari; respons TokoPay/PayDisini berbeda untuk "bad signature" vs
"unmatched"/"ignored" → oracle untuk menebak refId valid.
**BUSINESS IMPACT:** Memperbesar dampak Payment-1; juga DoS ringan ke DB (query+insert
ledger tiap hit).
**FIX:** Rate limit per-IP pada ketiga route; respons seragam untuk semua kasus non-otentik.
**CODE EXAMPLE:**
```ts
app.post("/pay/tokopay/callback", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, handler);
```
**CONFIDENCE:** Medium

**Implementasi aktual:** Bukan `@fastify/rate-limit` plugin (tidak terpasang di storefront);
sebagai gantinya helper in-process baru `webhookRateLimited(route, ip)` di
`apps/storefront/src/rateLimit.ts` — sliding window per-`${route}:${ip}` (mengikuti pola
`loginRateLimited` yang sudah ada di file yang sama), 30 hit/60 detik per route per IP.
Dipanggil sebagai baris pertama di ketiga handler webhook (TokoPay/PayDisini/NOWPayments),
mengembalikan 429 SEBELUM signature/body diproses sama sekali — lebih murah dari menjalankan
plugin rate-limit penuh untuk kasus ini. Respons untuk kasus non-otentik TIDAK diseragamkan
(403 disabled / 403 bad signature / 200 unmatched/ignored/dll tetap berbeda) — itu di luar
scope minimal fix ini (mengubahnya berisiko memutus integrasi gateway yang mengandalkan kode
balasan tertentu untuk berhenti retry). 4 test regresi baru: 2 unit test di
`apps/storefront/test/rate-limit.test.ts` (`webhookRateLimited` unit + integrasi route-level
429 setelah `WEBHOOK_RATE_LIMIT_MAX` hit, bucket terpisah per route).

### Payment-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/storefront/src/routes/checkout.ts:543-677` (semua webhook)
**PROBLEM:** Pemeriksaan amount tidak melakukan cross-check currency secara eksplisit
antara `cb.amount` dan `order.currency` (IDR vs USDT).
**BUSINESS IMPACT:** Risiko salah-deliver pada perubahan konfigurasi/metode tak terduga
(edge-case, defensif).
**FIX:** Validasi `order.currency` sesuai gateway sebelum membandingkan amount.
**CONFIDENCE:** Low-Medium

**Implementasi aktual:** Diimplementasikan persis seperti FIX — guard pencarian order di
ketiga webhook sekarang juga memeriksa `order.currency` eksplisit (TokoPay/PayDisini →
`OrderCurrency.IDR`, NOWPayments → `OrderCurrency.USDT`), bukan hanya `order.paymentMethod`.
Dalam operasi normal kedua field ini selalu konsisten (`finalizeOrderPayment` selalu
men-stamp keduanya bersamaan), jadi fix ini murni defense-in-depth untuk bug masa depan yang
memisahkan keduanya. 3 test regresi baru (satu per gateway) yang membuat order dengan
`paymentMethod` benar tapi `currency` yang DISENGAJAKAN salah, dan memverifikasi webhook
menolaknya sebagai "unmatched" tanpa menyentuh status order.

### Payment-5 [LOW]
**FILE:** `apps/order-bot/src/payments/binanceInternal.ts:309-319`
**PROBLEM:** Jalur amount-match menetapkan `cls="match"` tanpa `classifyTx` → tidak ada cek
underpaid eksplisit di jalur ini (diredam toleransi ±0.001 + unique-cents).
**FIX:** Tetap jalankan validasi amount eksplisit di jalur amount juga.
**CONFIDENCE:** Low

### Payment-6 [LOW]
**FILE:** `apps/web-admin/src/routes/payments.ts:196-239` (/payments/credit)
**PROBLEM:** Route tidak memverifikasi `ledger.outcome === "unmatched"` sebelum kredit
(berbeda dari `manualMatchTx`/`dismissUnmatchedTx`). Admin double-klik bisa berisiko
double-credit jika `creditOrderToBalance` hilir tidak idempoten (perlu cross-check §Pricing).
**FIX:** Tegaskan status `unmatched` + re-tag baris dalam transaksi yang sama sebagai gerbang
idempotensi.
**CONFIDENCE:** Low

**Catatan positif:** Signature NOWPayments (HMAC-SHA512 atas body ter-sort, `timingSafeEqual`)
menutup seluruh body — aman dari tamper/replay-amount. Idempotensi double-delivery via UNIQUE
constraint + atomic insert konsisten di semua gateway (webhook vs reconcile tidak saling
menggandakan). Semua poller read-only ke provider.

---

## C. Slice Pricing, Voucher, Wallet & FX

### Pricing-1 [HIGH] ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/db/src/crud/vouchers.ts:75-102`; `packages/db/src/crud/orders.ts:127-204`;
`prisma/schema.prisma:282-297`
**PROBLEM:** Tidak ada batas pemakaian voucher PER-USER — hanya `usageLimit`/`usedCount`
global. Tidak ada tabel redemption, tidak ada kolom userId pada pemakaian voucher.
**ATTACK SCENARIO:** Voucher promo "WELCOME50" (dimaksud sekali per pelanggan baru) dipakai
berulang oleh satu pelanggan sampai kuota global 1000 habis sendiri — atau tak terbatas bila
`usageLimit=null`.
**BUSINESS IMPACT:** Kerugian langsung % diskon pada tiap order berulang; promo
"first order"/"new customer" sama sekali tidak tertegakkan.
**FIX:** Tabel `VoucherRedemption(voucherId, userId, orderId, createdAt)` dengan unique index
`(voucherId, userId)`, dicek+insert di `$transaction` yang sama dengan pembuatan order.
**CODE EXAMPLE:**
```ts
if (voucher.perUserLimit != null) {
  const used = await db.voucherRedemption.count({ where: { voucherId: voucher.id, userId: args.user.id } });
  if (used >= voucher.perUserLimit) throw new ValidationError("error.voucher_used_up");
}
await db.voucherRedemption.create({ data: { voucherId: voucher.id, userId: args.user.id, orderId: order.id } });
```
**CONFIDENCE:** High

**Implementasi aktual:** Tabel `VoucherRedemption` ditambahkan persis seperti FIX (migrasi
`prisma/migrations/20260623074724_add_voucher_redemptions/`, divalidasi byte-identik terhadap
`prisma migrate diff`), TAPI tanpa kolom `perUserLimit` konfigurabel — cap di-hardcode 1x per
voucher per user via unique index `(voucherId, userId)`, opsi yang FIX di atas sendiri
tawarkan sebagai alternatif lebih sederhana ("dengan unique index... bila batas adalah
1x/user"). Tidak menambah field admin-configurable baru yang tidak diminta. Cek dilakukan di
`assertVoucherNotRedeemedByUser` (vouchers.ts) dipanggil SEBELUM `applyVoucherToSubtotal` di
kedua `createOrderFromCart` dan `createOrderDirect`; insert redemption terjadi tepat di
sebelah increment `usedCount`, dalam transaksi yang sama dengan pembuatan order. Unique index
tetap jadi race-safety net (kategori risiko laten yang sama dengan Pricing-2 — aman hari ini
karena serialisasi SQLite, perlu di-harden bersamaan saat migrasi Postgres). Locale key baru
`error.voucher_already_redeemed` ditambahkan ke `en.json`+`id.json` (key set identik,
diverifikasi `locales.test.ts`). 7 test regresi baru di `voucher_application.test.ts` (4) dan
`purchase_flow.test.ts` (1) memverifikasi: redemption row tercatat, reuse oleh user yang sama
ditolak, user LAIN tetap bisa pakai voucher yang sama (cap per-user bukan global), dan
percobaan yang ditolak tidak ikut menaikkan `usedCount` global.

### Pricing-2 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/db/src/crud/orders.ts:124-204, :237-288`
**PROBLEM:** Validasi limit voucher (read) dan increment `usedCount` (write) adalah dua
langkah non-atomik. Aman HARI INI karena SQLite single-writer serialisasi
`$transaction`, tapi bom waktu pasca-migrasi Postgres (lihat catatan lintas-domain).
**ATTACK SCENARIO:** Voucher `usageLimit=1`; dua checkout nyaris bersamaan keduanya baca
`usedCount=0`, keduanya increment → `usedCount=2`, limit terlampaui.
**FIX:** Increment kondisional atomik: `updateMany` dengan filter `usedCount < usageLimit`,
periksa `count===1` sebelum melanjutkan.
**CODE EXAMPLE:**
```ts
const bumped = await db.voucher.updateMany({
  where: { id: voucher.id, OR: [{ usageLimit: null }, { usedCount: { lt: voucher.usageLimit ?? undefined } }] },
  data: { usedCount: { increment: 1 } },
});
if (bumped.count === 0) throw new ValidationError("error.voucher_used_up");
```
**CONFIDENCE:** Medium

**Implementasi aktual:** Diimplementasikan persis seperti FIX/CODE EXAMPLE — helper baru
`bumpVoucherUsage(db, voucher)` di `packages/db/src/crud/orders.ts` membungkus
`updateMany` kondisional, dipakai oleh `createOrderFromCart` dan `createOrderDirect`
menggantikan `db.voucher.update({ data: { usedCount: { increment: 1 } } })` langsung. Atomik
di level isolasi DB manapun (lebih kuat dari ketergantungan implisit pada serialisasi
SQLite). 1 test regresi baru di `packages/db/src/crud/purchase_flow.test.ts`: voucher
`usageLimit=1` yang sudah terpakai oleh user A menolak order user B dengan
`error.voucher_used_up`, dan `usedCount` tidak melebihi limit.

### Pricing-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/conversations/checkout.ts:78-91`; `handlers/checkout.ts:110-130`
**PROBLEM:** Kode voucher di-cache di sesi (`ctx.session.scratch.appliedVoucherCode`) dan
otomatis diterapkan ulang ke checkout berikutnya tanpa input ulang — memperkuat Pricing-1.
**FIX:** Hapus `appliedVoucherCode` dari sesi setelah satu order berhasil dibuat.
**CODE EXAMPLE:**
```ts
delete ctx.session.scratch.appliedVoucherCode; // setelah createOrderDirect sukses
```
**CONFIDENCE:** Medium

**Implementasi aktual:** Titik `delete ctx.session.scratch.appliedVoucherCode` di KELIMA
`buyNow*` (`apps/order-bot/src/handlers/checkout.ts`) digeser dari SEBELUM pembuatan order
(perilaku lama: voucher langsung dihapus dari sesi begitu dibaca, walau order gagal dibuat
karena out-of-stock dll — artinya retry user kehilangan voucher yang sudah diketik ulang)
menjadi SETELAH order berhasil dibuat. Ini BUKAN sekadar menghapus voucher lebih awal seperti
CODE EXAMPLE menyiratkan — efeknya dua arah: voucher TETAP di sesi jika order gagal (retry
bisa pakai lagi), dan baru benar-benar dihapus begitu order sukses (mencegah reuse tanpa
input ulang, menutup Pricing-1 dari sisi UX bot). 3 test regresi baru di
`apps/order-bot/test/handlers.test.ts`: voucher tetap di sesi setelah order gagal (stok 0),
voucher terhapus setelah order sukses.

### Pricing-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/db/src/crud/orders.ts:57-70` (computeBulkDiscountForCart) +
upsert bulk-pricing/voucher
**PROBLEM:** Tidak ada validasi batas atas pada `discountPercent` (bulk pricing maupun
voucher PERCENT) di lapisan crud — satu-satunya pencegah order Rp0 adalah disiplin admin.
**ATTACK SCENARIO:** Admin keliru set `discountPercent=100` (atau >100) → order gratis.
**FIX:** Validasi `discountPercent`/`value` PERCENT ∈ (0,100] saat `upsertBulkPricing`/`createVoucher`.
**CODE EXAMPLE:**
```ts
if (new Decimal(discountPercent).lte(0) || new Decimal(discountPercent).gt(100))
  throw new ValidationError("error.invalid_discount_percent");
```
**CONFIDENCE:** Medium

**Implementasi aktual:** Diimplementasikan persis seperti CODE EXAMPLE di kedua tempat:
`upsertBulkPricing` (`packages/db/src/crud/catalog.ts`) untuk SEMUA discountPercent (bulk
pricing tidak punya konsep tipe FIXED), dan `createVoucher` (`packages/db/src/crud/vouchers.ts`)
HANYA untuk `type === VoucherType.PERCENT` — voucher FIXED tidak dibatasi karena nilainya
sudah otomatis di-cap ke subtotal oleh `applyVoucherToSubtotal`, jadi tidak ada risiko Rp0
darinya. `createVoucher` diubah jadi `async function` (sebelumnya sync) supaya error validasi
konsisten sebagai promise rejection seperti error lain di fungsi itu — semua caller sudah
`await` hasilnya jadi tidak ada breaking change. Key locale baru `error.invalid_discount_percent`
(en+id). 7 test regresi baru gabungan di `packages/db/src/crud/bulk_pricing.test.ts` (3) dan
`packages/db/src/crud/vouchers.test.ts` (4): >100 ditolak, 0/negatif ditolak, persis 100
diterima, voucher FIXED dengan value besar TIDAK dibatasi.

### Pricing-5 [LOW]
**FILE:** `packages/db/src/crud/orders.ts:46-44, :168-178, :270-281`
**PROBLEM:** `warrantyDaysSnapshot` di-assign lewat cast `as unknown` yang membypass tipe;
risiko regresi diam-diam jika `getCart` berhenti meng-include `warrantyDays`.
**FIX:** Tambahkan `warrantyDays` ke tipe `CartLine.product`, hapus cast.
**CONFIDENCE:** Low

### Pricing-6 [LOW]
**FILE:** `packages/core/src/formatters.ts:45-47` (usdtFromIdr); `packages/core/src/fx.ts:32-41`
**PROBLEM:** Pembulatan `ROUND_HALF_UP` ke 0.1 USDT bisa membulatkan ke bawah untuk
pembeli, erosi margin kecil-konsisten pada produk murah berbasis USDT.
**FIX:** Pertimbangkan `ROUND_UP` (memihak house) atau presisi 0.01 USDT. Keputusan bisnis,
bukan bug keamanan.
**CONFIDENCE:** Low

### Pricing-7 [LOW]
**FILE:** `packages/db/src/crud/orders.ts:130-194` (afterDiscount/walletUsed)
**PROBLEM:** Jika bulkDiscount+voucherDiscount > subtotal, `afterDiscount` bisa negatif
sebelum di-clamp; `walletUsed = min(walletAmount, afterDiscount)` ikut negatif. Guard
`walletUsed.greaterThan(0)` mencegah dampak finansial (tidak ada penambahan saldo nyata),
tapi `order.walletUsed` tersimpan negatif — data korup untuk audit/reporting.
**FIX:** `Decimal.max(0, subtotal - bulkDiscount - voucherDiscount)` sebelum hitung
`walletUsed`.
**CODE EXAMPLE:**
```ts
const afterDiscount = Decimal.max(ZERO, subtotal.minus(bulkDiscount).minus(discount));
const walletUsed = Decimal.min(walletAmount, afterDiscount); // kini ≥0
```
**CONFIDENCE:** Medium (no kerugian uang, tapi integritas data audit)

**Catatan positif:** Harga akhir TIDAK PERNAH berasal dari client (bot hanya kirim
productId/qty/voucherCode; storefront cart guest hanya `{p,q}`). Vektor manipulasi harga
langsung tertutup. Negative-price guard ada di banyak titik (`adjustWallet` menolak
overdraw, `creditOrderToBalance` idempoten, callback gateway menolak short-payment).

---

## D. Slice Stock, Delivery & Digital Product Security

> Catatan: temuan oversell utama (no-reservation) sudah digabung ke **Checkout-2** di atas
> untuk menghindari duplikasi — kedua agen menemukan akar masalah yang sama dari sudut
> berbeda.

### Stock-1 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `prisma/schema.prisma:193` (StockItem.credentials); `packages/db/src/crud/stock.ts:8-22`
(bulkAddStock)
**PROBLEM:** Tidak ada unique constraint pada `stock_items.credentials`; `bulkAddStock`
`createMany` tanpa dedup. Dua baris AVAILABLE identik bisa dialokasikan ke dua order
berbeda → **satu akun digital terkirim ke dua pelanggan**.
**ATTACK SCENARIO:** Admin upload CSV stok yang sama dua kali (atau berisi duplikat
internal) → dua baris identik tersimpan AVAILABLE terpisah → dua pembeli berbeda menerima
kredensial akun yang sama.
**BUSINESS IMPACT:** Konflik kepemilikan akun, satu pelanggan terkunci, klaim garansi,
reputasi.
**FIX:** Dedup di `bulkAddStock` terhadap baris AVAILABLE/RESERVED/SOLD existing sebelum
insert, laporkan jumlah yang di-skip.
**CODE EXAMPLE:**
```ts
const existing = new Set((await db.stockItem.findMany({
  where: { productId, credentials: { in: incoming },
           status: { in: [StockStatus.AVAILABLE, StockStatus.RESERVED, StockStatus.SOLD] } },
  select: { credentials: true },
})).map((r) => r.credentials));
const fresh = incoming.filter((c) => !existing.has(c));
```
**CONFIDENCE:** High

**Implementasi aktual:** Diimplementasikan persis seperti CODE EXAMPLE, PLUS satu lapis
dedup tambahan yang tidak disebut FIX: kredensial yang berulang DI DALAM batch yang sama
(misal CSV yang sama tertempel dua kali dalam satu paste) juga di-dedup via `new Set(...)`
sebelum dicek terhadap DB. Return value `bulkAddStock` berubah dari `number` (added saja)
menjadi `{ added, skipped }` — kedua caller (`apps/order-bot/src/conversations/admin.ts`,
`apps/web-admin/src/routes/stock.ts`) diupdate untuk melaporkan jumlah skip ke admin dan
mencatatnya di `logAdminAction`. Tidak ada unique constraint DB ditambahkan ke
`schema.prisma` (skala mitigasi-di-aplikasi sengaja dipilih dulu — constraint DB butuh
migrasi + keputusan soal data existing yang mungkin sudah duplikat; bisa jadi hardening
lanjutan). 8 test regresi baru di `packages/db/src/crud/stock.test.ts` (file baru): all-new
diterima, duplikat AVAILABLE/RESERVED/SOLD di-skip, duplikat DEAD TIDAK di-skip (baris mati
bukan duplikat hidup), duplikat dalam batch sendiri di-skip, dedup per-product (bukan
global), semua-duplikat → added=0, input kosong tidak query DB.

### Stock-2 [LOW]
**FILE:** `packages/db/src/crud/stock.ts:103-129` (allocateOneAvailableStock);
`orders.ts:464-476` (releaseOrderHolds)
**PROBLEM:** Risiko laten stale RESERVED lock — saat ini TIDAK aktif karena jalur create
belum mereservasi (lihat Checkout-2). Jika reservasi diaktifkan tanpa reaper TTL, baris bisa
terkunci RESERVED selamanya (crash setelah reserve, order yatim).
**FIX:** Saat mengaktifkan Checkout-2, tambahkan reaper berbasis `reservedAt`+TTL terjadwal.
**CODE EXAMPLE:**
```ts
export async function releaseStaleReservations(db: Db, olderThanMinutes: number) {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  return db.stockItem.updateMany({
    where: { status: StockStatus.RESERVED, reservedAt: { lt: cutoff } },
    data: { status: StockStatus.AVAILABLE, orderId: null, reservedAt: null },
  });
}
```
**CONFIDENCE:** Medium (desain/laten, belum aktif)

### Stock-3 [LOW]
**FILE:** `apps/web-admin/src/routes/stock.ts:161-182` (GET /stock/:productId/download)
**PROBLEM:** Endpoint download membuang seluruh kredensial AVAILABLE plaintext via GET
(bukan POST+CSRF). `Cache-Control: no-store` sudah di-set, tapi GET tetap rawan
prefetch/proxy-cache/log perantara.
**BUSINESS IMPACT:** Kebocoran massal kredensial belum terjual lewat satu GET, jika panel
terekspos publik tanpa proxy ketat.
**FIX:** Ubah ke POST+csrfProtect, atau tegaskan binding 127.0.0.1 + proxy no-cache.
**CONFIDENCE:** Low (default binding lokal memitigasi)

**Catatan positif:** Delivery dipagari ketat di belakang state pembayaran (`approveOrder`
menolak kecuali `PENDING_VERIFICATION`); idempotensi gateway kuat (claim tx-id dulu);
redisplay/resend tidak pernah re-alokasi/re-decrement; `allocateOneAvailableStock` atomik
benar (`updateMany WHERE status=AVAILABLE` + retry); tidak ada log kredensial/file_id di
manapun pada slice ini.

---

## E. Slice Admin Web Security (`apps/web-admin`)

### Admin-1 [HIGH] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/web-admin/src/routes/setup.ts:36-43, 76-112`;
`plugins/setupGate.ts:19`; `packages/db/src/crud/setup.ts:35-38`
**PROBLEM:** Kondisi penguncian wizard tidak cocok dengan kondisi gate. `setupGate` berhenti
redirect ke `/setup` begitu ADA admin dengan password (`anyAdminPasswordSet`), tetapi
`/setup/*` sendiri hanya terkunci oleh `isSetupCompleted()` (key `setup_completed`, hanya
di-set di step TERAKHIR wizard). Pada deploy yang di-bootstrap via `/bootstrap` (bukan
wizard), `setup_completed` tidak pernah ter-set — `/setup/*` (yang dikecualikan dari
setupGate dan pre-auth tanpa CSRF) tetap terbuka selamanya.
**ATTACK SCENARIO:** Toko sudah jalan (bootstrap, bukan wizard). Penyerang yang menjangkau
panel (LAN, SSRF, reverse-proxy salah konfigurasi) `POST /setup/owner` dengan
`telegram_id` miliknya + password pilihannya → `addAdminId`+`upsertUser(role=ADMIN)`+set
password hash. Lanjut `POST /setup/shop` → `markSetupComplete` + auto-login sebagai owner.
**BUSINESS IMPACT:** Pengambilalihan total panel admin oleh pihak tak terautentikasi: ubah
harga/voucher, kuras saldo wallet, approve order palsu, baca kredensial gateway pembayaran,
broadcast scam ke seluruh pelanggan.
**FIX:** Samakan basis penguncian: `lockedRedirect` harus memakai `isSetupCompleted() ||
anyAdminPasswordSet()`, dan self-heal `setup_completed="true"` begitu terdeteksi admin
password sudah ada.
**CODE EXAMPLE:**
```ts
async function lockedRedirect(reply: FastifyReply) {
  if (await isSetupCompleted(prisma)) { reply.code(303).redirect("/login"); return reply; }
  if (await anyAdminPasswordSet(prisma)) {
    await markSetupComplete(prisma);
    reply.code(303).redirect("/login"); return reply;
  }
  return null;
}
```
**CONFIDENCE:** High

**Catatan perbaikan (bonus finding, di luar lingkup audit asli):** Saat memperbaiki ini,
ditemukan bug independen yang lebih dasar di `lockedRedirect`: helper tersebut me-`return
reply` (objek `FastifyReply`), tetapi `FastifyReply` mengimplementasikan `.then()` (thenable).
Karena setiap call site melakukan `if (await lockedRedirect(reply)) return reply;`, native
Promise-resolution JS men-unwrap `reply` yang thenable itu menjadi `undefined` — sehingga
guard TIDAK PERNAH benar-benar menghentikan eksekusi (hanya redirect pertama yang terkirim;
kode SETELAH guard tetap berjalan). Diperbaiki dengan mengubah `lockedRedirect` agar
mengembalikan `boolean` murni, bukan `reply`.

### Admin-2 [HIGH] — digabung (admin-web + infra) ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/web-admin/src/auth.ts:212` (`DEFAULT_WEB_ROLE = "super"`);
`apps/web-admin/src/routes/admins.ts:53-77`; `plugins/auth.ts:31-34`;
`packages/core/src/runtime.ts:74`
**PROBLEM:** Admin tanpa baris role eksplisit otomatis diperlakukan `super` (akses penuh).
`addAdminIdToDb`/`/admins/add` tidak pernah men-set role. Lebih parah: route
`/admins/:tgId/role` menolak ID yang tidak ada di `config.ADMIN_IDS` (env-only) — admin yang
ditambah via DB **tidak bisa diturunkan haknya lewat UI sama sekali**, terjebak permanen
sebagai super-admin.
**ATTACK SCENARIO:** Super-admin (sah atau terkompromi) `POST /admins/add` dengan ID
kaki-tangan → otomatis super. Kaki-tangan reset password via `/forgot` → login penuh
sebagai super. Super-admin asli tidak bisa men-downgrade via UI (hanya bisa `/admins/remove`).
**BUSINESS IMPACT:** Privilege escalation by default pada setiap admin baru; eskalasi yang
sulit dicabut.
**FIX:** (a) `DEFAULT_WEB_ROLE = "readonly"` (default-deny); (b) konsistenkan pengecekan
keanggotaan admin di semua route `/admins/*` memakai `adminIds()` (env ∪ DB), bukan
`config.ADMIN_IDS` saja.
**CODE EXAMPLE:**
```ts
export const DEFAULT_WEB_ROLE: WebRole = "readonly";
if (!adminIds().includes(tgId)) return redirectWithFlash(reply, "/admins", "Bukan admin terdaftar.", "error");
```
**CONFIDENCE:** High

**Implementasi aktual:** `DEFAULT_WEB_ROLE` TIDAK diubah ke `"readonly"` — itu akan diam-diam
menurunkan hak admin legacy/bootstrap (ditambahkan sebelum fitur RBAC ada) yang belum pernah
punya baris role tersimpan, berisiko self-lockout massal pada deploy yang sudah berjalan.
Sebagai gantinya, dipakai opsi alternatif yang disebutkan FIX di atas: `/admins/add`
sekarang menulis role eksplisit `"readonly"` ke `webRoleKey(tgId)` SAAT admin ditambahkan,
jadi admin baru tidak pernah lagi "unset ⇒ super" secara diam-diam — sementara admin lama
yang sudah ada (unset, dari sebelum fitur RBAC) tetap berperilaku sama seperti sebelumnya.
`/admins/:tgId/role` dan `/admins/:tgId/logout` diubah memakai `adminIds()` (env ∪ DB)
sehingga admin DB sekarang BISA diatur/diturunkan rolenya dan di-force-logout lewat UI
(`admins.njk` diperbarui — form role-select & force-logout tidak lagi disembunyikan untuk
admin non-env). 3 test regresi baru menutup: default readonly saat add, role-route berfungsi
untuk admin DB, logout-route berfungsi untuk admin DB.

### Admin-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/web-admin/src/lib/telegramCheck.ts:13-21, 53-66`
**PROBLEM:** Panggilan `fetch` langsung ke `api.telegram.org` (getMe/getChat) tanpa
`AbortController`/timeout. Bisa menggantung thread request lama (DoS pada single-process);
token bot di URL path berisiko muncul di log proxy/TLS-MITM perantara.
**FIX:** Tambahkan timeout 5 detik via `AbortController` pada kedua fetch.
**CODE EXAMPLE:**
```ts
const ac = new AbortController();
const t = setTimeout(() => ac.abort(), 5000);
try { const res = await fetch(url, { signal: ac.signal }); } finally { clearTimeout(t); }
```
**CONFIDENCE:** Medium

**Implementasi aktual:** Diimplementasikan persis seperti CODE EXAMPLE pada kedua fetch
(`checkTokenWithTelegram`/`checkChannelWithTelegram`), timeout 5000ms via konstanta
`TELEGRAM_FETCH_TIMEOUT_MS`. Bagian "token di URL path" dari PROBLEM TIDAK diubah (di luar
scope minimal fix ini — Telegram Bot API mengharuskan token di path, tidak ada alternatif
header-based; mitigasinya tetap di level TLS/network, bukan kode aplikasi). 3 test regresi
baru di `apps/web-admin/test/telegramCheck.test.ts` (file baru): kedua fungsi abort dan
resolve `{ok:false}` saat fetch menggantung melewati timeout (fake timers), dan
`checkTokenWithTelegram` tetap berhasil normal jauh di bawah timeout.

### Admin-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/web-admin/src/plugins/auth.ts:63-70` (canMutate); `lib/upload.ts:60`;
`routes/catalog.ts:450`
**PROBLEM:** `canMutate` mencocokkan prefix path, tapi jalur upload memanggil dengan
`req.url` MENTAH (termasuk query string) sementara `roleGate` memangkasnya — inkonsistensi
yang bisa menyebabkan exact-match path (`/settings/password`) salah-evaluasi bila kelak
dipanggil dengan query string.
**FIX:** Normalisasi path (pangkas query) sekali, sebelum semua pemanggilan `canMutate`.
**CODE EXAMPLE:**
```ts
export function canMutate(role: WebRole, rawPath: string): boolean {
  const path = (rawPath.split("?")[0] || rawPath) ?? "/";
  // ...
}
```
**CONFIDENCE:** Medium

**Implementasi aktual:** Diimplementasikan persis seperti CODE EXAMPLE — normalisasi
dipindah ke DALAM `canMutate` itu sendiri (bukan di setiap call site), jadi ketiga caller
yang sebelumnya memanggil dengan `req.url` mentah (`lib/upload.ts`, `routes/branding.ts`,
`routes/catalog.ts`) otomatis ikut benar tanpa diubah satu-satu. 1 test regresi baru di
`apps/web-admin/test/web.test.ts`: matrix role/path dengan query string ditambahkan ke
exact-match (`/settings/password?foo=bar`) dan prefix-match (`/orders/1/approve?ref=abc`).

### Admin-5 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/web-admin/src/routes/users.ts:72-90`; `admins.ts:53-77`
**PROBLEM:** `/users/:userId/role` (super-only) bisa men-set `UserRole.ADMIN` tanpa
keterkaitan ke flow `/admins`. Dua sumber kebenaran admin (`UserRole` tabel User vs
`admin_ids` Setting) yang harus selaras manual, mudah salah saat refactor. Mitigasi: login
tetap butuh `isAdmin(telegramId)` jadi menaikkan UserRole saja belum cukup untuk login.
**FIX:** Satukan sumber kebenaran; cegah `/users/:id/role` meng-set `ADMIN`, pisahkan
promosi admin hanya lewat `/admins`.
**CONFIDENCE:** Low-Medium

**Implementasi aktual:** Diimplementasikan sesuai FIX — `ROLES` whitelist di
`apps/web-admin/src/routes/users.ts` dipersempit ke `[CUSTOMER, RESELLER]` saja (ADMIN
dihapus), dan handler `/users/:userId/role` menolak eksplisit `roleUpper === "ADMIN"` dengan
pesan yang mengarahkan ke `/admins` (bukan pesan generik "Invalid role.", supaya operator
tahu KENAPA). Template `user_detail.njk` diupdate: untuk user yang SUDAH `ADMIN`, form role
diganti catatan read-only ("dikelola dari halaman Admins") — ini mencegah masalah UX di mana
dropdown tanpa opsi ADMIN bisa membuat resubmit form pada admin existing tanpa sengaja
menurunkan rolenya ke CUSTOMER (opsi pertama di dropdown). Tidak ada perubahan pada
`UserRole` di skema atau pada logika auto-sync `isAdmin(telegramId) → role=ADMIN` di
`packages/db/src/crud/users.ts` (sumber kebenaran TUNGGAL tetap `admin_ids`; `UserRole.ADMIN`
murni derived, tidak digabung jadi satu kolom seperti tersirat di FIX — refactor skema
dianggap di luar scope minimal). 1 test regresi baru di `apps/web-admin/test/web.test.ts`:
POST role=admin ke user biasa ditolak dengan flash error, role tidak berubah.

### Admin-6 [LOW]
**FILE:** `apps/web-admin/src/auth.ts:116-124` (verifyTotp)
**PROBLEM:** Perbandingan kode TOTP memakai `===` biasa, bukan `timingSafeEqual` (tidak
konsisten dengan praktik konstan-waktu di tempat lain). Dampak timing-attack minimal (kode
6-digit, window 30s, rate-limited).
**FIX:** Bandingkan via `timingSafeEqual` atas buffer panjang sama.
**CONFIDENCE:** Low

### Admin-7 [LOW]
**FILE:** `apps/web-admin/src/routes/setup.ts:96, 109`; `packages/core/src/runtime.ts:62`
**PROBLEM:** `POST /setup/owner` (pre-auth, no CSRF) memutasi state runtime in-memory
(`adminIds`) SEBELUM transaksi DB sukses (ada rollback jika gagal, tapi window tetap ada).
Bagian dari risiko desain Admin-1, dicatat terpisah sebagai gap CSRF pada wizard sendiri.
**FIX:** Tambahkan verifikasi kepemilikan Telegram ID (kirim kode konfirmasi) sebelum
promosi + CSRF/nonce pada form setup.
**CONFIDENCE:** Medium (risiko desain), Low (eksploitabilitas pada deploy lokal yang benar)

### Admin-8 [LOW] — lihat juga Storefront-4
**FILE:** `apps/web-admin/src/routes/auth.ts:55-59` (clientIp), `:298-311` (loginRateLimited)
**PROBLEM:** `clientIp` mempercayai `X-Forwarded-For` tanpa daftar proxy tepercaya — bila
panel terekspos langsung tanpa proxy yang menormalkan XFF, rate-limit per-IP pada
login/forgot/reset bisa dilewati dengan memutar header. Lockout per-akun tetap menahan
brute-force ke satu admin.
**FIX:** Jangan percaya XFF kecuali `WEB_TRUST_PROXY` aktif; gunakan `req.ip` (Fastify
`trustProxy`) sebagai default.
**CONFIDENCE:** Low-Medium

### Admin-9 [LOW]
**FILE:** `apps/web-admin/src/routes/audit.ts:18`, `reports.ts:39`, `dashboard.ts:66`
**PROBLEM (observasi desain, bukan bug):** Semua GET (read) hanya pakai `currentAdmin` —
role `readonly`/`support` bisa membaca audit log, laporan finansial, saldo wallet user.
Bukan IDOR (tidak ada scoping per-tenant), tapi over-exposure data sensitif ke role rendah.
**FIX:** Bila diperlukan, gate read sensitif (audit, reports, wallet ledger) ke `super`.
**CONFIDENCE:** High (sebagai observasi)

**Catatan positif:** Whitelist settings tanpa mass-assignment; upload path traversal aman
(filename server-generated, SVG inert); CSRF coverage lengkap di semua route mutasi; tidak
ada pengiriman Telegram langsung dari route; setiap mutasi tercatat `logAdminAction`.

---

## F. Slice Storefront Customer Auth & Checkout

### Storefront-1 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/storefront/src/server.ts:42-48`; `routes/forgot.ts:49,68`
**PROBLEM:** Token reset password ada di PATH URL (`GET /reset/:token`). Access-log hook
sengaja membuang query string untuk menghindari pencatatan token — tapi token di path tetap
tercatat penuh ke log aplikasi setiap GET halaman reset.
**ATTACK SCENARIO:** Siapa pun dengan akses baca log (operator nakal, kebocoran log
aggregator) bisa mengambil token valid (TTL 1 jam, single-use sebelum consume) dan
`POST /reset/<token>` set password baru → ambil alih akun.
**BUSINESS IMPACT:** Pengambilalihan akun pelanggan (saldo wallet, riwayat order, kredensial
produk DELIVERED). Melanggar "Never log secrets" di CLAUDE.md.
**FIX:** Redaksi token di path sebelum logging; tambahkan `Referrer-Policy: no-referrer`
pada halaman reset.
**CODE EXAMPLE:**
```ts
const rawPath = req.url.split("?", 1)[0];
const path = rawPath.replace(/^\/reset\/[^/]+/, "/reset/[redacted]");
logger.info({ method: req.method, path, status: reply.statusCode }, "access");
```
**CONFIDENCE:** High

**Implementasi aktual:** Diimplementasikan persis seperti CODE EXAMPLE untuk redaksi path di
`server.ts`'s access-log hook, PLUS `Referrer-Policy: no-referrer` ditambahkan pada KEDUA
route `/reset/:token` (GET dan POST — POST juga merender ulang halaman yang sama dengan token
di URL saat validasi gagal). 6 test regresi terverifikasi lewat suite existing
(`apps/storefront/test/storefront.test.ts`) yang sudah mengecek log access — ditambah
verifikasi manual lewat output test run bahwa baris log untuk `/reset/<token>` kini tercatat
sebagai `/reset/[redacted]`.

### Storefront-2 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/storefront/src/routes/settings.ts:101-118`
**PROBLEM:** Ganti password TIDAK merotasi jti sesi (beda dengan flow forgot-password yang
merotasi). Sesi/cookie lama tetap valid setelah ganti password.
**ATTACK SCENARIO:** Penyerang punya akses sementara ke sesi korban (perangkat bersama).
Korban ganti password untuk "mengusir" penyusup → cookie penyerang tetap valid hingga TTL
30 hari karena jti tidak dirotasi.
**BUSINESS IMPACT:** Kontrol keamanan utama (ganti password) gagal menendang sesi penyerang.
**FIX:** Rotasi jti setelah `passwordHash` berubah, seperti pola `forgot.ts`.
**CODE EXAMPLE:**
```ts
if (changes.passwordHash) {
  const jti = newJti();
  await setSetting(prisma, shopSessionJtiKey(customer.userId), jti);
  // set ulang cookie sesi user saat ini
}
```
**CONFIDENCE:** High

**Implementasi aktual:** Diimplementasikan persis seperti CODE EXAMPLE — `if (changes.passwordHash)`
merotasi jti via `newJti()`/`setSetting`, lalu mint cookie baru via `makeCustomerSession` dan
`reply.setCookie` (pola yang sama dengan `establishSession` di `routes/auth.ts`) sehingga user
yang BARU mengganti password sendiri tidak ikut ter-logout — hanya sesi/device LAIN yang mati.
2 test regresi baru di `apps/storefront/test/storefront.test.ts`: cookie LAMA berhenti
berfungsi (redirect ke /login) setelah ganti password, request berikutnya dengan cookie BARU
dari response tetap 200.

### Storefront-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/storefront/src/routes/settings.ts:99-100`
**PROBLEM:** Ganti email TIDAK memerlukan verifikasi password (re-auth) dan tidak ada
verifikasi kepemilikan email baru. Email adalah jangkar recovery akun.
**ATTACK SCENARIO:** Penyerang dengan sesi aktif korban ganti email ke miliknya → logout →
"Lupa password" → token dikirim ke email penyerang → set password baru → pengambilalihan
permanen, korban kehilangan jalur recovery.
**FIX:** Wajibkan `current_password` untuk perubahan email/username; kirim email konfirmasi
ke alamat baru sebelum menerapkan (double opt-in).
**CONFIDENCE:** Medium

**Implementasi aktual:** Bagian PERTAMA dari FIX diimplementasikan: `current_password` kini
wajib (dan diverifikasi) untuk SETIAP perubahan kredensial — username, email, ATAU password —
bukan hanya password seperti sebelumnya, dengan exception yang sama seperti pengecekan
password lama (dilewati jika akun belum punya password sama sekali, mis. login Telegram-only,
karena tidak ada apa pun untuk diverifikasi). Bagian KEDUA (email konfirmasi double opt-in ke
alamat baru sebelum diterapkan) TIDAK diimplementasikan — itu perubahan UX/flow yang jauh
lebih besar (perlu token konfirmasi terpisah, halaman baru, state "email pending" di skema)
di luar scope minimal fix keamanan ini; re-auth wajib sudah menutup celah utama (sesi
ter-hijack tidak bisa lagi mengganti email tanpa tahu password). 2 test regresi baru: ganti
email tanpa/dengan current_password yang salah ditolak (email tidak berubah), ganti email
dengan current_password yang benar berhasil.

### Storefront-4 [MEDIUM] — lihat juga Admin-8 ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/storefront/src/routes/forgot.ts:30-66`; `rateLimit.ts:40-53`
**PROBLEM:** Rate-limit forgot-password/login hanya di-key IP via `X-Forwarded-For` tanpa
daftar proxy tepercaya — bisa diputar untuk bypass throttle per-IP. Tidak ada throttle
per-akun/per-email untuk forgot-password (beda dari login yang punya account lockout).
**ATTACK SCENARIO:** POST `/forgot` berulang dengan XFF acak per request → email-bombing
token reset ke korban; perbedaan timing (`createPasswordResetToken`+`sendMail` untuk email
terdaftar vs cepat-return untuk tidak terdaftar) jadi side-channel enumerasi.
**BUSINESS IMPACT:** Reputasi domain pengirim (spam/blacklist SMTP), enumerasi email
pelanggan, gangguan layanan recovery.
**FIX:** `trustProxy` Fastify terkonfigurasi proxy tepercaya; tambahkan throttle per-email;
samakan waktu respons.
**CONFIDENCE:** Medium

**Implementasi aktual:** DUA dari tiga sub-fix diimplementasikan: (1) `TRUST_PROXY` (config
baru, comma-separated IP/CIDR) di-wire ke opsi `trustProxy` Fastify di `server.ts` — default
UNSET berarti `trustProxy: false` (XFF diabaikan total, `req.ip` = TCP peer asli — fail-safe
secara default, bukan fail-open); `clientIp()` di `rateLimit.ts` disederhanakan untuk
mendelegasikan ke `req.ip` milik Fastify sepenuhnya (tidak lagi parse `x-forwarded-for`
manual). (2) Throttle per-email baru `forgotEmailRateLimited(email)`, sliding-window sama
dengan `loginRateLimited`, dipanggil bersamaan (`||`) di `POST /forgot`. Sub-fix KETIGA
(samakan waktu respons) TIDAK diimplementasikan — delay buatan berisiko memperlambat seluruh
test suite untuk manfaat yang marginal (side-channel timing butuh akses jaringan presisi
tinggi untuk dieksploitasi nyata; CONFIDENCE keseluruhan finding ini sudah "Medium", bukan
"High"). 4 test regresi baru di `apps/storefront/test/rate-limit.test.ts`: throttle per-email
menahan email korban walau IP diputar-putar, email LAIN tidak terdampak, XFF dari koneksi
TIDAK tepercaya diabaikan (throttle tetap jalan berbasis IP asli, bukan IP palsu).

### Storefront-5 [LOW]
**FILE:** `apps/storefront/src/routes/auth.ts:162-186`
**PROBLEM:** Login Telegram via GET membawa payload (termasuk hash HMAC) di query string;
window replay 15 menit. Tidak ada bypass auth langsung, tapi payload yang bocor (proxy log,
Referer) dalam jendela itu bisa di-replay.
**FIX:** Persempit `TG_AUTH_MAX_AGE_SECONDS`; catat `auth_date` yang sudah dipakai
(single-use); `Referrer-Policy: no-referrer`.
**CONFIDENCE:** Low

### Storefront-6 [LOW]
**FILE:** `apps/storefront/src/routes/account.ts:152-171`
**PROBLEM:** `POST /account/reviews` tidak melakukan cek kepemilikan order/produk sendiri di
level route — bergantung penuh pada crud `createReview` (di luar slice ini) untuk mengikat
order ke user & status DELIVERED.
**FIX:** Verifikasi di crud bahwa order milik user, DELIVERED, dan productId ada di item
order; unik per (userId, orderId).
**CONFIDENCE:** Low (perlu konfirmasi implementasi crud aktual)

### Storefront-7 [LOW]
**FILE:** `apps/storefront/src/routes/cart.ts:37-43, 132-201`; `routes/api.ts:151-188`
**PROBLEM:** Mutasi cart guest (belum login) melewati CSRF sepenuhnya, mengandalkan
`SameSite=Lax` saja. Risiko rendah (cart bebas-uang, checkout tetap login-gated +
harga di-recompute server-side).
**FIX (opsional):** Double-submit cookie token untuk guest bila ingin diperketat.
**CONFIDENCE:** Low

### Storefront-8 [LOW]
**FILE:** `apps/storefront/src/auth.ts:131-147`
**PROBLEM (informational):** CSRF token dibawa dalam payload cookie sesi (signed
double-submit) — aman terhadap CSRF klasik karena cookie HttpOnly; hanya relevan jika ada
XSS (yang sudah game-over terlepas dari ini).
**CONFIDENCE:** Low

**Catatan positif:** Token reset kriptografis kuat (32-byte, hashed, single-use atomik, TTL
dicek); anti-enumerasi konsisten; IDOR pada semua route account/checkout konsisten
menurunkan `userId` dari sesi + 404 (bukan 403); harga/qty tidak pernah dari body; XSS aman
(autoescape Nunjucks); open redirect ditolak; password bcrypt cost 12.

---

## G. Slice Bot Concurrency, Idempotency & Admin Bot Security

### Bot-1 [CRITICAL] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/main.ts:98-99`; `apps/order-bot/src/handlers/admin.ts:59, :218`
**PROBLEM:** Command `/admin` dan `/wallet` didaftarkan TANPA middleware otorisasi apa pun.
`adminOnly` (di `middleware.ts`) didefinisikan tapi **tidak pernah dipakai di mana pun**.
`adminWalletCommand` (`/wallet <uid> <amount>`) tidak memanggil `isAdmin` sama sekali.
**ATTACK SCENARIO:** User biasa mengirim `/wallet 1 1000000` → langsung
`adjustWallet(..., { allowNegative: true })` tanpa gate apa pun. User kredit saldo wallet
sendiri (atau siapa pun) sebesar berapa pun. `/admin` membuka panel admin penuh bagi siapa
pun.
**BUSINESS IMPACT:** Pencurian dana langsung tak terbatas + kompromi total panel admin
(approve order, ban user, ubah harga, broadcast). Ini adalah temuan paling serius di seluruh
audit.
**FIX:** Pasang `adminOnly` pada kedua command sebagai prioritas mutlak.
**CODE EXAMPLE:**
```ts
import { adminOnly } from "./middleware";
bot.command("admin", adminOnly, admin.adminCommand);
bot.command("wallet", adminOnly, admin.adminWalletCommand);
```
**CONFIDENCE:** High

### Bot-2 [HIGH] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/handlers/verification.ts:111-186`;
`packages/db/src/crud/orders.ts:638-647`
**PROBLEM:** Jalur approve tidak merender state buttonless sebelum mutasi terminal.
Idempotensi sepenuhnya bergantung pada `BEGIN IMMEDIATE` SQLite (serialisasi implisit), bukan
update kondisional eksplisit. Aman HARI INI; eksploitable pasca-migrasi Postgres (lihat
catatan lintas-domain) atau bila ada path approve di luar `$transaction`.
**BUSINESS IMPACT:** Hari ini: UX admin membingungkan (alert error pada double-tap).
Pasca-Postgres tanpa perbaikan: potensi double-delivery kredensial/komisi referral ganda.
**FIX:** Jadikan transisi status atomik & kondisional secara eksplisit, tidak bergantung
isolation level DB.
**CODE EXAMPLE:**
```ts
const claim = await db.order.updateMany({
  where: { id: orderId, status: OrderStatus.PENDING_VERIFICATION },
  data: { status: OrderStatus.DELIVERED },
});
if (claim.count !== 1) throw new ValidationError("error.order_not_pending_verification");
```
**CONFIDENCE:** High

**Implementasi aktual:** Diimplementasikan persis seperti FIX, di `packages/db/src/crud/orders.ts`
`approveOrder` (bukan di `verification.ts` — restrukturisasi murni di lapisan CRUD,
handler bot tidak berubah). Klaim atomik dilakukan SEKALIGUS dengan menulis
`paidAt`/`deliveredAt` (bukan hanya `status`) di langkah pertama, SEBELUM loop alokasi
stok — bila loop gagal (`error.cannot_deliver_out_of_stock`), `$transaction` pembungkus
(SEMUA caller produksi sudah memenuhi syarat ini) roll back klaim tersebut juga, jadi
perilaku gagal tetap sama seperti sebelumnya (all-or-nothing). Tidak menyentuh poin (c) dari
finding lain (render buttonless `admin.processing` sebelum tap) — itu di luar lingkup minimal
untuk menutup celah konkurensi DB-level. 1 test regresi baru di `stock_deduction.test.ts`:
approve kedua pada order yang SUDAH DELIVERED ditolak oleh klaim atomik (bukan oleh
pengecekan in-memory), dan tidak ada SOLD/kredensial ganda.

### Bot-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/handlers/admin.ts:489-505`; `packages/db/src/crud/support.ts:30-39`
**PROBLEM:** `closeTicketAdmin`→`closeTicket` read-then-write tanpa guard kondisional, tanpa
`$transaction`, tanpa `logAdminAction`. Double-tap "Close" mengirim DM duplikat ke buyer.
**FIX:** Guard `updateMany WHERE status != CLOSED`; DM hanya jika `count===1`; bungkus
`$transaction` + audit.
**CODE EXAMPLE:**
```ts
const res = await db.supportTicket.updateMany({
  where: { id: ticketId, status: { not: TicketStatus.CLOSED } }, data: { status: TicketStatus.CLOSED },
});
if (res.count === 0) return null;
```
**CONFIDENCE:** High

**Implementasi aktual:** Diimplementasikan persis seperti FIX/CODE EXAMPLE — `closeTicket`
sekarang melakukan `updateMany WHERE status != CLOSED` atomik, mengembalikan `null` (tidak
DM) saat `count===0`. `closeTicketAdmin` dibungkus `$transaction` yang menjalankan
`closeTicket` + `logAdminAction` (action `ticket_close`) bersamaan — TIDAK dikondisikan pada
hasil close (audit ditulis tiap kali admin menekan Close, bahkan untuk tiket yang sudah
closed; konsisten dengan pola existing `userBan`/`userSetReseller` yang JUGA mengaudit tiap
tap, bukan tiap PERUBAHAN nilai). 4 test regresi baru: `packages/db/src/crud/support.test.ts`
(file baru — close sukses, double-close kedua return null, tiket tak ada, owner tanpa
telegramId) + 2 test di `apps/order-bot/test/handlers.test.ts` (audit row tertulis,
double-tap tidak mengirim DM kedua).

### Bot-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/handlers/admin.ts:176-208, :366-387, :420-424, :453-473`
**PROBLEM:** Mutasi admin terminal (ban, toggle product, mark stock dead, delete bulk
pricing) tidak merender `admin.processing` sebelum eksekusi. `userBan`/`userSetReseller`
idempoten secara nilai tapi double-tap menghasilkan DUA baris audit. `adminMarkStockDead`
di luar `$transaction` dan TANPA `logAdminAction` sama sekali.
**BUSINESS IMPACT:** Log audit tercemar duplikat; perubahan status stok tidak terlacak ke
admin pelaku.
**FIX:** Render processing sebelum mutasi; bungkus `markStockDead` dalam `$transaction` +
audit.
**CONFIDENCE:** High

**Implementasi aktual:** HANYA bagian `markStockDead` dari FIX diimplementasikan —
`adminMarkStockDead` sekarang membungkus `markStockDead` + `logAdminAction` (action
`stock_mark_dead`) dalam SATU `$transaction`, mengikuti pola `userBan` yang sudah ada persis.
Ini menutup gap PALING signifikan dari PROBLEM (perubahan status stok TANPA jejak audit SAMA
SEKALI). Bagian "render `admin.processing` sebelum mutasi ban/toggle/delete-bulk-pricing"
TIDAK diimplementasikan — itu murni pengurangan noise log audit pada double-tap (BUSINESS
IMPACT-nya sendiri disebut "log audit tercemar duplikat", bukan kerusakan data atau
pelanggaran keamanan; nilai akhirnya tetap benar/idempoten), jadi diprioritaskan lebih rendah
dari gap audit yang nyata pada markStockDead. 1 test regresi baru di
`apps/order-bot/test/handlers.test.ts`: mark-dead menulis baris audit `stock_mark_dead`.

### Bot-5 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/jobs/index.ts:95-113` (autoCloseStaleTickets), `:68-93`
(autoCancelExpiredOrders)
**PROBLEM:** Kedua cron TIDAK memakai `{ protect: true }` (berbeda dari `drainBroadcasts`
yang benar). Eksekusi tumpang-tindih (job lambat/restart) bisa memproses set yang sama dua
kali → DM duplikat.
**FIX:** Tambahkan `{ protect: true }` pada kedua Cron.
**CODE EXAMPLE:**
```ts
new Cron("0 * * * *", { protect: true }, wrap("autoCloseStaleTickets", autoCloseStaleTickets));
new Cron("*/1 * * * *", { protect: true }, wrap("autoCancelExpiredOrders", autoCancelExpiredOrders));
```
**CONFIDENCE:** Medium

**Implementasi aktual:** Diimplementasikan persis seperti FIX/CODE EXAMPLE — `{ protect: true }`
ditambahkan ke kedua registrasi Cron di `scheduleJobs`. 1 test regresi baru di
`apps/order-bot/test/jobs.test.ts`: memverifikasi `options.protect === true` pada kedua Cron
ter-registrasi (via index array, mengikuti urutan literal `scheduleJobs`) plus konfirmasi
`drainBroadcasts` (pola referensi) masih `protect:true`.

### Bot-6 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/order-bot/src/conversations/admin.ts:279-362` (broadcast in-bot) vs
`jobs/index.ts:256-282` (drainBroadcasts — referensi pola yang BENAR)
**PROBLEM:** Broadcast in-bot mengirim DM via loop langsung TANPA klaim/idempotensi seperti
`drainBroadcasts`. Crash/restart di tengah loop tidak punya penanda "sudah terkirim"
per-recipient → resume/replay bisa mengirim ulang ke seluruh segmen.
**BUSINESS IMPACT:** Potensi broadcast ganda ke seluruh basis pengguna (spam masif, risiko
rate-limit/ban bot oleh Telegram).
**FIX:** Pindahkan broadcast in-bot melalui antrian `broadcast`+`drainBroadcasts` yang sudah
idempoten, atau catat status SENDING/SENT sebelum loop.
**CONFIDENCE:** Medium

**Implementasi aktual:** Opsi KEDUA dari FIX dipilih ("catat status SENDING/SENT sebelum
loop"), bukan opsi pertama (reroute lewat antrian `broadcast`+`drainBroadcasts`) — alasannya:
tabel `Broadcast` existing hanya menyimpan `message` sebagai string polos tanpa dukungan foto
atau `entities`, sementara flow in-bot mendukung KEDUANYA; reroute penuh berarti regresi fitur
(broadcast foto/format hilang), bukan sekadar refactor internal. Sebagai gantinya: lock
durable berbasis `Setting` (`broadcast_inflight_at`, helper `acquireBroadcastLock`/
`releaseBroadcastLock` baru) — dicek sebagai BARIS PERTAMA di dalam `conversation.external()`
yang menjalankan loop kirim, supaya pada crash-replay (grammY me-replay ulang fungsi
percakapan dari awal, yang akan menjalankan ULANG `external()` yang sama dari nol jika
sebelumnya tidak sempat selesai), guard ini pasti tereksekusi DULU sebelum loop sempat
mengirim ulang. Lock dilepas hanya pada penyelesaian BERSIH (sukses sampai baris audit) —
kalau ada exception di tengah, lock TETAP terkunci (fail-safe: butuh intervensi/auto-recover
lebih baik daripada broadcast ganda ke seluruh basis pengguna) dan self-heal otomatis setelah
`BROADCAST_LOCK_STALE_MS` (30 menit). Key locale baru `admin.broadcast_already_in_progress`
(en+id) untuk pesan saat lock aktif. 4 test regresi baru di
`apps/order-bot/test/conversations.test.ts`: broadcast kedua tetap terkirim setelah yang
pertama selesai (lock terlepas), broadcast dengan lock SEGAR aktif (simulasi crash-replay)
batal total tanpa kirim/audit, lock BASI (>30 menit) self-heal dan broadcast lanjut normal.

### Bot-7 [LOW]
**FILE:** `apps/order-bot/src/middleware.ts:58-79`; `main.ts:74`
**PROBLEM:** `rateLimit` middleware berada SETELAH `conversations()` di chain — update yang
diproses di dalam conversation aktif (wizard) tidak terkena rate limit.
**FIX:** Pindahkan `rateLimit` sebelum `conversations()` agar setiap update terhitung
(hati-hati urutan dengan `registeredUser` yang mengisi `session.lang`).
**CONFIDENCE:** Medium

### Bot-8 [LOW]
**FILE:** `apps/order-bot/src/conversations/admin.ts:344-347`
**PROBLEM:** Broadcast in-bot meneruskan teks admin tanpa `entities` ke default
`parse_mode: HTML` — teks berisi `<`/`&` bisa membuat `sendMessage` gagal untuk SEMUA
recipient. `drainBroadcasts` sudah benar (plain, tanpa parse_mode).
**FIX:** Samakan dengan `drainBroadcasts` — kirim plain untuk teks bebas operator.
**CONFIDENCE:** Medium

### Bot-9 [LOW]
**FILE:** `apps/order-bot/src/handlers/admin.ts:210-215, :218`
**PROBLEM:** Penyesuaian wallet admin tidak punya konfirmasi destruktif (`show_alert`)
sebelum commit — mengetik command yang sama dua kali (typo) menambah saldo dua kali tanpa
undo. Memperburuk Bot-1.
**FIX:** Setelah gate admin terpasang (Bot-1), tambahkan konfirmasi `show_alert` menampilkan
delta+saldo baru sebelum `adjustWallet`.
**CONFIDENCE:** Medium

**Catatan positif:** `handleAdminCallback` BENAR memvalidasi `isAdmin` di awal — lubang
otorisasi HANYA di command `/admin`/`/wallet` (Bot-1). `allocateOneAvailableStock` &
`claimNextDueBroadcast`+`drainBroadcasts {protect:true}` adalah pola idempoten yang benar
dan jadi acuan. `creditOrderToBalance` punya double-credit guard eksplisit. `retireKeyboard`
+ `error.stale_screen` menjaga invariant "satu keyboard aktif" dengan baik.

---

## H. Slice Infrastruktur, Secrets, DB Schema & Composition Root

### Infra-1 [HIGH] — lihat Admin-2 (digabung)
Lihat **Admin-2** — temuan ini adalah sudut pandang kedua dari masalah `DEFAULT_WEB_ROLE`
yang sama, ditemukan independen dari slice infra.

### Infra-2 [HIGH] ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/db/src/crud/notifications.ts:97`;
`packages/outbox-dispatcher/src/dispatcher.ts:71-113`
**PROBLEM:** Tidak ada claim/lock pattern pada outbox. `fetchPendingNotifications` hanya
`findMany WHERE status=PENDING`; baris ditandai SENT HANYA setelah `sendMessage` berhasil.
Window antara "kirim ke Telegram" dan "update status SENT": crash di window itu → baris
tetap PENDING → terkirim ulang tick berikutnya → double-send. Risiko penuh (dua writer aktif
bersamaan) muncul jika ada mis-deploy topology single-writer yang dijanjikan CLAUDE.md.
**BUSINESS IMPACT:** Double-delivery `ORDER_DELIVERED_DM` (kredensial akun dua kali),
`ADMIN_PW_RESET` (kode reset terkirim ganda).
**FIX:** Claim atomik sebelum kirim (`updateMany WHERE status=PENDING SET status=SENDING`,
proses hanya jika `count===1`); tambahkan reaper untuk SENDING basi.
**CODE EXAMPLE:**
```ts
const claimed = await db.notificationOutbox.updateMany({
  where: { id: notifId, status: "PENDING" }, data: { status: "SENDING" },
});
if (claimed.count !== 1) return;
```
**CONFIDENCE:** Medium (risiko nyata pada crash-window; risiko penuh butuh mis-deploy
multi-writer yang CLAUDE.md sudah larang tapi tidak ditegakkan teknis).

**Implementasi aktual:** Persis seperti FIX, PLUS reaper untuk SENDING basi (bagian dari
FIX yang sama, bukan dipisah ke Infra-3). Kolom baru `claimed_at` (migrasi
`prisma/migrations/20260623082258_add_notification_claimed_at/`) menandai kapan klaim
terjadi; status `SENDING` ditambahkan ke `NotificationStatus`. `claimNotification(db,
notifId)` melakukan `updateMany` atomik (PENDING, ATAU SENDING yang `claimedAt` lebih lama
dari `STALE_CLAIM_MS`=5 menit → ikut diklaim ulang). `fetchPendingNotifications` ikut
disesuaikan agar mengembalikan baris PENDING ATAU SENDING-basi (jadi reaper tidak perlu cron
terpisah — baris basi otomatis terlihat lagi tick berikutnya). `dispatcher.ts` memanggil
`claimNotification` SEBELUM setiap percobaan kirim; bila gagal klaim, baris dilewati (sudah
diambil instance lain / belum basi). Ditambah helper baru `releaseNotificationClaim` yang
mengembalikan baris SENDING ke PENDING TANPA menghitungnya sebagai percobaan gagal — dipakai
pada dua jalur yang BUKAN kegagalan riil: rate-limit Telegram (retry_after) dan "channel post
tanpa PUBLIC_CHANNEL_ID" (sebelumnya `continue` polos yang kini akan membiarkan baris
tersangkut SENDING sampai basi, 5 menit, alih-alih langsung PENDING lagi tick berikutnya).
`markNotificationFailed` diubah agar EXPLICIT menyetel `status: PENDING` saat belum
mencapai `maxAttempts` (sebelumnya implicit/tidak diubah — sekarang wajib karena baris sudah
SENDING saat fungsi ini dipanggil, bukan PENDING seperti sebelum fix). `markNotificationSent`
membersihkan `claimedAt`. 11 test baru di `notifications.test.ts` (klaim sekali, tidak
terlihat saat SENDING segar, basi→terlihat lagi, release→langsung PENDING, markFailed/
markSent membersihkan klaim) + 3 test integrasi baru di `dispatcher.test.ts` yang membuktikan
end-to-end lewat `drainBatch` asli (bukan cuma unit CRUD): kirim sekali tandai SENT, TIDAK
kirim ulang baris yang masih SENDING segar (skenario crash-window yang persis fix ini
cegah), DAN kirim ulang baris SENDING yang sudah basi (skenario dispatcher crash lalu pulih).

### Infra-3 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/outbox-dispatcher/src/dispatcher.ts:177`
**PROBLEM:** Tidak ada backoff per-baris; baris yang gagal terus-menerus menempati slot
teratas batch (orderBy createdAt ASC) tiap tick sampai max-attempt, menunda baris valid di
belakangnya (head-of-line blocking).
**FIX:** Tambahkan `nextRetryAt` dengan exponential backoff, filter query terhadapnya.
**CONFIDENCE:** Medium

**Implementasi aktual:** Diimplementasikan persis seperti FIX — kolom `nextRetryAt` baru
(migrasi `prisma/migrations/20260623174936_add_notification_next_retry_at/`) di
`NotificationOutbox`; `fetchPendingNotifications`/`claimNotification` di
`packages/db/src/crud/notifications.ts` berbagi helper `claimableWhere` yang menambahkan
filter `nextRetryAt IS NULL OR nextRetryAt <= now`. `markNotificationFailed` menghitung
backoff eksponensial (`notificationBackoffMs`: basis 30 detik, dobel per attempt, capped 10
menit — beberapa kali lipat `NOTIF_POLL_INTERVAL_SECONDS=10` default) dan menyetel
`nextRetryAt` HANYA saat kembali ke PENDING (baris yang mencapai FAILED tidak butuh
nextRetryAt — terminal). `retryNotification` (retry manual admin di panel /outbox) juga
diupdate menghapus `nextRetryAt` — tanpa ini, klik "retry" admin bisa diam-diam tertahan oleh
sisa window backoff dari kegagalan sebelumnya. Tidak ada perubahan di `dispatcher.ts` sendiri
— seluruh logic backoff terkapsulasi di layer crud, dipanggil transparan lewat
`markNotificationFailed(prisma, row.id, ..., config.NOTIF_MAX_ATTEMPTS)` yang sudah ada. 5
test regresi baru di `packages/db/src/crud/notifications.test.ts`: kurva backoff
dobel-dan-capped, baris yang baru gagal TIDAK muncul di batch sampai window lewat lalu
muncul lagi, baris FAILED punya `nextRetryAt=null`, `retryNotification` menghapus backoff,
dan — yang paling langsung membuktikan FIX-nya — baris yang terus gagal TIDAK memblokir baris
valid yang di-enqueue setelahnya saat batch dibatasi `limit=1`.

### Infra-4 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `packages/db/src/crud/notifications.ts:78` (enqueueAdminOverpaid)
**PROBLEM:** Alert overpayment di-loop atas `config.ADMIN_IDS` (env-only), bukan allow-list
resolved (env ∪ DB). Admin yang dikelola sepenuhnya via DB/wizard tidak pernah menerima
alert overpayment.
**ATTACK SCENARIO (operasional):** Toko kelola admin via DB saja, `ADMIN_IDS` env kosong →
overpayment buyer luput dari peninjauan refund/kredit.
**FIX:** Resolusikan admin ids dari sumber yang sama dengan runtime (`adminIds()`/
`resolveAdminIds(db)`).
**CONFIDENCE:** High

**Implementasi aktual:** Diimplementasikan persis seperti FIX — `enqueueAdminOverpaid`
sekarang memanggil `resolveAdminIds(db)` (sudah ada di `packages/db/src/crud/admins.ts`,
union env `ADMIN_IDS` ∪ Setting `admin_ids`) menggantikan loop `config.ADMIN_IDS` langsung;
import `config` yang jadi tak terpakai dihapus dari file. 1 test regresi baru di
`packages/db/src/crud/paydisini.test.ts`: admin yang ditambahkan HANYA via
`addAdminIdToDb` (tanpa entri di env ADMIN_IDS yang di-mock) tetap menerima baris
ADMIN_OVERPAID-nya sendiri.

### Infra-5 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `prisma/schema.prisma:213-261` (Order dan relasi finansial)
**PROBLEM:** `onDelete: Cascade` pada beberapa relasi finansial/audit:
`Referral.order→Order`, `OrderItem.order`, `WalletTransaction.user`, `Review`. Menghapus
User cascade menghapus `WalletTransaction` (ledger append-only); menghapus Order (bila ada
jalur hard-delete) cascade menghapus `Referral`/`OrderItem`.
**BUSINESS IMPACT:** Hilangnya integritas catatan finansial/komisi yang seharusnya
append-only; tidak ada cara rekonstruksi pembayaran/komisi setelah cascade.
**FIX:** Ganti `onDelete: Cascade` pada tabel ledger/komisi menjadi `Restrict`/`SetNull`;
pertimbangkan soft-delete untuk Order/User.
**CONFIDENCE:** Medium (cacat schema nyata; eksploitabilitas bergantung jalur hard-delete
yang dimiliki slice admin-web)

**Implementasi aktual:** `Restrict` dipilih (bukan `SetNull`) untuk SEMUA empat relasi yang
disebut FIX — `WalletTransaction.user`, `OrderItem.order`, `Review.order`, dan
`Referral.order` — karena keempat FK-nya NOT NULL (mengosongkan via SetNull butuh
melonggarkan kolom jadi nullable, perubahan skema lebih besar dari yang dibutuhkan minimal
fix ini); `Referral.referee`/`Referral.referrer` (relasi User lain di model yang sama, TIDAK
disebut FIX) dibiarkan Cascade. Dikonfirmasi via grep bahwa TIDAK ADA jalur produksi yang
hard-delete Order atau User sama sekali hari ini — jadi perubahan ini murni guardrail skema
untuk masa depan, zero behavior change untuk kode existing. Migrasi baru
`prisma/migrations/20260623174046_restrict_financial_cascades/` (redefine-table SQLite,
divalidasi byte-identik via `prisma migrate diff` terhadap shadow DB, mengikuti pola migrasi
sesi ini). Efek samping yang ditemukan & diperbaiki: helper test bersama
`tests/helpers/sampleData.ts`'s `resetDb()` mengandalkan Cascade lama untuk membersihkan
`wallet_transactions` saat `user.deleteMany()` — sekarang menghapus `walletTransaction`
eksplisit lebih dulu. Diverifikasi dengan menjalankan SELURUH test suite monorepo (915 test,
71 file) — semua hijau, termasuk 6 file test lain yang melakukan `user`/`order`
`deleteMany()` di luar helper bersama ini.

### Infra-6 [MEDIUM] ✅ DIPERBAIKI 2026-06-23
**FILE:** `apps/server/src/index.ts` — tidak ada `process.on('unhandledRejection'/'uncaughtException')`
**PROBLEM:** Composition root tidak memasang handler global. Karena topologi single-process
(satu proses = web-admin + storefront + bot + semua worker), satu unhandled rejection di
poller manapun bisa menjatuhkan SELURUH proses.
**BUSINESS IMPACT:** Satu bug worker → outage total toko (web+bot+pembayaran).
**FIX:** Pasang `process.on('unhandledRejection', ...)` dan `uncaughtException` untuk log +
graceful shutdown terkontrol.
**CONFIDENCE:** Medium

**Implementasi aktual:** Diimplementasikan persis seperti FIX, plus satu detail tambahan:
`shutdown()` (helper SIGINT/SIGTERM existing) diperluas menerima `exitCode` opsional (default
0) supaya jalur crash bisa exit dengan kode 1 — membedakan "proses crash" dari "stop bersih"
di log process supervisor (systemd/pm2/Docker). Logika registrasi diekstrak ke fungsi
terekspor `registerCrashHandlers(shutdown, proc = process)` — parameter `proc` opsional
(default `process` asli) memungkinkan test menyuntikkan `EventEmitter` palsu, sehingga test
TIDAK PERNAH memasang handler asli pada proses test-runner sendiri (yang berisiko membocorkan
listener antar file test atau memanggil `process.exit` sungguhan). 2 test regresi baru di
`apps/server/test/bootstrap.test.ts`: emit `unhandledRejection`/`uncaughtException` pada
`EventEmitter` palsu memanggil `shutdown` dengan `("unhandledRejection"|"uncaughtException", 1)`.

### Infra-7 [LOW]
**FILE:** `Dockerfile:28, 52`
**PROBLEM:** `COPY . .` menyalin seluruh build context; setiap file baru di root yang
tidak match `.dockerignore` otomatis masuk image. `.dockerignore` saat ini sudah menutup
vektor utama (.env, db, .git).
**FIX:** Whitelist eksplisit file yang di-COPY; `pnpm prune --prod` untuk runtime image.
**CONFIDENCE:** Medium (hardening, bukan kebocoran aktual saat ini)

### Infra-8 [LOW]
**FILE:** `Dockerfile:36-66`
**PROBLEM:** Image runtime default tetap `root`; drop privilege ke user `app` hanya terjadi
via `gosu` di entrypoint. Override entrypoint (debug shell, orkestrator lain) memberi root
penuh.
**FIX:** Dokumentasikan larangan override entrypoint, atau set `USER app` sebagai default
akhir dengan provisioning volume terpisah.
**CONFIDENCE:** High (fakta default root) / Low (dampak praktis — happy path sudah aman)

### Infra-9 [LOW]
**FILE:** `packages/core/src/config.ts:189` (WEBHOOK_SECRET)
**PROBLEM:** `WEBHOOK_SECRET` hanya `z.string().optional()` tanpa `.min()` — operator bisa
set secret 1 karakter dan lolos validasi schema saat `BOT_MODE=webhook`.
**FIX:** `z.string().min(32)` + validasi keras saat mode webhook aktif.
**CONFIDENCE:** High pada gap validasi; Low pada likelihood (butuh operator memilih secret lemah)

### Infra-10 [LOW]
**FILE:** `packages/core/src/mailer.ts:20-28`
**PROBLEM:** `logger.info` mencatat alamat email penerima penuh (PII) di log. Tidak ada
vektor header-injection (to berasal dari lookup DB, subject dari admin-controlled).
**FIX:** Mask alamat email di log (`t***@domain`) atau log hanya user id.
**CONFIDENCE:** High

**Catatan positif:** Tidak ada hardcoded secret di source (grep bersih); `.env` benar-benar
gitignored & tidak pernah ter-commit; `.env.example` hanya placeholder; password.ts pakai
bcrypt cost 12; logger.ts tidak pernah mencatat password/kode reset/token bot/webhook URL;
PrismaClient singleton benar; idempotency ledger schema (UNIQUE pada semua `processed_*_tx`)
solid; semua field uang Decimal; template outbox meng-escape konten user-controlled sebelum
HTML parse_mode.

---

## Rekomendasi Urutan Perbaikan

1. ✅ **Bot-1** (Critical) — pasang `adminOnly` pada `/admin` dan `/wallet`. Ini satu baris
   perubahan dengan dampak finansial terbesar di seluruh audit; perbaiki sebelum apa pun lain.
   **DIPERBAIKI 2026-06-23**: gate ditambahkan di `main.ts` (middleware `adminOnly`) DAN
   defensif langsung di dalam `adminCommand`/`adminWalletCommand` (karena unit test
   memanggil handler langsung, melewati middleware grammY) + 2 test regresi baru.
2. ✅ **Admin-1** — perbaiki kondisi lock setup wizard (`lockedRedirect`). **DIPERBAIKI
   2026-06-23**, plus bug `.then()`-thenable independen yang ditemukan & diperbaiki sekaligus
   (lihat catatan di §Admin-1).
3. ✅ **Admin-2** — satukan pengecekan `adminIds()` di semua route `/admins/*` + default
   readonly saat add. **DIPERBAIKI 2026-06-23** (lihat catatan implementasi di §Admin-2).
4. ✅(sebagian) **Payment-1** — DIPERBAIKI 2026-06-23 via live-confirm (`checkTransaction`),
   bukan mengubah skema signature (lihat catatan di §Payment-1).
   ✅ **Payment-2** — DIPERBAIKI 2026-06-23, hard gate per-tick bukan throw di boot
   (lihat catatan di §Payment-2).
5. ✅ **Pricing-1** — DIPERBAIKI 2026-06-23, tabel `VoucherRedemption` + cap 1x/user
   (lihat catatan di §Pricing-1).
6. ✅ **Checkout-2 / Stock-1** — DIPERBAIKI 2026-06-23, reservasi stok atomik saat checkout
   (lihat catatan implementasi di §Checkout-2). §Stock-1 (dedup kredensial `bulkAddStock`)
   tetap pending — itu temuan terpisah, bukan bagian dari fix ini.
7. ✅ **Checkout-1** — DIPERBAIKI 2026-06-23, guard double-tap per (user, product,
   paymentMethod) di kelima `buyNow*` (lihat catatan implementasi di §Checkout-1).
8. ✅ **Infra-2** — DIPERBAIKI 2026-06-23, claim/lock pattern + reaper SENDING basi pada
   outbox dispatcher (lihat catatan implementasi di §Infra-2).
9. ✅ **Bot-2** — DIPERBAIKI 2026-06-23, transisi `approveOrder` kini atomik eksplisit
   (lihat catatan implementasi di §Bot-2).
10. Sisanya (Medium/Low) bisa dikerjakan bertahap sesuai kapasitas tim; prioritaskan yang
    bersinggungan dengan rencana migrasi Postgres (Pricing-2, Bot-2, Checkout-7) sebelum
    migrasi benar-benar dilakukan.
