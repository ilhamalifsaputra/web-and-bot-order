# Audit dan implementasi Trustance: saklar, Telegram, email

Spec: `C:/Users/ilham/Downloads/trustance-admin-toggles-telegram-auth-email-events-full-implementation-v2.md`.
Branch: `worktree-auth-email-toggles`, baseline `aa2794f5`. Pelaksana awal bug: Astra high; mengikuti perubahan instruksi pengguna, kelanjutan implementasi dan audit menggunakan GPT-6.1 Sol high.

## Audit sebelum perubahan produk

| Area | File/fungsi aktual | Kondisi dan akar masalah | Dampak/risiko | Perubahan minimal dan tes |
|---|---|---|---|---|
| Telegram | `apps/storefront/client/src/lib/telegramOAuth.ts`, `apps/storefront/src/routes/auth.ts`, verifier `apps/storefront/src/auth.ts` | Legacy OAuth langsung kembali ke GET server yang membaca query; fragment tidak terkirim melalui HTTP. | Login/link gagal; callback perlu state, expiry, replay dan redirect aman. | Adapter fragment menuju POST, verifikasi HMAC server, intent satu kali; tes valid/invalid/link/login. |
| Admin email | `packages/outbox-dispatcher/src/dispatcher.ts` | Wallet dan sebagian paid-order memakai shortcut `recordSent`, tanpa SMTP. | Status berhasil palsu. | Hapus shortcut EMAIL; `SENT` hanya setelah acceptance SMTP; tes send/skip/retry. |
| Customer email | `packages/db/src/crud/orders.ts`, `enqueueBuyerOrderReadyEmailIfGuest` | Guard guest+guestEmail mengecualikan akun registered. | Pelanggan registered tidak mendapat receipt. | Resolver pemilik order+snapshot guest yang valid, alasan tanpa penerima, dedup; tes kedua keluarga produk dan registered/guest. |
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
Verifikasi terarah, build dan runtime di bawah sudah dijalankan. **Gate final setelah sinkronisasi branch lulus: `pnpm typecheck` dan `pnpm test`, 628 file / 11.804 tes / 0 gagal, 717.65 detik, exit 0.** Seluruh pretest existing lulus tanpa skip, filter atau perubahan konfigurasi tes. Angka tes per command terarah tidak dijumlahkan sebagai total unik.

- `pnpm exec vitest run packages/db/src/crud/emailEvents.test.ts packages/db/src/crud/support.test.ts packages/outbox-dispatcher/src/emailEvents.integration.test.ts`: 235 tes lulus sebelum penambahan regresi audit terakhir. Setiap 23 key diuji transport acceptance, dedup, dispatch OFF, penerima kosong, SMTP transient/retry dan permanent rejection.
- `pnpm exec vitest run apps/web-admin/test/email-notifications-api.test.ts`: 5 lulus; RBAC, CSRF, boolean/persistence, reset wajib, jadwal, marker aktivasi idempoten, threshold, supplier exclusion dan preview seluruh 23 event tanpa write/send.
- `pnpm exec vitest run apps/web-admin/client/src/pages/BrandingPage.test.tsx apps/web-admin/client/src/pages/EmailNotificationsPage.test.tsx apps/web-admin/client/src/components/shared/StockEmailThresholds.test.tsx`: 17 lulus; tes diagnostics tambahan lulus terpisah.
- `pnpm typecheck`: lulus untuk seluruh workspace dan tipe tes. Gate pertama menemukan tipe helper tes API terlalu umum dan HTML recovery opsional; keduanya diperbaiki dengan tipe payload yang sesuai serta validasi hasil renderer, lalu gate lengkap lulus.
- `pnpm -r build`: lulus untuk seluruh workspace. Peringatan ukuran bundle/import dinamis Vite existing tetap ada.
- Storefront lint dan `pnpm doctor:changed`: lulus, changed scan 30 file.
- `pnpm doctor:bugs`: 628 file, tidak ada temuan.
- `pnpm doctor:full`: **628 file, 12.7 detik, 0 errors / 0 warnings**. Diagnostics `react-doctor-5a5ec21e-4a31-48e6-8e7c-abeaed16d916` di direktori temporary Windows; tidak ada suppression/exclusion/rule disable baru.
- Setelah sinkronisasi tes async checkout, `doctor:changed`, `doctor:bugs` dan `doctor:full` diulang dan tetap lulus. Full scan terakhir memakai cache diagnostik 628 file, 337ms, 0 errors / 0 warnings; diagnostics `react-doctor-7ea76949-195f-42ce-b183-9125f5d5adc0`.
- Sesudah perbaikan DOM readiness terakhir, ketiga scan diulang lagi: full 628 file, cached 154ms, **0 errors / 0 warnings**, diagnostics `react-doctor-d3c56a41-5e44-44ce-ae41-30d4f634d7cd`. Workspace production build terbaru serta gabungan tes mailer/socket SMTP/InstantBuy **67 PASS**; typecheck lengkap pada source ini lulus.
- `pnpm exec vitest run packages/core/src/mailer.integration.test.ts`: **3 PASS** dengan Nodemailer asli dan server SMTP TCP loopback terisolasi. Verify koneksi tidak mengirim DATA; send benar-benar mengirim envelope/MIME sebelum acceptance; recipient 550 ditolak sebelum DATA; respons 450 setelah DATA tidak menghasilkan acceptance. Seluruh alamat synthetic `example.invalid`, tanpa SMTP/customer produksi.
- `pnpm exec tsx .local/auth-email-smoke.mts`: browser Chromium memakai bundle produksi dan API fixture lokal, 23 switch, recovery locked ON, keyboard Space, refresh persistence, rollback save gagal, preview render-only, tanpa overflow pada viewport 390px, screenshot desktop/mobile dan 0 page errors. Ini bukti runtime UI lokal, bukan bukti email produksi. Server smoke langsung ditutup setelah tes. Setelah dijalankan, script dan kedua screenshot dipindahkan ke `%TEMP%/trustance-auth-email-toggles/` agar artefak QA tidak ikut commit.

