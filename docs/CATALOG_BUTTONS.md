# Catatan: Tombol Katalog Telegram (Top Up Game)

Catatan pekerjaan 1 Oktober 2026 untuk memperbaiki tampilan katalog dan inline keyboard Telegram. Dokumen ini
merangkum **apa yang diubah, kenapa, bagaimana cara kerjanya sekarang, bagaimana diverifikasi, dan apa yang masih
terbuka**. Aturan yang berlaku untuk pekerjaan berikutnya ada di
`.claude/skills/bot-ux-grammy/SKILL.md` (bagian "Inline keyboard button labels") dan ringkasannya di
`.claude/CLAUDE.md` (bagian "Telegram inline keyboard labels").

## 1. Ringkasan

- **Fokus: Top Up Game** (`category.group === "GAME_TOPUP"`). **Premium Apps tidak berubah** (keputusan pemilik
  proyek): pickernya tetap bentuk asli, dan semua aturan penamaan baru di core dibatasi ke `GAME_TOPUP`.
- Tombol katalog game kini ringkas, tidak berkata ganda, memakai ikon dari kamus, dan memakai nomor `#id` hanya
  sebagai langkah paling akhir (selalu dijelaskan di pesan yang sama).
- Batas lebar tombol, kamus ikon dan singkatan, tes penjaga, dan petunjuk batas karakter di kolom admin sudah
  ditulis sebagai aturan di repo, supaya tidak ada tombol yang kelebihan karakter di masa depan.
- Terverifikasi dengan sapuan atas 515 SKU dummy dan 232 nama supplier nyata (`catalogSnapshot.json`), serta
  lima putaran review independen. **Belum** dicek di klien Telegram asli (lihat bagian 11).

## 2. Latar belakang dan pemicu

Prompt acuan: `prompt-codex-perbaikan-katalog-telegram-scalable.md` (di luar repo; berisi gejala, aturan label,
pipeline `Canonical product -> konteks tampilan -> kandidat label -> collision -> layout -> keyboard`, dan kriteria
selesai §12). Gejala awal dari screenshot:

1. label mengulang unit atau qualifier sehingga terlalu panjang;
2. kata seperti `Garena` muncul dua kali;
3. tombol hanya berupa `#98` atau `#203`;
4. pesan berisi daftar lengkap lalu diulang di keyboard;
5. produk terakhir berbagi row dengan Refresh;
6. navigasi Back/Kembali tidak konsisten.

Dua kejadian tambahan yang mengarahkan pekerjaan:

- **CapCut Pro (Premium Apps):** setelah katalog kanonik (commit `bc403360`), picker Premium ikut dirender oleh
  presenter kanonik: body berisi blok `#5 · $0.28 (Stock 5)` dan plan panjang menjadi tombol `#2`. Pemilik proyek
  meminta bentuk asli (tanpa nomor) dikembalikan.
- **Genshin Impact (data dummy):** tombol `#673`, `#680`-`#682` dan label berkata ganda
  `160 Primogems Primogems 160`. Penyebabnya satu kelas masalah (urutan token berbeda, unit di luar daftar parser,
  total yang sudah memuat bonus), jadi diperbaiki sebagai kelas, bukan per game.

## 3. Cara kerja label sekarang (Top Up Game)

File utama: `apps/order-bot/src/util/canonicalPresenter.ts` (presenter), `packages/core/src/canonicalProduct.ts`
(data kanonik), `packages/core/src/unitDictionary.ts` + `unitDisplay.ts` (kamus), `packages/core/src/buttonLimits.ts`
(batas), `apps/order-bot/src/keyboards/customer.ts` (baris keyboard).

- **Kuantitas persis.** `1186+224 💎`, `10K` hanya untuk kelipatan bersih 1000 mulai 10.000. Tidak pernah
  `1186 -> 1.2K`.
- **Kuantitas terstruktur cocok dalam urutan token apa pun.** Unit yang diisi admin (`qtyUnit`) ikut kosakata
  parser untuk SKU itu; total yang sama dengan jumlah `A + B` memverifikasi bonus
  (`6480+1600 Genesis Crystals`).
- **Qualifier dihapus bila sudah tertulis di nama** (`Garena` tidak dua kali), dan header bersama hanya dipakai bila
  seluruh daftar benar-benar berbagi qualifier itu. Seri campuran (`- Garena` pada sebagian SKU) tetap
  dibedakan per tombol.
