# Phase 9 — Error Handling Audit

> Read-only.

---

## Konteks Proyek
Logger **pino** (`packages/core/logger`). Storefront & web-admin punya `setErrorHandler`
+ `setNotFoundHandler` (halaman ramah, **tak** log body request — `apps/storefront/src/server.ts:56-84`).
Aturan: jangan log secret. Pembayaran & job memanggil API eksternal (Bybit/Binance/Telegram/SMTP)
yang bisa gagal/timeout/429.

---

## Objective
Temukan penanganan error yang lemah: exception ditelan, tanpa log, tanpa retry, atau bocor ke user.

## Langkah Investigasi
1. **Catch kosong / menelan:** 
   - `grep -rnE "catch\s*\([^)]*\)\s*\{\s*\}" apps packages --include=*.ts`
   - `grep -rnA3 "catch" apps packages --include=*.ts | grep -v test` → periksa blok yang hanya `return`/diam tanpa log.
2. **Promise tanpa catch:** `await` panggilan eksternal tanpa try/catch (payments, mailer, telegram fetch).
3. **Retry/backoff:** cek job/notifier/outbox & API client — `grep -rn "retry\|backoff\|attempts\|RateLimited" apps/order-bot/src apps/notifier/src`. Apakah kegagalan transient diulang?
4. **Pesan ke user:** error internal harus jadi pesan ramah (web: error.njk; bot: toast/alert i18n), bukan stack trace.
5. **Logging memadai:** error penting di-`logger.error({ err }, "...")` dengan konteks, tanpa secret.

## Output → tulis ke `audit/reports/phase-09-error-handling.md`
```
ID | File:line | Jenis (swallowed / no-log / no-retry / leak-to-user / unhandled-promise) | Dampak | Rekomendasi | Severity
```
Tutup dengan ringkasan pola berulang (mis. "panggilan eksternal X tak punya retry").
