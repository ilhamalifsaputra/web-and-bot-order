# Audit Trustance: rebranding dan kesiapan Xendit

Tanggal: 10 Oktober 2026. Basis awal: `0959e631`, worktree `trustance-readiness`.
Bahasa UI tetap mengikuti locale id/en. Audit ini tidak mengesahkan legalitas bisnis atau aktivasi merchant.

## Audit sebelum perubahan

Repository terverifikasi: monorepo pnpm, React 18 + React Router + Vite,
Fastify 5, Prisma/PostgreSQL, grammY, Docker. Grafik arsitektur dikonsultasikan
dengan `graphify query`; graph di worktree tidak tersedia, query read-only
di checkout utama berhasil. Isi source digunakan untuk memverifikasi hasil.

| Prioritas | Bukti awal | Temuan / reproduksi | Rencana patch |
|---|---|---|---|
| P0 | `packages/core/locales/en.json:1236` | About menganggap semua fulfillment mengambil stok akun | Jelaskan top-up, auto stock, manual/informasi sesuai model aktual |
| P0 | `packages/core/locales/en.json:1268`, `:1286`, `:1288` | Terms/Privacy menyebut Xendit memproses pembayaran; `checkout.ts` tidak menawarkan rail Xendit | Hapus klaim processor yang belum terintegrasi; rujuk metode dan instruksi checkout |
| P0 | `packages/db/src/crud/payMethodDisplay.ts:44` | Flag logo QRIS/kartu menyala dari konfigurasi Xendit, meskipun checkout tidak mendukungnya | Flag hanya mencerminkan rail checkout yang terimplementasi; tes konfigurasi Xendit tetap tersembunyi |
| P0 | `packages/core/locales/en.json:1282`, `:1290`, `:1292` | Password disebut terenkripsi, kredensial diklaim tak ada di notifikasi, penghapusan data dijanjikan otomatis | Cocokkan bcrypt, otorisasi dan kanal pengiriman; jangan menjanjikan penghapusan tanpa review |
| P0 | `packages/core/locales/en.json:1270`, `:1302`, `:1304` | Janji SLA manual 1×24 jam, refund 7 hari/instan belum dibuktikan | Draft koreksi faktual; `LEGAL_REVIEW_REQUIRED`, keputusan SLA oleh owner |
| P1 | `apps/storefront/client/src/components/layout/Navbar.tsx:64`, `AuthBrandPanel.tsx:47` | Rendering logo berulang, fallback Store; gambar header 28px | Komponen BrandLogo dari Settings yang sama, wordmark fallback, box stabil |
| P1 | `apps/storefront/client/src/components/layout/Footer.tsx:128`, `:175` | Footer selalu ikon Store, kontak default terbuka, padding mobile besar | Logo bersama, dua disclosure tertutup, identitas tetap terlihat, policy links permanen |
| P1 | `apps/storefront/client/src/pages/HomePage.tsx:288`, `AuthBrandPanel.tsx:72` | Hardcode QRIS & USDT walau gateway belum dikonfigurasi | Copy netral yang mengarahkan ke checkout; metode faktual tetap di checkout |
| P1 | `packages/core/locales/en.json:863`, `:1154`, `:1199` | SEO premium-only dan pengiriman kredensial global | Positioning produk digital; status/deliverable sesuai jenis produk |

## Sumber kebenaran

- Identitas: Settings `shop_name`, `shop_tagline`, `business_legal_name`,
  `business_address`, `business_phone`, `business_email`, `business_hours`;
  dibaca oleh `routes/apiPages.ts`, `routes/spaShell.ts`, `lib/company.ts`.
- Asset: Settings `web_logo_url`, `web_favicon_url`, upload melalui admin Branding.
  Tidak ditemukan asset logo final Trustance yang dilacak git. Default favicon
  adalah ikon belanja generik, bukan logo resmi. Logo dan favicon resmi yang
  sudah diunggah ditemukan pada context publik; URL dicatat di branding-inventory.md.
  Fixture tes menyalin byte asli; setting produksi tidak diubah.
- Produk: Category → Product → Denomination; group PREMIUM_APPS / GAME_TOPUP dan
  resolver legacy; `deliveryType` auto/manual/manual_with_info, informasi player,
  mapping Digiflazz, snapshot order. Tidak menambah tipe fulfillment baru.
- Checkout: `apps/storefront/src/routes/checkout.ts:checkoutView` menawarkan
  TokoPay, PayDisini, Binance internal, Bybit internal/BSC, NOWPayments dan saldo
  sesuai konfigurasi, minimum, kurs dan saldo. Xendit saat ini konfigurasi admin
  dan probe, belum rail checkout. Konfigurasi bukan bukti merchant live.
- Keamanan: password bcrypt (`packages/core/src/password.ts`), credential
  encryption, session ownership, CSRF; jumlah uang Decimal. Tidak mengubahnya.
- Email: `packages/outbox-dispatcher/src/emailTemplates.ts` membaca Settings brand;
  Telegram memiliki flow dan presenter game/premium terpisah.

## Inventory route (source: client/src/App.tsx)

