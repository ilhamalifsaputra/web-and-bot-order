# gogogo-frontend — Component Specs

Layout and composition reverse-engineered from gogogo.id (2026-09-01); colour,
type, radius and shadow retoned to this repo's own "Clean Modern" brand
(`apps/storefront/static/app.css`). Token names refer to `tokens.css`.
Screenshots showing each component's original layout are noted in _italics_
— read their shapes/positions, not their gogogo.id colours.

---

## Button

_layout ref: `screenshots/*/01-home.png`, `19-product-detail-desktop.png`_

Shared: `14px/600` label, `border-radius 12px` (`--gg-radius-md`), min-height
**44px** tap target, `transition 150ms`. Compact `.btn-sm`: `12px` text,
`radius 8px`, min-height 32px on a mouse — grows back to 44px under
`(pointer: coarse)`.

| Variant | Fill | Text | Shadow | Example |
|---|---|---|---|---|
| **Primary** | `pine` `#2563eb` | white | `shadow-soft` | "Lanjutkan", "Cek ID" (main CTA), "Kasih Saran" |
| **Soft** | `pine-tint` `#e6effe` | `pine-dark` `#1d4ed8` | none | Secondary action beside a primary one |
| **Ghost / text** | transparent | `ink-soft`, hover → `ink` + `sand` fill | none | "Tampilkan lebih banyak", "Cara Top Up?" |
| **Danger** | `rust` `#dc2626` | white | none | Destructive / cancel-order actions |
| **Icon button** | transparent, hover `sand` | `ink-soft` | none | carousel prev/next, close |
| **Disabled** | `sand` | `ink-faint` | none | inactive "Lanjutkan" / OTP submit |

- Hover: primary → `pine-dark` fill; soft → `rgba(37,99,235,.15)`; ghost →
  `sand` fill.
- Focus: `box-shadow: 0 0 0 3px rgb(37 99 235 / .35)` (`--gg-shadow-focus`) —
  no separate outline.
- Full-width primary buttons are used inside the auth flow and the mobile
  sticky purchase bar.

---

## Text field

_layout ref: `screenshots/desktop/12-login-otp.png`, `mobile/18-product-validation.png`_

