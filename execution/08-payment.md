# 08 — Payment Integrity

## ROLE
Payment Engineer.

## OBJECTIVE
Pastikan auto-confirm pembayaran andal & bebas double-credit: aktifkan `USE_UNIQUE_CENTS` di prod (M-9)
dan validasi ulang idempotensi/anti-ambiguity.

## GLOBAL RULES
- Minimal patch (M-9 utamanya config), zero regression. Jangan ubah logika matching tanpa bukti. Test bila berubah.

## INPUT (issue audit)
- **M-9** — Set `USE_UNIQUE_CENTS=1` di prod agar auto-confirm Binance bisa bedakan order ber-total sama. (Phase 16/B16-03)

## ANALYSIS (cari)
- **unique cents:** `apps/order-bot/src/payments/binanceInternal.ts:362-368` — bila `USE_UNIQUE_CENTS` off, dua order ber-total sama tak bisa dicocokkan by amount → auto-confirm degrade (refuse, **bukan** mis-deliver). Boot sudah `logger.warn`.
- **anti salah-kredit:** `matchByAmount` (`:93-101`) → `hits.length === 1 ? hit : null` (menolak bila ambigu). Verifikasi tetap utuh.
- **idempotency:** `packages/db/src/crud/binance_internal.ts:147-153` — `processedBinanceTx.create` klaim TxID; unique violation → `already_processed`. Cek paralel untuk Bybit (`bybit_deposit.ts`) & Tokopay.
- **money:** matching pakai tolerance `toNumber()` (by design); kredit/total tetap Decimal.

## IMPLEMENTATION STRATEGY
1. Verifikasi `USE_UNIQUE_CENTS` di `config.ts` + efeknya pada pembuatan total order (apakah benar menghasilkan total unik).
2. Konfirmasi idempotensi 3 provider (Binance/Bybit/Tokopay) via unique TxID.
3. Konfirmasi anti-ambiguity matchByAmount.
4. Set env prod + uji skenario.

## WRITING PLAN
- **Config (ops):** set `USE_UNIQUE_CENTS=1` di `.env` prod (bukan kode). Pastikan didokumentasikan (file 12).
- **Verifikasi kode (tanpa ubah bila sudah benar):** baca `binanceInternal.ts`, `bybit_deposit.ts`, `tokopay.ts`, crud Processed*Tx.
- **Test:** bila ada celah, tambah test di `packages/db/src/crud/*` (idempotensi: panggil proses TxID sama 2× → kedua tak kredit ganda; ambiguity: 2 order total sama → refuse).
- **Docs:** payment integrity checklist + catatan `USE_UNIQUE_CENTS` wajib di prod.

## EXECUTION PLAN (siap jalan)
1. `grep -rn "USE_UNIQUE_CENTS" packages/core/src/config.ts apps packages` → pahami efek pada total order.
2. Telusuri idempotensi: `processedBinanceTx/Bybit/Tokopay` create + unique handling.
3. Tulis/temukan test idempotensi & ambiguity; `npx vitest run packages/db/src/crud` → hijau.
4. Set `USE_UNIQUE_CENTS=1` di env prod; restart; konfirmasi log boot **tidak** lagi memunculkan warning unique-cents.
5. Uji staging: 2 order total identik (unique cents on) → tetap dapat total berbeda → auto-confirm benar; poll TxID ganda → no double-credit.

## OUTPUT
- **Payment integrity checklist:** unique cents aktif (no warn boot); idempotensi 3 provider (TxID unique); matchByAmount refuse-on-ambiguity; money Decimal pada kredit; transisi state valid (tak approve order cancelled/paid).

## CONSTRAINT
Jangan ubah logika pembayaran tanpa bukti. Hasilkan payment integrity checklist (+ test bila ada celah).
