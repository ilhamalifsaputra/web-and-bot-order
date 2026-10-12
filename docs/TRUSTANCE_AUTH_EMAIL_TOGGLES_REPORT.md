# Audit dan implementasi Trustance: saklar, Telegram, email

Spec: `C:/Users/ilham/Downloads/trustance-admin-toggles-telegram-auth-email-events-full-implementation-v2.md`.
Branch: `worktree-auth-email-toggles`, baseline `aa2794f5`. Pelaksana awal bug: Astra high; mengikuti perubahan instruksi pengguna, kelanjutan implementasi dan audit menggunakan GPT-6.1 Sol high.

## Audit sebelum perubahan produk

| Area | File/fungsi aktual | Kondisi dan akar masalah | Dampak/risiko | Perubahan minimal dan tes |
|---|---|---|---|---|
| Telegram | `apps/storefront/client/src/lib/telegramOAuth.ts`, `apps/storefront/src/auth.ts` | Legacy OAuth langsung kembali ke GET server yang membaca query; fragment tidak terkirim melalui HTTP. | Login/link gagal; callback perlu state, expiry, replay dan redirect aman. | Adapter fragment menuju POST, verifikasi HMAC server, intent satu kali; tes valid/invalid/link/login. |
| Admin email | `packages/outbox-dispatcher/src/dispatcher.ts` | Wallet dan sebagian paid-order memakai shortcut `recordSent`, tanpa SMTP. | Status berhasil palsu. | Hapus shortcut EMAIL; `SENT` hanya setelah acceptance SMTP; tes send/skip/retry. |
| Customer email | `packages/db/src/crud/orders.ts`, `enqueueBuyerOrderReadyEmail` | Guard guest+guestEmail mengecualikan akun registered. | Pelanggan registered tidak mendapat receipt. | Resolver pemilik order+snapshot guest yang valid, alasan tanpa penerima, dedup; tes kedua keluarga produk dan registered/guest. |
| Test SMTP | `apps/web-admin/src/routes/api/settings.ts` | Test hanya `verifySmtp`. | UI menyamakan koneksi dengan pengiriman. | Pisahkan verify dan send nyata terbatas recipient admin, acceptance dan audit. |
| Setting boolean | `SettingsPage.tsx`, API settings dan runtime consumers | SMTP TLS, owner/email flags, FX auto, Digiflazz, Xendit logos, bulk broadcast masih FieldRow teks. | Salah ketik/default tak terlihat. | Metadata boolean server dan saklar bersama, payload boolean kompatibel penyimpanan Settings string; tes gagal-save/default/persist. |
| Form boolean | `AdditionalFieldsEditor.tsx`, `DeliveryTypeSection.tsx`, `StockProductPage.tsx`, `TicketDetailPage.tsx` | Required, buyer-info, restock broadcast, internal note memakai checkbox/radio. | Kontrol ON/OFF tidak konsisten. | Switch dengan label ON/OFF; menjaga reset field/family/optimistic rollback. |
| Template | `emailTemplates.ts`, `apiAuth.ts`, `BrandingPage.tsx` | Paid-order/reset copy editable dari Settings; renderer HTML/plaintext sudah ada. | Template tersebar/konfigurasi manual. | Copy terpusat source; hapus editor UI setelah cutover; simpan setting legacy. |
| Event policy | `ownerEmail.ts`, `notifications.ts` | Lima event owner memakai master+legacy per-event; satu completion customer. | Jangan memetakan received ke paid atau menyalakan event fiktif. | Registry 23 keys dan extension event existing; policy memakai default existing, event baru opsional OFF, mandatory reset ON. |
| Riwayat | Local database terisolasi | Tidak ada data produksi delapan/enam order yang dilaporkan. | Hitungan produksi tidak dapat dibuktikan di checkout lokal. | Helper rekonsiliasi read-only dan klasifikasi kandidat; tanpa resend/perubahan historis. |

## Inventory kontrol admin

