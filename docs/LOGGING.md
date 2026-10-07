# Logging

Project ini punya dua jenis "log" yang sangat berbeda audiensnya. Aturan
penulisannya **beda untuk masing-masing** — jangan pakai gaya yang sama
untuk keduanya.

| | Audit log (`logAdminAction`) | Log Pino (`logger.*`) |
|---|---|---|
| Pembaca | Admin toko (orang awam, non-teknis), lewat halaman `/audit` di web-admin | Developer/ops, lewat output server/file log |
| Tempat kode | `packages/db/src/crud/audit.ts` | `packages/core/src/logger.ts` |
| Gaya | Kalimat utuh berbahasa manusia | Kalimat deskriptif, tetap teknis, berbahasa Inggris |
| Contoh buruk | `"added=150 parse_skipped=2 dedup_skipped=1"` | `"admin_command: user=123 via=cb"` |
| Contoh baik | `"Added 150 items; skipped 2 invalid lines and 1 duplicate."` | `"Admin command from user 123 via a callback button"` |

Lihat juga aturan **"Never log secrets"** di
[`../.claude/CLAUDE.md`](../.claude/CLAUDE.md)
("Never do") — kredensial, `file_id` bukti bayar, hash password, dan DB URL
lengkap tidak boleh masuk ke `details` audit log maupun ke pesan Pino,
keduanya.

## 1. Audit log — kalimat untuk admin toko

`logAdminAction(db, { adminId, action, targetType, targetId, details })`
menulis satu baris ke tabel `auditLog`. Halaman `/audit` (React
`AuditPage.tsx`, data dari `apps/web-admin/src/routes/api/audit.ts`)
menampilkan `details` **mentah, tanpa parsing** — jadi satu-satunya cara
membuatnya terbaca adalah menulis kalimat yang benar dari awal di setiap
titik pemanggilan, bukan memformat ulang di komponen.

**Aturan:**
1. Tulis kalimat pendek yang utuh (diawali huruf kapital, diakhiri titik),
   bukan potongan field.
2. Sebutkan hasil/akibatnya dulu, baru angka-angka pendukung — jangan
   memimpin dengan nama field (`added=`, `count=`, dst).
3. Angka tetap angka dalam kalimat ("150 item", "2 gagal"), bukan
   `key=value`.
4. **Jangan pernah** menyisipkan daftar id/nama yang dipotong
   (`.slice(0, N)`) ke dalam kalimat — ringkas jadi jumlah saja. Kolom
   `details` di `AuditPage.tsx` di-`truncate` pada `max-w-[320px]` (teks
   penuh hanya muncul lewat tooltip `title` saat hover; tampilan kartu
   mobile pakai `break-words`), jadi string panjang tak pernah terlihat
   utuh dan makin tidak terbaca.
5. Nama/key yang berasal dari input user boleh diberi tanda kutip ganda
   agar mudah dipindai: `Changed setting "MAINTENANCE_MODE".`
6. Tetap singkat — satu kalimat. Detail yang hanya berguna untuk developer
   (bukan untuk admin toko) tidak perlu masuk ke `details`; itu urusan log
   Pino.
7. Untuk titik panggil yang sebelumnya hanya melempar satu variabel mentah
   (`details: key`, `details: reason`), bungkus jadi kalimat juga, kecuali
   variabel itu memang sudah berbunyi seperti klausa lengkap.

**Sebelum / sesudah:**

| Aksi | Sebelum | Sesudah |
|---|---|---|
| `stock_upload` | `` `added=${n} parse_skipped=${skippedCount} dedup_skipped=${skipped}` `` | `` `Added ${n} items; skipped ${skippedCount} invalid lines and ${skipped} duplicates.` `` |
| `broadcast` | `` `sent=${sent} failed=${failed}` `` | `` `Broadcast sent to ${sent} users${failed ? ` (${failed} failed to deliver)` : ""}.` `` |
| `voucher_create` | `` `code=${code} type=${vtype} value=${value} limit=${limit}` `` | `` `Created voucher "${code}" (${vtype}, value ${value}, limit ${limit}).` `` |
| `product_bulk_active` (daftar id terpotong) | `` `is_active=${isActive} count=${count} ids=${ids.join("|").slice(0,180)}` `` | `` `${isActive ? "Activated" : "Deactivated"} ${count} products.` `` |
| `setting_set` (variabel mentah) | `details: key` | `` `Changed setting "${key}" to "${displayValue}".` `` |

Jangan terlalu pusingkan tata bahasa singular/plural ("1 items" tetap
boleh) — yang penting konsisten dan jelas, bukan gramatikal sempurna.

`action` (mis. `stock_upload`, `broadcast`) **tidak diubah** — field ini
dipakai filter `replace('_', ' ') | title` di kolom Action, jadi harus
tetap snake_case.

## 2. Log Pino — pesan deskriptif untuk developer/ops

