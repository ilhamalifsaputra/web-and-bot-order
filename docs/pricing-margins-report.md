# Laporan Pricing & Margins

## Ringkasan audit awal

Pekerjaan ini melanjutkan T1–T3 dari sesi yang terhenti, melalui branch baru `worktree-pricing-margins-finish`. Worktree lama `pricing-margins` yang terkunci tidak diubah.

Markup sebelumnya tersimpan pada Setting `digiflazz_markup_type` dan `digiflazz_markup_value`, lalu diterapkan saat import/sync ke `Denomination.price`. Nilai 15% berasal dari konfigurasi produksi, bukan default kode. Kedua key tetap digunakan; tidak ada seed atau backfill yang mengganti nilainya.

Override berada pada `Denomination.priceOverridden`. PATCH katalog sebelumnya menghitung ulang flag pada setiap edit, sehingga perubahan nama setelah kebijakan berubah dapat salah menjadikan harga otomatis sebagai manual. PATCH kini mempertahankan flag bila harga/HPP tidak berubah dan menyediakan mode eksplisit.

## Perubahan yang diimplementasikan

- Menu `/pricing`: default global, markup persen/nominal IDR, pembulatan, ambang peringatan margin, aturan kategori, preview server, serta preview dampak dan penerapan harga.
- POST/PUT/DELETE pricing menggunakan autentikasi, CSRF dan izin super-admin. Role lain memperoleh tampilan baca saja. Preview tidak menyimpan kebijakan.
- Settings tetap menampilkan koneksi Digiflazz; editor markup dipindahkan dan endpoint edit Settings menolak perubahan key pricing. Ekspor/impor tetap membawa key lama.
- Import/sync/preview Digiflazz dan edit harga admin bot memakai aturan kategori dan pembulatan yang sama. Pemilihan kategori pada wizard memperbarui saran harga tanpa menjalankan sync baru.
- Katalog admin menampilkan sumber harga, HPP, harga hasil aturan, harga aktif, estimasi laba/margin dan peringatan. Harga aktif menggunakan nilai tersimpan, termasuk ketika aturan baru belum diterapkan.
- SKU Digiflazz Game Top Up menyediakan mode Otomatis/Manual. Premium Apps dan kategori legacy yang diperlakukan sebagai Premium Apps tetap manual; HPP kosong ditampilkan sebagai belum tersedia.
- Penyimpanan kebijakan global/kategori dan audit bersifat atomik. Pembacaan kebijakan global memakai satu snapshot DB agar tipe dan nilai markup tidak tercampur antara dua versi.

## Berkas yang diubah

| Path | Perubahan | Alasan |
|---|---|---|
| `packages/core/src/pricingRule.ts`, `.test.ts`, `packages/core/package.json` | Added / Modified | Resolver Decimal, pembulatan, margin, parser nilai tersimpan dan ekspor modul. |
| `packages/db/src/crud/pricingPolicy.ts`, `.test.ts`, `packages/db/src/index.ts` | Added / Modified | Persistensi aturan, audit, preview dampak, penerapan dengan lease dan row lock. |
| `packages/db/src/crud/settings.ts` | Modified | Invalidasi cache setelah commit atomik. |
| `packages/db/src/crud/digiflazz.ts`, `.test.ts` | Modified | Integrasi resolver pada import, sync, auto-add dan override. |
| `prisma/schema.prisma`, `prisma/migrations/20261011090000_category_markup_rule/migration.sql` | Modified / Added | Kolom aturan kategori nullable. |
| `apps/web-admin/src/routes/api/pricing.ts` | Added | API pricing dan validasi. |
| `apps/web-admin/src/lib/catalogPricing.ts` | Added | Metadata pricing khusus admin dengan harga aktif tersimpan. |
| `apps/web-admin/src/routes/api/catalog.ts`, `digiflazzSync.ts`, `settings.ts` | Modified | Mode SKU, metadata, preview kategori dan pemisahan editor Settings. |
| `apps/web-admin/src/plugins/auth.ts`, `src/server.ts` | Modified | Izin super-admin untuk mutasi dan registrasi rute. |
| `apps/order-bot/src/conversations/admin.ts` | Modified | Kategori diberikan pada pemeriksaan override harga. |
| `apps/web-admin/client/src/pages/PricingPage.tsx`, `.test.tsx` | Added | Halaman kebijakan, preview yang menolak respons kedaluwarsa, kategori dan apply. |
| `apps/web-admin/client/src/components/catalog/PricingSummary.tsx` | Added | Ringkasan harga/margin dan peringatan. |
| `apps/web-admin/client/src/pages/DenominationEditPage.tsx`, `ProductDetailPage.tsx`, `DigiflazzSyncPage.tsx`, `SettingsPage.tsx` beserta tesnya | Modified | Integrasi pricing pada UI yang sudah ada. |
| `apps/web-admin/client/src/components/layout/Sidebar.tsx`, `.test.tsx`, `client/src/App.tsx` | Modified | Navigasi dan lazy route `/pricing`. |
| `apps/web-admin/client/src/api/client.ts` | Modified | AbortSignal preview dan helper PUT. |
| `apps/web-admin/test/pricing-api.test.ts`, `catalog-denomination-edit.test.ts`, `digiflazz-sync-api.test.ts`, `settings-money-input.test.ts` | Added / Modified | Validasi, izin, audit, regresi override, preview dan pemisahan Settings. |
| `docs/pricing-margins-tasks.md`, `docs/pricing-margins-report.md` | Added | Checklist kelanjutan dan laporan verifikasi/rollout. |

## Aturan prioritas harga aktual

