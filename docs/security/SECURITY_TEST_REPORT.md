# Laporan pengujian hardening

Pengujian8Oktober2026 memakai PostgreSQL16 dummy container `trustance-security-test`, port loopback55479, database `security_test`. Harness membuat schema/database per file dan membersihkannya; tidak memakai data pelanggan. Provider pembayaran/Digiflazz/SMTP memakai mock atau alamat `.invalid`. Tidak ada transaksi uang atau perubahan production.

## Lingkungan dan perintah

PowerShell dari root repository:

```powershell
$env:DATABASE_URL_PRISMA='postgresql://security_test:security_test@127.0.0.1:55479/security_test'
$env:LOG_LEVEL='error'
$env:pnpm_config_verify_deps_before_run='false'
node node_modules/vitest/vitest.mjs run apps/storefront/test apps/storefront/client/src/pages/TrackOrderPage.test.tsx apps/storefront/client/src/pages/OrderDetailPage.test.tsx apps/web-admin/test/web.test.ts apps/web-admin/test/settings-security-api.test.ts packages/db/src/crud/wallet_concurrency.test.ts packages/db/src/crud/wallet_cart_checkout_concurrency.test.ts packages/db/src/crud/checkout_intent_concurrency.test.ts packages/db/src/crud/settlePaidOrder.test.ts packages/core/src/guestOrderAccess.test.ts --maxWorkers=4 --minWorkers=1
node node_modules/vitest/vitest.mjs run apps/order-bot/test/handlers.test.ts packages/outbox-dispatcher --maxWorkers=2 --minWorkers=1
npx.cmd --yes pnpm@9.15.9 -r typecheck
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit
node node_modules/tsx/dist/cli.mjs scripts/build-bundle.ts
node node_modules/tsx/dist/cli.mjs scripts/check-migration-drift.ts
node node_modules/tsx/dist/cli.mjs scripts/check-migration-timestamps.ts
node node_modules/tsx/dist/cli.mjs scripts/check-frontend-boundaries.ts
node node_modules/tsx/dist/cli.mjs scripts/check-detection-engine-purity.ts
npx.cmd --yes pnpm@9.15.9 audit --prod --json
git diff --check
```

Build dari masing-masing `apps/storefront/client` dan `apps/web-admin/client`: `node node_modules/vite/bin/vite.js build`. Lint storefront: `node node_modules/eslint/bin/eslint.js .` dari direktori client.

## Hasil dan riwayat

- Tes fokus awal:PASS7/7 pada2file.
- Suite sebelum update dependency:1550PASS/4FAIL dari1554 pada42file. Penyebab:2asersi URL email lama belum memeriksa token;1pesan batas jumlah file berubah;1asersi teks bantuan UI lama. Parser error jumlah file diperbaiki sesuai API lama, email test kini memverifikasi signature/order scope, UI text test disesuaikan. Rerun8file:PASS288/288.
- Run harness dengan LOG_LEVEL=silent gagal collect karena nilai enum env tidak valid; diulang dengan error. Run terputus saat agen kena usage limit tidak dihitung sebagai PASS suite lengkap.
- Typecheck awal gagal karena error handler membaca unknown; diperbaiki dengan type guard. Upgrade static10 menuntut FastifyReply.header sebagai pengganti SetHeadersResponse/setHeader; kedua host disesuaikan.
- Build kedua SPA dan bundle server:PASS. Warning ukuran chunk dan CheckoutPage imported static/dynamic masih ada; bukan error build dan tidak diubah dalam patch keamanan.
- Lint storefront:PASS. Boundary frontend, timestamp migrasi, purity detection engine:PASS. Migration drift pada DB dummy:PASS (`No difference detected`).
- Audit fase pertama exit1: awal1critical/41high/40moderate/4low, sesudah update terarah0critical/33high/35moderate/4low. Hasil historis33 high tersimpan pada dependency-audit-before.json. Remediasi lanjutan menghasilkan audit produksi exit0, seluruh kategori0; dependency-audit.json sekarang memuat hasil terbaru. Pada akhir fase33, audit all masih12findings; remediation tooling berikutnya menyelesaikan seluruhnya menjadi0, dijelaskan pada DEVELOPMENT_TOOLING_REMEDIATION.md.