- **Qualifier yang sudah tertulis di nama produk tidak diulang sama sekali.** Region/variant yang seluruh token-nya
  sudah ada di nama produk (`Indonesia` pada `Valorant (Indonesia)`; token utuh, huruf besar-kecil, tanda kurung dan
  strip diabaikan) tidak muncul di tombol, baris header bersama, header halaman 2+, maupun blok penjelasan `#id`.
  Qualifier yang hanya sebagian ada di nama (`South East Asia` pada `Game (Asia)`) atau berbeda dari nama
  (`Indonesia` pada `Valorant (Malaysia)`) tetap ditampilkan. Ini murni aturan presenter: `qualifiers` di core tidak
  berubah, jadi toko web dan layar detail/konfirmasi tetap menampilkan region.
- **Urutan langkah bila label tidak muat** (berhenti di langkah pertama yang muat **dan** unik dalam daftar):
  bentuk compact/ikon, bentuk lengkap, nama saja, unit milik jumlah itu menjadi ikon (satu frasa saja), singkatan,
  kata unit yang sudah dinyatakan kepala jumlah dibuang, qualifier akhir `- Garena` / `(Global)` dibuang, kata
  awal + `…` + akhir (`Blessing of… Moon x2`), akhir saja, dan baru terakhir `#id`. Kandidat yang mengulang kata
  atau menempatkan dua ikon kamus berdampingan tidak pernah diterima. Tombol yang dipendekkan atau berupa `#id`
  dijelaskan di body halaman yang sama (nama lengkap dan harga exact).
- **Baris keyboard:** produk dulu, lalu Previous/Next, Refresh, dan Back, masing-masing satu baris sendiri. Back dari
  detail kembali ke halaman asal picker, dan Back dari picker (keyboard balasan maupun inline) kembali ke halaman asal
  daftar produk. Keyboard angka 1-5 dan Menu tidak diubah.
- **Callback stabil:** `v1:browse:denom:<id>` (maks 64 byte), tidak pernah diturunkan dari label atau harga.

### Batas lebar (`packages/core/src/buttonLimits.ts`)

| Konstanta | Nilai | Arti |
|---|---|---|
| `MAX_LABEL_WIDTH` | 36 sel | batas keras satu kolom (emoji dan CJK = 2 sel) |
| `TARGET_LABEL_WIDTH` | 32 | target langkah pemendekan |
| `NARROW_LABEL_WIDTH` | 18 | dua tombol per baris hanya bila tidak lebih dari ini |
| `MAX_LABEL_BYTES` | 64 | batas byte |
| `CATALOG_PAGE_SIZE` | 20 | produk per halaman, sama untuk semua game |
| `LIST_LABEL_MAX_CHARS` | 30 | potongan `truncLabel` tombol pencarian/populer/kategori |
| `PLAN_LABEL_MAX_CHARS` | 24 | potongan `truncLabel` picker Premium (dibaca `util/format.ts`) |

Angka 36/32/18 adalah **heuristic** (Telegram memotong menurut piksel; di HP kira-kira 28-34 karakter tebal per
tombol selebar layar). Mengubahnya cukup di satu file, lalu salin ke
`apps/web-admin/client/src/lib/buttonLimits.ts` (klien admin tidak boleh mengimpor `@app/core`; tes di core gagal bila
salinannya berbeda).

## 4. Kamus ikon dan singkatan (`packages/core/src/unitDictionary.ts`)

Data murni (tanpa logika), satu-satunya sumber ikon dan singkatan. Pencocokan: nama utuh per token, tanpa membedakan
huruf besar-kecil, tidak pernah substring (`Weekly Diamond Pass` bukan jumlah diamond; `Gemstone` bukan `Gem`).
Satuan berbeda yang berbagi ikon dieja namanya bila bertemu dalam satu daftar.

| Satuan | Alias | Tampil |
|---|---|---|
| Diamonds | Diamond | 💎 |
| Crystals | Crystal | 💎 |
| Genesis Crystals | Genesis Crystal | 💎 (singkat: `Gen Crystals`) |
| Gems / Primogems / Jewels | Gem / Primogem / Jewel | 💎 |
| Coins / Delta Coins | Coin / Delta Coin | 🪙 |
| Gold | - | 🪙 (pilihan pemilik proyek; sama dengan Coins, jadi dieja bila bercampur) |
| World Lock | World Locks | `WL` |