## Matriks 23 event

Semua baris memakai registry source `packages/core/src/email/registry.ts`, renderer HTML/plaintext terpusat (receipt dan recovery memakai renderer khusus), per-event policy, durable `notification_outbox`, dedup persisten dan worker SMTP. `emailEvents.integration.test.ts` menguji seluruh 23 key melalui worker; `registry.test.ts` menguji escaping dan field opsional untuk seluruh key. Producer diuji melalui lifecycle nyata di `emailEvents.test.ts`, suite domain dan auth, bukan hanya pemanggilan registry.

Status implementasi: recovery, completion dan ticket-created admin memperluas jalur existing; 20 key canonical lainnya menambahkan event email baru pada lifecycle yang tersedia atau prasyarat baru yang ditulis di tabel. Prasyarat baru mencakup state/counter persisten, inventory crossing/hysteresis, policy, report scheduler dan activation marker. **Status tes terarah setiap baris: PASS**, termasuk jalur worker untuk semua 23 key; full regression gate dicatat terpisah. Tidak ada baris yang hanya berupa toggle/template tanpa producer.

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

Peta file utama per fase:

- Auth: `apps/storefront/client/src/lib/telegramCallback.ts`, `apps/storefront/client/src/main.tsx`, `apps/storefront/src/routes/auth.ts`, `apps/storefront/src/telegramCallback.ts`, verifier `apps/storefront/src/auth.ts` dan password routes `apps/storefront/src/routes/apiAuth.ts`.
- Transport dan status: `packages/core/src/mailer.ts`, `packages/outbox-dispatcher/src/dispatcher.ts`, `packages/outbox-dispatcher/src/emailTemplates.ts`, `apps/web-admin/src/routes/api/settings.ts` dan `apps/web-admin/src/routes/api/outbox.ts`.
- Registry, default dan copy: `packages/core/src/email/registry.ts`, `packages/core/src/booleanSettings.ts`, `packages/core/src/email/templates/resetPassword.ts` dan `packages/core/src/email/templates/eventPreview.ts`.
- Policy, producer dan prerequisites: `packages/db/src/crud/emailEvents.ts`, `emailPolicy.ts`, `emailInventory.ts`, `emailSecurity.ts`, `emailReports.ts`; lifecycle terhubung melalui `orders.ts`, `orderStatus.ts`, `digiflazz.ts`, `refunds.ts`, `support.ts`, `webauth.ts`, `poll_health.ts` dan `binance_internal.ts` pada direktori CRUD yang sama.
- Scheduler/bootstrap: `packages/outbox-dispatcher/src/emailMaintenance.ts`, `apps/server/src/index.ts` dan `apps/web-admin/src/server.ts`.
- Admin: `apps/web-admin/client/src/components/shared/SettingsToggle.tsx`, `StockEmailThresholds.tsx`, `apps/web-admin/client/src/pages/EmailNotificationsPage.tsx`, `SettingsPage.tsx`, `BrandingPage.tsx`, `OutboxPage.tsx` serta komponen form boolean pada inventory kontrol di atas.
- Diagnostics: `packages/db/src/crud/emailDiagnostics.ts`, `apps/web-admin/src/routes/api/emailNotifications.ts` dan `scripts/audit-email-delivery.ts`.