- Settings FieldRow boolean: `usd_idr_rate_auto` (default ON), `smtp_secure` (fallback SMTP env), `owner_email_enabled`, `owner_email_on_paid_order`, `owner_email_on_manual_queue`, `owner_email_on_new_ticket`, `owner_email_on_ticket_reply`, `owner_email_on_wallet_topup`, `xendit_qris_enabled`, `xendit_card_enabled`, `bulk_purchase_broadcast_enabled`, `digiflazz_enabled` (default ON).
- Sudah Switch: service bot/web, tujuh payment rail, kategori/product/denomination active. Tetap boolean; health konfigurasi terpisah.
- Checkbox setting: additional field `required`, product `broadcastOnRestock`, ticket internal-note mode. Radio boolean buyer-info required dikonversi.
- Tetap checkbox: table/bulk selection, voucher product multi-selection, pilihan unit order, filter archived/deleted. Tetap radio/select enum: checkout flow, delivery method, supplier, pricing mode.
- Tidak ada tristate setting yang dikonversi. Nilai kosong FX/Digiflazz adalah fallback ON, SMTP mengikuti env; kosong OFF pada owner/bulk flags.
- Security 2FA adalah wizard enable/disable dengan kredensial dan konfirmasi, bukan checkbox setting biasa; flow keamanan dipertahankan.

## Keputusan kompatibilitas

- Akun Telegram tetap lookup-only sesuai kebijakan signup existing. Sesi pertama melalui web untuk pengguna bot yang sudah terdaftar didukung; Telegram ID yang belum terdaftar tetap ditolak dengan petunjuk aman.
- Tidak ada migrasi skema/destructive drop yang direncanakan. Settings menyimpan string legacy; API dan UI saklar memakai boolean terstruktur.
- `FAILED` + kode skip yang aman adalah outcome terminal tanpa send pada enum existing; `SENT` berarti SMTP accepted saja.
- Saklar OFF diperiksa kembali sebelum dispatch, termasuk job lama yang belum terkirim. Mandatory password reset tetap ON.
- Dokumen konten `trustance-email-templates-p0-p2.md` tidak tersedia di repo/Downloads; pengguna menunjuk kembali spesifikasi v2. Semua 23 key mengikuti matriks v2, dengan copy faktual terpusat di source. Event yang semula belum ada dibangun dengan producer dan pipeline nyata; tidak ada placeholder unavailable.

## Validasi dan hasil

Baseline: install frozen lockfile, Prisma generate, build kedua SPA berhasil; database lokal baru pada port 55459 berhasil `db push --skip-generate`.
Verifikasi terarah, build dan runtime di bawah sudah dijalankan; full gate setelah sinkronisasi branch masih berlangsung. Angka tes per command tidak dijumlahkan sebagai total unik.

- `pnpm exec vitest run packages/db/src/crud/emailEvents.test.ts packages/db/src/crud/support.test.ts packages/outbox-dispatcher/src/emailEvents.integration.test.ts`: 235 tes lulus sebelum penambahan regresi audit terakhir. Setiap 23 key diuji transport acceptance, dedup, dispatch OFF, penerima kosong, SMTP transient/retry dan permanent rejection.
- `pnpm exec vitest run apps/web-admin/test/email-notifications-api.test.ts`: 4 lulus; RBAC, CSRF, boolean/persistence, reset wajib, jadwal, marker aktivasi idempoten, threshold dan supplier exclusion.
- `pnpm exec vitest run apps/web-admin/client/src/pages/BrandingPage.test.tsx apps/web-admin/client/src/pages/EmailNotificationsPage.test.tsx apps/web-admin/client/src/components/shared/StockEmailThresholds.test.tsx`: 17 lulus; tes diagnostics tambahan lulus terpisah.
- Package typecheck enam backend lulus; pemeriksaan lengkap workspace dan tipe tes dicatat setelah gate akhir.
- `pnpm -r build`: lulus untuk seluruh workspace. Peringatan ukuran bundle/import dinamis Vite existing tetap ada.
- Storefront lint dan `pnpm doctor:changed`: lulus, changed scan 30 file.
- `pnpm doctor:bugs`: 628 file, tidak ada temuan.
- `pnpm doctor:full`: **628 file, 12.7 detik, 0 errors / 0 warnings**. Diagnostics `react-doctor-5a5ec21e-4a31-48e6-8e7c-abeaed16d916` di direktori temporary Windows; tidak ada suppression/exclusion/rule disable baru.
- `pnpm exec tsx .local/auth-email-smoke.mts`: browser Chromium memakai bundle produksi dan API fixture lokal, 23 switch, recovery locked ON, keyboard Space, refresh persistence, rollback save gagal, tanpa overflow pada viewport 390px, screenshot desktop/mobile dan 0 page errors. Ini bukti runtime UI lokal, bukan bukti email produksi. Server smoke langsung ditutup setelah tes.