`packages/core/src/logger.ts` adalah instance Pino tunggal (di-tag
`updateId` lewat `AsyncLocalStorage` saat memproses update Telegram). Log
ini **tidak pernah dilihat admin toko** — tetap berbahasa Inggris, tapi
harus ditulis selengkap mungkin sehingga seseorang yang baru baca log (tanpa
membuka kode di sekitarnya) tetap mengerti apa yang terjadi dan kenapa itu
penting.

**Aturan:**
1. Sebutkan dulu apa yang terjadi; untuk `warn`/`error`, lanjutkan dengan
   kenapa itu penting atau apa langkah berikutnya, disambung dengan tanda
   pisah em dash `—` (gaya yang sudah ada di beberapa pesan terbaik di repo
   ini, lihat contoh "Sudah baik" di bawah).
2. Jabarkan singkatan internal saat pertama disebut dalam pesan: `cb`/`cmd`
   → "a callback button"/"a typed command"; `idx` → sebut apa yang
   diindeks; `tx` → "transfer"/"transaction" sesuai konteks.
3. ID/kode boleh tetap ada kalau membantu manusia menemukan record-nya
   (`order ${order.orderCode}`), tapi jangan memimpin kalimat dengan
   `id=${x}` mentah — sebut dulu entitasnya, baru id-nya.
4. **Jangan ubah** argumen objek metadata terstruktur (`{ err, id }` pada
   `logger.info({ ... }, "pesan")`) — hanya string pesan di depan yang
   diubah.
5. **Jangan ubah** level log (`info`/`warn`/`error`/`debug`/`fatal`) — itu
   perubahan perilaku, di luar cakupan penulisan ulang ini.
6. Jangan menyisipkan daftar id/nama yang dipotong (`.slice(0, N)`) ke
   pesan — sama seperti aturan audit log, ringkas jadi jumlah.

**Sebelum / sesudah:**

| Lokasi | Sebelum | Sesudah |
|---|---|---|
| `apps/order-bot/src/handlers/admin.ts` | `` `admin_command: user=${ctx.from?.id} via=${ctx.callbackQuery ? "cb" : "cmd"}` `` | `` `Admin command from user ${ctx.from?.id} via ${ctx.callbackQuery ? "a callback button" : "a typed command"}` `` |
| `packages/outbox-dispatcher/src/dispatcher.ts` | `` `Sent notif id=${row.id} event=${row.event}` `` | `` `Sent notification ${row.id} (${row.event}) to Telegram` `` |
| `apps/order-bot/src/payments/binanceInternal.ts` | `` `Unmatched transfer tx=${tx.txId} note=${tx.note} amount=${tx.amount}` `` | `` `No pending order matched Binance transfer ${tx.txId} (note: "${tx.note}", amount: ${tx.amount}) — left for manual review` `` |
| `apps/order-bot/src/jobs/index.ts` | `"Reconciliation: clean (no drift)"` | `"Payment reconciliation finished — all checked orders matched, no drift found"` |

**Contoh yang sudah baik** (jadikan kalibrasi gaya, jangan ditulis ulang):
- `apps/server/src/index.ts` — `"Bot token not configured — web serves, bot is OFF (Settings → bot token, then restart)"`
- `apps/order-bot/src/payments/binanceInternal.ts` — `` `Binance rate-limited (hit #${hitCount}) — backing off ${delayMs}ms` ``
- `apps/order-bot/src/payments/bybitDeposit.ts` — `"Bybit deposit auto-confirm is enabled but USE_UNIQUE_CENTS is OFF — refusing to match deposits by amount this cycle. Set USE_UNIQUE_CENTS=1."`

## Digiflazz timing events

Satu order Digiflazz yang sudah dibayar meninggalkan jejak log Pino
terstruktur dari pembayaran sampai selesai. Setiap baris adalah
`logger.info({ event, ... }, "<kalimat Inggris lengkap>")`, jadi bisa
di-grep per event (`"event":"order.completed"`) atau per order
(`"orderCode":"ORD-..."`). Kontrak nama field ada di satu tempat:
`packages/core/src/suppliers/digiflazzTiming.ts` (`DigiflazzTimingEvent`,
tipe `*Fields`, `elapsedMs`, `logDigiflazzTimingEvent`). Semua event juga
membawa `orderId` dan `orderCode`.