- `SettingsToggle` membungkus Radix Switch existing dengan label, ON/OFF, deskripsi, pending/disabled reason dan ARIA. Metadata boolean API mempertahankan fallback runtime; penyimpanan Settings string legacy tetap kompatibel. Multi-select, table selection, consent dan enum tidak diubah menjadi saklar.
- Email Notifications memisahkan preference dari readiness SMTP, memiliki jadwal report dan diagnostics read-only. Threshold stok tersimpan per SKU. Branding mempertahankan brand color/support; editor copy paid/reset digantikan link event setelah renderer source cutover. Nilai template legacy tidak dihapus dari storage.
- Legacy Telegram callback fragment diproses sebelum React mount, dibersihkan dari history, kemudian diverifikasi server dengan HMAC, timestamp, browser intent/state dan replay guard DB. GET query kompatibel tetap memakai verifier yang sama. Login/link mempertahankan lookup-only signup policy existing; akun Telegram yang belum ada tidak dibuat diam-diam. Callback menghindari open redirect dan tidak memasukkan hash/state ke login next URL.
- `sendMail` memeriksa recipient SMTP accepted dan menghasilkan timestamp/message ID aman. Dispatcher menyimpan evidence bersamaan dengan status; error dikategorikan tanpa secret. Jalur EMAIL fake SENT dihapus. Worker email berjalan walaupun bot tidak dikonfigurasi; antrian Telegram tidak mengambil jatah batch email-only.
- Send Test Email berbeda dari koneksi `verify()`, hanya ke owner email tersimpan, memakai RBAC/CSRF/cooldown DB, audit, dan acceptance. Tidak ada pengiriman live dalam verifikasi otomatis.
- Helper completion membaca email akun langsung untuk kebutuhan pengiriman, tanpa menambah email ke order JSON admin. Tidak ada password, deliveredContent atau stock credential dalam receipt.
- Audit concurrency memperbaiki FK lock upgrade pada stok, retry collision nomor ticket, state counter security/provider serta serialisasi expiry/payment. Cooldown dan report cursor survive restart.
- Outbox admin menunjukkan recipient masked, safe error, attempts, waktu dan acceptance. Historical SENT tanpa evidence ditandai unverified dan tidak ditafsirkan gagal/berhasil inbox. Retry SENT ditolak agar tidak terjadi resend historis tak sengaja.

## Rekonsiliasi riwayat dan batas bukti

Checkout lokal menggunakan database baru terisolasi; delapan order dan enam receipt produksi yang dilaporkan pengguna tidak tersedia untuk dihitung ulang. `pnpm exec tsx scripts/audit-email-delivery.ts` menghasilkan agregat read-only dari database yang sengaja dikonfigurasi operator: inspected, SMTP evidence, historical sent-without-evidence, kandidat shortcut legacy, penerima tidak valid dan delapan order terbaru tanpa email. Kandidat shortcut bersifat advisory, bukan bukti pasti tidak terkirim. Tidak ada resend atau perubahan status historis otomatis. Worker integration memakai transport mock terkontrol, sedangkan tiga tes mailer tambahan menguji protokol SMTP nyata melalui loopback. Keduanya membuktikan jalur aplikasi/transport lokal dan acceptance handling; pengiriman/inbox produksi belum diverifikasi.

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

