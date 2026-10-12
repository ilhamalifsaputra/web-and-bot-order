# Trustance Ticketing V2

## Audit sebelum implementasi — 12 Oktober 2026

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

Strategi: reuse Prisma, auth/RBAC/CSRF, outbox + dispatcher, UI token/komponen, dan audit existing. Replace customer entry dengan satu /help dan detail canonical. Tambah konfigurasi kategori di core yang disajikan backend untuk web dan dipakai bot. Tambah metadata R2, tanpa Redis/microservice/storage disk baru. Request idempotency diikat owner dan tiket. Legacy consumer tetap diterima selama transisi; histori tidak dihapus.

Risiko: schema harus terpasang sebelum worker/API baru; R2 memerlukan konfigurasi operator; perubahan nomor tidak boleh mengganti nomor yang sudah publik. Migration additive, nomor null di-backfill dengan random kriptografis berdasarkan createdAt. Rollback kode dapat memakai kolom lama; jangan drop tabel/kolom baru atau hapus objek saat rollback. Media disk historis tetap dapat diakses melalui ownership existing sampai migrasi media eksplisit; jangan hapus histori secara spekulatif.

Urutan: domain/schema + backfill → private media/API → customer compact → admin workspace/media → bot flow/reply → focused tests → sync master → full typecheck/tests/Doctor → QA responsive dan laporan aktual. Tidak ada mutasi finansial dari ticketing.

Lingkungan lokal: worktree `ticketing-v2`, port admin 8419/customer 8420, Postgres container `ticketing-v2-postgres-1` port 55459 dan database khusus `ticketing_v2`. Token bot produksi tidak dijalankan untuk QA.


## Konfigurasi R2

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

## Implementasi dan migrasi

Customer: satu halaman `/help`, form kategori/jenis dari backend, order conditional milik user, deskripsi 10-2000 karakter, history server paging/search/filter dan detail canonical. Route `/account/support` lama redirect. Form dan composer memakai direct PUT R2, progress XHR, finalize, preview foto/video, retry maksimal tiga percobaan dan remove. Batas file mengikuti options backend; default 3 file, foto 5 MB, MP4 20 MB. Admin: nomor publik/copy, aktivitas terakhir, pencarian nomor tiket/order/customer, source filter, statistik nyata, start processing, catatan internal, upload/preview, hold evidence dan reuse context/audit/assignment/priority existing. Telegram: kategori, jenis, optional order paging, deskripsi, media, review, submit; reply mode hingga Done/Cancel dengan TTL 30 menit. Domain, idempotensi, kepemilikan dan outbox bersama, tanpa mutasi finansial.

Schema additive: `prisma/migrations/20261012100000_ticketing_v2/migration.sql`. Tambahan metadata attachment, request keys, origin, subcategory, legal hold dan last activity. SQL mengisi last activity historis dari timestamp bisnis/messages, bukan waktu deploy. Status lama tetap terbaca; OPEN/WAITING_ADMIN ditampilkan Baru, REPLIED/WAITING_CUSTOMER Menunggu Pelanggan. Resolved dan Closed berbeda. Balasan pada Resolved membuka antrean yang benar dengan audit; Closed harus reopen dulu.

Rollout operator: backup DB, apply migration sesuai prosedur repo sebelum menjalankan API/worker/bot baru; regenerate Prisma; jalankan `pnpm exec tsx scripts/backfill-ticket-numbers.ts` pada target DB yang sudah diverifikasi. Script import-safe, batch 100, hanya nomor null, cryptographic random, unique-index retry, repeatable; nomor yang sudah diterbitkan tetap utuh. Bandingkan jumlah tiket/pesan, timestamps dan relasi sebelum/sesudah. Ship server + kedua SPA + bot/worker bersama, restart, reload tab lama, smoke-test auth/create/reply/upload/download dan outbox. Jangan mengaktifkan poller kedua pada token bot produksi.

Cleanup mengklaim bukti dengan status DELETING di transaksi pendek; tidak ada network transfer dalam lock tersebut. Reopen/hold memakai lock tiket yang sama dan menolak konflik saat penghapusan sudah berjalan. Failed delete tetap diklaim untuk retry siklus selanjutnya. Bukti yang sudah dihapus menurut kebijakan tidak dapat dipulihkan dengan reopen. Hold perlu dipasang sebelum masa retensi berakhir. Rollback: rollback kode sebagai satu release; pertahankan kolom/tabel baru, nomor, media R2, dan histori disk; jangan reverse migration destruktif atau hapus bukti.

## Verifikasi lokal dan batasan

- Build semua workspace lulus (`pnpm -r build`), Prisma development schema hanya diterapkan ke database isolated port 55459.
- Focused domain/backfill/delivery: 152 tests lulus; lifecycle/retention-race/stream-limit: 12 tests lulus; API admin/storefront/bot regression: 381 tests lulus. Full typecheck/tests masih menunggu final gate, jangan menyimpulkan semua test sudah hijau dari angka focused.
- Browser menggunakan response fixture, bukan akun produksi. CSS widths 320/375/768/1024/1440/1920: customer help/detail dan admin list/detail tanpa overflow dokumen; tabel admin horizontal scroll hanya di panel pada ukuran menengah. Short refund description `Gg` invalid; category switch menghapus draft order. Full React Doctor 635 files: 0 errors/0 warnings.
- R2 account/token/CORS belum dikonfigurasi untuk pengujian live. Tidak ada live Telegram send/poller. Test transport memakai mock, sementara domain/API memakai PostgreSQL isolated. Smoke test layanan asli tetap wajib saat rollout.
- Pemeriksaan file menggunakan signature gambar dan bounded MP4 ftyp, size, MIME dan pinned ETag. Ini bukan antivirus atau full media decoder. Bucket tetap private; tidak ada klaim malware-free. Integrasi scanner eksternal tidak ditambahkan.
- Telegram API tidak menawarkan transaksi dengan database. Checkpoint mencegah pengulangan text/media yang telah tercatat saat retry; crash tepat sesudah transport menerima namun sebelum checkpoint dapat mengulang satu bagian. Salinan media Telegram tidak ikut terhapus saat retensi R2.
- Baseline latency/RSS/volume produksi tidak tersedia. Build artifact size dan latency integration lokal dicatat sebagai pengukuran lokal, bukan klaim peningkatan terhadap baseline yang tidak diukur. Web upload hanya membawa metadata melalui Fastify; Telegram dibatasi dua stream per proses, timeout 90 detik, byte-count/backpressure, inspection 4 KiB.