| Event | Dari mana | Field tambahan |
|---|---|---|
| `payment.confirmed` | `settlePaidOrder` (orders.ts), cabang Digiflazz → PROCESSING | `paymentMethod`, `currency`, `paidAt` (ISO UTC), `fulfillmentProvider` |
| `fulfillment.claimed` | `processDigiflazzOrder` setelah menang klaim atomik | `trigger` (`direct` = instant dispatch setelah bayar, `cron` = recovery cron 5 detik), `claimKind` (`fresh`/`recheck`), `attempt`, `delayFromPaymentMs` = waktu klaim − `paidAt` |
| `digiflazz.request` | tepat sebelum `createTransaction` | `refId` (= order code), `skuCode`, `attempt` |
| `digiflazz.response` | tepat sesudah `createTransaction` | `refId`, `status` (`Sukses`/`Pending`/`Gagal`/`error`), `durationMs`; untuk `error`: `errorKind` (`timeout`, `network`, `http_5xx`, `http_429`, `http_4xx`, `unparseable`, `rejected` = balasan 2xx tanpa data transaksi, atau `unknown`) dan `retryable` (apakah ref id yang sama akan dicoba lagi: selalu `true` untuk recheck; pada dispatch pertama hanya `http_4xx` yang `false` dan langsung jadi gagal final untuk admin) |
| `digiflazz.webhook_received` | webhook storefront, **hanya setelah signature valid** dan ref cocok dengan order | `refId` (yang sudah terverifikasi), `callbackStatus`, `msSinceDispatch` = waktu terima − `digiflazzDispatchedAt` |
| `order.completed` | `fulfillDigiflazzOrder` setelah commit DELIVERED (Sukses), atau dispatcher saat order gagal final (Gagal) | `outcome`, `paymentToFulfillmentMs`, `digiflazzApiDurationMs`, `digiflazzPendingDurationMs`, `paymentToCompletionMs` |

Durasi `order.completed`, semuanya dari kolom yang sudah ada (tanpa
perubahan skema):
- `paymentToFulfillmentMs` = `digiflazzDispatchedAt` (dispatch pertama) − `paidAt`
- `digiflazzApiDurationMs` = lama panggilan `createTransaction` yang
  menghasilkan outcome ini (tidak ada kalau Sukses datang lewat webhook)
- `digiflazzPendingDurationMs` = waktu selesai (`deliveredAt`) − dispatch pertama
- `paymentToCompletionMs` = waktu selesai − `paidAt`
  (= `paymentToFulfillmentMs` + `digiflazzPendingDurationMs`)

Field yang titik awalnya tidak ada (order lama tanpa `paidAt`) **dihilangkan**,
bukan ditulis 0. `logDigiflazzTimingEvent` tidak pernah melempar error —
logger yang rusak tidak boleh mengganggu dispatch atau pembayaran. Jangan
pernah menambahkan API key, signature, webhook secret, body request/webhook,
atau data pemain ke field ini.

**Contoh: order yang Sukses di request pertama.**

```
payment.confirmed    paidAt 10:00:00.000
fulfillment.claimed  trigger direct, claimKind fresh, attempt 1, delayFromPaymentMs 180
digiflazz.request    refId ORD-AB12CD, skuCode ml86, attempt 1
digiflazz.response   status Sukses, durationMs 1240
order.completed      outcome Sukses, paymentToFulfillmentMs 180, digiflazzApiDurationMs 1240,
                     digiflazzPendingDurationMs 1275, paymentToCompletionMs 1455
```

Dibaca sebagai:

| Tahap | Waktu | Sumber |
|---|---|---|
| Payment confirmation | 0 ms | `paidAt` (titik nol) |
| Fulfillment dispatch | 180 ms | `paymentToFulfillmentMs` |
| Digiflazz API | 1.240 ms | `digiflazzApiDurationMs` |
| Provider processing | 35 ms | `digiflazzPendingDurationMs` − `digiflazzApiDurationMs` (di sini cuma tulis DB setelah jawaban) |
| **Total** | **1.455 ms** | `paymentToCompletionMs` |

Kalau Digiflazz menjawab `Pending` dulu, `digiflazzPendingDurationMs` memuat
seluruh waktu tunggu di supplier (mis. 41.300 ms sampai webhook/recheck
melaporkan Sukses), dan `digiflazz.webhook_received` menunjukkan kapan
callback-nya datang (`msSinceDispatch`). Fulfillment dispatch yang besar
(detik, bukan ratusan ms) dengan `trigger: "cron"` berarti instant dispatch
tidak jalan dan order diambil oleh recovery cron.

## 3. Checklist singkat sebelum commit

- [ ] Apakah ini `logAdminAction` (admin toko) atau `logger.*` (Pino)? Pakai
  aturan yang sesuai bagiannya.
- [ ] Kalimat menyebutkan apa yang terjadi, bukan cuma dump nama field.
- [ ] Tidak ada daftar id/nama yang dipotong ditempel ke string.
- [ ] Untuk warn/error: ada penjelasan kenapa penting / langkah selanjutnya.
- [ ] Tidak ada singkatan internal tanpa penjelasan (`cb`, `cmd`, `idx`, `tx`, dst).
- [ ] Tidak ada secret (kredensial, `file_id`, hash password, DB URL) di
  dalam string log.

## Di mana kode-nya

- Penulis audit log: `packages/db/src/crud/audit.ts` (`logAdminAction`,
  `listAuditLogs`, `countAuditLogs`).
- Tampilan audit log: `apps/web-admin/client/src/pages/AuditPage.tsx` +
  `apps/web-admin/src/routes/api/audit.ts` (render `details` mentah, tanpa
  parsing apa pun — jangan menambah logic parsing di sini, perbaiki di
  titik panggilnya).
- Instance Pino: `packages/core/src/logger.ts`.