| Kelompok | Route/state aktual | Cakupan verifikasi |
|---|---|---|
| Discovery | `/`, `/categories`, `/c/:slug`, `/products`, `/flash`, `/p/:slug`, `/search?q=` overlay | Source + browser sintetis; dua keluarga produk |
| Cart/checkout | `/cart`, `/checkout`, `/checkout/:code/pay` | Kosong/isi, guest/akun uji, sebelum pembayaran eksternal; state payment via tes yang sudah ada |
| Wallet | `/wallet/topup`, `/wallet/topup/:code/pay` | Source/auth guard + tes lokal; review stored value/USDT oleh owner |
| Auth | `/login`, `/register`, `/forgot`, `/reset/:token` | Browser tanpa data pelanggan; reset sintetis tidak valid |
| Account | `/account`, `/account/orders`, `/account/orders/:code`, `/account/referral`, `/account/reviews`, `/account/settings` | Akun sintetis; noindex HTML + otorisasi API |
| Support | `/help`, `/track`, `/account/support`, `/account/support/:id` | Source + browser sintetis; tidak mengakses akun nyata |
| Informasi | `/about`, `/contact`, `/how-to-order`, `/terms`, `/privacy`, `/refund` | Browser, policy links, kesamaan crawler/UI |
| Lain | catch-all 404, setup gate 503, error shell 500, `/robots.txt`, `/sitemap.xml`, `/lang`, `/currency` | Source + tes; `/__ui` hanya DEV, tidak production |
| Admin/bot/email | Branding, sidebar, email brand resolver, bot welcome/terms, presenter/receipt | Source + tes, tanpa poller bot atau pengiriman email/Telegram |

Tidak ada route Warranty/FAQ terpisah, PWA manifest/service worker atau invoice
PDF brand yang ditemukan. FAQ berada di homepage/help. Jangan mengarang route.

## Referensi resmi dan pembanding publik

Dibaca ulang 10 Oktober 2026:

