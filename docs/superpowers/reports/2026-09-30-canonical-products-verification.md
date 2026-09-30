# Canonical products: catatan verifikasi

Status 1 Oktober 2026: source final `21cf36f8` selesai diverifikasi, seluruh finding review teratasi. Pengguna meminta merge lokal + push origin/master; integrasi masih menunggu izin eksplisit atas checkout utama yang dirty (perubahan existing tidak overlap). Kode belum di-merge/push.

## Lingkup dan isolasi

Branch `worktree-canonical-products`, base `c0a56595`; perubahan berada di `.claude/worktrees/canonical-products`. Checkout utama memiliki perubahan sebelumnya (.env.example, graphify-out, cache), tidak di-commit/ditimpa oleh patch. Belum ada merge/push; pengguna kini mengotorisasi keduanya setelah verifikasi. Tidak ada deployment, migration produksi, atau pengiriman Telegram nyata.

Database pengujian PostgreSQL16 disposable milik tugas ini berjalan di localhost port55839. Helper Vitest membuat schema acak per suite. Playwright memakai schema fixture terpisah dan wallet lokal, tanpa payment gateway nyata. Container lain tidak dipakai atau dihentikan.

## Bukti fondasi

- Task1 `cc165076`: domain canonical, runtime schema, Money exact dan penyimpanan supplierRawName nullable.
- Review menemukan parsing suffix pada angka ambigu; fix `7d59e9b` menolak grouping tidak didukung dan mempertahankan raw text.
- TDD fix: 8 kegagalan sebelum fix, 52 tes lulus sesudah fix; scoped review spec dan quality approved.
- Core broad sebelum fix terakhir: 62 file, 923 tes lulus. Tes import/resync Digiflazz:32 lulus,93 dilewati oleh filter. Mutation storage:4 gagal tanpa raw-name writes,4 lulus setelah dipulihkan.
- Typecheck core/db dan Prisma generate lulus. Migration drift check memakai database disposable: tidak ada perbedaan schema.
- Guard migration:22 timestamp unik, quoting lulus. Detection purity guard:10 file, tanpa pelanggaran.
- Baseline recursive package typecheck dan test-tsconfig lulus. Baseline build kedua SPA lulus, dengan warning chunk besar/static-dynamic import existing.

## Verifikasi integrasi akhir

- Recursive9 package typecheck dan `tsc -p tsconfig.test.json --noEmit`: exit0.
- Lint storefront dan frontend-boundary: exit0; tidak ada import server-only pada browser.
- Build storefront (2374 modules) dan admin (3116 modules): exit0. Warning existing chunk >500KB dan CheckoutPage static/dynamic import tetap dicatat, tanpa redesign/bundling di luar scope.
- Playwright Chromium:3/3 lulus,29.8s. Nama lengkap/harga exact membungkus tanpa overflow pada desktop1280 dan mobile375; checkout wallet benar-benar paid/delivered; perubahan stok sebelum submit menuntut retry eksplisit. Warning NO_COLOR/FORCE_COLOR adalah warning proses test.
- Setelah dua edge case self-review presenter diperbaiki, covering typecheck order-bot dan test-tsconfig kembali exit0. Source web tidak berubah sejak build/browser check.
- Tes terfokus implementer: web131, bot55 (264 filtered), signed API+Instant30; domain53+presenter9. Bukti RED/GREEN dicatat pada laporan task, bukan menjumlahkan run duplikat sebagai cakupan baru.
- Suite lengkap pertama:500/505 file lulus,8587/8603 tes lulus,16 gagal (760.24s). Tiga file gagal terkait additive canonical/timestamp/formatting; diperbaiki lewat tes terfokus tanpa mengubah arithmetic. Dua file lainnya membutuhkan environment/fixture yang memang diasumsikan tes existing.
- `integrity.test.ts` membaca schema default dev; database disposable sebelumnya kosong. Semua22 migration diaplikasikan sukses pada database disposable saja; integrity5/5 kemudian lulus.
- Storage summary legacy mengukur file lokal `data/bot.db`, bukan ukuran database PostgreSQL. Fixture file-size synthetic (bukan database/copy data nyata) disediakan sementara di worktree agar assertion existing tetap diuji tanpa melemahkan tes atau mengubah route di luar scope.
- Tiga file kompatibilitas setelah perbaikan:205/205 lulus (sebelumnya194/205,11 gagal), test TypeScript dan diff check exit0. Assertion bentuk item tetap exact plus runtime schema; hanya timestamp canonical.generatedAt yang dikecualikan pada perbandingan dua request terpisah.
- Suite penuh ulang selesai exit0:505/505 file dan8603/8603 tes lulus,0 gagal. Ini hasil sebelum dua fix review tambahan, bukan klaim verifikasi final setelah fix.
- Review Task2 menemukan dua Important: satu grapheme ekstrem melewati batas chunk/button; callback Buy lama mengabaikan active/archive flags saat konfirmasi. Fix terfokus dan re-review sedang berjalan. Minor separator unit/total English dan React act warnings dicatat untuk triage review akhir.
- Fix `171d691a`: hanya grapheme melebihi budget dipecah per code point dengan HTML entity/surrogate tetap utuh; label di atas64 bytes memakai #ID fallback. Empat active/archive flags dicek sebelum callback Buy masuk konfirmasi. Regresi Unicode RED1 lalu GREEN10; byte-guard mutation RED lalu GREEN; empat stale callback RED4 lalu GREEN4. Full covering bot333/333, bot/test TypeScript dan diffcheck exit0.
- Suite post-review pada source `171d691a`:exit0,505/505 file dan8608/8608 tes lulus,0 gagal (826.39s). Source stabil sepanjang run dan reviewer read-only; ini hasil sebelum final fix wave, bukan klaim final source green.
- Whole-branch reviewer memeriksa seluruh4174 line package: no Critical; satu Important parent product name hilang pada cart, web checkout dan konfirmasi Telegram; dua Minor grouping English dan async fixture warning. Satu patch terakhir menangani seluruh finding. Contextual picker/detail tetap dipertahankan; ringkasan standalone harus memperlihatkan nama induk + variant + qualifier.
- Final wave `21cf36f8`: standalone cart/web checkout/bot confirmation memuat nama induk + variant + qualifier, tanpa duplikasi jika nama tepat sama. Nama induk sangat panjang tetap dikirim lengkap dalam pesan berbatas. Regresi identitas RED4/GREEN4, exact-equality RED3/GREEN3. English confirmation total/voucher/wallet memakai grouping konsisten tanpa perubahan arithmetic; RED3/GREEN6. Covering web82/82, bot356/356, client/bot/test TypeScript + storefront lint exit0.
- React card fixture memakai seeded shop-context query. Isolated15/15 pre/post tanpa warning yang direproduksi; ini stabilisasi fixture, bukan klaim seluruh historical act warning hilang.
- Satu scoped final re-review menyatakan Important + dua Minor ADDRESSED, no new breakage. Tidak ada review/implementasi duplikat setelahnya.
- Build storefront terbaru2375 modules exit0; browser Chromium terbaru3/3 lulus18.3s, desktop/mobile wrapping + wallet delivered + stale stock retry. Warning bundling/NO_COLOR existing tetap dicatat.
- Suite penuh final setelah semua source fix:exit0,505/505 file dan8617/8617 tes lulus,0 gagal,734.11s. Command: `node node_modules/vitest/vitest.mjs run --maxWorkers 4 --minWorkers 1 --silent --reporter=json --outputFile .superpowers/sdd/2026-09-30-canonical-products/post-final-wave-suite.json`. DATABASE_URL_PRISMA hanya mengarah ke disposable PostgreSQL port55839; pnpm dependency-verification guards dipakai. Source `21cf36f8` tidak berubah sepanjang run.

