# Laporan Phase 16 — Bot Audit (grammY, end-to-end)

Tanggal: 2026-06-18 · Read-only (tidak ada kode diubah). Cakupan: `apps/order-bot`.

## Ringkasan
| Severity | Jumlah |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 3 |

**3 hal teratas sebelum produksi:**
1. **Set `USE_UNIQUE_CENTS=1` di prod** (config, bukan bug) — agar auto-confirm Binance bisa membedakan order ber-total sama. Bot sudah **warn loudly** saat boot bila off.
2. **B16-01** rateLimit `Map` tanpa housekeeping → pertumbuhan memori pada uptime sangat panjang.
3. **B16-02** `bot.catch` mencatat teks pesan user (terpotong 120) → bisa menangkap free-text sensitif.

Verdict: **bot dalam kondisi sangat baik.** Tidak ada Critical/High; jalur uang & admin aman, kepatuhan kontrak UX CLAUDE.md tinggi, paritas i18n sempurna.

---

## Temuan
```
ID | Sev | Area | File:line | Gejala | Root cause | Dampak | Rekomendasi | Effort
B16-01 | Low | B/I | middleware.ts:60-79 | buckets Map<userId,number[]> tak pernah dihapus | tak ada sweep entri kosong | memori naik pelan seiring jumlah user unik (bukan per-pesan); restart membersihkan | sweep periodik bucket kosong / TTL | S
B16-02 | Low | I | main.ts:124 | logger.error mencatat text=ctx.message.text.slice(0,120) | konteks diagnosa | bisa menangkap TxID/teks sensitif user di log | redaksi/hilangkan text mentah; cukup callbackData/ref | S
B16-03 | Low/Info | G/J | payments/binanceInternal.ts:79,99,128 | match deposit pakai Decimal.toNumber()+tolerance (bukan Decimal arithmetic) | pencocokan fuzzy deposit | aman: refuse-on-ambiguity + USE_UNIQUE_CENTS; bukan aritmetika uang | biarkan; dokumentasikan tolerance | —
B16-04 | Low/Info | H | jobs/index.ts (croner) | job (auto-cancel/broadcast/reconcile) asumsi single-instance | 2 proses → job ganda | double-cancel/broadcast bila di-scale | dokumentasikan asumsi single-instance (selaras SQLite single-writer) | —
```

---

## A. Wiring & Middleware Chain ✅
- Urutan benar (`main.ts:66-71`): `bindUpdateId` → `sequentialize(per-chat)` → `session` → `conversations()` → `registeredUser` → `rateLimit`. `registeredUser` (upsert + sync lang + ban-block) jalan **sebelum** entry trigger.
- `rateLimit` melindungi callback **dan** message (`middleware.ts:62`), drop senyap saat limit (callback dapat toast `error.rate_limited`). Window `Date.now()/1000` — boundary aman. **Catatan B16-01** (housekeeping).
- `drop_pending_updates` saat boot (`main.ts:234`) best-effort try/catch.
- Global parse_mode HTML auto (`main.ts:52-63`) — **escaping diaudit di E/A**: helper `esc()` dipakai konsisten untuk input user (nama produk, username, voucher code, TxID, fullName). Contoh `conversations/admin.ts:397` `name = esc(...)`, `handlers/admin.ts:112,144,163` `esc(...)`. **Tidak ditemukan HTML injection.**

## B. Conversation Engine ✅
- `consumeInput` dipakai untuk input transien: wizard admin & **voucher code** (`checkout.ts:265`). **TxID tidak di-consume** (hanya satu consumeInput di checkout = voucher), **support text tidak di-consume** (`support.ts` tanpa consumeInput) → patuh aturan "free-text bernilai-record tidak dihapus".
- Cancel/Back hidup; `isAdminCancelLike` di wizard broadcast (`admin.ts:324,363`).

## C. Callback Router & Stale-Screen ✅
- Namespacing `v1:` ditegakkan; non-`v1:`/domain tak dikenal → `dead_tap` + `error.stale_screen` (`callbacks.ts:170-203`).
- **IDOR aman**: order callbacks hanya routing; ownership dicek di fungsi — `viewOrder` (`customer.ts:536` `order.userId !== info.id`), `cancelPendingOrder` (`checkout.ts:767`), tiket (`callbacks.ts:238` `ticket.userId !== info.id`). User tak bisa akses order/tiket orang lain.

## D. Render/UX Helper Compliance ✅
- `smartEdit`/`adminEdit` mengedit teks **dan** foto+caption + fallback fresh-send (`util/chat.ts:71-188`); error edit ditangani (tak dilempar ke `bot.catch`).
- `retireKeyboard` (`chat.ts:42`) → satu keyboard aktif per chat.