Gate penuh pertama selesai dalam 843.20 detik: 627 file, 11.800 tes, 21 gagal. Seluruh kegagalan diperiksa dengan rerun file terpisah: 17 ekspektasi kontrak/stub perlu mengikuti event/outcome baru, satu ekspektasi FAQ tertinggal dari copy `master`, satu guard menemukan perhitungan stok inline, dan dua tes timeout saat run penuh. Kontrak tes diperbarui tanpa skip/suppression, helper inventory kini memakai `usesLocalInventory`, serta audit fulfillment tidak lagi mengklaim receipt terkirim. Tes Digiflazz tetap menguji kegagalan sesudah commit dan menambah regresi rollback delivery bila receipt gagal ditulis. Hasil terarah setelah perbaikan: lifecycle lima file 171 PASS, guard/heartbeat tiga file 46 PASS, enam regresi pada tiga file legacy PASS. Kedua file timeout lulus sendiri: NOWPayments 27 PASS dan order creation 7 PASS. Gate lengkap diulang sesudah seluruh perubahan ini.

Run penuh kedua: 627 file, 11.801 tes, satu gagal dalam 815.43 detik; seluruh kegagalan run pertama sudah lulus. Kegagalan baru merupakan race pada tes voucher existing: request preview sudah dipanggil tetapi DOM `checkout-summary` masih loading, sehingga `within(null)` gagal. File lulus sendiri 51/51. Tes kini menunggu request voucher dimulai dan summary benar-benar dirender sebelum memeriksa respons SKU yang ditinggalkan; tidak ada sleep, pelonggaran assertion atau perubahan perilaku checkout. Tiga pengulangan terarah sebelum perbaikan DOM lulus, lalu gate lengkap diulang pada revisi final beserta tes SMTP loopback baru.

**Hasil final:** pipeline berurutan `pnpm -r build`, tes mailer/SMTP/InstantBuy (67 PASS), `doctor:changed`, `doctor:bugs`, `doctor:full` (0 errors / 0 warnings), `pnpm typecheck`, lalu `pnpm test` seluruhnya exit 0. Run penuh terakhir: **628 file dan 11.804 tes lulus, 717.65 detik**. Log utama `.build-verified.log`, `.transport-checkout-verified.log`, `.doctor-*-verified.log`, `.typecheck-verified.log`, `.test-verified.log` dipertahankan di worktree dan disalin ke `%TEMP%/trustance-auth-email-toggles/verification/`. Log run gagal dan rerun terarah juga dipertahankan agar perbaikan dapat ditelusuri.

## Status integrasi repository

Implementasi berada di branch/worktree `worktree-auth-email-toggles` dengan baseline `aa2794f5`, sudah `git fetch origin` dan sync terhadap `master` pada baseline tersebut. Checkout utama tetap pada `master` dan memiliki file untracked di luar lingkup perubahan ini (`skills-lock.json`). Sesuai aturan integration lane pada `AGENTS.md`, checkout utama tersebut tidak dibersihkan atau dipaksa merge. Tidak ada merge, push, deployment atau perubahan konfigurasi/database produksi dalam pekerjaan ini. Worktree dipertahankan untuk review/integrasi; cleanup dilakukan setelah branch benar-benar digabung.

## Risiko tersisa dan tindak lanjut

- P1 saat deployment: verifikasi konfigurasi SMTP dan recipient owner, lalu Send Test Email berizin. Acceptance lokal/provider tidak membuktikan inbox; deliverability, bounce dan reputasi sender memerlukan bukti provider produksi.
- P1 sebelum tindakan historis: jalankan audit read-only pada database yang dipilih operator untuk memeriksa kasus delapan order/enam receipt. Pengiriman ulang memerlukan verifikasi penerima dan otorisasi terpisah.
- P2 batas SMTP: dedup persisten mencegah enqueue ganda dari lifecycle/webhook/scheduler. Transport tetap at-least-once; jika SMTP sudah menerima pesan tetapi penyimpanan evidence/status ke database gagal, retry berpotensi mengirim ulang. SMTP biasa tidak menyediakan transaksi atomik dengan database atau idempotency provider; tidak ada klaim exactly-once untuk celah kegagalan tersebut.
- P2 kebijakan akun: Telegram ID yang sama sekali belum terdaftar mengikuti kebijakan lookup-only existing. Bila pendaftaran langsung melalui Telegram diinginkan, perubahan kebijakan signup perlu ditentukan terpisah; email bukan syarat Telegram login.
- P2 operasi: aktifkan event baru sesuai kebutuhan dan tinjau jadwal/threshold. Default OFF mencegah aktivasi notifikasi baru tanpa keputusan admin; recovery wajib tetap ON.
