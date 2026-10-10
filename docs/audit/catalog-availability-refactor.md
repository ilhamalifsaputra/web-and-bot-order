# Refactor katalog dan pengamanan credit pesanan

## 1. Audit dan akar masalah

- Katalog memakai model `Category → Product → Denomination`; `Category.group` membedakan Game Top Up dan Premium Apps. Kategori lama tanpa group tetap mengikuti resolver Premium Apps (`packages/core/src/services.ts`).
- `Denomination.deliveryType` dan `autoDeliverySource` menentukan pemenuhan. Sebelumnya beberapa tampilan hanya memeriksa `deliveryType === auto`, sehingga SKU Digiflazz dengan stok lokal kosong tampak habis meskipun backend menerima pembeliannya.
- Pembelian di `packages/db/src/crud/orders.ts` sejak awal melewati reservasi stok untuk SKU Digiflazz/manual. Tampilan storefront, bot, stok admin, flash sale, dan peringatan stok perlu mengikuti keputusan yang sama.
- Pesanan Digiflazz `PROCESSING` masih dapat dikreditkan melalui `creditOrderToBalance`. Credit membatalkan pesanan, sedangkan supplier dapat tetap mengirim top-up. Akibatnya pembeli bisa memperoleh saldo sekaligus top-up.

## 2. Keputusan arsitektur

`packages/core/src/productAvailability.ts` memusatkan sumber pemenuhan (`INTERNAL_INVENTORY`, `PROVIDER_API`, `MANUAL`) dan kelayakan stok. Sumber provider mengungguli delivery type. Produk, kategori, dan SKU nonaktif tetap tidak dapat dibeli. Stok yang belum dimuat menjadi `UNKNOWN` hanya untuk inventory lokal.

Kelayakan membeli SKU provider mengikuti kontrol publikasi yang tersedia; ini bukan jaminan stok supplier real-time. Tidak ada panggilan Digiflazz per kartu atau render. Sinkronisasi provider tidak diubah.

Data katalog tetap terpadu. Registry keluarga pada admin mengatur tab dan filter berdasarkan group kategori, tanpa menebak dari nama produk. Identitas keluarga tidak menentukan apakah SKU menggunakan inventory.

## 3. Perubahan implementasi

- **Backend/domain:** resolver sumber pemenuhan dipakai pada pengecekan stok, low-stock alerts, flash sale, data storefront, dan API admin. Subscription restock ditolak untuk SKU provider/manual.
- **Admin:** tab All Products/Game Top-Up/Digital Apps, kategori mengikuti keluarga, status stok netral bagi provider/manual, sorting stok rendah mengutamakan inventory, dan default form sesuai keluarga. SKU non-inventory diarahkan ke katalog; tautan stok langsung tidak menawarkan unggah/download kredensial. Endpoint unggah stok menolak SKU non-inventory. Drawer mobile tampil di atas header agar tombol tutupnya dapat disentuh.
- **Storefront:** payload menyediakan `purchasable` dan `uses_local_inventory`; kartu, pemilih paket, cart, dan checkout mengikuti keputusan server. SKU provider/manual tidak memakai batas jumlah dari stok lokal dan tidak menawarkan restock alerts.
- **Telegram:** picker Premium Apps tetap dipertahankan; catalog/checkout tidak menganggap stok provider kosong sebagai kehabisan stok. Panel admin menampilkan sumber pemenuhan, menu unggah hanya berisi SKU inventory, dan callback stok lama ditangani dengan satu edit. Detail game tidak menampilkan tipe akun, durasi, atau garansi aplikasi. Daftar produk admin membaca hitungan stok dengan satu agregasi, bukan query per SKU.
- **Credit:** guard dijalankan setelah kunci row pesanan `FOR UPDATE`, sebelum perubahan wallet/ledger/status. Pesanan Digiflazz queued/submitting/pending tidak dapat dikreditkan; pesanan CANCELLED yang sudah diserahkan ke supplier juga dikunci selama hasilnya belum failed. Credit pada MANUAL/STOCK dan Digiflazz failed tetap tersedia. UI dan API memakai aturan sama; SSE memuat ulang eligibility saat status provider berubah ke/dari failed.
- **Database:** tidak ada perubahan schema, backfill, penghapusan stok historis, atau perubahan nominal/pricing.