## Matriks 23 event

Semua baris memakai registry source `packages/core/src/email/registry.ts`, renderer HTML/plaintext terpusat (receipt dan recovery memakai renderer khusus), per-event policy, durable `notification_outbox`, dedup persisten dan worker SMTP. `emailEvents.integration.test.ts` menguji seluruh 23 key melalui worker; `registry.test.ts` menguji escaping dan field opsional untuk seluruh key. Producer diuji melalui lifecycle nyata di `emailEvents.test.ts`, suite domain dan auth, bukan hanya pemanggilan registry.

| Event | Producer / fakta bisnis | Prasyarat dan penerima | Kebijakan default |
|---|---|---|---|
| order.received.customer | `createOrderDirect`, `createOrderFromCart` setelah order tersimpan | Web/bot, akun atau guest yang memiliki email | OFF baru |
| order.received.admin | Producer order yang sama; tidak menyatakan paid | Owner email tervalidasi | OFF baru |
| payment.confirmed.customer | `approveOrder` / `settlePaidOrder` setelah payment tervalidasi; ADMIN_OVERRIDE dikecualikan | Pemilik order dengan email | OFF baru |
| order.completed.customer | Fulfillment auto/manual/Digiflazz yang benar-benar selesai; mapping `BUYER_EMAIL_ORDER_READY` | Lookup email akun privat atau guest; tanpa credential produk | ON sesuai receipt existing |
| order.failed.customer | Terminal FAILED/REJECTED dan callback Digiflazz final | Pemilik order; pending tidak memicu | OFF baru |
| order.failed.admin | Transisi terminal yang sama | Owner email | OFF baru |
| inventory.sku.critical | Stock ledger, crossing dari normal ke critical | SKU finite lokal, threshold per denomination, serialisasi dan episode | OFF baru |
| inventory.sku.out_of_stock | Available benar-benar turun ke nol | Supplier Digiflazz tidak dianggap finite | OFF baru |
| account.password_reset.requested | `/auth/forgot`: token dan outbox dalam satu transaksi | Hanya akun password; URL reset dienkripsi at rest; token single-use | Wajib ON |
| payment.expired.customer | Expiry cancellation dari invoice pending/unpaid dengan deadline elapsed | Serialisasi paid race; cancellation biasa tidak dipalsukan menjadi expiry | OFF baru |
| payment.underpaid.customer | `markOrderUnderpaid` setelah bukti jumlah payment | Pemilik order, dedup transisi | OFF baru |
| payment.underpaid.admin | Transisi underpayment yang sama | Owner email | OFF baru |
| refund.initiated.customer | Refund masuk PROCESSING | Workflow refund existing, tidak mengklaim payout | OFF baru |
| refund.completed.customer | Refund execution atau refund underpayment yang benar-benar mengkredit wallet | Jumlah/currency payout aktual; mark COMPLETED tanpa evidence tidak memicu | OFF baru |
| inventory.sku.restocked | Recovery episode stok melewati recovery threshold | Hysteresis, tidak satu email tiap unit/import | OFF baru |
| support.ticket.created.admin | `createTicket` transaksi ticket + outbox | Owner email, legacy toggle dipertahankan | Mengikuti legacy |
| support.ticket.created.customer | Ticket berhasil dibuat | Pemilik ticket saja | OFF baru |
| support.ticket.replied.customer | Pesan ADMIN non-internal tersimpan | Reply user/internal tidak memicu; tanpa menyalin isi sensitif | OFF baru |
| security.login.suspicious | 5 verifikasi password gagal dalam 10 menit | Akun password, counter persisten, cooldown 1 jam | OFF baru |
| security.password.changed | Hash password existing benar-benar berubah | Signup/set password pertama tidak dianggap perubahan | OFF baru |
| provider.incident.opened | 3 operasi provider gagal dalam 10 menit | Aggregation persistent, cooldown 1 jam, success menutup episode | OFF baru |
| report.daily_sales_inventory | Worker maintenance per menit, periode harian tertutup | Timezone/jam di admin; activation marker cegah backfill | OFF baru |
| report.weekly_revenue | Worker maintenance, minggu kalender tertutup | Weekday/jam terpisah, dedup periode; IDR/USDT tidak dicampur | OFF baru |

