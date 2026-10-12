# Trustance Ticketing V2

## 1. Audit hasil temuan

Source yang dibaca: `prisma/schema.prisma` (SupportTicket/TicketMessage), `packages/db/src/crud/{support,ticketAccess,notifications,orders}.ts`, `packages/core/src/enums.ts`, `apps/storefront/src/routes/apiAccount.ts`, `apps/storefront/src/lib/ticketAttachments.ts`, `apps/storefront/src/{auth.ts,routes/auth.ts}`, customer `pages/{HelpPage,SupportPage,TicketDetailPage}.tsx` dan komponen support, admin `routes/api/support.ts`, `pages/{SupportPage,TicketDetailPage}.tsx`, `components/support/TicketConversation.tsx`, bot `conversations/{support,customer,index}.ts`, ticket handlers/keyboards, `packages/outbox-dispatcher/src/dispatcher.ts`, `package.json`, `vitest.config.ts`, dan `docker-compose.postgres.yml`. Graphify dikonsultasikan sebelum pembacaan source.

Kondisi/gap:

- Customer memiliki dua UI aktif: /help (form + list + detail inline) dan /account/support (form lama enam baris, nomor #id). Hero besar, form meminta subject dan produk, preview/nomor tidak konsisten. Detail lama masih dipakai oleh link order.
- Prisma/Postgres sudah menyimpan tiket, pesan, note internal, assignment, priority, timestamp response/resolved/closed. Status OPEN, WAITING_ADMIN, REPLIED, WAITING_CUSTOMER, RESOLVED, CLOSED sudah memiliki transisi dan audit; belum ada IN_PROGRESS. Nomor TCK memakai count harian; belum ada backfill seluruh histori.
- Customer API sudah memvalidasi ownership order/tiket dan mengecualikan note internal. Identitas web memakai session userId; login Telegram diverifikasi melalui auth existing. Tidak perlu identity engine kedua atau merge berdasarkan input username/email.
- Kategori enum sembilan nilai dan dropdown frontend berbeda; belum ada jenis kendala bersama. Backend /support/new mewajibkan produk meskipun kendala akun tidak memiliki produk.
- Upload customer memakai multipart, Buffer.concat, lalu disk /uploads/tickets. Video belum diperiksa signature. Admin hanya mengirim teks dan preview file Telegram. Belum ada R2, upload intent, finalize, atau metadata attachment privat.
- Bot membuat tiket deskripsi → optional order → foto, tanpa kategori/jenis/review. Validasi dan penambahan foto masih mengirim bubble. Reply hanya satu teks dan notifikasi admin langsung dari bot.
- Outbox existing menangani new ticket/reply/closed dan email. Web admin reply baru mengantre email, Telegram reply notification belum konsisten. Internal note sudah tidak memicu notifikasi customer.
- Admin sudah memiliki filter/pagination/assignment/priority, split context dan activity audit. Context per-unit memakai endpoint order yang sudah menyamarkan credential; pengungkapan tetap melalui endpoint khusus yang diaudit.

## 2. Keputusan desain dan arsitektur

Strategi: reuse Prisma, auth/RBAC/CSRF, outbox + dispatcher, UI token/komponen, dan audit existing. Replace customer entry dengan satu /help dan detail canonical. Tambah konfigurasi kategori di core yang disajikan backend untuk web dan dipakai bot. Tambah metadata R2, tanpa Redis/microservice/storage disk baru. Request idempotency diikat owner dan tiket. Legacy consumer tetap diterima selama transisi; histori tidak dihapus.

Risiko: schema harus terpasang sebelum worker/API baru; R2 memerlukan konfigurasi operator; perubahan nomor tidak boleh mengganti nomor yang sudah publik. Migration additive, nomor null di-backfill dengan random kriptografis berdasarkan createdAt. Rollback kode dapat memakai kolom lama; jangan drop tabel/kolom baru atau hapus objek saat rollback. Media disk historis tetap dapat diakses melalui ownership existing sampai migrasi media eksplisit; jangan hapus histori secara spekulatif.

Urutan: domain/schema + backfill → private media/API → customer compact → admin workspace/media → bot flow/reply → focused tests → sync master → full typecheck/tests/Doctor → QA responsive dan laporan aktual. Tidak ada mutasi finansial dari ticketing.

Lingkungan lokal: worktree `ticketing-v2`, port admin 8419/customer 8420, Postgres container `ticketing-v2-postgres-1` port 55459 dan database khusus `ticketing_v2`. Token bot produksi tidak dijalankan untuk QA.

Seluruh antarmuka menggunakan domain `packages/db/src/crud/support.ts` dan katalog `packages/core/src/supportCatalog.ts`. Metadata privat ada di `supportAttachments.ts`; signing, discovery bucket, dan bounded format inspection ada di `packages/core/src/supportMedia.ts`. Browser tidak mengirim byte bukti melalui Fastify. Jalur Telegram memakai stream dan outbox existing. React menggunakan komponen/token Trustance existing; nomor publik selalu berasal dari backend.

## 3. Perubahan yang diimplementasikan

- Customer Web: `/help` menggantikan entry lama; layout ringkas, kategori/jenis dinamis, order conditional, validasi deskripsi, history server paging, detail/percakapan dan foto/video. Canonical detail tetap kompatibel dengan link lama. Label status pelanggan dan bot konsisten. Composer dua baris awal, form tiga baris, teks panjang dapat membungkus tanpa memaksa halaman melebar.
- Admin: daftar dengan enam statistik riil, filter source, order number lengkap, desktop table dan mobile cards. Detail mendukung status Diproses, koreksi judul, hold evidence, balasan foto/video dan internal note yang jelas privacy-nya. Context/audit/assignment/priority existing dipertahankan.
- Telegram: kategori, jenis, order milik user dengan paging, deskripsi, lampiran, review dan konfirmasi. Shortcut detail order memvalidasi/prefill order. Reply mode berakhir lewat Done/Cancel atau TTL 30 menit. Navigasi mengedit anchor; pesan teks/media tiket tetap tersimpan sebagai histori baru.
- API/DB: ownership/RBAC/CSRF, idempotent request keys, deduplikasi tiket aktif untuk order secara transactional, status authoritative dan audit. Nomor `TKT-YYYYMMDD-XXXXXX` acak kriptografis, unique-index retry, immutable. Tidak ada refund/order/payment/wallet mutation dari tiket.
- R2/media: upload intent, direct PUT, progress nyata, finalize HEAD + signature + ETag, copy ke key immutable, authorized short-lived download. Maksimal tiga file bahkan saat input event bersamaan; retry intent baru maksimal tiga percobaan. SVG/HTML ditolak tanpa upload. UI membedakan tipe/ukuran, timeout, network, 403/expired access, quota, ticket unavailable, 5xx dan verification failure; tidak merender error upstream atau signed URL.
- Notification: create/reply mengantre event melalui outbox dalam transaksi domain. Public admin reply worker memvalidasi recipient dan visibility, mengirim actual text/media dengan checkpoint per bagian, reuse file ID hanya untuk bot yang sama, serta fallback stream R2 yang dibatasi. Internal note tidak mengantre customer notification. Worker menunggu transport sebelum mengakui pengiriman.

## 4. Migrasi, kompatibilitas dan rollback

Schema additive: `prisma/migrations/20261012100000_ticketing_v2/migration.sql`. Tambahan metadata attachment, request keys, origin, subcategory, legal hold dan last activity. SQL mengisi last activity historis dari timestamp bisnis/messages, bukan waktu deploy. Status lama tetap terbaca; OPEN/WAITING_ADMIN ditampilkan Baru, REPLIED/WAITING_CUSTOMER Menunggu Pelanggan. Resolved dan Closed berbeda. Balasan pada Resolved membuka antrean yang benar dengan audit; Closed harus reopen dulu.

Rollout operator: backup DB, apply migration sesuai prosedur repo sebelum menjalankan API/worker/bot baru; regenerate Prisma; jalankan `pnpm exec tsx scripts/backfill-ticket-numbers.ts` pada target DB yang sudah diverifikasi. Script import-safe, batch 100, hanya nomor null, cryptographic random, unique-index retry, repeatable; nomor yang sudah diterbitkan tetap utuh. Bandingkan jumlah tiket/pesan, timestamps dan relasi sebelum/sesudah. Ship server + kedua SPA + bot/worker bersama, restart, reload tab lama, smoke-test auth/create/reply/upload/download dan outbox. Jangan mengaktifkan poller kedua pada token bot produksi.

Sebelum copy ke R2, tujuan salinan dicatat sebagai record cleanup sementara. Commit metadata READY sekaligus menghapus record sementara tersebut dalam transaksi pendek; jika copy/commit berhenti atau gagal, record tetap tersedia untuk cleanup setelah TTL satu jam. Test meliputi kegagalan commit, retry yang berhasil, cleanup orphan, dan concurrent finalize tanpa menghapus objek pemenang.

Cleanup mengklaim bukti dengan status DELETING di transaksi pendek; tidak ada network transfer dalam lock tersebut. Reopen/hold memakai lock tiket yang sama dan menolak konflik saat penghapusan sudah berjalan. Failed delete tetap diklaim untuk retry siklus selanjutnya. Bukti yang sudah dihapus menurut kebijakan tidak dapat dipulihkan dengan reopen. Hold perlu dipasang sebelum masa retensi berakhir. Rollback: rollback kode sebagai satu release; pertahankan kolom/tabel baru, nomor, media R2, dan histori disk; jangan reverse migration destruktif atau hapus bukti.

Migration/backfill belum dijalankan ke produksi. Verifikasi schema lokal hanya ke database isolated `ticketing_v2` pada port 55459. Existing ticket number tidak diganti; backfill hanya mengisi null dan dapat dijalankan ulang. Database menyimpan metadata/tombstone, bukan binary atau presigned URL permanen.

## 5. Hasil verifikasi

- `pnpm -r build`: lulus untuk semua workspace; output `.ticketing-build-complete-final.log`.
- `pnpm typecheck`: lulus, termasuk semua workspace dan `tsconfig.test.json`; output `.ticketing-typecheck-compact-final.log`.
- `pnpm lint`: lulus, termasuk Storefront ESLint dan `pnpm doctor:bugs` untuk kedua client; output `.ticketing-lint-complete-final.log`.
- `pnpm doctor:changed`: 38 files, Bugs clean. `pnpm doctor:full`: **637 files, 0 errors, 0 warnings**, 38.4 detik; diagnostics `react-doctor-19b65f01-13a6-45a1-8f0f-34a14d1e1f3d`. Tidak ada suppression, exclusion atau disabled rule baru.
- Focused domain/backfill/delivery 152 tests lulus; lifecycle/retention-race/stream-limit 12 lulus; API/bot regressions 381 lulus. Final upload hooks + admin list/detail: **87 tests lulus**. Angka ini per-run, bukan total unik.
- Final synchronized gate pada source `50490bd7`, setelah sinkronisasi dengan `master` / `origin/master` di `c39b0150`: **`pnpm typecheck` dan `pnpm test` exit 0; 634 files, 11,845 tests, 0 failures, 757.39 detik**. Seluruh pretest gate lulus (migration drift/timestamps, frontend boundaries, lint dan detection purity). Output full suite `.ticketing-test-verified-final.log`. Perubahan setelah gate hanya laporan ini.
- Browser fixtures: CSS viewport **320/375/768/1024/1440/1920** untuk customer help/detail dan admin list/detail. Tidak ada horizontal overflow dokumen/main. Tabel admin scroll hanya dalam panel pada ukuran menengah. `Pembayaran & Saldo`/refund dengan deskripsi `Gg` invalid; pergantian kategori membersihkan draft order. Nomor/teks panjang membungkus; title editor mobile dapat disimpan; internal note admin terpisah. Screenshots: `docs/ticketing-help-mobile.png`, `ticketing-detail-mobile.png`, `ticketing-admin-mobile.png`, `ticketing-admin-desktop.png`, `ticketing-admin-detail-mobile.png`.

Ukuran chunk hasil production build lokal (minified / gzip; tidak termasuk shared chunks):

| Halaman | Minified | Gzip |
| --- | ---: | ---: |
| Customer Help | 10.02 kB | 3.59 kB |
| Customer Ticket Detail | 22.42 kB | 6.96 kB |
| Admin Support | 19.92 kB | 6.41 kB |
| Admin Ticket Detail | 31.10 kB | 9.83 kB |

## 6. Konfigurasi operasional

Bucket dibuat operator. Nama bucket opsional: jika `SUPPORT_R2_BUCKET` kosong, aplikasi memakai S3 ListBuckets dan memilih otomatis hanya bila hasilnya tepat satu bucket. Tidak pernah memilih bucket pertama saat hasilnya lebih dari satu. Discovery di-cache 10 menit (kegagalan 60 detik) dan digabung untuk permintaan bersamaan. Bucket aktual disimpan pada setiap metadata lampiran, sehingga download/finalize/cleanup tetap memakai bucket asli meski konfigurasi berubah. Contoh: `SUPPORT_R2_BUCKET=trustanceid-bucket`; nama lain tetap didukung cukup dengan mengubah environment. Isi `SUPPORT_R2_ACCOUNT_ID`, `SUPPORT_R2_ACCESS_KEY_ID`, dan `SUPPORT_R2_SECRET_ACCESS_KEY` melalui secret environment server, bukan source code atau chat. Mode eksplisit mendukung token Object Read & Write hanya untuk bucket yang dipilih. Mode otomatis membutuhkan izin ListBuckets; menurut [izin Cloudflare R2](https://developers.cloudflare.com/r2/api/tokens/), token Object Read & Write saja tidak memiliki izin tersebut. Token Admin Read & Write mendukung daftar bucket dan upload, tetapi cakupannya lebih luas. Aplikasi tidak mengubah permission atau membuat bucket otomatis. Public Access tetap Disabled. Restart API dan bot setelah perubahan environment.

Pembuatan bucket tidak otomatis menghubungkan aplikasi. Agar browser bisa PUT langsung, tambahkan CORS di Settings bucket dengan origin HTTPS customer dan admin yang sebenarnya (tanpa slash terakhir), contoh berikut diganti sesuai domain:

```json
[{
  "AllowedOrigins": ["https://shop.example.com", "https://admin.example.com"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["Content-Type", "Range"],
  "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
  "MaxAgeSeconds": 3600
}]
```

Presigned URL berlaku 180 detik. Upload browser hanya ke prefix staging `support/`; finalize memeriksa ukuran, MIME, signature, dan menyalin ETag terverifikasi ke `support-ready/` yang tidak pernah menerima presigned PUT browser. Konfigurasikan lifecycle prefix `support/` untuk kedaluwarsa setelah 2 hari; jangan terapkan lifecycle tersebut ke `support-ready/`. Cleanup attachment terikat hanya untuk tiket Closed yang melewati retention dan tanpa legal hold. Panduan resmi: [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [CORS](https://developers.cloudflare.com/r2/buckets/cors/).


Endpoint JSON dan multipart teks lama tetap diterima selama transisi. Seluruh consumer aktif berpindah ke upload-intent/finalize; multipart **file** lama ditolak eksplisit dengan `helpdesk.use_direct_upload`. Tidak ada fallback upload baru ke disk, termasuk ketika R2 belum tersedia. API dan kedua client harus dirilis bersama; tab lama perlu reload. Static mount disk hanya untuk lampiran historis, dengan ownership dan internal-note guard tetap berlaku.

Environment contoh ada di `.env.example`. `SUPPORT_IMAGE_MB` / `SUPPORT_VIDEO_MB` dapat menurunkan batas default (maksimum kebijakan 5/20 MB); options backend menjadi sumber limit browser/bot. Retensi default 90 hari setelah Closed dapat disesuaikan melalui `SUPPORT_RETENTION_DAYS`. Cleanup bounded batch berjalan melalui job bot existing, bukan scheduler baru. Jangan menjalankan dua poller pada token bot yang sama.

## 7. Sisa risiko dan batasan

- R2 account/token/CORS belum dikonfigurasi untuk pengujian live. Tidak ada live Telegram send/poller. Test transport memakai mock, sementara domain/API memakai PostgreSQL isolated. Smoke test layanan asli tetap wajib saat rollout.
- Pemeriksaan file menggunakan signature gambar dan bounded MP4 ftyp, size, MIME dan pinned ETag. Ini bukan antivirus atau full media decoder. Bucket tetap private; tidak ada klaim malware-free. Integrasi scanner eksternal tidak ditambahkan.
- Telegram API tidak menawarkan transaksi dengan database. Checkpoint mencegah pengulangan text/media yang telah tercatat saat retry; crash tepat sesudah transport menerima namun sebelum checkpoint dapat mengulang satu bagian. Salinan media Telegram tidak ikut terhapus saat retensi R2.
- Baseline latency/RSS/volume produksi tidak tersedia. Ukuran build dicatat di atas; log integration mencatat durasi request lokal. Peak RSS upload live, jumlah file/ukuran volume produksi dan delta terhadap baseline belum diukur. Web upload hanya membawa metadata melalui Fastify; Jalur ingest dan delivery Telegram masing-masing dibatasi dua stream per proses, timeout 90 detik, byte-count/backpressure, inspection 4 KiB.
- QA browser memakai Chromium dengan response fixture. Real-service E2E upload/download R2, recipient Telegram, mobile keyboard fisik serta Safari/Firefox belum dilakukan; jangan mengklaim cross-browser atau production ready dari fixture ini.
- Vite build masih memberikan warning existing untuk shared admin chunk di atas 500 kB. Ukuran chunk ticketing di atas terpisah; batas warning tidak dinaikkan/disembunyikan.
- Permission R2 discovery lebih luas daripada object-only token. Jika operator memilih least privilege per-bucket, isi `SUPPORT_R2_BUCKET` secara eksplisit. Kredensial dan CORS tidak dapat muncul otomatis hanya dari pembuatan bucket.
- Integrasi berasal dari branch `worktree-ticketing-v2`. User mengizinkan pengecualian syarat checkout bersih untuk merge ini: `skills-lock.json` untracked di folder utama tetap utuh dan tidak ikut commit/push. Verifikasi integrasi menggunakan database lokal terisolasi; log disimpan di `.local/ticketing-v2-verification/`. Deployment, migration/backfill produksi dan konfigurasi R2 live tetap merupakan langkah rollout terpisah.

Screenshot tambahan: `docs/ticketing-admin-320.png`. Filter admin tetap dua kolom pada 320 px; setiap trigger sekitar 131 px dan tidak menyebabkan overflow.
