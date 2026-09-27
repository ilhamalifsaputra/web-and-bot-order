# Finance Architecture & Math Logic

Ringkasan arsitektur uang (money), model harga, dan logika matematis di repo
ini. Ditulis sebagai referensi cepat — untuk detail historis/bug-fix lihat
`docs/audit-security-2026-06-23.md` (bagian C: Pricing, Voucher, Wallet & FX).

## 1. Base currency: IDR, bukan multicurrency sejajar

**Acuan/base currency sistem ini adalah IDR (central-IDR), bukan USDT.**
Ditegaskan langsung di komentar `packages/core/src/enums.ts:288-289`
(plan.md §15.2):

> "the catalog price is always central IDR; USDT is a derived, rounded figure"

- `Product.price` / `Denomination.price` **selalu** disimpan dalam Rupiah —
  satu-satunya source of truth untuk harga katalog. Tidak ada kolom harga
  USDT tersendiri di produk.
- USDT bukan currency independen — ia **derived value**, dihitung saat
  checkout lewat `usdtFromIdr(idr, rate)`, dengan `rate` = setting
  `usd_idr_rate` (admin-set, auto-update dari market rate).
- `OrderCurrency` (`packages/core/src/enums.ts`) cuma dua nilai: `IDR` dan
  `USDT` — ini bukan currency katalog, tapi **transaction currency** yang
  dipilih pembeli saat bayar (`finalizeOrderPayment` di `crud/pricing.ts`).
  Semua perhitungan subtotal/bulk-discount/voucher tetap jalan di ranah IDR
  dulu; konversi ke USDT hanya terjadi **sekali**, di akhir, terhadap total.
- Konsekuensi:
  - Admin ganti `usd_idr_rate` → harga IDR katalog **tidak berubah**, hanya
    tampilan/harga USDT turunan yang berubah.
  - Order yang sudah dibuat **snapshot `fxRate` miliknya sendiri** —
    perubahan rate admin belakangan tidak pernah me-reprice histori order.
  - `usd_idr_rate` unset/invalid → jalur pembayaran USDT (Binance/Bybit/dst.)
    otomatis disembunyikan, tapi jalur IDR (TokoPay/PayDisini/QRIS) tetap
    jalan normal karena IDR tidak bergantung pada rate sama sekali.

## 2. Fondasi tipe uang — `packages/core/src/money.ts`

- Semua uang pakai **`Decimal` (decimal.js)** — tidak pernah `number`/float.
  Kolom DB adalah `Numeric(12,4)`.
- `money(v)` → quantize ke 4 desimal. `fmtMoney`, `moneyEq`, `ZERO` sebagai
  helper dasar. Prisma sudah mengembalikan `Decimal` langsung, jadi tidak ada
  konversi lossy di boundary DB.

## 3. Formatting & rounding — `packages/core/src/formatters.ts`

- `quantizeMoney(amount, decimals)` — pembulatan **half-up**, satu-satunya
  cara "round to N desimal" di seluruh kode.
- `formatIdr` — `Rp` + titik ribuan, 0 desimal.
- `formatUsdt` / `formatUsdtAmount` — sampai 4dp, trailing zero dibuang.
- `formatMoney(amount, currency)` — dispatch ke salah satu berdasarkan
  `Order.currency` (bukan `Intl.NumberFormat` karena `"USDT"` bukan kode
  ISO-4217 yang valid).
- `usdtFromIdr(idr, rate)` — konversi IDR→USDT, dibulatkan ke **0.1 USDT
  terdekat** (plan.md §15.1). Dilakukan **sekali per total**, bukan per item,
  untuk menghindari drift pembulatan berganda.
- `computeUniqueCents(orderId)` — offset unik 0.002–0.098 USDT (49 bucket,
  step 0.002) untuk membedakan dua order bernominal sama saat matching
  transfer manual (Binance/Bybit) berbasis jumlah. Step ini sengaja lebih
  besar dari `AMOUNT_TOLERANCE` (0.001) di payment matcher supaya tidak
  collide.

## 4. FX rate — `packages/core/src/fx.ts`

- `fetchUsdIdrMarketRate()` — narik rate USDT→IDR dari CoinGecko's `/simple/price?ids=tether&vs_currencies=idr`
  (gratis, keyless, optional demo API key untuk raise rate limit).