Extension paid-owner/manual-queue/ticket-user-reply/wallet-topup tetap terpisah dari 23 key agar semantik lama dan default toko tidak berubah. Saklar legacy tetap tersedia di Settings. Recipient yang tidak valid menghasilkan outcome `SKIPPED_NO_RECIPIENT` (legacy dispatch `NO_RECIPIENT`); OFF menghasilkan `SKIPPED_DISABLED`. Enum schema existing memakai `FAILED` untuk terminal skip dan kode alasan eksplisit, tidak menyamar sebagai `SENT`.

## Detail perubahan dan hasil audit lanjutan

- `SettingsToggle` membungkus Radix Switch existing dengan label, ON/OFF, deskripsi, pending/disabled reason dan ARIA. Metadata boolean API mempertahankan fallback runtime; penyimpanan Settings string legacy tetap kompatibel. Multi-select, table selection, consent dan enum tidak diubah menjadi saklar.
- Email Notifications memisahkan preference dari readiness SMTP, memiliki jadwal report dan diagnostics read-only. Threshold stok tersimpan per SKU. Branding mempertahankan brand color/support; editor copy paid/reset digantikan link event setelah renderer source cutover. Nilai template legacy tidak dihapus dari storage.
- Legacy Telegram callback fragment diproses sebelum React mount, dibersihkan dari history, kemudian diverifikasi server dengan HMAC, timestamp, browser intent/state dan replay guard DB. GET query kompatibel tetap memakai verifier yang sama. Login/link mempertahankan lookup-only signup policy existing; akun Telegram yang belum ada tidak dibuat diam-diam. Callback menghindari open redirect dan tidak memasukkan hash/state ke login next URL.
- `sendMail` memeriksa recipient SMTP accepted dan menghasilkan timestamp/message ID aman. Dispatcher menyimpan evidence bersamaan dengan status; error dikategorikan tanpa secret. Jalur EMAIL fake SENT dihapus. Worker email berjalan walaupun bot tidak dikonfigurasi; antrian Telegram tidak mengambil jatah batch email-only.
- Send Test Email berbeda dari koneksi `verify()`, hanya ke owner email tersimpan, memakai RBAC/CSRF/cooldown DB, audit, dan acceptance. Tidak ada pengiriman live dalam verifikasi otomatis.
- Helper completion membaca email akun langsung untuk kebutuhan pengiriman, tanpa menambah email ke order JSON admin. Tidak ada password, deliveredContent atau stock credential dalam receipt.
- Audit concurrency memperbaiki FK lock upgrade pada stok, retry collision nomor ticket, state counter security/provider serta serialisasi expiry/payment. Cooldown dan report cursor survive restart.
- Outbox admin menunjukkan recipient masked, safe error, attempts, waktu dan acceptance. Historical SENT tanpa evidence ditandai unverified dan tidak ditafsirkan gagal/berhasil inbox. Retry SENT ditolak agar tidak terjadi resend historis tak sengaja.