## Hasil final pada lockfile terbaru

| Pemeriksaan | Hasil |
|---|---|
| Suite storefront/admin/payment/wallet/core/UI,42file | PASS1554/1554, exit0,293.01detik |
| Handler bot + outbox,5file | PASS593/593, exit0,159.61detik |
| Header final owner/admin attachment + storefront/settings admin,3file | PASS150/150, exit0,19.81detik |
| Workspace recursive typecheck + tsconfig.test | PASS, exit0 |
| Storefront/admin Vite build + server bundle | PASS, exit0 |
| Git diff whitespace check | PASS, exit0 |
| pnpm9 offline/frozen-lockfile install | PASS, exit0; lockfile up to date |
| Lint storefront final | PASS, exit0 |

Total2147kasus unik pada47file suite utama;150kasus header adalah pengulangan subset dan tidak dijumlahkan sebagai kasus unik tambahan. Setelah suite utama lulus, regression header baru memperlihatkan public max-age=0 menimpa no-store pada attachment200. Perbaikan dipindahkan ke callback setHeaders final kedua host;150kasus subset kembali lulus, termasuk header owner/admin, nosniff, akses anonim/B dan encoded paths. Suite luas tidak diulang setelah perubahan header terakhir; subset mencakup kedua server, dan typecheck/bundle diulang.

Container pengujian telah dihentikan setelah seluruh proses selesai; tidak menyisakan listener PostgreSQL baru yang berjalan. Ringkasan hasil tersimpan di dokumen ini; log sementara root dibersihkan, output audit dependency tetap tersedia dalam repository.

## Cakupan asersi nyata

| Kasus | Bukti suite / batas |
|---|---|
| A/B orders/tickets/reply/attachment/SSE | spa-api, support-api, security-hardening, apiOrderDigiflazzStream; owner sukses, stranger404, DB reply forged tetap0 |
| Admin/cookie/role/revoke | web, settings-security-api, security-hardening; allowlist dicabut langsung menolak file; existing CSRF/RBAC tests |
| Telegram palsu/expired/future | security-hardening + storefront auth tests; hash sah diterima, tamper/future ditolak |
| Price/discount/FX/wallet | api, spa-api, checkout-minimums, topup-order-api, wallet-topup-api, settlePaidOrder; snapshot nominal tidak berubah |
| Callback signature/reference/amount/replay | tokopay-webhook, paydisini-webhook, nowpayments-webhook, digiflazz-webhook; provider mock, underpayment/manual review dan terminal guards |
| Race/double spend/duplicate | wallet_concurrency, wallet_cart_checkout_concurrency, checkout_intent_concurrency, checkout-gateway-race; PostgreSQL nyata |
| Guest abuse tetap kompatibel | guest-checkout-api, rate-limit-guest, track-api/global-cap, guest-order-email; token order bound/expiry/tamper unit tests |
| Upload/mass assignment/DoS | security-hardening, support-api, spa-api; image magic, jenis/jumlah/ukuran file, invalid body,413, random/path alias dan limiter count |
| Proxy spoof | security-hardening; header XFF/CF pada TCP peer nonproxy tidak memberi quotaIP baru, IPv6 identity quota |
| UI recovery | TrackOrderPage/OrderDetailPage; payload token+kode, kegagalan generik dan navigasi |
| Ticket XSS | Upload SVG/image magic ditolak, judul SVG disimpan sebagai data; renderer JSX ditinjau. Tidak ada browser E2E eksekusi XSS baru dalam audit ini |
| SQLi/SSRF | Query ORM/raw parameterization ditinjau. Tidak ditemukan customer arbitrary-URL fetch; tidak membuat tes SSRF fiktif. Bukan coverage penuh semua laporan/admin |