- `roundRateToStep(rate, step)` — bulatkan ke kelipatan `step` rupiah
  (default Rp100, half-up).
- `refreshUsdIdrRate` (`crud/pricing.ts`, dipanggil job `reconcileFinancesJob`
  tiap jam via cron) — auto-update `usd_idr_rate` kecuali setting
  `usd_idr_rate_auto` = `"false"`.

## 5. Layering harga per line

Urutan matematis dari `orders.ts` / `flash.ts` / `bulk.ts` / `vouchers.ts`:

1. **Flash sale** (`core/flash.ts: effectiveUnitPrice`) — REPLACES harga
   dasar. Reseller dapat `min(resellerPrice, flashPrice)` supaya dua diskon
   tidak saling menumpuk jadi nyaris gratis.
2. **Bulk discount** (`core/bulk.ts: bulkDiscountFor`) — persen dari
   subtotal per line jika `quantity >= minQuantity`. Formula tunggal:
   `subtotal × percent / 100` (bukan `subtotal × (1 - percent/100)` — kedua
   spelling identik secara aljabar tapi beda pembulatan, sehingga sengaja
   cuma satu yang dipakai di seluruh kode).
3. **Voucher** (`crud/vouchers.ts: applyVoucherToSubtotal`) — PERCENT atau
   FIXED, dihitung di atas subtotal **net-of-bulk-discount**, dengan scope
   ALL/SELECTED (`computeEligibleAmounts` menghitung basis diskon hanya dari
   line yang match scope). Dua cap berurutan: cap ke `eligibleSubtotal`
   dulu, lalu ke `maxDiscount` (mana yang lebih kecil menang), lalu **floor
   ke 0 di akhir** sebagai pertahanan berlapis — supaya voucher yang
   misconfigured/corrupt tidak pernah menghasilkan discount negatif (yang
   berarti overcharge, karena rumus totalnya
   `subtotal - bulkDiscount - discount`).
4. Total akhir:
   `afterDiscount = max(0, subtotal - bulkDiscount - discount)`, lalu di
   `finalizeOrderPayment` dikonversi ke mata uang bayar + unique cents.

## 6. Wallet credit — `crud/wallet_checkout.ts`

- Jalur "bayar penuh pakai saldo" **selalu re-derive** harga/diskon/stok
  dari nol (tidak pernah percaya klaim caller "sudah cover"), lalu assert
  `totalAmount === 0` setelah kredit diterapkan (`error.insufficient_wallet`
  kalau tidak pas).
- Ledger currency-aware: leg IDR didebit **sebelum** konversi ke USDT, leg
  USDT didebit **sesudah** — dicatat lewat `WalletTransaction` (bukan
  diasumsikan dari `Order.currency`).

## 7. Rekonsiliasi — `crud/reports.ts: reconcileFinances`

Dijalankan job cron tiap 6 jam. Read-only drift detector, tidak memutasi
data:

- **Order drift** — hitung ulang `expected` dari
  `subtotalAmount - bulkDiscountAmount - discountAmount`, dikurangi wallet
  leg (dibaca dari `WalletTransaction`, bukan kolom `walletUsed` yang
  ambigu currency-nya), lalu (untuk USDT) dikonversi via `usdtFromIdr` +
  unique cents — dibandingkan ke `order.totalAmount` tersimpan, toleransi
  `0.0001`.
- **Voucher drift** — `usedCount` tersimpan vs jumlah order non-cancelled
  aktual yang memakainya.
- **Negative wallet balances** — deteksi saldo IDR/USDT yang minus
  (harusnya mustahil, tapi tetap dicek).

## 8. Prinsip desain yang berulang

- Satu fungsi murni per aturan (flash/bulk/voucher), dipakai bersama oleh
  bot, storefront, dan `createOrder*` — supaya harga yang ditampilkan dan
  yang ditagih tidak pernah berbeda.
- Validasi ulang di titik baca (bukan cuma di titik tulis) untuk kolom
  seperti `discountPercent`/`flashDiscountPercent`, mengantisipasi baris
  lama/hasil edit manual di DB.
- Semua pembulatan eksplisit soal *kapan* dan *berapa desimal* (dikomentari
  tebal di kode) karena order konkuren + rail pembayaran ganda
  (TokoPay/PayDisini/NOWPayments/Binance/Bybit/Wallet) membuat drift
  pembulatan sangat mudah terjadi kalau tidak disiplin.