- **Shape:** `border-radius 12px` (`--gg-radius-md`) — a normal rounded
  rectangle, **not** a full pill (gogogo.id's fields are pills; this brand's
  aren't).
- **Fill:** white `card`. **Border:** `1px solid` `line` `#e3e8ef`.
- **Padding:** `0.5rem 0.75rem`, min-height 44px.
- **Text:** 16px on mobile (prevents iOS Safari's auto-zoom-on-focus), 14px
  from 640px up. Colour `ink`. **Placeholder:** `ink-faint`.
- **Label:** above the field — `~11px/600 uppercase`, `0.05em` tracking,
  `ink-soft` (`.field-label`), with a required marker where needed.
- **Error state:** border → `rust`; helper text below in `rust`, 12–14px
  (e.g. _"Isi User ID kamu dulu ya."_).
- **Focus:** border → `pine`; `box-shadow: 0 0 0 3px rgb(37 99 235 / .2)`.

### OTP input

Six separate square inputs, `~48px`, `border-radius 12px`, white fill, 1px
`line` border; focused box gets a `pine` border + focus ring. A countdown
timer (`00:53`) sits below, then a "Kirim lewat SMS" text link in `pine`.

---

## Card / surface panel

_layout ref: `screenshots/desktop/19-product-detail-desktop.png`_

- White (`card`) background, `border-radius 16px` (`--gg-radius-lg`), `1px
  solid line` border, **`shadow-soft`**.
- Padding `20px` mobile → `24px` desktop (`.card-pad`).
- Hover/interactive cards step up to `shadow-lift`.

---

## Product card (catalog tile)

_layout ref: `screenshots/desktop/01-home.png` (grids), `02-category-topup.png`_

Vertical card, white surface, `border-radius 16px`, `shadow-soft`. Composition
top→bottom:

1. **Cover art** — square-ish game key art, fills card width, rounded top
   corners matching the card radius.
2. **Rating chip** — top-left overlay: star icon + `5.0`, small white pill
   with its own soft shadow so it reads over any art.
3. **Title** — 14px/500 `ink`, 2-line clamp.
4. **Sales row** — flame icon + `587 RB+ Terjual` in 12px `ink-soft`.

Hover: card lifts to `shadow-lift` (a real elevation change, not just a
border/colour swap). Entire card is a single link.

---

## Denomination / package card

_layout ref: `screenshots/desktop/19-product-detail-desktop.png`, `mobile/18-product-validation.png`_
_icon assets: `../assets/icons/`_

Selectable tile in the product-detail nominal grid.

- **Shape:** `border-radius 8px` (`--gg-radius-sm`), white surface, `1px line`
  border.
- **Layout:** currency icon top-left (see `../assets/icons/` — a shared
  "Diamonds" icon reused across many games, or a game-specific icon);
  **discount badge** top-right; item label (`"5 Diamonds"`, `ink`, ~15px); a
  divider; price row = current price `14px/700` `ink` + original price
  `12px` `ink-faint` `line-through`.
- **Selected:** `2px solid pine` border + `shadow-focus` ring — never a solid
  colour fill on the whole card.
- **Grid:** 2-col mobile, 3-col desktop, `12–16px` gap.

---

## Badge & chip

| Badge | Style |
|---|---|
| **Discount** `15% OFF` | `grass-tint` fill, `grass-dark` text, `~10px/700`, `radius 6px` — a **soft** tint, not gogogo.id's solid cyan fill |
| **Hot** | flame icon + muted `ink-soft` text |
| **Savings** `Hemat Rp150` | `grass-dark` text on `grass-tint` |
| **Trust row** `Money Back Guarantee` / `Official and Trusted Supply` / `24/7 Customer Support` | icon + 12–13px `ink-soft` text, inline row under hero |
| **Category label** `topup` | tiny `pine-tint`/`pine-dark` pill, lowercase |
| **Coin balance** | pill: number + coin icon, `sand` fill, in header |
| **Status chip** (order/transaction) | `grass` success / `amberx` pending / `rust` failed — always the *tint* background + *dark* text pairing, `border-radius full` |

---

## Segmented control / tabs

_layout ref: `screenshots/desktop/19-product-detail-desktop.png` (Termurah / Membership / Diamonds)_

- Row of pill buttons, `border-radius full`, `12–14px/600`, padding
  `~0.375rem 0.75rem`.
- **Active:** `pine-tint` fill + `pine-dark` text (the `.btn-soft` pattern) —
  not an outline like gogogo.id's yellow-bordered active tab.
- **Inactive:** `ink-soft` text on `sand` fill.
- Same pattern for the **home category filter** (`Lagi Populer`, `Top Up`,
  `Steam Game`, `Voucher`, `Entertainment`).

---

## Top navigation (desktop)

_layout ref: `screenshots/desktop/01-home.png`_

- Fixed, white/`paper` background, `1px line` bottom border, no shadow (or a
  faint `shadow-soft` if it needs to float over content on scroll).
- Left: wordmark logo. Center-left: text links `14px/600` `ink`, plus a
  "Semua Produk ▾" mega-menu trigger.
- Right: search field (pill, `sand` fill) · coin chip · circular avatar
  (`pine-tint` background, `pine-dark` initial).
- Logged-out: a solid `pine` **"Login"** button replaces the avatar.

---

## Bottom navigation (mobile)

_layout ref: `screenshots/mobile/01-home.png`_

- Fixed bottom bar, white/`paper` background, `1px line` top border, 5 items:
  `Home · Transaksi · Promo · Bantuan · Akun`.
- Icon above `~10–12px` label; active item + label tinted `pine`.
- A dismissible cashback promo strip (`pine-tint` background, `pine-dark`
  text) can dock directly above the bar.

---

## Breadcrumb

_layout ref: `screenshots/desktop/19-product-detail-desktop.png`_

`Beranda › Top Up › Top Up Free Fire` — 14px, trailing/leading crumbs in
`ink-soft`, **current page in `ink`** (bold), `›` separators `ink-faint`.

---

## Accordion (FAQ)

_layout ref: `screenshots/desktop/01-home.png` bottom, every product page_

- Full-width rows on white card surface, `1px line` divider between rows.
- Trigger: question 14–15px/500 `ink` left, chevron right (`ink-soft`),
  rotates on open.
- "Tampilkan lebih banyak" ghost link (`pine` text) expands the list.

---

## Sticky purchase bar (product detail)

_layout ref: `screenshots/desktop/19-product-detail-desktop.png`, `mobile/07-product-freefire.png`_

Two stacked strips, pinned to bottom (mobile) / bottom of the purchase column
(desktop), white surface with a `shadow-lift` cast **upward** onto the page
content above it:

1. **Cashback ribbon** — `pine-tint` background, `pine-dark` text:
   `"Asik kamu bisa dapat hingga CASHBACK 18 Koin!"` + coin icon.
2. **Price + CTA** — left: `Harga` label (`ink-soft`) over the current price
   in **`grass-dark` `~20px/700`**, plus `Hemat RpX` (grass) `+ Dapat X Koin`
   (pine) chips. Right: full-height **primary "Lanjutkan"** button.

---

## Carousel / banner

_layout ref: `screenshots/desktop/01-home.png` hero_

- Rounded banner images, `border-radius 16px`.
- Circular prev/next icon buttons (white, `shadow-soft`, `ink-soft` icon),
  dot pagination below (active dot `pine`, wider).

---

## Toast / notifications

Style toasts on white `card`, `border-radius 12px`, `shadow-lift`, `ink`
text, a left status accent bar (`grass` success / `rust` error / `amberx`
warning / `pine` info).

---

## Footer

_layout ref: `screenshots/desktop/01-home.png` bottom_

- `sand` background, `1px line` top border. Left block: logo + tagline +
  region selector + payment-method logos (`"+metode bayar populer lainnya"`
  in `ink-faint`).
- 3 link columns (`16px/600` `ink` headings — Outfit, `15px` `ink-soft`
  links — Manrope). Collapsible accordion on mobile.
- Bottom row: store badges, socials, `Syarat & Ketentuan`, `Kebijakan
  Privasi`, copyright — all `ink-faint`.