## SKIPPED dan batas

Fase pertama memakai subset. Pada remediation dependency lanjutan, full monorepo suite580file telah dijalankan; hasil dan pengujian ulang setelah perbaikan dicatat di bawah. Tidak melakukan pentest produksi, scan domain/VPS, provider live, load test produksi, migrasi/destructive cleanup produksi, browser E2E payment widget/Cloudflare maupun benchmark memory jangka panjang. Tidak ada klaim percentage coverage; tidak menganggap tes snapshot sebagai bukti authorization. CSP enforcement/Turnstile baru tidak diimplementasikan. Retained cache, origin bypass, packet routing, provider retry dan NAT quotas wajib staging/manual sesuai rollout.

## Verifikasi remediasi dependency lanjutan

Tanggal8 Oktober2026; pnpm9.15.9, Node26.4.0, PostgreSQL16 dummy pada127.0.0.1:55479. Full suite menggunakan command berikut:

```powershell
node node_modules/vitest/vitest.mjs run --maxWorkers=4 --minWorkers=1
```

Run seluruh580file selesai1700.38detik:576file lulus,4file gagal;10626tes lulus,25gagal dari10651. Exit1 dicatat sebagai hasil awal, tidak diganti menjadi exit0 atau disembunyikan. Empat penyebab:

- order-overpayment-api:16gagal karena session fixture Telegram999 tetapi allowlist mock444. Fixture kini allowlist444,999; authorization produksi tetap ketat. Rerun17/17 lulus.
- storage-api:4gagal karena fixture998 di luar allowlist setup999,1000. Fixture memakai999; rerun6/6 lulus.
- bootstrap:1gagal karena metadata baru route memuat concrete Telegram webhook secret walau path sudah disamarkan. Kedua server kini menerapkan redactPath juga pada route; rerun bootstrap11/11 plus redaction kedua aplikasi5/5 lulus.
- integrity:4gagal karena test mengasumsikan tabel dalam schema public database dummy, sedangkan harness lain membuat schema isolated. Jalankan prisma db push --skip-generate hanya pada database dummy loopback, tanpa accept-data-loss. Tidak mengubah implementation integrity. Rerun5/5 lulus.

Regresi gabungan terakhir menjalankan keempat file dan dua file redaksi log pada tree akhir:44/44 pada6file, exit0. Dengan run lengkap dan rerun ini, seluruh10651kasus unik memiliki hasil lulus. Full suite580file tidak diulang sebagai satu command setelah perbaikan; regresi diulang pada semua file gagal dan jalur redaksi terkait. Tidak menjumlahkan44rerun sebagai kasus unik tambahan.

| Pemeriksaan akhir | Hasil |
|---|---|
| Audit produksi, tanpa mute | PASS exit0; critical/high/moderate/low0 |
| Audit all termasuk dev (fase33 historis) | Exit1;3critical/1high/7moderate/1low; kini resolved, lihat fase tooling di bawah |
| Semua workspace typecheck + tsconfig.test | PASS exit0; diulang setelah fix log |
| Storefront lint | PASS exit0 |
| Storefront dan admin Vite build | PASS exit0 |
| Server bundle | PASS exit0; diulang setelah fix log |
| Migration drift/timestamp, frontend boundaries, detection purity | PASS exit0 |
| pnpm9 offline frozen lockfile install | PASS exit0; lockfile up to date |
| Nodemailer real library JSON transport smoke | PASS; subject Unicode,recipient,text,HTML,recovery fragment preserved; tanpa jaringan |
| Independent review Astra high | Tidak ada temuan pada dependency remediation, CSS/license, fix log dan fixture overpayment |

CSS vendored diverifikasi byte-identik dengan shadcn4.11.0. SMTP/provider live, pentest produksi dan deploy tetap belum dijalankan. Setelah pengujian, dummy container dihentikan dan log sementara dibersihkan; bukti audit JSON dan laporan ini dipertahankan. Push git tidak berarti deploy produksi telah dilakukan.