## 9. Math logic — formula lengkap & contoh numerik

Notasi: `round₀`, `round₁`, `round₄` = pembulatan half-up ke 0/1/4 desimal
(`quantizeMoney`). Semua nilai intermediate adalah `Decimal`, bukan float.

### 9.1 Harga per unit (flash sale) — `core/flash.ts`

```
percent  = d.flashDiscountPercent            (hanya valid jika 0 < percent ≤ 100
                                               dan flashStartsAt ≤ now < flashEndsAt)
flashPrice   = round₀( price × (100 − percent) / 100 )     // hanya dari `price`, bukan resellerPrice
base         = isReseller && resellerPrice != null ? resellerPrice : price
unitPrice    = flashPrice == null ? base : min(base, flashPrice)
```
Contoh: `price = Rp50.000`, flash 20% aktif → `flashPrice = round₀(50000×80/100) = Rp40.000`.
Reseller dengan `resellerPrice = Rp42.000` → `unitPrice = min(42000, 40000) = Rp40.000`
(flash tidak pernah menaikkan harga reseller).

### 9.2 Subtotal cart

```
subtotal = Σ over cart lines ( unitPrice_i × quantity_i )
```
Dihitung pada satu instant `pricedAt` yang sama untuk seluruh line (§5), supaya
flash sale yang expired di tengah loop tidak membuat subtotal dan
`OrderItem.unitPrice` yang tersimpan saling kontradiksi.

### 9.3 Bulk discount per line — `core/bulk.ts`

```
percent          = rule.discountPercent      (valid hanya jika 1 ≤ minQuantity,
                                               0 < percent ≤ 100, quantity ≥ minQuantity)
lineDiscount_i   = round₄( lineSubtotal_i × percent / 100 )
bulkDiscount     = round₄( Σ lineDiscount_i )   // computeBulkDiscountForCart
```
Formula ini SATU-SATUNYA spelling yang dipakai — `subtotal × (1 − percent/100)`
secara aljabar sama tapi rounding-nya beda, jadi sengaja tidak dipakai paralel.

Contoh: line 10 unit @ Rp10.000 = Rp100.000 subtotal, rule "beli 5+ diskon 10%"
→ `lineDiscount = round₄(100000 × 10/100) = Rp10.000` → subtotal-net-bulk = Rp90.000.

### 9.4 Voucher — `crud/vouchers.ts: applyVoucherToSubtotal`

```
eligibleBase = eligibleSubtotal − eligibleBulkDiscount     // scope ALL: = subtotal − bulkDiscount
raw          = type == PERCENT ? eligibleBase × value / 100
                                : value                     // FIXED
discount     = min(raw, eligibleBase)                       // cap #1: tak lebih dari basis yang eligible
discount     = maxDiscount != null ? min(discount, maxDiscount) : discount   // cap #2
discount     = (!isFinite(discount) || discount < 0) ? 0 : discount          // floor TERAKHIR
discount     = round₄(discount)
```
Urutan `cap → cap → floor` itu wajib: floor harus paling akhir supaya nilai
negatif/NaN dari voucher yang misconfigured tidak lolos lewat salah satu cap
lalu jadi *menambah* tagihan (karena rumus totalnya pengurangan, §9.5).

Contoh: `eligibleBase = Rp90.000` (setelah bulk discount di atas), voucher
PERCENT 15% dengan `maxDiscount = Rp12.000`:
`raw = 90000×15/100 = Rp13.500` → cap #1 (≤ 90.000, lolos) → cap #2
(`min(13500, 12000) = Rp12.000`) → `discount = Rp12.000`.

### 9.5 Total sebelum konversi currency

```
afterDiscount = max( 0, subtotal − bulkDiscount − discount )
```
Lanjutan contoh: `100.000 − 10.000 − 12.000 = Rp78.000`.

### 9.6 Konversi ke USDT — `usdtFromIdr` (`core/formatters.ts`)

