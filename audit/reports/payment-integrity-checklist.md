# Payment Integrity Checklist — execution/08 (M-9)

Tanggal: 2026-06-18. Verifikasi kode + status `USE_UNIQUE_CENTS`. Tanpa mengubah
logika pembayaran (CONSTRAINT task 08).

## Status M-9 — `USE_UNIQUE_CENTS`

| Lokasi | Nilai | Catatan |
|---|---|---|
| `packages/core/src/config.ts:81` | `looseBool.default(true)` | **default sudah ON** |
| `.env:59` | `USE_UNIQUE_CENTS=1` | aktif di env ini |
| `.env.example:19` | `USE_UNIQUE_CENTS=1` | terdokumentasi sebagai default |
| test setup (`apps/*/test/setup-*.ts`) | `=0` | **sengaja** (totals deterministik utk assertion) |

➡ **M-9 terpenuhi**: unique-cents aktif di prod (default + `.env`). Boot **tidak**
akan memunculkan warning unique-cents (`binanceInternal.ts:364`, `bybitDeposit.ts:297`
hanya warn bila OFF).

## Checklist integritas (terverifikasi dari kode + test)

| Item | Status | Bukti |
|---|---|---|
| Idempotensi **Binance** | ✅ | `processedBinanceTx.create` → `isUniqueViolation` → `already_processed` (`binance_internal.ts:149-153`); test `deliverPaidInternalOrder ... idempotent on same tx id` |
| Idempotensi **Bybit** | ✅ | `processedBybitTx` UNIQUE `bybit_tx_id` (`bybit_deposit.ts:140-144`); pola identik |
| Idempotensi **Tokopay** | ✅ | `processedTokopayTx` UNIQUE `trx_id` (`tokopay.ts:59-63`) |
| `matchByAmount` refuse-on-ambiguity | ✅ | `hits.length === 1 ? hit : null` (`binanceInternal.ts:101`); test "refuses on a collision (≥2 candidates)" |
| Underpaid → bukan mis-deliver | ✅ | `classifyTx` → `underpaid` bila kurang dari tolerance; test "flags underpaid" |
| Transisi state valid (tak approve cancelled/paid) | ✅ | `stale` guard pada order non-pending; test "returns 'stale' when a different tx targets an already-delivered order" |
| Money = Decimal pada kredit/total | ✅ | `q4`/`Decimal` di `orders.ts`/`pricing.ts`; matching pakai `toNumber()` **hanya** untuk perbandingan tolerance (by design) |
| Unit test `computeUniqueCents` | ✅ (ditambah) | `core.test.ts` — determinisme, rentang, formula, + dokumentasi gap |

## ✅ TEMUAN gap `computeUniqueCents` vs `AMOUNT_TOLERANCE` — DIPERBAIKI

**Gap semula (matematis + ter-test):** `computeUniqueCents` melangkah
**0.0001–0.0099 USDT** (`(id%99+1)/10000`), padahal `AMOUNT_TOLERANCE = 0.01`
(`binanceInternal.ts:43`, `bybitDeposit.ts:41`) dan matcher pakai `|diff| <= 0.01`.
Rentang offset **< tolerance** ⇒ dua order base-sama (id1→5.0002, id2→5.0003)
sama-sama dalam tolerance → 2 hits → **refuse**. Unique-cents tak mencapai tujuan
docstring-nya ("disambiguate simultaneous transfers of the same amount"). Dampak
terberat di **Bybit** (BEP20 no-memo ⇒ amount-match satu-satunya jalur).

**Perbaikan (keputusan owner: perbesar offset):**
`formatters.ts` → `computeUniqueCents(id) = ((id % 49) + 1) / 50` → **0.02–0.98
USDT, step 0.02**. Step sengaja **> tolerance 0.01** (dan > 0.01 walau matcher
pakai `<=`, karena adjacent ≥0.02), jadi dua order base-sama kini berjarak ≥0.02 →
**hanya satu kandidat** → auto-confirm benar. Tolerance **tidak** diubah.

> Catatan: `/100` murni (step 0.01) **tidak** cukup — selisih adjacent tepat 0.01
> dan matcher `<=` tetap menangkap keduanya. Karena itu dipakai step 0.02.

**Tradeoff yang diterima (didokumentasikan):**
- Pelanggan membayar **+0.02…0.98 USDT** ekstra (masuk margin toko).
- Offset s.d. 0.98 ⇒ order ber-**base berbeda** yang totalnya berdekatan (<~0.98)
  kini bisa alias dalam tolerance → **refuse** (manual). Tetap **aman** (tak pernah
  mis-deliver); hanya mengurangi auto-confirm untuk produk berharga sangat mirip.
  49 bucket menjaga surcharge < 1 USDT.

**Backward-compatible:** hanya order **baru** terpengaruh — semua konsumen
(`reports.ts`, `orders.ts`) membaca kolom `uniqueCents` tersimpan, bukan menghitung
ulang. Order lama tetap pakai nilai mereka.

**Verifikasi:** unit test `computeUniqueCents` di `core.test.ts` membuktikan rentang
baru, formula, dan **adjacent spread > tolerance** (gap tertutup). `pnpm -r
typecheck` + `npx vitest run` = **522/522** hijau.
