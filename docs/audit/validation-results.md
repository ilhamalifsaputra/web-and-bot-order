# Hasil validasi

Environment: Windows, Node 26.4.0, pnpm 9.15.9, PostgreSQL lokal; database
`trustance_readiness_20261010` khusus worktree, schema browser `readiness_audit`.
Tidak memakai akun/order pelanggan. Port 8239/8240; bot/outbox tidak dijalankan.

| Perintah / pemeriksaan | Status | Catatan |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | Lockfile tidak berubah |
| `pnpm prisma:generate` | PASS | Client di worktree |
| `pnpm -r build` | PASS | Admin + storefront dibuat sebelum tes |
| `pnpm --filter @app/storefront-client lint` | PASS | ESLint |
| `pnpm --filter @app/storefront-client typecheck` | PASS | Package yang diubah |
| Focused frontend | PASS | BrandLogo, footer, home, privacy, auth, Layout; assertion lama disesuaikan copy baru |
| Focused copy/error | PASS | 44 tes Layout/BrandLogo/commerceCopy; 10 tes ErrorPage/StatusScreen |
| Focused backend | PASS | 28 tes SEO; 15 tes payment flags/context |
| `pnpm exec playwright test -c tests/audit/readiness.playwright.config.ts` | PASS | 5 tes, 55,9 detik; 125 observasi route/viewport, search, guest checkout, akun sintetis, footer/keyboard dan logo |
| `pnpm typecheck` | PASS | Seluruh package + tsc tsconfig.test.json, setelah fetch/rebase master |
| `pnpm test` | BLOCKED | Gate penuh setelah sync master |
| Firefox/WebKit | SKIPPED | Browser tersedia Chromium; tidak menambah dependency |
| Transaksi produksi / akun nyata | SKIPPED | Di luar batas audit; checkout browser berhenti sebelum pembayaran |
| Smoke console + sampel performa lokal (focused Playwright) | PASS | 2 tes; 125 route diulang untuk console, LCP/CLS awal pada 390/1440px; 6 skenario browser unik keseluruhan |
| CWV lapangan / INP / sertifikasi WCAG | SKIPPED | Sampel lab singkat dan kontras token bukan pengukuran lapangan/sertifikasi |

Build memperingatkan chunk besar dan impor CheckoutPage statis/dinamis yang
sudah ada. Warning pnpm tentang lokasi overrides dan Node localStorage bersifat
tooling; tidak mengubah konfigurasi/lockfile untuk task rebrand.

Run Playwright awal mengungkap asumsi test yang perlu dikoreksi: `/help` meminta
login dan CTA cart mobile berbentuk button. Audit juga menemukan judul 404/500
hanya paragraf; kini h1 dengan tes. Hasil gagal awal tidak dilaporkan sebagai PASS. Lima check reset memakai
limiter IP auth yang sama dengan login; skenario login dipindah sebelum check
tersebut, tanpa mengubah proteksi produksi. Typecheck awal menemukan tuple
viewport dan penempatan opsi reducedMotion pada skrip audit; keduanya diperbaiki.
Build storefront terakhir sesudah perbaikan kontras footer juga PASS (8,17 detik).
Full run awal mendeteksi assertion empty-state akun yang masih mengharapkan
credentials global; direproduksi sendiri dan diperbaiki (19/19 focused PASS).
Tes canonical/email-link juga mengharapkan public URL tidak diset; URL browser
lokal dipindah ke env webServer Playwright agar tidak mencemari unit tests.
Tes canonical + settlePaidOrder lulus ulang 223/223 setelah pemisahan URL.
Tes integrity mengakses schema dasar database lokal, bukan schema sintetis
browser. Schema public database audit disiapkan dengan Prisma (source schema
tidak berubah); lima tes integrity kemudian lulus ulang. Full run awal:
594/598 file lulus, 11.113/11.121 tes lulus dan 8 gagal (1 assertion copy, 3 URL
setup, 4 database setup). Seluruh file gagal sudah diverifikasi sendiri setelah
koreksi. Gate penuh diulang karena run awal belum hijau.
Kode perhitungan uang/fulfillment tidak diubah untuk mengatasi setup tersebut.

Screenshot `before-*` dan `after-*` memakai fixture yang sama tanpa logo upload,
untuk membandingkan fallback dan footer secara adil. Screenshot `after-owner-logo-*`
memakai salinan byte-identik logo publik lewat intersepsi asset/context saja;
bukan tes aktivasi gateway. Lihat [galeri](ux-screenshots/README.md).

## Menjalankan ulang audit browser

1. Gunakan worktree sendiri dan PostgreSQL lokal dengan database khusus
   `trustance_readiness_20261010`; arahkan DATABASE_URL_PRISMA di `.env` lokal ke
   database tersebut. Jangan gunakan database produksi atau database sesi lain.
2. Set port 8239/8240; jangan menjalankan bot/outbox. Config Playwright
   menetapkan public URL localhost hanya untuk proses browser/server audit.
   Biarkan PUBLIC_URL/SHOP_PUBLIC_URL kosong pada `.env` untuk tes unit existing
   yang secara sengaja menguji kondisi tanpa URL.
3. `pnpm install --frozen-lockfile`, `pnpm prisma:generate`, `pnpm -r build`.
   Sebelum full unit suite, siapkan schema public pada database lokal khusus itu
   dengan `pnpm exec prisma db push --skip-generate`; integrity.test.ts memang
   memeriksa tabel pada database dasar. Pastikan datasource tetap database audit
   lokal sebelum menjalankan perintah tersebut.
4. `pnpm exec playwright test -c tests/audit/readiness.playwright.config.ts`.

Config/seed menolak host non-local atau nama database yang berbeda; hanya schema
`readiness_audit` milik audit yang direset. Run membuat data sintetis, tidak
menghubungi gateway. Fixture logo hanya diintersep pada test browser, bukan
route debug atau asset produksi. `AUDIT_PHASE=before` adalah label capture;
untuk baseline yang sah gunakan kode sebelum patch, bukan menamai kode baru
sebagai before. Dua puluh lima PNG, JSON route/console dan JSON performa awal disimpan tanpa
cookie/trace. Console error resource 401/404 yang disengaja dicatat terpisah dari
exception JS dan error tak terduga.

Sampel performa awal (localhost, tanpa throttle, 1 detik observasi): homepage
390x900px LCP 364ms/CLS 0,0256; 1440x900px LCP 176ms/CLS 0,0651. Hasil bukan p75 dan
bukan audit INP. Nilai dapat berubah menurut cache, font, katalog, jaringan dan
beban mesin; JSON mencatat environment dan raw sample.
