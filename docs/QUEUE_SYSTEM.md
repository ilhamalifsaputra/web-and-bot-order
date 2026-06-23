# Sistem Antrian (`notification_outbox`)

**Bukan Redis, bukan BullMQ/Sidekiq.** Antrian adalah satu tabel SQLite
(`NotificationOutbox` / `notification_outbox`), diisi oleh request
handler/poller mana pun yang perlu mengirim Telegram, dikonsumsi oleh satu
loop polling in-process (`packages/outbox-dispatcher`). Pola ini dipilih
karena **web tidak pernah boleh memanggil Telegram langsung**
([`../CLAUDE.md`](../CLAUDE.md) "Never send Telegram from the web") — admin
panel & storefront hanya menulis baris ke tabel ini; bot/dispatcher
(proses yang punya koneksi Telegram) yang mengirim.

## Skema kolom

| Kolom | Tipe | Fungsi |
|---|---|---|
| `event` | string | `ORDER_DELIVERED`, `ORDER_DELIVERED_DM`, `ADMIN_OVERPAID`, `ADMIN_PW_RESET` |
| `payloadJson` | string (JSON) | Data event — **tidak pernah** berisi kredensial (dibaca live dari DB saat kirim) |
| `orderId` | int? | Tautan ke order (null untuk `ADMIN_PW_RESET`) |
| `status` | string | `PENDING` → `SENDING` → `SENT`/`FAILED` |
| `attempts` | int | Hitungan percobaan kirim |
| `claimedAt` | datetime? | Kapan baris diklaim `SENDING` (gerbang anti-double-send) |
| `nextRetryAt` | datetime? | Backoff eksponensial — baris tidak claimable sampai waktu ini lewat |

## Enqueue

```ts
await enqueueNotification(tx, NotificationEvent.ORDER_DELIVERED_DM, orderId, {
  chat_id: Number(user.telegramId), order_code: order.orderCode, ...
});
```

**Wajib pakai `tx` (transaction client) yang sama** dengan mutasi bisnis
yang memicunya — baris outbox harus landing atomik bersama perubahan state
(mis. order jadi `DELIVERED`), bukan di transaksi terpisah yang bisa gagal
sendiri.

## Klaim atomik sebelum kirim (anti double-send)

```ts
export async function claimNotification(db, notifId, now = new Date()) {
  const staleCutoff = new Date(now.getTime() - STALE_CLAIM_MS); // 5 menit
  const res = await db.notificationOutbox.updateMany({
    where: { id: notifId, ...claimableWhere(staleCutoff, now) },
    data: { status: "SENDING", claimedAt: now },
  });
  return res.count === 1;
}
```

`claimableWhere` mendefinisikan baris yang boleh diambil: `PENDING`, ATAU
`SENDING` yang `claimedAt` lebih lama dari `STALE_CLAIM_MS` (5 menit —
dispatcher yang mengklaimnya dianggap mati di tengah kirim). Dipanggil
**sebelum setiap percobaan kirim** di `dispatcher.ts`; gagal klaim → baris
dilewati (sudah diambil instance lain, atau belum basi).

Ini menutup *crash-window*: jika proses mati tepat antara "kirim ke Telegram"
dan "tandai SENT", baris tetap `SENDING` (bukan balik ke `PENDING`) sehingga
**tidak** terkirim ulang di tick berikutnya — hanya jadi claimable lagi
setelah 5 menit (Infra-2 fix, audit keamanan 2026-06-23).

## Backoff eksponensial (anti head-of-line blocking)

```ts
export function notificationBackoffMs(attempts: number): number {
  return Math.min(NOTIF_RETRY_BASE_MS * 2 ** (attempts - 1), NOTIF_RETRY_MAX_MS);
  // basis 30s, dobel per attempt, dibatasi 10 menit
}
```

Tanpa ini, baris yang terus gagal (chat_id rusak, payload cacat) akan
menempati slot teratas batch (`orderBy createdAt ASC`) setiap tick sampai
`maxAttempts`, menunda baris valid di belakangnya. `markNotificationFailed`
men-set `nextRetryAt` saat baris balik ke `PENDING` (bukan saat `FAILED` —
status terminal tidak butuh retry window). `retryNotification` (tombol Retry
admin di `/outbox`) **menghapus** `nextRetryAt` — klik admin berarti
"sekarang", bukan "tunggu sisa window backoff" (Infra-3 fix, audit 2026-06-23).

## Loop dispatcher

```ts
export async function runDispatcher(bot, signal?) {
  while (!signal?.aborted) {
    await drainBatch(bot);                              // catch internal, tidak crash loop
    await sleep(config.NOTIF_POLL_INTERVAL_SECONDS * 1000);  // default 10s
  }
}
```

`drainBatch` ambil maks 50 baris claimable per tick (`fetchPendingNotifications`),
proses satu per satu:

1. `claimNotification` — skip jika gagal.
2. Parse `payloadJson` — JSON rusak → `markNotificationFailed` dengan
   `maxAttempts=1` (langsung `FAILED`, tidak ada gunanya retry payload yang
   secara struktural rusak).
3. **`ORDER_DELIVERED_DM`** — jalur khusus: baca order LIVE dari DB
   (`getOrderByCodeFull`), bangun file `.txt` kredensial saat itu juga
   (`buildAccountFileContent`), kirim via `sendDocument`. Kredensial **tidak
   pernah** ada di `payloadJson` — hanya `chat_id`+`order_code`.
4. Event lain — render template teks (`render(event, payload)`), kirim via
   `sendMessage`.
5. Channel post (`ORDER_DELIVERED`) tanpa `PUBLIC_CHANNEL_ID` terkonfigurasi
   → `releaseNotificationClaim` (balik `PENDING` tanpa hitung attempt) —
   baris menunggu sampai admin set channel, bukan gagal permanen.

## Penanganan error per jenis

| Kondisi | Aksi |
|---|---|
| Sukses kirim | `markNotificationSent` — `status=SENT`, `claimedAt=null` |
| `GrammyError` dengan `retry_after` (flood control Telegram) | `sleep(retry_after+1)`, `releaseNotificationClaim` (BUKAN dihitung gagal — transient, bukan salah baris ini), **bailout tick** (baris sisanya tunggu tick berikutnya) |
| `GrammyError` 403 Forbidden (bot diblokir/bukan admin channel) | `markNotificationFailed` dengan `maxAttempts=1` — langsung `FAILED`, retry tidak akan membantu |
| Error lain | `markNotificationFailed` dengan `config.NOTIF_MAX_ATTEMPTS` (default 5) — backoff eksponensial sampai mencapai limit |

## Memantau & operasi manual

Panel admin **`/outbox`** (`apps/web-admin/src/routes/outbox.ts`) —
`listNotifications`/`outboxStatusCounts` untuk monitoring, tombol **Retry**
(`POST /outbox/:id/retry` → `retryNotification`) untuk requeue baris
`FAILED`/stuck: reset `attempts=0`, hapus `lastError`/`sentAt`/`nextRetryAt`,
`status=PENDING`.

## Kapan baris outbox tidak terkirim — diagnosis cepat

Lihat [TROUBLESHOOTING.md](TROUBLESHOOTING.md) untuk daftar gejala→fix,
termasuk kasus `P2022` yang ditemukan saat dokumentasi ini ditulis (kolom
`claimed_at`/`next_retry_at` hilang dari DB live karena `db push` belum
dijalankan ulang pasca-update skema).
