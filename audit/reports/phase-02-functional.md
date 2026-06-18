# Laporan Phase 2 — Functional Audit

Tanggal: 2026-06-18 · Read-only.

## Bukti test
`npx vitest run` → **518 lulus / 0 gagal, 42 file** (per 2026-06-18). Tidak ada test gagal/skip mencurigakan.

## Flow yang ditelusuri & status
| Flow | Lokasi | Status |
|---|---|---|
| Register/Login/Logout | storefront & web-admin `routes/auth.ts` | ✅ tercakup test (login benar/salah/banned, register+referral, dedup username) |
| 2FA | `web-admin/src/auth.ts`, `routes/settings.ts` | ✅ test "login requires 2FA once enabled", "disable requires password+code" |
| CRUD katalog + denominasi | `web-admin/routes/catalog.ts`, `crud/catalog.ts` | ✅ assign/unassign via dropdown, cross-category reject |
| Search/Filter | storefront `/search` (group-aware), admin `search.ts` | ✅ |
| Pagination | admin `routes/orders.ts:36-37` | ✅ ada (PAGE_SIZE) |
| Upload/Download | `lib/upload.ts`, `/uploads/` | ✅ guard CSRF+MIME+size |
| Notification/Email | `notification_outbox`, notifier, `storefront/forgot.ts` | ✅ reset mail one-time + invalidasi sesi |
| Payment (Bybit/USDT, QRIS) | `order-bot/payments/*`, storefront `checkout.ts` | ✅ test order BYBIT/USDT, pay page, reject saat disabled |
| Webhook/jobs | `server/index.ts`, `order-bot/jobs/index.ts` | ✅ auto-cancel/rekonsiliasi |
| Bot integration | browse → denominasi → checkout | ✅ test bot (denominasi picker, harga IDR) |

## Edge case — diperiksa
- **Race condition stok:** ✅ test "out-of-stock request throws and leaks no RESERVED rows" → deduksi stok dalam `$transaction`, tak oversell.
- **Idempotensi pembayaran:** ✅ `ProcessedBinanceTx/Bybit/Tokopay` ber-`@unique` pada txid → transaksi ganda tak diproses dua kali.
- **Order code/paymentRef unik:** ✅ `@unique` (orderCode, paymentRef) — cegah duplikasi order.
- **Double submit checkout:** ⚠️ lihat catatan UX (Phase 4) — server membuat order dalam transaksi, tapi tombol klien tak disable; risiko ditekan oleh unik orderCode + window pembayaran.

## Temuan
Tidak ada **bug fungsional** yang teridentifikasi dari suite + pembacaan kode.

## Area dengan cakupan test yang bisa diperkuat (rekomendasi, bukan bug)
```
ID | Area | Rekomendasi test
F-01 | searchCatalogEntries di route /search | test route-level untuk query parsial & grup-by-name (sudah ada unit crud; route inject opsional)
F-02 | Voucher boundary | over-limit used_count, kadaluarsa tepat di batas waktu
F-03 | Wallet balance negatif | jalur adjust saldo manual admin (allowNegative)
F-04 | Webhook mode | test webhookCallback path (saat ini polling yang banyak diuji)
```

> Read-only — tidak ada perubahan kode.