Untuk SKU otomatis: aturan kategori menggantikan global; markup dihitung dari HPP, kemudian dibulatkan sesuai kebijakan. Harga manual SKU mengalahkan keduanya. Tanpa HPP, harga tersimpan dipertahankan dan margin tidak dibuat-buat.

Menyimpan aturan tidak langsung mengganti harga katalog. Sync berikutnya atau tindakan Terapkan sekarang mematerialisasikan hasil aturan. UI membedakan harga hasil aturan dari harga jual aktif dan menghitung margin aktif dari harga tersimpan. Diskon, reseller, checkout, FX dan snapshot pesanan mempertahankan alur yang sudah ada.

Override tingkat Product tidak ditambahkan: model Product tidak mempunyai harga jual; harga berada pada Denomination/SKU.

## Database, deployment dan rollback

Migrasi `20261011090000_category_markup_rule` menambahkan `categories.markup_type TEXT` dan `categories.markup_value DECIMAL(65,30)`, keduanya nullable. Tidak ada perubahan harga/backfill. Setting pembulatan yang belum diisi berarti `none`.

Sebelum menjalankan kode baru di produksi, terapkan migrasi menurut prosedur proyek dan restart order-bot. Rilis admin client bersama server karena payload uang prefilled memakai `exact_fields`. Tidak ada deployment atau pemanggilan provider produksi yang dilakukan oleh pekerjaan ini.

Rollback kode tidak memerlukan penghapusan kolom/Setting baru; simpan datanya. Harga yang sudah diterapkan adalah harga tersimpan dan tidak otomatis kembali ketika kode di-rollback. Periksa audit `pricing_global_update`, `pricing_category_rule_set`, `pricing_category_rule_clear`, `pricing_reprice`, serta log sync bila ada ketidaksesuaian harga.

## Validasi dan hasil pengujian

Database lokal terisolasi pada port 5549; browser mengakses admin lokal pada 8319. Provider tidak dipanggil saat pengujian browser.

| Command / Test | Hasil | Detail |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | Dependensi worktree tersendiri. |
| `pnpm prisma:generate` | PASS | Client sesuai schema tambahan. |
| `pnpm -r build` | PASS | Build awal kedua SPA; peringatan ukuran chunk tetap ada. |
| `pnpm exec prisma db push` | PASS | Hanya DB worktree lokal. |
| `pnpm exec vitest run apps/web-admin/test/catalog-denomination-edit.test.ts apps/web-admin/test/digiflazz-sync-api.test.ts apps/web-admin/test/settings-money-input.test.ts` | PASS | 130 tes pada pemeriksaan awal. |
| Tes terfokus API pricing dan `PricingPage.test.tsx` | PASS | 18 tes, termasuk preview race, izin, validasi, save/reload dan kategori. |
| Tes terfokus UI katalog, Settings, Sidebar dan wizard | PASS | Setelah memperbarui ekspektasi pemindahan kontrol dan preview kategori. |
| Tes `pricingPolicy`, Digiflazz dan sync API | PASS setelah perbaikan guard | Guard pembacaan tetap O(1) disesuaikan dari getSetting terpisah ke satu query snapshot; pengujian guard ulang lulus. Tes atomisitas rollback lulus. |
| `pnpm --filter @app/web-admin-client build` | PASS | Build final untuk uji browser. |
| Playwright smoke melalui `.audit-data/pricing-margins/smoke.mts` | PASS | Desktop 1440px, mobile 375px, preview server, save/reload, impact/apply, SKU game manual, Premium Apps, tanpa overflow horizontal/page error. |
| `pnpm typecheck` | PASS | Typecheck seluruh paket dan tes setelah field username fixture diperbaiki. |
| `pnpm test` pertama | 11.448 PASS, 9 FAIL | 610/611 berkas lulus. Satu berkas Digiflazz identity menemukan konstanta pricing yang tertangkap sebelum siklus import selesai. Kegagalan direproduksi pada berkas itu sendiri lalu diperbaiki dengan pembacaan key saat fungsi dipanggil. |
| Tes ulang `digiflazzIdentityArchive` dan `pricingPolicy` | PASS | 52 tes lulus setelah perbaikan urutan inisialisasi modul. |
| `pnpm typecheck` dan `pnpm test` final | PASS | Seluruh typecheck lulus; 611 berkas dan 11.457 tes lulus dalam 708,85 detik. Termasuk migration drift, timestamp, frontend boundary, lint dan detection purity. |

Bukti browser dan salinan log disimpan lokal di `C:/Users/ilham/Documents/pricing-margins-evidence-20261011`, di luar worktree agar tetap tersedia setelah cleanup.

## Risiko residual dan langkah manual

- Perubahan aturan menunggu sync/penerapan eksplisit; preview dampak adalah estimasi sebelum eksekusi, yang memeriksa ulang kelayakan SKU saat mengunci baris.
- Harga reseller di atas retail setelah repricing, cache FX bot, dan field harga mentah API publik merupakan batasan lama di luar perubahan ini.
- Margin katalog adalah estimasi kotor sebelum biaya/diskon/refund; bukan laba bersih transaksi.
- Review dilakukan pada sesi Codex ini. Review Opus terpisah yang tercantum pada rencana sesi Claude tidak dijalankan. Merge dan push akan didelegasikan ke Luna sesuai instruksi pengguna setelah gate penuh lulus.

## Acceptance criteria

Implementasi menu, persistensi, preview, aturan kategori, mode SKU, pemisahan Premium Apps, keamanan dan audit: PASS berdasarkan tes terfokus dan browser. Gate penuh sebelum integrasi: PASS. Merge/push didelegasikan ke Luna sesuai instruksi pengguna. Deployment produksi: NOT RUN, di luar tindakan yang dijalankan. Product-level override: NOT IMPLEMENTED karena model Product tidak menyimpan harga.
