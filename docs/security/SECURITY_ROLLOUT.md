# Rollout dan rollback

## Sebelum deploy (pemilik/operator)

1. Review patch, hasil tes, dan perilaku recovery baru bersama support. Ambil backup database+uploads sesuai deploy/backup/README.md; cek restore di staging. Patch ini tidak membutuhkan migrasi schema.
2. Deploy build yang sama ke staging satu proses. Gunakan key/provider dummy/sandbox; jangan mengirim uang/provider live untuk validasi.
   Instal dependency memakai pnpm9.15.9 dan frozen lockfile; generate Prisma Client lalu build. Static server meningkat major9→10 untuk security fix. Jangan menjalankan pnpm11 yang mengabaikan override package.json; verifikasi versi resolved sesuai audit. Advisory lain masih residual dan perlu triage sebelum menyatakan readiness produksi menyeluruh.
3. Set WEB_COOKIE_SECURE=true pada HTTPS; SHOP_PUBLIC_URL/ADMIN_PUBLIC_URL benar; TRUST_PROXY hanya proxy hop aktual, bukan0.0.0.0/0 atau percaya semua. Periksa alamat TCP yang dilihat Fastify pada deployment Docker/nginx sebelum mengubahnya.
4. Env baru optional: SUPPORT_CREATE_RATE_LIMIT_MAX=3, SUPPORT_REPLY_RATE_LIMIT_MAX=15, SUPPORT_RATE_LIMIT_WINDOW_SECONDS=60. IP3x account quota untuk NAT. Single process sesuai compose; replica tambahan memerlukan shared quota sebelum scale. Tidak ada mode report-only backend yang diklaim; naikkan env dalam batas schema jika false positive terukur, jangan mematikan authorization.
5. Siapkan informasi pelanggan: kode order pendek saja tidak lagi membuka sesi. Sesi lama tetap bekerja dan dapat menyimpan link recovery; email baru membawa link fragment. Email lama tanpa token ? bantuan support dengan verifikasi kepemilikan. Jangan membuat endpoint pemberi token berdasarkan email/kode saja.

## Urutan deploy

1. Tutup caching publik `/uploads/tickets/*` di nginx/Cloudflare dan purge URL lama, dengan approval pemilik produksi. Contoh nginx repo memisahkan prefix ticket. Pastikan forwarding cookie dan Host; attachment `<img>` menggunakan session cookie. Jangan membuka kembali file publik untuk memperbaiki preview.
2. Deploy backend+SPA+locales bersamaan memakai build biasa. Jangan menjalankan migrasi produksi dari mesin audit ini. Restart satu instance menghapus quota in-memory; mitigasi edge dibutuhkan bila restart berulang saat serangan.
3. Staging smoke: checkout guest normal, token recovery wrong/expired/correct, akun A/B order/ticket/file, admin dicabut, CSRF, QRIS/USDT invoice mock, webhook valid/invalid/duplicate, wallet debit/credit, manual/digiflazz/premium, cancel/expiry/underpaid, Telegram normal.
4. Verifikasi file cache header no-store baik origin maupun edge, resource code saja404, MIME SVG ditolak, JSON malformed400/oversized413. Pastikan route provider `/pay/*/callback`, Telegram `/tg/*`, health dan SSE tidak dikenai browser challenge.

## Monitoring

Pantau per menit status429/403/500, p95 latency checkout, invoice created/order ratio, pending/cancelled burst, ticket created/replied, queue/outbox age, signature failures, paid tetapi belum fulfilled, dan mismatch amount/reference. Korelasikan requestId+IP trusted+route+timestampms; actorId numeric hanya pada event relevan. Jangan log body/token, email, chat, stock credentials atau signature. Raw IP/logs akses operator saja, usulan retention14hari dan agregat30hari; sesuaikan kebutuhan toko dan kapasitas disk. Compose membatasi Docker logs10MiB?5 per service; rotasi ini bukan janji retention waktu.

## Rollback

Rollback artefak aplikasi dan SPA bersama bila regresi terbukti, setelah menyimpan requestId dan metrik. Tidak ada migrasi yang perlu di-downgrade. Tetap pertahankan private ticket cache/authorization dan penutupan recovery kode-pendek; rollback utuh ke versi rentan membuka ulang SEC-01/02/03. Untuk insiden UX, sementara disable recovery route melalui nginx403 dan arahkan ke support, bukan mengaktifkan kembali kode pendek. Quota dapat dinaikkan konfigurasi lalu satu restart terencana. Jangan rotasi key/payment/bot secret otomatis; bila terindikasi bocor lakukan inventaris, koordinasi provider, rollout key, invalidasi sesi, lalu verifikasi callback.

Tidak ada langkah produksi dalam dokumen ini yang sudah dijalankan. Approval produksi diperlukan untuk deploy, perubahan DNS/WAF/firewall/purge, dan rotasi credential.

## Dependency lanjutan

Gunakan pnpm9.15.9 dan frozen lockfile; rebuild backend dan kedua SPA. Nodemailer berpindah major ke10; smoke SMTP staging harus memverifikasi subject/body/HTML dan recovery link memakai mailbox staging. Tidak ada pengiriman provider live dari audit. CSS shadcn sudah lokal berlisensi MIT, CLI bukan dependency aplikasi. Image masih memasang tooling development, yang kini juga telah diperbarui sampai audit all kosong; bukti sebelum/sesudah tersedia pada DEVELOPMENT_TOOLING_REMEDIATION.md.

## Tooling development final

Audit seluruh graph dependency kini0 seluruhkategori, termasuk tooling yang dipasangDocker. Rebuild dengan frozenlockfilepnpm9.15.9. MinimumSafari targetSPA naik14 ke14.1 karena kompatibilitas compilerpatched. Vitest4 memakai --maxWorkers tanpa --minWorkers; commandVitest2 di laporanlama adalah catatanhistoris. Tidak ada perubahan schema atau deployproduksi dari remediation ini.
