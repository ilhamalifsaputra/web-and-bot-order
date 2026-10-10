# Inventaris branding Trustance

Audit 10 Oktober 2026. Nama/asset tetap berasal dari Settings admin, tidak ada
logo baru yang digambar. Tidak ada penggantian global istilah premium, game,
akun, atau stock karena istilah tersebut sah pada domain masing-masing.

## Asset yang ditemukan

Public context read-only `https://trustance.id/api/v1/pages/context` menampilkan
`shop_name = Trustance`, logo `/uploads/branding/logo-7ef3e2e4246b44cd.png` dan
favicon `/uploads/branding/favicon-9510a6ac220575e6.png`. Kedua asset berhasil
diunduh/diperiksa. Logo PNG 1600×1600 memiliki latar putih dan whitespace internal;
favicon 160×160. File tidak dilacak git sebagai asset produksi karena merupakan
upload owner. Salinan logo tanpa perubahan disimpan hanya sebagai fixture visual
`tests/audit/fixtures/trustance-logo.png`, bukan default brand baru.

| Surface / lokasi | Hardcode awal dan klasifikasi | Hasil |
|---|---|---|
| `components/layout/Navbar.tsx:59` | Store fallback dan rendering gambar berulang; identitas generik keliru pada shop berlogo | BrandLogo, gambar 44px dengan wordmark, label account/login bisa dibaca assistive technology |
| `components/layout/Footer.tsx:117` | Store selalu digunakan meski logo owner tersedia | BrandLogo dari context yang sama; fallback teks |
| `components/AuthBrandPanel.tsx:46` | Store fallback dan rendering logo berulang | BrandLogo, dipakai login/register/forgot/reset; tone inverse |
| `components/layout/MobileDrawer.tsx:215` | Nama teks tanpa logo | BrandLogo; focus trap/escape tetap |
| `components/BrandLogo.tsx:5` | Sebelumnya tidak ada sumber rendering bersama | Nama+URL dari context; ukuran tetap, alt, fallback bila asset rusak |
| `pages/HomePage.tsx` | Hero tidak memakai logo terpisah; hardcode QRIS & USDT pada trust strip | Copy lokal netral dan fulfillment sesuai produk; katalog tetap data aktual |
| `components/layout/Footer.tsx:238` | Link kebijakan hanya di disclosure | Link Terms/Privacy/Refund selalu terlihat; operator/alamat di luar disclosure |
| `pages/ContactPage.tsx` | Store sebagai ikon baris BUSINESS NAME | VALID: ikon fungsi untuk label data, bukan pengganti brand; dipertahankan |
| `pages/CartPage.tsx`, `CheckoutPage.tsx`, `PayPage.tsx`, account/support | Branding diwarisi dari Layout | Tidak ada logo baru yang diduplikasi; masuk smoke dan/atau tes state |
| `pages/ErrorPage.tsx` | Branding diwarisi dari Layout; judul error hanya paragraf | Heading h1 semantik 404/500; tidak menampilkan stack/secret |
| `routes/apiPages.ts:118` | `web_logo_url`/`web_favicon_url` | VALID: sumber context owner, dipertahankan |
| `routes/spaShell.ts:658` | Settings untuk favicon/apple-touch | VALID; tes memastikan asset terkonfigurasi dipakai |
| `routes/spaShell.ts:284` | Homepage OG tanpa gambar brand | Menggunakan logo owner jika tersedia; Contact/legal juga demikian |
| `routes/spaShell.ts:628` | Canonical private URL memuat order code/reset token | Private tetap noindex dan tidak memancarkan URL sensitif ke metadata |
| `static/favicon.svg` | Ikon tas generik bawaan, juga pada admin | VALID sebagai default instalasi tanpa upload; public Trustance memakai favicon upload. Tidak diganti dengan logo baru rekaan |
| `client/index.html` | Placeholder title/lang/meta diganti server | VALID; Vite hashed assets, tidak ada ikon Vite/React default |
| `apps/web-admin/client/src/components/layout/Sidebar.tsx` | `shopName || "Shop Admin"` | VALID: nama Settings, fallback label alat admin; bukan klaim retail |
| `apps/web-admin/src/routes/branding.ts:28` | Upload logo/favicon/banner dengan audit log | VALID: pemilik asset dan versioning filename; dipertahankan |
| `packages/core/src/email/layout.ts:45` | `brand.logoUrl`, alt `brand.shopName` | VALID: logo opsional; tidak ada logo email statis yang salah |
| `packages/outbox-dispatcher/src/emailTemplates.ts:207`, `:237` | Resolver owner/buyer brand membaca Settings dan origin yang sesuai | VALID: satu sumber Settings, pengiriman email tidak dijalankan dalam audit |
| `packages/core/locales/*.json` | `Trusted digital marketplace`, premium-only SEO, global credentials | Posisi produk/layanan digital, tanpa klaim multi-seller; premium-specific delivery strings tetap valid |
| Telegram welcome / bot banner | Welcome lama premium-only; banner dari Setting owner | Default welcome diperluas; custom welcome/banner yang tersimpan perlu review owner, tidak ditimpa |
| Receipt / game presenter / credential file | Istilah credential di flow premium, player/SN di game | VALID: output keluarga berbeda; aturan message budget tidak diubah |
| PWA manifest / service worker / invoice PDF logo | Tidak ditemukan implementasi yang dilacak git | Tidak dibuat route atau template palsu |

Path komponen tanpa awalan dalam tabel relatif ke
`apps/storefront/client/src/`; path `routes/` relatif ke `apps/storefront/src/`.

## Cache dan batas visual

Vite mengganti hash JS/CSS setiap build. Server shell memakai `Cache-Control:
no-store`; upload Branding memakai nama file baru. Tidak ada service worker
yang perlu dihapus atau random query cache-buster. Deployment harus membawa
bundle storefront/admin dan upload owner yang sama; jangan mengganti URL logo
ke file fixture tes. SVG default hanya dipakai saat setting tidak tersedia.

Owner dapat menyediakan versi logo transparan dengan whitespace lebih kecil
melalui Branding untuk keterbacaan lebih baik. Audit menggunakan file asli,
tanpa crop, recolor, atau klaim logo baru. Tidak ada mode dark global; auth
panel memakai background gelap dan diuji dengan treatment inverse.