Singkatan kata saat ini: Genesis -> Gen, Package -> Pkg, Weekly -> Wkly, Monthly -> Mthly. Premium, Membership dan
Subscription **tidak** disingkat (bagian nama resmi paket, mis. `Valorant Indonesia Premium Battle Pass`); dipangkas
lewat branch `dictionary-prune-abbrevs` (bagian 10). Bila label masih terlalu lebar setelah singkatan, langkah
pemotongan (`…`) yang berjalan, bukan singkatan karangan.

Tidak diberi ikon: Tokens, Credits, Points (spesifikasi §5: jangan menyamakan dengan Coins hanya karena mirip),
UC, VP, Bonds, Robux. Ikon Stars dan Tickets sempat ditambahkan lalu dicabut (rawan salah kena nama seperti
"Honkai Star Rail").

## 5. Premium Apps dikembalikan ke bentuk asli

- Picker Premium (kategori selain `GAME_TOPUP`, termasuk grup null) memakai jalur sebelum `bc403360`: body
  `browse.denomination_line` (plan, harga, stok), tombol `denominationPickerKb` dengan `formatDenominationLabel`,
  tanpa `#id`. SKU Premium yang punya `qtyValue/qtyUnit` tetap memakai `gameTopUpDenomLabel`.
- Semua aturan baru di `canonicalProduct.ts` (buang nama produk, urutan token, dedupe qualifier, unit terstruktur)
  dibatasi `isGameTopUp(input)`.
- Bukti invarian: keluaran `canonicalProduct(...)` dan `canonicalName(...)` identik dengan `master` pada 56 SKU Premium
  dummy dan 232 nama snapshot untuk grup Premium, null, dan lainnya (**2312 keluaran, 0 beda**).
- Catatan: tombol Premium (paket dan kategori) dua per baris sampai 24-30 karakter. Itu perilaku lama dan sengaja
  dibiarkan; petunjuk di admin memakai 18 sebagai target "dua tombol sebaris", batas potong aslinya 24.

## 6. Kolom admin dan wizard bot

Komponen `ButtonLabelInput` (`apps/web-admin/client/src/components/shared/`) menampilkan teks bantuan dan penghitung
sel hidup di samping setiap kolom yang teksnya tampil di tombol Telegram. **Batas lunak**: tidak memblokir
penyimpanan, tidak memotong ketikan, tanpa `maxLength`, dan peringatan memakai warna amber. Anggaran diturunkan dari
kode bot di `buttonNameBudget(kind)`:

| Kolom | Anggaran (sel) | Catatan |
|---|---|---|
| Nama produk (tombol pencarian/populer) | 30 | |
| Nama kategori | 18 (15 bila ada emoji) | |
| Game Variant / Game Region | 18 (15 bila ada emoji variant) | |
| Duration Label (paket Premium) | 18 | dua tombol sebaris; potong keras 24 |
| Nama denominasi Game | 24-25 | diukur setelah awalan nama produk; dilewati bila qty dan unit terisi |
| Quantity Unit | 16-17 | |

Wizard bot admin hanya mendapat satu baris petunjuk di prompt label durasi dan prompt rename
(`admin.button_hint_plan`, `admin.button_hint_name`, en dan id): admin tidak bisa mengganti kategori, variant, region,
atau qty unit lewat bot. Setelah perbaikan, peringatan keliru untuk nama game turun dari 379 menjadi 34 dari 515 SKU.

## 7. Aturan di repo dan tes penjaga

- Aturan tertulis: `.claude/skills/bot-ux-grammy/SKILL.md` ("Inline keyboard button labels") dan
  `.claude/CLAUDE.md` ("Telegram inline keyboard labels"); komponen admin dicatat di
  `docs/ui/03_COMPONENT_LIBRARY.md`.
- Tes penjaga: `apps/order-bot/test/keyboard-label-guard.test.ts` (matriks nama panjang, CJK, emoji, `<&>`, angka
  bergrup, SKU hanya beda harga, 1 sampai 83 SKU, id/en, IDR/USD). Memeriksa lebar sel, byte callback, label
  kembar, kata dan ikon berulang, penjelasan di body, urutan baris, dan larangan ikon yang ditulis langsung di
  keyboard di luar kamus. Uji mutasi menangkap kenaikan batas, langkah yang dihapus, dan ikon tertulis langsung.
- Tes kamus: `packages/core/src/unitDictionary.test.ts`; tes batas dan drift salinan klien:
  `packages/core/src/buttonLimits.test.ts`.
- Keterbatasan penjaga: tombol statis dari file locale (`← Back`, `Refresh`) pendek dan tidak disapu; tombol buatan
  baru di handler lain hanya ditahan oleh aturan tertulis.