## 4. Matriks perilaku

| Kemampuan | Game melalui provider | Apps inventory | Apps manual/API |
|---|---|---|---|
| Perlu stok lokal positif | Tidak | Ya | Tidak |
| Reservasi inventory | Tidak | Ya | Tidak |
| Badge stok dan restock alert | Tidak | Ya | Tidak |
| Unggah kredensial stok | Tidak | Ya | Tidak |
| Input pembeli | Metadata game/SKU | Sesuai konfigurasi aplikasi | Sesuai konfigurasi aplikasi |
| Pemenuhan | Lifecycle supplier | Alokasi stok | Manual/provider sesuai SKU |
| Credit saat Digiflazz masih in-flight | Ditolak | Jalur credit biasa | Ditolak bila melalui Digiflazz |

## 5. Pengujian dan verifikasi

Verifikasi memakai database PostgreSQL khusus sesi; tidak menjalankan bot poller atau transaksi produksi. Test regresi mencakup resolver, API, picker/cart, keluarga legacy, inventory, credit, pesan bot, serta SSE eligibility.

| Pemeriksaan | Hasil |
|---|---|
| `pnpm -r build` | Lulus; bundle admin dibangun ulang setelah perbaikan drawer |
| `pnpm typecheck` penuh setelah sinkronisasi master | Lulus |
| Test terarah bot, conversation, API stok, dan halaman stok | 5 file, 548 test lulus |
| Test kemampuan inventory admin setelah perubahan terakhir | 9 test lulus |
| Playwright katalog dan tautan stok provider, viewport 360/1440 | 4 test lulus |
| Pretest suite penuh: migration drift/timestamps, frontend boundaries, lint storefront, detection purity | Lulus |
| `pnpm test` penuh | Belum selesai; pengguna meminta merge dan push segera sebelum hasil akhir tersedia |

Suite penuh tidak diklaim lulus. Integrasi dipercepat sesuai instruksi pengguna. Bukti visual tersedia untuk [mobile](catalog-availability/catalog-mobile.png) dan [desktop](catalog-availability/catalog-desktop.png).

## 6. Deployment dan rollback

Deploy server dan kedua bundle SPA dari revisi yang sama; build melalui `pnpm -r build`, lalu restart layanan sesuai prosedur deployment proyek. Tidak diperlukan migrasi database untuk perubahan ini. Jangan menjalankan dua poller order-bot dengan token yang sama.

Rollback menggunakan revisi rilis sebelumnya untuk server dan bundle bersama-sama. Rollback juga membuka kembali celah credit yang diperbaiki di sini; selama rollback, hindari credit pada pesanan yang masih diproses supplier. Tidak ada data historis yang perlu dikembalikan.

## 7. Batasan dan tindak lanjut

- Sync Digiflazz sengaja ditunda. SKU yang hilang dari price list masih memerlukan kebijakan penonaktifan dan perlindungan terhadap daftar parsial.
- `createRefund`/`executeRefund` merupakan jalur berbeda dari credit. Keduanya masih memungkinkan refund pada pesanan provider yang sedang in-flight; kebijakan refund ini belum diubah dalam pekerjaan catalog/credit.
- Pesanan lama yang sudah terlanjur dikreditkan saat supplier masih pending tidak diperbaiki otomatis; perlu rekonsiliasi terpisah.
- Hitungan antrean manual memuat pesanan PROCESSING lalu memfilter provider in-flight. Optimasi query dapat dilakukan bila volume antrean meningkat.
- Endpoint riwayat stok tetap mempertahankan data dan relasi lama; perubahan UI tidak menghapusnya.