## E. i18n / No Leaked English ✅ (sempurna)
- **Paritas EN/ID: 517 kunci masing-masing, 0 hilang dua arah, 0 placeholder mismatch.**
- String customer/admin lewat `t()`/`coreT()`. (Catatan: pesan ke **admin** internal sebagian sengaja Inggris—mis. dashboard produk/voucher di `handlers/admin.ts`—konsisten dengan praktik repo; bukan kebocoran ke customer.)

## F. Admin Surface Security ✅
- Gate `adminOnly`/`isAdmin(ctx.from.id)` di **entry**: middleware (`middleware.ts:82`), conversation admin (`admin.ts:78` + `denyAdmin`), reject (`reject.ts:27`), handler admin (`admin.ts:573`). Non-admin → `error.admin_only` alert, bukan eksekusi. Sumber otoritas = `ADMIN_IDS` runtime (bukan snapshot session basi).

## G. Payments Poller ✅ (jalur uang aman)
- **Anti salah-kredit:** `matchByAmount` mengembalikan `null` bila **≥2** order cocok jumlah (`binanceInternal.ts:100` `hits.length === 1 ? hits[0] : null`) → menolak, tak mis-deliver. Boot **warn** bila `USE_UNIQUE_CENTS` off (`:362-368`).
- **Idempotensi:** `processedBinanceTx.create` klaim TxID; unique-violation → `already_processed` (`crud/binance_internal.ts:147-153`) + single-writer SQLite → tak double-credit.
- **Secrets:** tak ada log secret/apikey/signature di `payments/*` (grep nihil).
- **No-op tanpa creds:** poller idle bila creds kosong (`:356-358`), tak crash-loop.

## H. Jobs / Scheduler ✅
- `autoCancelExpiredOrders` membungkus tiap order di `prisma.$transaction(cancelOrder)` (`jobs/index.ts:49`) — transaksi pendek; cancel hanya bila masih PENDING (cek transisi state di `cancelOrder`). Notifikasi user try/catch (gagal kirim ≠ batal cancel). **B16-04**: asumsi single-instance.

## I. Resilience ✅
- `bot.catch` (`main.ts:116-142`): correlation `ref` ke user + log; user dapat `error.generic_ref` (**tak bocor stack/secret**); never rethrow; best-effort reply dibungkus try/catch. **B16-02**: log menyertakan teks pesan user (terpotong) — redaksi disarankan.
- Watchdog poller alert admin bila macet (Phase 10).

## J. State / Session Integrity ✅
- Otorisasi admin pakai `isAdmin(id)` runtime, **bukan** snapshot `session.dbUser` → tak ada otorisasi basi.
- Keputusan uang dibaca ulang di dalam `$transaction` (bukan dari saldo string di session).

---

## Kepatuhan Kontrak UX CLAUDE.md
| Aturan | Status |
|---|---|
| Edit bubble, bukan toast | ✅ smartEdit/adminEdit |
| Satu keyboard aktif per chat | ✅ retireKeyboard |
| Wizard single-bubble + consumeInput | ✅ anchor + consume transien saja |
| Free-text bernilai-record tidak dihapus (TxID/support/review) | ✅ |
| Toast (sukses) vs alert (error/destruktif) | ✅ show_alert pada admin_only/stale |
| Never strand the user | ✅ keyboard navigasi di layar terminal |
| No leaked English (customer-facing) | ✅ via t(); paritas 517/517 |
| Web tak pernah kirim Telegram | ✅ (lihat Phase 1) |
| Jangan log secret | ✅ payments bersih · ⚠️ B16-02 teks pesan user |
| Money Decimal | ✅ (match deposit pakai tolerance, by design) |
| Audit state change (logAdminAction) | ✅ (lihat Phase 10) |

## Paritas i18n EN/ID
**Lulus sempurna** — 517 kunci identik, 0 placeholder mismatch.

## Risiko Pembayaran & Konkurensi
| Skenario | Status |
|---|---|
| Dua order jumlah sama → salah kredit | ✅ ditolak (matchByAmount null) |
| Poll/webhook ganda satu TxID | ✅ dedup (processedBinanceTx unique) |
| Auto-cancel vs paid (race expired/confirm) | ✅ cancel hanya bila PENDING dlm transaksi |
| Double-tap approve/cancel | ✅ admin.processing buttonless (Phase verifikasi UX) |
| Equal-total tanpa USE_UNIQUE_CENTS | ⚠️ auto-confirm degrade (refuse, bukan mis-deliver) + warn boot |

> Read-only — tidak ada perubahan kode. Diringkas bersama fase lain oleh Phase 15.