## 8. Hasil verifikasi

**Tes:** typecheck exit 0; `scripts/check-frontend-boundaries.ts` lulus; tes terkait 77 file / 1897 tes lulus.
Suite penuh terakhir yang dijalankan pada basis pekerjaan ini: 506 dari 507 file lulus; satu-satunya gagal
`apps/web-admin/test/storage-api.test.ts` (`dbBytes` = 0, bug lama di `master`: `storage.ts` masih men-stat file
SQLite). Sudah diperbaiki di branch `storage-api-dbbytes` (ukuran database kini dibaca dari Postgres), sehingga suite
tidak lagi punya kegagalan yang diketahui.

**Sapuan** (seluruh produk game dummy, 515 SKU, dan 232 nama nyata dari `catalogSnapshot.json` dalam 3 varian;
semua dalam 4 mode id/en x IDR/USD):

| Metrik | Sebelum | Sesudah |
|---|---|---|
| Label berkata ganda (dummy) | 208 | **0** |
| Tombol `#id` saja (dummy) | 184 | 4 (satu SKU dummy bernama 200 karakter, ekornya sama dengan saudaranya) |
| Label 37-44 sel | 222 | **0** |
| Ikon ganda atau berdampingan | 64 | **0** |
| Awal nama terpotong (dummy) | 76 | 28 (7 SKU; tidak ada bentuk unik yang lebih baik) |
| Awal nama terpotong (nama nyata) | 12 | **0** |
| Label kembar, label melebihi batas, pemendekan tanpa penjelasan | - | **0** |
| Label yang berubah / yang lebih buruk dari sebelumnya | - | 128 / **0** |

Contoh sebelum dan sesudah (id/IDR; harga ilustratif):

| Nama supplier | Sebelum | Sesudah |
|---|---|---|
| Genshin `Primogems 160` (qty 160 Primogems) | `160 Primogems Primogems 160 · Rp40K` | `160 Primogems · Rp40K` |
| Genshin `6480 + 1600 Genesis Crystals` | `#673` | `6480+1600 Genesis Crystals · Rp1,66M` |
| Delta Force `Black Hawk Down Redefine  - Garena` | `…Down Redefine - Garena` | `Black Hawk Down Redefine · Rp125K` |
| Genshin `Blessing of the Welkin Moon x2` | `…of the Welkin Moon x2` | `Blessing of… Moon x2` |
| MLBB `Event Gift Pack 1 Diamonds` (qty 7) | `7 💎 Event Gift Pack 1 💎` | `7 💎 Event Gift Pack 1 · Rp18K` |
| ML `1186 + 224 Diamonds` | `#12014` | `1186+224 💎 · Rp281K` |
| PUBG `9375 UC` | `9,375K UC` | `9375 UC` |

**Review:** lima putaran review Opus independen. Temuan yang tidak tertangkap oleh tes saat itu: header qualifier
bersama hilang oleh `(x2)`, seri campuran Delta Force jatuh ke `#id`, ikon ganda dari langkah ikon-di-dalam-nama,
awal nama terpotong, dan penghitung admin yang keliru untuk 379 SKU. Semuanya sudah diperbaiki dan diberi tes
regresi dengan uji mutasi.

## 9. Menjalankan stack dummy untuk uji manual

Dipakai untuk mencoba di Telegram dan panel admin dengan data besar dan teks panjang. **Hanya satu bot yang boleh
berjalan per token** (dua poller pada satu token memicu error 409), dan RAM harus longgar (bot, admin, toko web,
vitest, dan sesi Claude pernah berebut memori sampai sistem mematikan proses).

1. Worktree sendiri: `.claude/worktrees/<topik>`; salin `.env` dari direktori utama; `CI=true pnpm install`;
   `pnpm prisma:generate`; `pnpm -r build`.
2. Di `.env` worktree: `WEB_PORT` dan `STOREFRONT_PORT` diganti (dipakai 8209/8210), dan `DATABASE_URL_PRISMA`
   menunjuk ke database `bot_order_dummy` di Postgres dev yang sudah berjalan
   (`docker exec web-and-bot-order-postgres-1 psql -U bot_order -d postgres -c "CREATE DATABASE bot_order_dummy"`).
3. `pnpm prisma db push`, lalu `pnpm seed-chart-of-accounts`; token bot dan login admin disalin dari database dev
   (hanya kunci yang perlu: `bot_token`, `bot_username`, `admin_ids`, hash password admin, flag layanan, kurs, dan baris
   admin di tabel `users`; **tidak** `digiflazz_*` dan kredensial pembayaran).