## Rekonsiliasi riwayat dan batas bukti

Checkout lokal menggunakan database baru terisolasi; delapan order dan enam receipt produksi yang dilaporkan pengguna tidak tersedia untuk dihitung ulang. `pnpm exec tsx scripts/audit-email-delivery.ts` menghasilkan agregat read-only dari database yang sengaja dikonfigurasi operator: inspected, SMTP evidence, historical sent-without-evidence, kandidat shortcut legacy, penerima tidak valid dan delapan order terbaru tanpa email. Kandidat shortcut bersifat advisory, bukan bukti pasti tidak terkirim. Tidak ada resend atau perubahan status historis otomatis. Local mocked SMTP membuktikan jalur aplikasi dan acceptance handling; pengiriman/inbox produksi belum diverifikasi.

## Database, deployment dan rollback

Tidak ada perubahan Prisma schema/migrasi, dependency atau infrastruktur produksi baru. Settings menggunakan key additive; unique outbox dedupe existing mempertahankan idempotency. Docker PostgreSQL port 55459 hanya untuk worktree ini; bot poller tidak dijalankan selama verifikasi.

1. Backup aplikasi/config dan metadata outbox sesuai prosedur deployment existing. Pause worker sebelum cutover supaya worker lama tidak memproses event canonical baru yang belum dikenalnya.
2. Deploy aplikasi/API, bundle kedua SPA dan worker dari revisi yang sama. Schema existing tetap kompatibel; jalankan prosedur generate/build/restart existing. Aktifkan worker email dan maintenance hanya sekali per deployment yang dimaksud.
3. Verifikasi SMTP configuration/owner recipient, lakukan Test Connection, lalu Send Test Email ke owner yang diizinkan. Periksa acceptance dan provider logs/inbox secara manual.
4. Aktifkan event baru satu per satu sesuai kebutuhan. Reports memulai dari aktivasi; tidak backfill history. Atur threshold hanya pada stok finite lokal.
5. Rollback: pause worker, OFF event canonical baru, deploy seluruh versi sebelumnya bersama bundle, resume worker lama setelah memastikan tidak memproses pending event baru secara tidak didukung. Jangan drop settings atau requeue historis otomatis; evaluasi pending canonical rows secara read-only sebelum tindakan admin terpisah.

## Checklist manual operator

- Login Telegram via fragment, ulangi callback (harus ditolak), coba external next (harus internal safe fallback); coba link saat logout tanpa hash/state tertinggal di URL login.
- Ubah boolean, refresh, pastikan persisted; uji keyboard dan role yang tidak berwenang.
- Send Test Email ke owner, cocokkan evidence SMTP; verifikasi inbox terpisah bila diperlukan.
- Buat order test registered/guest untuk tiap keluarga produk, pastikan received tidak paid, paid tidak completed, receipt tanpa credential; user tanpa email tercatat skip.
- Ulangi callback/scheduler dan pastikan tidak ada target duplikat; matikan event pending dan pastikan tidak dikirim.
- Coba SKU finite crossing critical/nol/recovery; supplier tanpa stok lokal tidak menghasilkan alert tersebut.
- Jalankan refund test berizin, ticket create/admin reply/internal note dan password recovery/change pada akun test.
- Buka Email Notifications diagnostics dan Outbox; tidak ada email penuh/token/auth hash/credential; historical unverified tetap jujur.


Review akhir menambahkan preview render-only per 23 event, tanpa token/outbox/send, memakai renderer source yang sama untuk recovery/receipt dan renderer event untuk lainnya. Tes preview UI/API/renderer: 59 lulus; Outbox safe error guidance: 10 lulus. Backend audit tambahan: 366 lulus pada enam file dan 10 tes Digiflazz terarah. Respons provider valid Gagal/Pending tidak dipalsukan menjadi outage.