```
usdt = round₁( idr / rate )        // ke KELIPATAN 0.1 USDT terdekat, half-up
```
Dipanggil **sekali** atas TOTAL (`baseIdr = afterDiscount − walletIdrLeg`),
tidak pernah per line — mengalikan/menjumlah hasil yang sudah dikonversi
menggandakan error pembulatan. Contoh nyata dari kode (`orders.ts` L1856-1866):
5 unit @ Rp8.900 pada `fxRate = 16.000`:
- Salah (per-unit): `unitPrice = round₁(8900/16000) = round₁(0.55625) = 0.6` →
  `5 × 0.6 = 3.0 USDT`.
- Benar (per-total): `round₁((5×8900)/16000) = round₁(44500/16000) =
  round₁(2.78125) = 2.8 USDT`.

Kasus reconciliation-drift lain (docstring `orders.ts` L1808-1810): subtotal
Rp45.000 dengan voucher Rp9.000 pada `fxRate = 16.000`:
- Convert subtotal & discount independen: `2.8125→2.8` dan `0.5625→0.6`,
  `2.8 − 0.6 = 2.2 USDT`.
- Convert net sekali: `(45000−9000)/16000 = 2.25 → round₁ half-up = 2.3 USDT`.
- **2.2 ≠ 2.3** — kontradiksi 0.1 USDT. Karena itu halaman order/receipt
  men-derive subtotal DARI net + discount (satu konversi), bukan mengonversi
  keduanya secara independen (lihat komentar `enqueueBuyerOrderReadyEmailIfGuest`).

### 9.7 Unique cents (disambiguasi transfer manual) — `computeUniqueCents`

```
bucket = (orderId mod 49) + 1              // 1..49
cents  = round₄( bucket / 500 )            // 0.002 .. 0.098, step 0.002
```
`0.002` sengaja > `AMOUNT_TOLERANCE = 0.001` di payment matcher, supaya dua
order bernilai basis sama tidak pernah saling collide dalam toleransi matching.

### 9.8 Total final per currency — `finalizeOrderPayment`

```
baseIdr = order.totalAmount − order.uniqueCents     // strip noise sebelum re-derive

IDR:   totalAmount = round₀(baseIdr) ;  uniqueCents = 0

USDT:  usdt        = usdtFromIdr(baseIdr, rate)              // §9.6
       cents       = method == WALLET ? 0 : computeUniqueCents(orderId)   // §9.7
       totalAmount = usdt + cents
```

### 9.9 FX rate rounding — `roundRateToStep`

```
rate_rounded = round₀( rate / step ) × step
```
Contoh: `rate = 16.243,7`, `step = 100` → `round₀(16243.7/100) = round₀(162.437) = 162`
→ `162 × 100 = Rp16.200`. `rate = 16.250`, `step = 100` → `round₀(162.5) = 163`
(half-up) → `Rp16.300`.

### 9.10 Reconciliation "expected total" — `reports.ts: reconcileFinances`

```
afterDisc = subtotalAmount − bulkDiscountAmount − discountAmount

// walletIdrLeg / walletUsdtLeg dibaca dari WalletTransaction (bukan walletUsed)

if currency == USDT && fxRate != null:
    baseIdr    = max(0, afterDisc − walletIdrLeg)
    afterCredit= max(0, usdtFromIdr(baseIdr, fxRate) − walletUsdtLeg)
    expected   = round₄(afterCredit + uniqueCents)

elif currency == IDR:
    expected   = round₀(max(0, afterDisc − walletIdrLeg))

else:   // order lama tanpa fxRate snapshot
    expected   = round₄(max(0, afterDisc − walletIdrLeg − walletUsdtLeg) + uniqueCents)

drift  if  |expected − order.totalAmount| > 0.0001
```
Wallet leg IDR dikurangkan SEBELUM konversi ke USDT (sesuai titik debit di
`createOrder*`); wallet leg USDT dikurangkan SESUDAH konversi (sesuai titik
debit di `applyUsdtWalletToOrder`) — rumus di atas benar untuk kombinasi leg
apa pun (IDR saja, USDT saja, keduanya, atau tidak ada).

## Referensi file utama

- `packages/core/src/{money,formatters,fx,flash,bulk}.ts`
- `packages/db/src/crud/{pricing,orders,vouchers,wallet_checkout,reports}.ts`
- `docs/audit-security-2026-06-23.md` (bagian C: Pricing, Voucher, Wallet &
  FX) untuk histori bug-fix di area ini.