4. Seed katalog dummy: skrip tidak dilacak git, `tmp/seed-dummy-catalog.ts` (menolak berjalan kecuali
   `DATABASE_URL_PRISMA` berakhir `/bot_order_dummy`): 35 produk (24 game, 11 Premium Apps), 571 SKU, 1747 item stok,
   semua bertanda `[DUMMY]`. Opsi: `--reset` (bangun ulang), `--remove` (hapus data dummy saja).
5. Jalankan di terminal terpisah: `pnpm dev:bot`, `pnpm dev:web` (admin, port WEB_PORT), `pnpm dev:store`
   (toko web, port STOREFRONT_PORT).
6. Bersih-bersih: hentikan ketiga proses, lalu
   `docker exec web-and-bot-order-postgres-1 psql -U bot_order -d postgres -c "DROP DATABASE bot_order_dummy"`.

Catatan lain: database dev lokal `bot_order` dan bot `@testtoko_bot` adalah data uji (bukan produksi); skemanya
tertinggal dari kode (belum ada kolom `supplier_raw_name`), jadi `prisma db push` harus dijalankan lebih dulu bila
kode ini diarahkan ke sana, lalu order-bot di-restart. saklar layanan Top Up Game bernilai mati di database
itu lewat kunci lama `service_game_topup_enabled=false` (dibaca sebagai fallback untuk kedua kanal sampai
`service_game_topup_enabled_bot` / `service_game_topup_enabled_web` disetel); di database dummy disetel `true`.

## 10. Keputusan pemilik proyek dan follow-up

Keputusan: fokus Top Up Game; Premium Apps tidak berubah; ikon Gold 🪙; singkatan dipangkas; **format harga
mengikuti bahasa pembeli** (id: `Rp4.480`, `Rp1,64jt`, `$0,28`; en: `Rp4,480`, `Rp1.64M`, `$0.28`); setiap follow-up
dikerjakan **satu branch per item**, berurutan.

Aturan: harga di bot hanya lewat pemformat sadar-bahasa (`formatIdrFor`/`formatUsdFor`/`formatCompactIdrFor`,
`ctxPriceFormatter`); jangan menulis pemisah ribuan sendiri di handler.

| Branch | Isi | Status |
|---|---|---|
| `price-format-by-language` | Semua layar pembeli di bot (picker, detail, konfirmasi `Harga × qty` dan `Total`, layar bayar QRIS/PayDisini, pesanan, riwayat, dompet, top-up, DM flash sale dan DM top-up) memformat Rupiah dan dolar dari satu modul `packages/core/src/moneyFormat.ts` sesuai bahasa pembeli (id `Rp4.480`, `Rp1,64jt`, `$0,28`; en `Rp4,480`, `Rp1.64M`, `$0.28`). Angka tidak berubah, hanya pemisah. Dampak Premium: pembeli en kini melihat `Rp30,000` di baris picker; pembeli id tetap `Rp30.000`, kecuali tombol kuantitas ≥ Rp1 juta (`Rp1,64jt`) dan harga USD (`$0,28`). Pengecualian: jumlah USDT/kripto (`5.07 USDT`), layar admin, log, dan web | selesai |
| `region-dedupe-header` | Region yang sudah ada di nama produk (`Valorant (Indonesia)`) tidak diulang di tombol, header bersama, header halaman 2+, dan blok penjelasan. Hanya presenter yang berubah (Game Top-Up saja); `qualifiers` core tidak berubah. Sapuan atas snapshot nyata (15 produk, 10 skenario region/variant sintetis, 600 daftar, 9.460 tombol, versi master vs HEAD): skenario tanpa qualifier 0 perubahan; 1.060 label berubah dan semuanya hanya kehilangan qualifier yang sudah ada di nama (960) atau kini menampilkan satu-satunya qualifier yang belum ada di nama karena sudah muat (100, sebelumnya semua qualifier dibuang demi lebar); 0 label lebih buruk, tidak ada callback/urutan berubah, semua label unik dan dalam batas lebar | selesai |
| `back-page-reply-kb` | Back dari picker atau detail tunggal lewat keyboard balasan kembali ke halaman daftar produk asal (sebelumnya selalu halaman 0), sama seperti Back inline; halaman di luar jangkauan dipangkas ke halaman terakhir yang valid. Premium Apps memakai jalur kode yang sama dan tidak berubah; spesifikasi §9 | selesai |
| `storage-api-dbbytes` | Ukuran database dari Postgres (`pg_database_size` lewat helper di `packages/db/src/crud`), bukan file SQLite; tes `storage-api` lulus lagi dan suite tanpa kegagalan yang diketahui | selesai |
| `compact-idr-jt` | Rupiah kompak untuk pembeli berbahasa Indonesia memakai `jt` (`Rp1,64jt`, kuantitas `1,5jt`), bukan `M` yang dalam bahasa Indonesia terbaca miliar. Bahasa Inggris tetap `Rp1.64M`. Lebih lebar 1 sel, jadi anggaran nama tombol IDR turun 1 (`COMPACT_PRICE_CELLS.IDR` 9); kepala label yang menyebut unit panjang (`6480+1600 Genesis Crystals`) kini boleh memakai singkatan kamus (`Gen Crystals`) sebagai bentuk fallback terakhir sebelum `#id` | selesai |
| `dictionary-prune-abbrevs` | Hapus Premium, Membership, Subscription dari singkatan (tersisa Genesis, Package, Weekly, Monthly). Sapuan atas snapshot nyata (232 label GAME_TOPUP, harga sintetis): 0 label berubah, karena tidak ada nama snapshot yang memakai singkatan yang dihapus; label sintetis `Weekly Premium Subscription Package` berubah dari `Wkly Prem Sub Pkg` menjadi `Wkly… Subscription Pkg` (dipotong, bukan disingkat) | selesai |