## Integrasi yang diminta pengguna

Fetch origin/master berhasil; saat diperiksa branch7 commit ahead,0 behind, master/origin/master masihbasec0a56595. Checkout utama memiliki9 tracked local changes (.env.example dan graphify-out), serta cache untracked;0 overlap dengan47 file patch. Tidak ada unrelated change yang di-commit, dihapus, di-stash atau ditimpa. Aturan repo meminta main bersih sebelum merge, sehingga pertanyaan izin merge non-overlap dengan local changes tetap dipertahankan dikirim; menunggu jawaban eksplisit. Workflow CI hanya workflow_dispatch, bukan trigger push otomatis. Tidak ada klaim CI remote/deployment dijalankan.

## Hambatan environment yang ditangani

- Dependency offline awal tidak tersedia/instalasi sandbox tersendat. Instalasi offline dengan approval selesai dan Prisma dihasilkan; lockfile tidak diubah.
- pnpm11 mencoba memverifikasi package manager9 yang dipin repo dan fetch gagal. Environment `pnpm_config_verify_deps_before_run=false` dipakai untuk menjalankan command dengan dependency yang sudah terpasang, tanpa mengubah packageManager/lockfile.
- tsx sandbox gagal pada `uv_os_get_passwd` ENOMEM dan akses Docker diblokir sandbox. Command relevan diulang dengan approval; tidak mengubah source untuk menutupi masalah environment.

## Keputusan selama eksekusi

1. Melanjutkan desain/plan tanpa approval gate tambahan sesuai instruksi pengguna. Jika penafsiran desain salah, perubahan tetap dapat direview/diubah pada branch.
2. Money IDR mendukung scale0..4 agar presisi caller tidak dibuang. Jalur katalog aktif tetap menggunakan wholeRupiah existing; consumer harus membaca scale.
3. Menambahkan supplierRawName nullable karena importer sebelumnya menghapus region. Nama historis tidak ditebak; provenance legacy eksplisit sampai sync berikutnya.
4. Source konversi mengikuti rate yang benar-benar terpilih: setting atau fallback konfigurasi existing, timestamp nullable. Jika metadata keliru, koreksi metadata tanpa mengubah arithmetic rate.

## Batas verifikasi

Tidak ada screenshot masalah terkini dari pengguna yang diperiksa. Telegram Android/iOS/Desktop dan font scaling perangkat belum diverifikasi manual. Heuristic lebar grapheme bukan jaminan pixel-perfect; fallback list/detail menjaga informasi ketika label terlalu panjang. Migration additive harus diterapkan sebelum kode baru dijalankan pada deployment terpisah.