## Verifikasi akhir seluruh tooling development

Vitest4.1.11 dan coverage4.1.11; seluruh580file/10651tes lulus,0failed,0skipped. Full suite dipartisi menjadi2project yang disjoint. Frontend exit0; run backend awal exit1 karena6beforeAll setup PostgreSQL melewati hook default10detik, tanpa kegagalan asersi.343file/8008tes lulus,497tes pada6file belum dijalankan. hookTimeout ditetapkan30detik (testTimeout20detik tetap) dan seluruh6file diuji ulang dengan2worker:497/497lulus,exit0. Full backend349file tidak diulang sebagai satu command setelah perubahan hooktimeout. Hasil run dan rerun berikut meliputi580file/10651tes unik tanpa pendingfailure atau skipped akhir:

| Project | File | Tes | Durasi |
|---|---:|---:|---|
| node | 343 | 8008 | 1337.72s (transform 26.59s, setup 0ms, import 1348.89s, tests 3829.30s, environment 1.85s) |
| frontend | 231 | 2146 | 662.30s |
| hooks | 6 | 497 | 67.07s (transform 2.56s, setup 0ms, import 5.42s, tests 126.45s, environment 1ms) |

Command node: `node node_modules/vitest/vitest.mjs run --project=node --maxWorkers=4 --reporter=verbose`. Command frontend: `node node_modules/vitest/vitest.mjs run --project=frontend --maxWorkers=2 --reporter=verbose`. Rerun hook: command run scripts/backfill-stock-traceability.test.ts packages/db/src/crud/catalog.test.ts packages/db/src/crud/orders.test.ts packages/db/src/crud/revenue.test.ts packages/db/src/crud/settlePaidOrder.test.ts packages/db/src/crud/wallet_topup.test.ts --project=node --maxWorkers=2 --reporter=verbose. Shared DATABASE_URL_PRISMA hanya PostgreSQLdummy loopback55479; tidak ada providerlive atau produksimigration. Inventory580unique cocok dengan globsVitest2, tanpa filemissing/extra. Runmigrasi awal dihentikan saat menemukan mocklifecycleincompatibility dan tidak dihitungPASS. Regresired/green tercakup penyesuaianfixture denganasersi tetap; testvoucherphase juga menunggu renderedrefetch agar tidak bocor.

Audit prod dan all exit0, critical/high/moderate/low seluruh0, advisories/mutedkosong; produksi300dependency, seluruhgraph676dependency. Bukti JSON sebelum/sesudah dipertahankan. VersiVitest2/Vite5/tinypool1/esbuildlama/parser7.1.4 tidak ada dalamlockfileakhir.

Typecheckworkspace/testTS, lintstorefront, buildduaSPA, serverbundle,4guards danofflinefrozeninstall PASSexit0. Coverage providerV8baru:15file170tesPASS, statements94.62%,branches94.08%,functions100%,lines94.53%; threshold90dipertahankan. Coverage smoke memakai `run packages/core/src/detection --project=node --maxWorkers=1 --coverage --coverage.include=packages/core/src/detection/**`; tidak mengklaim angka ini sebagai coverage seluruhmonorepo. Summarytersimpan pada development-tooling-test-summary.json dan development-tooling-coverage-summary.json.

Review independen Astrahigh tidak menemukan masalah pada graphdependency, projectinheritance/discovery, fixturelifecycle atau targetbrowser. BuildtargetSafari naik14 ke14.1 secaraeksplisit untuk compatibilitycompilerpatched; lainnya tetapdefaultVite6. Tidak ada BrowserE2ESafari dilakukan. Dummycontainer dihentikan sesudahtes; logtemporarydibersihkan. Commit/push sesuaiinstruksi pengguna tidak disamakan dengandeployproduksi.