Ditunda, prioritas rendah: pembersihan kode mati (`stockLabels`, `unitIcon`, jalur non-game
`canonicalDenominationPickerKb`; `gameTopUpDenomLabel` kini dipakai lagi oleh Premium dan jangan dihapus); mencatat
unit yang belum ada di kamus saat label jatuh ke fallback (log info satu kali per unit); tes penjaga untuk tombol
statis dari locale.

Sengaja **tidak** dikerjakan: kamus yang bisa diedit dari panel admin (tunggu bukti kebutuhan); menyesuaikan picker
Premium atau kategori ke batas 18; menurunkan batas lebar lebih jauh sebelum cek di HP.

## 11. Keterbatasan dan hal yang belum terverifikasi

- **Tampilan klien Telegram asli** (Android, iOS, Desktop, ukuran font berbeda) belum dicek. Batas 36/32/18 hanya
  heuristic. Kasus terburuk yang layak dicoba: Genshin, Mobile Legends (83 SKU, beberapa halaman), Delta Force
  campuran, dan SKU bernama 80-200 karakter.
- Panel admin belum dicoba di browser (butuh login); komponen dan halaman hanya diuji dengan Testing Library.
- Toko web (storefront) memakai data kanonik yang sama: untuk game, nama denominasi tanpa awalan nama produk.
  Review menyatakan tidak ada regresi, tetapi pengecekan visual belum dilakukan.
- Langkah "ikon dan singkatan" bisa tampak janggal pada nama dummy yang sengaja bermusuhan
  (mis. `💎… 100 ✨🔥 Mega Combo 🎁`); selalu unik, dalam batas lebar, dan dijelaskan di body.
- Angka bergrup pada SKU non-Digiflazz tanpa qty terstruktur (`10.000 Bonds + 1.000 Bonus`) sengaja tidak diurai
  karena titik ambigu.
- Singkatan di nama resmi (`Premium Battle Pass` menjadi `Prem Battle Pass`) sudah dihapus lewat branch
  `dictionary-prune-abbrevs`. Akibatnya nama panjang bergaya itu kini lebih sering jatuh ke langkah potong (`…`) pada
  tombol; nama lengkap tetap ada di body.

## 12. Pelajaran proses

- Beberapa review independen (tanpa membaca laporan sebelumnya) menemukan kelas cacat yang berbeda tiap putaran,
  termasuk satu regresi dari perbaikan sebelumnya. Sapuan atas data banyak dan nama nyata lebih efektif daripada
  contoh tunggal.
- Klaim laporan implementer diverifikasi ulang secara mekanis (commit, trailer, tes, typecheck) sebelum dipercaya.
- Satu bug di tampilan sering satu kelas: perbaiki kelasnya dan buktikan dengan sapuan sebelum dan sesudah.
- Memori terbatas: jangan menjalankan suite penuh bersamaan dengan stack dev dan sesi review; jalankan suite dalam
  batch dengan `--maxWorkers=2 --minWorkers=1`.