1. [Kriteria situs](https://help.xendit.co/hc/id/articles/4405784216973-Apa-saja-kriteria-situs-web-atau-aplikasi-untuk-registrasi): situs aktif, sesuai bisnis; katalog/alur pembayaran diutamakan.
2. [S&K Indonesia](https://www.xendit.co/id/syarat-dan-ketentuan/): bagian 11 mencakup hak kekayaan intelektual, mata uang virtual dan nilai tersimpan. Penerapan untuk katalog dan wallet Trustance harus dikonfirmasi langsung, bukan disimpulkan dari desain.
3. [Penolakan/aktivasi](https://help.xendit.co/hc/en-us/articles/4801728966553-Why-my-application-was-rejected-What-to-do-next): keputusan dan tindak lanjut bergantung evaluasi Xendit.
4. [Dokumen Indonesia](https://help.xendit.co/hc/en-us/articles/10891368765593-ID-What-are-the-legal-documents-required-to-register-to-Xendit-for-Indonesian-Merchants): dokumen mengikuti bentuk badan usaha. Cocokkan identitas, NIB dan dokumen perusahaan; persyaratan tambahan konfirmasi ke Xendit.

Footer compact/ukuran logo adalah rekomendasi UX, bukan persyaratan resmi Xendit.
`https://trustance.id` hanya pembanding read-only; tidak ada transaksi live.

## Status implementasi dan validasi

Kode terimplementasi di branch `worktree-trustance-readiness`, terpisah dari
master. Identitas bisnis dinyatakan sesuai oleh owner melalui percakapan;
dokumen tidak diperiksa agent. Owner juga menegaskan Xendit belum aktif dan
baru akan direview. Semua perubahan kebijakan tetap `LEGAL_REVIEW_REQUIRED`.

| Prioritas selesai | Perubahan / lokasi akhir | Bukti |
|---|---|---|
| P0 klaim pembayaran | `packages/db/src/crud/payMethodDisplay.ts:27`; Terms/Privacy en/id | Konfigurasi Xendit tidak menyalakan mark QRIS/kartu; tes CRUD dan API context |
| P0 transparansi fulfillment | `packages/core/locales/en.json:1237`, `id.json`; hero/how-to/FAQ | Game memakai player/status, aplikasi memakai deliverable per paket; kategori baru tidak diiklankan |
| P0 privacy/refund | Locale Terms/Privacy/Refund en/id | Bcrypt dan akses staf/kanal pengiriman sesuai kode; janji SLA tanpa bukti dihapus dari draft, diff di legal-review.md |
| P1 brand bersama | `client/src/components/BrandLogo.tsx:5`, Navbar:59, Footer:117, MobileDrawer:215, AuthBrandPanel:46 | Satu sumber Settings; box 44px, fallback wordmark/error image; tes asset asli pada 5 viewport |
| P1 footer | `client/src/components/layout/Footer.tsx:47`, `:237` | Disclosure tertutup, keyboard Enter/Space, policies permanen, legal operator di luar accordion, safe-area |
| P1 copy/payment strip | `client/src/pages/HomePage.tsx:271`, `AuthBrandPanel.tsx:58` | Copy id/en mengarahkan ke opsi checkout, tidak mengklaim rail tertentu aktif |
| P1 SEO/privacy | `routes/spaShell.ts:249`, `:628`, `routes/seo.ts:80` | Logo owner pada social meta publik; noindex tanpa canonical sensitif; reset/order tidak bocor di meta |
| P1 aksesibilitas | `client/src/pages/ErrorPage.tsx:30`, `Footer.tsx:237` | H1 404/500; kontras copyright footer diperbaiki dari 4,27:1 menjadi 5,29:1 pada sand |

Path `client/` dan `routes/` di tabel relatif ke `apps/storefront/`.

## Bukti per state dan batas cakupan

| Route/state | Cara verifikasi | Batas |
|---|---|---|
| 25 route publik pada 5 viewport | Playwright; 125 observasi di ux-screenshots/route-results.json, title/favicon/overflow/JS/network | Data lokal sintetis; `/help` menuju login, 404 disengaja |
| Search kosong, hasil, lalu produk | Chromium mobile, combobox ArrowDown/Enter | Tidak memakai pencarian akun/customer produksi |
| Cart isi menuju checkout guest | Chromium mobile, jumlah/CTA terlihat, kartu/Xendit tidak ditawarkan | Berhenti sebelum membuat/membayar order |
| Login dan 7 halaman akun/wallet | Akun sintetis lokal; h1 dan overflow | Tidak memeriksa histori pelanggan nyata |
| Game / Premium / kategori legacy | Browser tiga detail produk + commerceCopy/game-topup-details/PayPage tests | Tidak mengeklaim premium apps tersedia di katalog publik saat snapshot |
| Pending/processing/underpaid/expired/cancelled/gateway error | `apps/storefront/test/pay-state.test.ts`, `client/src/pages/PayPage.test.tsx` | State sintetis/unit; bukan pengujian settlement live |
| Game target/SN vs credentials, owner/guest/non-owner | `apps/storefront/test/game-topup-details.test.ts` | Otorisasi, data provider aman dan pemisahan keluarga melalui tes lokal |
| Ticket list/detail/create dan order detail | Source + `support-api.test.ts`, `OrderDetailPage.test.tsx` dan tes terkait pada full suite | Browser hanya list akun kosong; detail/create/state tidak semuanya direkam screenshot |
| Empty/loading/error/setup gate | StatusScreen/ErrorPage tests; public cart/flash/reset/404 browser, setup route tests | Tidak memaksa downtime/maintenance situs publik |
| Admin/bot/email/receipt | Source Settings/resolver/presenter + full test suite | Tidak menjalankan poller, worker pengiriman, webhook live atau email nyata |

## Performa dan aksesibilitas

Box logo memiliki ukuran eksplisit, object-contain, dan tidak mengubah rasio asset.
Fallback rusak diuji; JS/CSS memakai hash Vite dan shell no-store. Tidak ditemukan
service worker. Build memperingatkan chunk besar yang sudah ada; task ini tidak
mengubah bundler atau memasukkan library baru. Gambar katalog memakai perilaku
lazy/responsive existing. Sampel lab awal homepage tanpa throttle pada Chromium
lokal: 390x900px LCP 364ms/CLS awal 0,0256; 1440x900px LCP 176ms/CLS awal 0,0651.
Observasi hanya satu detik setelah font/render dan satu navigasi per ukuran;
transferSize adalah HTML navigation, bukan seluruh bundle. Tidak mengukur INP
atau percentile lapangan. Tidak mengklaim Core Web Vitals produksi lulus.
Data mentah: `ux-screenshots/performance-results.json`.

Keyboard drawer (Escape/focus restore), combobox, disclosure, label auth serta
heading error diperiksa. Perhitungan luminansi token di `client/src/index.css:74`
memberi ink/card 15,79:1, soft/card 5,99:1, faint/card 4,84:1, pine/card 5,17:1.
Copyright footer soft/sand 5,29:1 setelah patch. Angka ini hanya pasangan token
tersebut, bukan sertifikasi WCAG semua state/opacity/komponen.

## Risiko yang belum selesai

- `NEEDS_OWNER_VERIFICATION`: hak distribusi, SLA/refund, retensi/privacy final,
  status gateway live, monitoring kontak dan kesesuaian wallet/USDT dengan Xendit.
- Identitas dinyatakan sesuai oleh owner; pencocokan akta/NIB tetap tanggung jawab
  owner. Tidak menyimpan dokumen atau secret ke report.
- `XENDIT_DECISION_PENDING`: merchant belum aktif; keberhasilan audit kode tidak
  menjamin keputusan Xendit.
- Patch belum dipush/dideploy. Situs publik masih dapat menampilkan copy lama
  sampai owner menyetujui legal text dan merilis perubahan.

Hasil perintah, jumlah tes dan status teknis akhir ada di [validation-results.md](validation-results.md).
Galeri perbandingan ada di [ux-screenshots/README.md](ux-screenshots/README.md);
tindakan review ada di [owner-action-items.md](owner-action-items.md).
