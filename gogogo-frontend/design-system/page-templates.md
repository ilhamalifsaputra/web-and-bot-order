# gogogo-frontend — Page Templates

Layout/composition reverse-engineered from gogogo.id (2026-09-01); colours
retoned to this repo's own brand (`foundations.md`) — read screenshot colours
as layout reference only, not literal values. Each entry maps to screenshots
in `../screenshots/desktop/` and `../screenshots/mobile/`.

Global chrome on every page: **fixed top nav** (desktop) / **top bar + fixed
bottom tab bar** (mobile), and the **`sand`-background footer**. Content is
centered in a `max-width: 1152px` column with `~16px` side gutters.

---

## 1. Home / Landing — `/`
_`01-home.png`_

1. **Promo strip** (dismissible) — cashback message, `pine-tint` background /
   `pine-dark` text, close `×`.
2. **Hero** — banner carousel (rounded, dot pagination, circular arrows) beside
   an H1 + supporting paragraph + inline **trust badges** row.
3. **Category filter** — pill segmented control (`Lagi Populer`, `Top Up`,
   `Steam Game`, `Voucher`, `Entertainment`).
4. **Product sections** — repeated: H2 + 5-col product-card grid (2-col mobile)
   + "Tampilkan lebih banyak" ghost link.
5. **Help CTAs** — two side-by-side cards: "Kasih Saran" (game request) and
   "Hubungi CS", each with a mascot illustration + button.
6. **FAQ accordion**.

---

## 2. Category listing — `/p/:category`
_`02-category-topup.png`, `03-category-voucher.png`, `04-…`, `05-…`_

Minimal: **breadcrumb** → **H2** (category name) → a single 5-col grid of
product cards (portrait key-art, name below/overlaid). No sidebar, no facets,
no visible pagination (long scroll / lazy load). Each `/p/:category` has its own
SEO `<title>` and copy.

---

## 3. Product detail — `/p/:category/:slug`
_`06-product-mlbb.png`, `07-product-freefire.png`, `19-product-detail-desktop.png`, `mobile/18-product-validation.png`_

**Desktop = 2 columns.** **Mobile = 1 column + sticky purchase bar.**

- **Breadcrumb** (`Beranda › Top Up › Top Up Free Fire`, current crumb bold `ink`).
- **Left column**
  - Product summary card: key-art, small `topup` category pill, H1 product
    name, "Cara Top Up?" ghost link, trust badges footer strip.
  - "Cara Top Up" numbered steps card.
- **Right column**
  - **"Masukkan User ID"** card — labelled pill input + inline "Cek ID" button;
    inline error state (`"Isi User ID kamu dulu ya."`, red).
  - **"Pilih Nominal atau Paket"** card — segmented tabs
    (`Termurah` / `Membership` / `Diamonds`) + responsive grid of
    **denomination cards** (currency icon from `../assets/icons/`, `% OFF`
    badge, label, price + strikethrough; selected = `2px pine` border + focus
    ring).
  - **FAQ accordion** (product-specific).
- **Sticky purchase bar** — cashback ribbon (`pine-tint`) + price block (price
  in **`grass-dark`**, `Hemat` / `Dapat X Koin` chips) + primary **"Lanjutkan"**.

> Next step after "Lanjutkan" is the checkout / payment-method screen — not
> captured here (would create a live order). Treat it as: order summary card +
> payment-method list (grouped: e-wallet / VA / QRIS / retail) + a final
> confirm CTA. Follow the same card + pill + primary-button language.

---

## 4. Auth flow — `/login` → `/login/otp`
_`12-login-otp.png`_

Full-screen, no nav/footer, centered narrow column, top-left back `‹` and
top-right "Bantuan" pill.

1. **Email/phone step** — logo, "Welcome to Gogogo!" H1, single pill input
   (`nama@email.com`), "Pakai nomor HP" toggle link, full-width primary
   "Lanjutkan" (disabled until valid).
2. **Flip account-link consent** — modal/sheet: heading + explainer + a
   required checkbox ("hubungkan akun Flip … Syarat & Ketentuan …"), "Kembali"
   / "Lanjutkan".
3. **OTP step** — "Verifikasi Nomor HP", 6-box OTP input, `mm:ss` resend
   countdown, "Kirim lewat SMS" fallback link.

---

## 5. Account — `/user`
_`13-user-profile.png`_

Centered column. Header block: "Akun" eyebrow, `Game on, <name> 🚀`, decorative
header background image. Below: a list of info rows (Email, Nomor Telepon,
Region dan Bahasa, Bantuan) — each icon + label + value, chevron affordance —
then a **Logout** row (icon + `rust` label).

---

## 6. Transaction history — `/transaction`  ·  Tracker — `/track-transaction`
_`11-transaction-history.png`, `10-track-transaction.png`_

Centered narrow column. Heading + a **filter row**: pill search field
(`ID transaksi`) + a **select dropdown** (`Semua Status ▾`).

- **Empty state** — grayscale binoculars illustration, "Belum ada transaksi",
  one-line subtext, primary "Telusuri Game" button.
- **Populated** (not captured) — vertical list of transaction cards: product
  thumbnail, name + nominal, timestamp, status chip (`grass` success /
  `amberx` pending / `rust` failed), amount.
- The public **tracker** is the same form without login, keyed by transaction
  ID (+ email/phone).

---

## 7. Content / legal — `/syarat-ketentuan`, `/kebijakan-privasi`
_`14-syarat-ketentuan.png`, `15-kebijakan-privasi.png`_

Single narrow prose column (~`768px`). H1 + long-form body: section headings,
paragraphs, ordered/unordered lists. Body `16px/1.5` Manrope, headings Outfit
600, generous vertical spacing. No card chrome — text sits directly on `paper`.

---

## 8. Support — `/support`
_`09-support.png`_

Centered column: "Frequently Asked Questions" H2 → FAQ accordion →
"Tampilkan lebih banyak" → help CTA card ("Gak nemu topik…" + "Hubungi CS"
outline button) → **"Layanan Pengaduan Konsumen"** legal/regulator info block
(company entity, support email, Ditjen PKTN contact), center-aligned.

---

## 9. Promo — `/promo`
_`08-promo.png`_

Breadcrumb → segmented tabs (`Semua Promo` / `Flip QRIS` / `GOGOAPLIKASI`) →
2-col grid of promo cards: rounded banner image on top, then title (Outfit
`18px/600`) + one-line description on a white `card` (`shadow-soft`).

---

## 10. Search
_`17-search-results.png` (desktop), `mobile/17-search-overlay.png`_

Not a route — an **overlay panel** dropping from the header search field
(mobile opens it full-width from a search icon). Live-filtered list of product
rows (thumbnail + name) as you type. No dedicated `/search` page (`/search`
404s).

---

## 11. 404 / Not found — any unknown route (e.g. `/install`)
_`16-404.png`_

Standard chrome retained. Centered message + illustration + a primary button
back to catalog/home. HTTP 404.

---

## Mega-menu — "Semua Produk ▾" (desktop nav)
_`18-semua-produk-menu.png`_

Click-to-open panel anchored under the nav item, listing product categories /
popular games in grouped columns on a raised white surface (`shadow-lift`,
`1px line` border). Mobile has no equivalent — categories are reached via home
sections + bottom nav.
