# Business Adaptation

> The **semantic layer** on top of `gogogo-frontend/design-system/`. The visual
> spec files (`foundations.md`, `components.md`, `page-templates.md`,
> `tokens.*`) define **how it looks**; this file defines **what it means** for
> this shop. Where the two disagree, business functionality wins and the
> visual *language* is preserved by adapting composition (prompt §3.2).
>
> Source of truth for everything below: the repository —
> `apps/storefront/client/src/**`, `packages/core/locales/{id,en}.json`,
> `packages/core/src/enums.ts` — plus the Task 1 audit
> (`docs/implementation/00-audit.md`). Reference vocabulary being mapped away
> from comes from `foundations.md` / `page-templates.md` / the gogogo.id
> screenshots.
>
> **Companion docs:** resolved escalations are logged in
> `docs/implementation/assumptions.md` (mobile-nav model, form library).

---

## Brand

| Field | Value |
|---|---|
| **Brand name** | **Shop-configured, not hardcoded.** Read from `useShopContext().shop_name` (`apps/storefront/client/src/components/Layout.tsx`, backed by `GET /api/v1/pages/context`). The app is multi-tenant — one storefront build serves many shops, each with its own name, tagline, logo, contact channels. Never write a literal brand name into markup, copy, `alt` text, or tests. Where a sentence needs the name, interpolate it (`t("web.about_p1", { shop })`) — the i18n layer already does this (`AboutPage.tsx`, `/terms`, `/privacy`). |
| **Logo** | `useShopContext().logo_url` when set — rendered `object-contain`, max ~10rem wide, in the header (`Layout.tsx`). Fallback when unset: the `Store` lucide glyph + the shop name in `font-display` semibold. No bundled bitmap logo. |
| **Favicon** | Served by the app shell / server per tenant; not a design-system asset. Not set from client code. Treat as shop-configured, same class as `logo_url`. |
| **Primary color (token)** | `--pine` `#2563eb` (primary buttons, links, focus ring, active nav/tab, cart pill). Hover `--pine-dark` `#1d4ed8`; soft fill `--pine-tint` `#e6effe`. Matches the repo's shipped `app.css` — this is structural, **not a rebrand**. |
| **Secondary / accent color (token)** | `--grass` `#16a34a` — savings, discounts, success, the positive checkout price (`--grass-dark` text on `--grass-tint` fill). Support hues: `--amberx` `#b45c0a` (pending / soft warning), `--rust` `#dc2626` (errors, destructive). No new hue is introduced by this shop. |
| **Voice and tone** | **Plain, direct, warm, Indonesian-first and fully bilingual (ID + EN).** Every user-facing string is a key in `packages/core/locales/{id,en}.json`, resolved by `lib/i18n.ts` (`<html lang>` → EN fallback → raw key). ID copy is conversational and reassuring without being salesy ("Kabari saat ready", "Belanja sebagai tamu? Lacak pesananmu", "Masuk untuk lanjut — isi keranjangmu ikut terbawa."). No hype, no invented social proof — testimonials and stats render **only** from real delivered orders (`HomePage.tsx` hides the section when empty; the vanity-stats band was deliberately replaced by a static "Our Promise" block). EN copy mirrors ID meaning, not word-for-word. Sentence case for actions; Title Case avoided except proper nouns. Keep this register for any new copy; tag placeholders `TODO_COPY` (prompt §21.3). |

---

## Product / Service

| Field | Value |
|---|---|
| **What we sell** | Digital entertainment goods for a games / online-services audience: **game top-ups** (per-denomination in-game currency & memberships, e.g. Diamonds), **vouchers / redeem codes**, **digital entertainment credit**, and **wallet top-ups** (buying store credit — `Saldo` — in IDR or USDT for later purchases). Fulfillment is either **automatic** (Digiflazz provider pilot, `checkout_flow: "instant"` categories → `InstantBuyPage`) or **manual / manual-with-info** (admin hand-delivers; buyer supplies delivery fields like a game User ID). |
| **Product categories** | **Dynamic, from the API** (`GET /api/v1/pages/context`, `/pages/categories`, `/pages/category/:slug`). Each category has a slug, name, and optional emoji; some carry `checkout_flow: "instant"`. Do **not** enumerate a fixed category list in the UI or in config — render whatever the API returns, with an empty state when there are none. The reference site's fixed pill set (`Lagi Populer / Top Up / Steam Game / Voucher / Entertainment`) is illustrative only. |
| **Pricing model** | Per-denomination **fixed price** (each package/denomination has its own price; no per-unit arithmetic in the UI). Optional **flash-sale discount** (`/flash` shelf, `FlashBadge` with `% OFF` + strikethrough + countdown; `ctx.flash_active` gates the nav entry). **Voucher codes** applied at checkout (`OrderSummaryCard` voucher field → `POST /api/v1/checkout/voucher/preview`). **Quantity / bulk discounts** computed server-side at checkout, surfaced as a summary line — never recomputed client-side. All money is `Decimal` server-side (`@app/core/money`); the client only formats. |
| **Currency and formatting rules** | **IDR is primary.** USDT is shown for crypto rails and USDT wallet balances. All formatting goes through `apps/storefront/client/src/lib/format.ts` (`formatIdr`, `formatNativeUsdt`, …) — a byte-for-byte mirror of `packages/core/formatters.ts` (Decimal, half-up rounding, IDR grouping, USDT display). **Restyle only — never touch the arithmetic or re-implement it inline** (prompt §12, audit §A). The `Price` component (`components/shop/Price.tsx`) is the single render boundary for "IDR + optional derived USDT"; `CurrencyAmount` is the admin equivalent (not used here). Dates: UTC in the DB, formatted for display against the shop `TIMEZONE` by the shared formatter — no ad hoc `toLocaleString`. |

---

## Customer

| Field | Value |
|---|---|
| **Target customer** | Indonesian retail buyers of game credit and digital vouchers — price-sensitive, mobile-first, want delivery in minutes and a way to check on an order without necessarily holding an account. Many arrive from a Telegram bot or WhatsApp link (the same shop also runs an order-bot). Comfortable with QRIS; a subset pays in USDT. |
| **Customer journey** | `browse` (home / category / search) → `product detail` → `pick denomination / package` → **either** `add to cart` → `cart` → `checkout` **or** `instant buy` (single-page, for `instant` categories) → `checkout` (guest email if not signed in · manual delivery-info step · voucher · payment method · place order) → `pay` (gateway instructions + live status poll + countdown) → `fulfillment` (auto within minutes, or manual by an admin) → `order detail` (reveal credentials / delivered content; edit info while `PROCESSING`) → optional `review` and / or `support ticket`. |
| **Authenticated vs. anonymous capabilities** | **Anonymous / guest** (server serves anonymous visitors; guest cart via cookie/session): browse everything, search, build a cart, check out (guest email), pay, and **track** an order by its code (`/track` → establishes a session). A guest order creates a synthetic account whose only real destination is order history. **Authenticated** (registered, or Telegram login): everything above **plus** wallet (IDR + USDT balance, top-up), referral code / earnings, reviews (only for delivered orders), support tickets, full order history, account settings (username / email / password / Telegram link). Wallet top-up, referral, reviews, settings, and support all 401 → redirect to `/login?next=…` for anonymous visitors (treated as correct UX, not a `PermissionDenied` screen — audit §E). |

---

## Core Actions

| Field | Value |
|---|---|
| **Primary CTA** | **Beli sekarang / Buy now** (`btn-primary`) — commits a denomination to purchase (`ProductPage` picker & sticky bar; `InstantBuyPage` submit). Downstream primary CTAs continue the same funnel with step-specific wording: **Lanjut ke pembayaran / Continue to payment** (cart → checkout), **Buat pesanan & bayar / Place order & pay** (checkout submit), **Bayar sekarang / Pay now** (unpaid order → pay), **Top up sekarang / Top up now** (wallet). One primary action per screen. |
| **Secondary CTA** | **Tambah ke keranjang / Add to cart** (`btn-soft`) — the non-committal alternative on product detail. Other secondaries: **Lanjut belanja / Continue shopping** (`btn-ghost`), **Kabari saat ready / Notify me when ready** (`btn-soft`, out-of-stock restock signup), **Kembali ke keranjang / Back to cart** (`btn`). |
| **Destructive actions and their confirmation pattern** | **Both must show a confirmation dialog** (Global Constraints; the app does **not** today — audit §E flags this as `fix-now`): <br>• **Batalkan pesanan / Cancel order** (`PayPage`, currently `btn-ghost text-rust` firing the mutation immediately) — must gain an `AlertDialog` confirmation before the migrating task ships. <br>• **Keluar / Sign out** (`AccountPage`, `btn-ghost`) — must gain a confirmation dialog. <br>• **Hapus / Remove** cart line (`CartPage`, `btn-danger btn-sm`) — already has an inline two-state confirm row; keep the confirm, restyle only. <br>Confirmation copy stays in the plain-direct voice; destructive confirm button uses the `danger` variant, cancel uses `ghost`. A `Modal` / `AlertDialog` primitive does not yet exist and must be built first (audit §C1/§E). |
| **Checkout / order flow** | `Cart` → **Continue to payment** → `Checkout` (guest email if anonymous → manual delivery-info collection → voucher preview → payment-method select → **Place order & pay**) → `Pay` (gateway-specific instructions: QRIS / PayDisini / NOWPayments / Binance / Bybit; live `…/status` poll every ~5s + countdown; **Cancel order** with confirmation) → on success → `Order detail` (credentials / delivered content, info edit while `PROCESSING`). The `InstantBuyPage` variant folds product-pick + delivery-info + payment onto one page for `checkout_flow: "instant"` categories. The `Stepper` component shows `1 Cart · 2 Payment · 3 Done`. |

---

## CTA Register

One row per **semantic action**. Where the app currently uses more than one label for the same action, the **canonical label** is listed here and the divergent screens are named under "Fix targets" below — later tasks must converge on the canonical label. Labels are `ID | EN`, sourced from `packages/core/locales/{id,en}.json`. Variants map to the `app.css` button classes (`components.md` "Button": `primary` / `soft` / `ghost` / `danger`, `-sm` size modifier).

| Label (ID / EN) | Action | Destination | Auth required | Variant |
|---|---|---|---|---|
| Beli sekarang / Buy now | Commit selected denomination to purchase; begin checkout | `InstantBuyPage` submit, or → `/checkout` | No | primary |
| Tambah ke keranjang / Add to cart | Add selected denomination to the guest/user cart | stays on page (`POST /api/v1/cart`) | No | soft |
| Kabari saat ready / Notify me when ready | Register for a restock notification | stays on page (`POST /api/v1/restock/:id`) | No | soft |
| Lanjut ke pembayaran / Continue to payment | Move cart to checkout | `/checkout` | No | primary |
| Lanjut belanja / Continue shopping | Leave cart / empty state, resume browsing | `/` | No | ghost |
| Pakai / Apply | Apply a voucher code to the order | stays on page (`POST /api/v1/checkout/voucher/preview`) | No | soft |
| Buat pesanan & bayar / Place order & pay | Place the order and go to payment | `/checkout/:code/pay` | No (guest checkout) | primary |
| Kembali ke keranjang / Back to cart | Return from checkout to cart | `/cart` | No | soft |
| Bayar sekarang / Pay now | Pay an existing unpaid order | `/checkout/:code/pay` | Session | primary |
| Buka halaman pembayaran / Open payment page | Open the external gateway page (QRIS/PayDisini/NOWPayments/…) | external gateway URL | Session | primary |
| Coba lagi / Try again | Reload payment instructions after a transient error | `payPath` (self) | Session | soft |
| Batalkan pesanan / Cancel order *(canonical; app string: "Batalkan pesanan ini / Cancel this order")* | Cancel the unpaid order — **destructive, must confirm** | stays on page (`POST …/cancel`) | Session | danger *(currently `ghost text-rust`)* |
| Lacak pesanan / Track order | Look up a guest order by its code | `/track` → session established | No | — (nav link) |
| Cari pesananmu / Find my order | Submit the tracking form | resolves the order, redirects | No | primary |
| Top up saldo / Top up balance *(canonical; nav + tiles)* | Open the wallet top-up flow | `/wallet/topup` | Yes | primary / link |
| Top up sekarang / Top up now | Submit the wallet top-up | `/wallet/topup/:code/pay` | Yes | primary |
| Masuk / Sign in | Authenticate (identifier + password, or Telegram widget) | `/login` submit → `next` or `/account` | No | primary *(nav: ghost link)* |
| Buat akun / Create account | Register a new account | `/register` submit | No | primary |
| Baru di sini? Buat akun / New here? Create an account | Go to registration | `/register` | No | link |
| Kirim tautan reset / Send reset link | Request a password-reset email | `/forgot` submit | No | primary |
| Simpan kata sandi baru / Save new password | Set a new password from the emailed link | `/reset/:token` submit | No (token-gated) | primary |
| Minta tautan reset baru / Request a new reset link | Escape hatch from a dead/expired reset link | `/forgot` | No (token-gated) | link |
| Keluar / Sign out | End the session — **destructive, must confirm** | `POST /api/v1/auth/logout` → `/` | Yes | ghost |
| Ubah / Edit *(canonical for "modify a record"; app also uses "Ubah / Update" for the cart quantity stepper — see fix targets)* | Enter edit mode for delivery info on a `PROCESSING` order | stays on page | Yes | soft `-sm` |
| Simpan perubahan / Save changes | Persist edited order delivery info | stays on page (`PATCH …/info`) | Yes | primary `-sm` |
| Batal / Cancel | Dismiss an inline edit / confirm prompt (non-destructive) | stays on page | — | ghost `-sm` |
| Hapus / Remove | Remove a cart line — inline two-state confirm | stays on page (`…/remove`) | No | danger `-sm` |
| Segarkan / Refresh | Manually refetch order status | stays on page | Yes | soft `-sm` |
| Kirim / Send | Create a new support ticket | `/account/support/:id` | Yes | primary `-sm` |
| Balas / Reply | Post a reply on a support ticket | stays on page (`…/reply`) | Yes | primary `-sm` |
| Masalah selesai / Problem solved | Close a support ticket *(semantic = "close ticket"; worded reassuringly on purpose)* | stays on page (`…/close`) | Yes | soft `-sm` |
| Buka lagi tiket / Reopen ticket | Reopen a closed, still-reopenable ticket | stays on page (`…/reopen`) | Yes | soft `-sm` |
| Kirim ulasan / Send review | Submit a rating + comment for a delivered order | stays on page (`POST /api/v1/account/reviews`) | Yes | primary `-sm` |
| Simpan / Save | Save account credential changes | stays on page (`…/credentials`) | Yes | primary |
| Salin / Copy | Copy referral link / code / credentials to clipboard | — (clipboard) | Yes | soft `-sm` |
| Bersihkan / Clear | Clear the recent-searches list | stays on page (localStorage) | No | ghost `-sm` |
| Lihat produk / Browse products *(canonical)* | Go to the browse-all shelf / jump to products | `/products` or `#products` | No | primary *(hero)* / ghost link |
| Hubungi kami / Contact support | Jump to the contact section / support | `#contact` / `/account/support` | No | ghost *(on-dark outline)* |
| Lihat per Kategori / Browse by category | Jump to the category section on Home | `#categories` | No | link |
| Kembali ke beranda / Back to home | Leave the 404 page | `/` | No | primary |

**Fix targets (label inconsistencies to converge in later tasks):**

1. **"Lihat produk" casing / EN drift.** `web.view_products` renders **"Lihat Produk / View products"** (Home category cards) while `web.nav_products` / `web.hero_cta` render **"Lihat semua produk / Browse products"** and **"Lihat produk / Browse products"**. Canonical: **`Lihat produk` / `Browse products`** (sentence case). Fix `web.view_products`.
2. **"Ubah" EN split.** `web.update` = "Ubah / **Update**" (cart quantity stepper aria-label) vs `web.order_info_edit_btn` = "Ubah / **Edit**" (order-info edit). Same ID word, two EN words. Low-risk. Canonical for "modify a record" = **`Ubah` / `Edit`**; the cart stepper's "commit pending quantity" may legitimately stay "Update" — decide during the Cart migration, don't silently leave both as "Edit".
3. **Track submit vs nav label.** Nav/link = "Lacak pesanan / Track order"; the form submit = "Cari pesananmu / Find my order". Acceptable (submit-button specificity) but note the pair when migrating `/track`.
4. **Ticket close is worded "Masalah selesai / Problem solved"**, not "Tutup tiket / Close ticket". Intentional (friendlier). Keep, but register the semantic so a later task doesn't "correct" it to a literal Close.
5. **`web.notify_restock` = "Kabari saat ready"** mixes English "ready" into ID copy — a `TODO_COPY`-class polish item for the copy pass, not a semantics change.

---

## Navigation

### Main navigation (desktop top bar — `Layout.tsx` header)

Logo (shop-configured) · persistent **search** field (pill, `sand` fill) · **language** toggle (shows the language *in force*; one click swaps ID↔EN via a server round-trip) · **Track order** (icon-only, `PackageSearch`) · **Account** or **Sign in** · **Cart** pill (`pine-tint`, count badge). No "Semua Produk ▾" mega-menu — this app reaches categories via the Home category section, the footer, and the mobile drawer. Browse-all shelves (`/products`, `/categories`, `/flash`) are **not** in the desktop top bar; they live in the footer and mobile nav.

### Account navigation (`AccountPage` — grouped menu, the sole account nav listing)

- **Group "Orders":** My orders (`/account/orders`), Reviews (`/account/reviews`)
- **Group "Profile":** Settings (`/account/settings`)
- **Group "Help":** Referral (`/account/referral`), Support (`/account/support`)
- Plus **wallet top-up** reached from the two emphasized wallet-balance summary tiles (`/wallet/topup?currency=IDR|USDT`), and **Sign out** as a standalone row.
- **Guest accounts** see a reduced view: only My orders is real; other destinations are hidden (`GUEST_HREFS`).

### Footer navigation (`Layout.tsx` `FOOTER_LINKS`)

Two nav blocks: **Quick Links** — Browse products, Categories, Track order, About, How to order, Terms, Privacy, Refund (the only internal path a crawler has to the policy pages). **Contact** — WhatsApp and/or Telegram, each rendered only if the shop configured that channel. Brand name + tagline in columns 1–2; centered copyright note. No social icons (no Setting drives them).

### Mobile navigation behavior

**Today:** a hamburger button opens a slide-in **left drawer** (`role="dialog"`, focus-trapped, Esc-to-close, scrim) containing labelled copies of the header links in three divider-separated groups (mine → for-sale → everything else), a language row, a help row, and a muted trust footer. A persistent search field sits in a mobile secondary header row.

**Resolution (ASSUMPTION — logged in `docs/implementation/assumptions.md`, 2026-09-02; controller made this call under Auto Mode, user may veto):** **adopt the design system's fixed bottom tab bar** for mobile primary navigation. `foundations.md` §7 and `components.md` "Bottom navigation (mobile)" make it the visual authority (prompt §2 KEEP: "navigation patterns"), and `tokens.json` already reserves `layout.bottomNavHeight` (`56px`). Adapt **composition, not invention** (prompt §3.2 rule 3):

- **(a) The bottom tab bar is HIDDEN on the full-funnel screens that already own the bottom edge with a sticky action bar** — product detail (`/p/:slug`), cart (`/cart`), checkout (`/checkout`), pay (`/checkout/:code/pay`), wallet top-up (`/wallet/topup`), wallet-top-up pay (`/wallet/topup/:code/pay`). Two fixed bottom elements must never coexist on one screen (prompt §15: no route with two visual languages / colliding chrome). The sticky purchase / checkout bar wins on those six; the tab bar returns everywhere else.
- **(b) Tab items — this shop's real destinations, 5 tabs:**

  | Tab (ID / EN) | Icon (lucide) | Destination | Notes |
  |---|---|---|---|
  | Beranda / Home | `House` | `/` | — |
  | Cari / Search | `Search` | search overlay | Opens the search overlay (per `page-templates.md` §10 and the pre-declared `/search`→overlay deviation in the audit). If that deviation does **not** land and the persistent mobile header search field stays, **drop this tab** and ship a 4-tab bar. |
  | Keranjang / Cart | `ShoppingBag` | `/cart` | Count badge from `ctx.cart_count`. The tab is hidden on `/cart` itself (rule a) but works from every other screen. |
  | Pesanan / Orders | `Package` | `/account/orders` when signed in, else `/track` | Guests have no session; routing them to the code-lookup form matches the existing drawer's "Perlu masuk" handling without a redirect surprise. Canonical label **Pesanan**, not the reference's "Transaksi" (see Terminology). |
  | Akun / Account | `CircleUser` | `/account` (or `/login` if anonymous) | — |

  **Why not the reference's `Home · Transaksi · Promo · Bantuan · Akun`:** "Promo" → this shop's flash sale is **conditional** (`ctx.flash_active`); a permanent tab that opens an empty shelf is worse than no tab, so flash stays a drawer entry. "Bantuan" (support) is **auth-gated** here and lower value for a storefront than Cart — demoted to the drawer / footer. Cart earns permanent billing because repeat top-up buyers return to it constantly.
- **(c)** `layout.bottomNavHeight` (`56px`) is now reachable and used; add `env(safe-area-inset-bottom)` padding **below** the bar; the page's bottom scroll padding must clear `56px + safe-area` so the last row of content is never hidden behind the bar (prompt §10 verification). Active item tinted `--pine` (icon + label), inactive `--ink-soft`.
- **The left drawer is retained as secondary navigation** for the long tail the 5 tabs don't cover (Categories, Products, Flash sale when active, language, Help, trust footer) — opened from a menu affordance, not deleted. The bottom bar is primary; the drawer is "more".

---

## Pages

| Page | This shop |
|---|---|
| **Home** (`/`) | Dark hero band (shop-configured hero image / gradient) + trust chips + two CTAs (Browse products / Contact) · feature grid · "how to order" stepper · dynamic category grid · featured (newest) products · upcoming-services teaser · pine "Our Promise" band (replaces vanity stats) · verifiable-trust checklist · real testimonials (hidden when none) · FAQ accordion · contact cards (WhatsApp / Telegram / support ticket). |
| **Listing** | `/c/:slug` (category), `/products` (browse all), `/flash` (flash sale), `/categories` (grid of category tiles). Product grid + sort `<select>` + empty state; category pages add category-switch pills. Maps to `page-templates.md` §2, adapted. |
| **Detail** (`/p/:slug`) | Product summary + denomination / package picker + **Buy now** / **Add to cart** (+ **Notify me when ready** when out of stock) + reviews + related products. Branches to `InstantBuyPage` (one-page pick + info + pay) for `checkout_flow: "instant"` categories. Desktop 2-col; mobile 1-col + sticky purchase bar. |
| **Cart** (`/cart`) | Line items (quantity stepper, inline remove-confirm), summary card, **Continue to payment**. Guest cart via cookie. Desktop 2-col + summary; mobile sticky checkout bar. |
| **Checkout** (`/checkout`) | Guest email (if anonymous) → manual delivery-info step → voucher → payment method → **Place order & pay**. Shares `OrderSummaryCard` / `PaymentMethodSelector` with `InstantBuyPage`. Guest checkout supported. |
| **Account** (`/account`) | Identity header · wallet (IDR + USDT) / orders / referral summary tiles · grouped nav menu · desktop-only Recent Orders widget · **Sign out**. Reduced view for guest accounts. |
| **Other** | **Wallet top-up** (`/wallet/topup`, `…/:code/pay`) — currency toggle → amount → gateway → submit. **Track** (`/track`) — guest order-code lookup, one generic failure message (anti-enumeration). **Order history** (`/account/orders`) + **order detail** (`/account/orders/:code`, credentials reveal, info edit while `PROCESSING`, SSE sub-status). **Referral** (`/account/referral`). **Reviews** (`/account/reviews`). **Support** — ticket inbox + composer (`/account/support`), ticket detail with merged message/event timeline (`/account/support/:id`) — a business-specific feature the reference site (FAQ-only "Layanan Pengaduan Konsumen") never had. **Settings** (`/account/settings`). **Auth** (`/login`, `/register`, `/forgot`, `/reset/:token`) — full-viewport, outside the shop chrome; Telegram-widget login alongside password. **Legal / content** (`/about`, `/how-to-order`, `/terms`, `/privacy`, `/refund`) — narrow prose, `StaticPage`; wording is frozen for `/terms` `/privacy` `/refund` (restyle only). **404** (`*`). |

---

## Terminology

| Reference term (gogogo.id) | Our business term | Notes |
|---|---|---|
| Koin (loyalty coin, header pill, "Dapat X Koin") | *(no equivalent — do not build)* | This shop has **no loyalty-coin / points system**. Do not add a coin balance pill or "earn X coins" copy. The nearest thing is **wallet credit — `Saldo`** (IDR + USDT), which is spendable stored value, **not** a gamified reward. `components.md`'s "Badge – Coin balance" variant stays unbuilt (audit §C1). |
| Saldo / wallet | **Saldo / Balance** (IDR + USDT) | Real spendable credit. Topped up via the same payment gateways (`/wallet/topup`). Shown as summary tiles on `/account`, and as a payment method at checkout when funded. |
| Nominal | **Nominal / Denominasi** — "Denomination / package" | A fixed-price package within a product (e.g. a Diamonds tier, a membership). `DenominationCard`. Keep "Nominal" in ID copy; "Denomination" / "Package" in EN. |
| "Masukkan User ID" + "Cek ID" button | **Manual delivery fields** (e.g. game User ID), validated **inline** | This app has **no separate "Cek ID" button** on product detail. Delivery fields are collected as form inputs at checkout (or on `InstantBuyPage`), validated client-side by `src/lib/deliveryFields.ts` (`fieldError`, `isValidEmail`) mirroring the server, re-validated server-side. |
| Promo (`/promo`, promo cards, "Semua Promo / Flip QRIS / GOGOAPLIKASI" tabs) | **Flash Sale** (`/flash`) + **voucher codes** | Two distinct mechanisms: a time-boxed flash-sale shelf (`FlashBadge`, `% OFF`, countdown, `ctx.flash_active`) and checkout voucher codes. No standalone "promo" content model / carousel. |
| Pesanan / Transaksi (`/transaction`, "transaction history") | **Pesanan / Order** *(canonical)* | The app's own copy is dominated by **"Pesanan"** (`nav_orders` = "Pesanan saya / My orders", `order_code`, `account_orders`, `order_status`). Use **Pesanan / Order** everywhere — including the mobile bottom-tab label — and map the reference's "Transaksi" onto it. "Transaction" survives only in back-office / payment-record contexts, not storefront UI. |
| Tracker (`/track-transaction`, "same form without login, keyed by transaction ID") | **Lacak pesanan / Track order** (`/track`) | Keyed by **order code** (looks like `ORD-20260101-ABCD`), no email/phone required. One generic failure message for both "not found" and "wrong account" (deliberate, anti-enumeration). |
| "Layanan Pengaduan Konsumen" (FAQ page + regulator/entity info block) | **Support tickets** (`/account/support`) + FAQ on Home | This shop runs a real **ticketing system** (inbox, composer, attachments, message/event timeline, close/reopen), not a static FAQ-plus-regulator-block page. FAQ content lives in the Home FAQ accordion. Any regulator/company-entity disclosure is shop-configured, not a fixed block. |
| "Semua Produk ▾" mega-menu (desktop nav) | **Category section on Home + footer links + mobile drawer** | No mega-menu component. Categories are dynamic; reached via the Home category grid, the `Categories` / `Products` footer links, and the mobile drawer. |
| "Welcome to Gogogo!" / branded auth headline | Shop-configured / neutral auth copy | Auth screens use neutral, shop-name-interpolated copy — never a hardcoded brand greeting (prompt §14 IP). |
| Bottom nav: `Home · Transaksi · Promo · Bantuan · Akun` | `Beranda · Cari · Keranjang · Pesanan · Akun` | See Navigation → Mobile. Reference labels do not map 1:1 onto this shop's IA. |
| Cashback ribbon / "Dapat X Koin" on the sticky bar | *(omit)* | No cashback or coin-earn mechanic. The sticky bar shows price (in `grass-dark`) and, when applicable, a `Hemat` / savings chip only. |

---

## Entity States

Each state maps to an **existing** semantic token — `grass` (success / positive), `amberx` (pending / in-progress / soft warning), `rust` (failed / destructive), `pine` (awaiting-payment, an actionable neutral), or `sand`/`ink-soft` (inert). **No new color.** Verified against `components/shop/StatusBadge.tsx`, `TicketStatusBadge.tsx`, `StockBadge.tsx`, and `packages/core/src/enums.ts` (`OrderStatus`, `customerStatusLabel`). Storefront shows a **coarse** status; several internal `OrderStatus` values fold into one buyer-facing label (`customerStatusLabel`).

### Order / transaction states

| State (coarse) | Meaning | Badge token | User-visible label (ID / EN) |
|---|---|---|---|
| `PENDING_PAYMENT` | Order placed, payment window open, nothing received yet | `pine` (`pine-tint` / `pine-dark`) — actionable, not a warning | Menunggu Pembayaran / Waiting Payment (chip: "Menunggu pembayaran / Awaiting payment") |
| `PENDING` | Payment seen but not yet cleared / verifying | `amberx` | Menunggu / Waiting |
| `PROCESSING` *(folds `PENDING_VERIFICATION`, `PAID`, `UNDERPAID`, `PROCESSING`)* | Paid; fulfillment in progress (auto queue or admin) | `amberx` | Sedang Diproses / Processing · order-detail heading: "Sedang disiapkan / Being prepared" |
| `DELIVERED` | Fully fulfilled; credentials / content available | `grass` (`grass-tint` / `grass-dark`) | Terkirim / Delivered |
| `PARTIALLY_DELIVERED` | Part of the order did not arrive — deliberately **not** shown as success | `amberx` (never `grass`) | Terkirim Sebagian / Partially Delivered |
| `FAILED` *(folds `CANCELLED`, `REJECTED`, `FAILED`)* | Order will not be fulfilled | `rust` (`rust-tint` / `rust-dark`) | Gagal / Failed · (chips: Dibatalkan/Cancelled, Ditolak/Rejected) |
| `REFUNDED` | Paid, then money returned | `rust` | Direfund / Refunded |
| Payment-window **expired** | The pay countdown elapsed before payment cleared | not a distinct order badge — `PayPage` renders expiry copy (`web.pay_expired`); the order itself resolves into the `FAILED` bucket (`rust`) | Waktu pembayaran habis / Payment window expired (page copy); chip falls under Gagal / Failed |
| Credited to balance | An unmatched / over-paid amount was pushed to wallet credit instead | `grass` | Ditambahkan ke saldo / Added to credit balance |

### Support-ticket states

| State | Meaning | Badge token | User-visible label (ID / EN) |
|---|---|---|---|
| `OPEN` *(and `WAITING_ADMIN`)* | Awaiting the support team's first / next reply | `pine` in `TicketStatusBadge` (list chips via `StatusBadge` tone `amberx`) — *see note* | Menunggu Dukungan / Waiting for Support |
| `ANSWERED` / `REPLIED` *(and `WAITING_CUSTOMER`)* | Support replied; the buyer's turn | `amberx` | Menunggu Balasanmu / Waiting for Your Reply |
| `CLOSED` | Resolved; still reopenable within the warranty window | `grass` | Ditutup / Closed |

> **Tone note:** `TicketStatusBadge` (ticket detail) tones OPEN as `pine` with a `Clock` icon; the shared `StatusBadge` (list views) tones the same `open` value as `amberx`. This is an existing, deliberate divergence (`TicketStatusBadge`'s header comment — ticket-specific copy can't live in the shared badge). Both stay within the existing token set; a later task may unify the tone but must not introduce a new color.

### Stock states (`StockBadge`)

| State | Meaning | Badge token | User-visible label (ID / EN) |
|---|---|---|---|
| In stock | `available > lowThreshold`, or all denominations are manual (never "out") | `grass` | Tersedia / Available (chip EN: "In stock") |
| Low | `0 < available ≤ lowThreshold` | `amberx` | Sisa {n} / {n} left |
| Out of stock | `available === 0` (auto denominations only) | `rust` | Stok habis / Out of stock |

> `StockBadge` uses a one-off foreground nudge (`text-[#157e3b]`) scoped to the badge to clear WCAG AA on `grass-tint` — the shared `--color-grass-dark` token is untouched. Preserve that behavior when refactoring onto the `Badge` primitive; do not "clean it up" into the shared token.

---

## Features

- **Guest checkout** — browse, cart, checkout (guest email), pay, and track without an account; a synthetic account is created for order history.
- **Order tracking** — `/track`, keyed by order code only; establishes a session, anti-enumeration failure copy.
- **Wallet** — IDR + USDT stored balance (`Saldo`), topped up via the same gateways, spendable at checkout.
- **Referral** — per-account code + link, commission on each referred friend's first purchase, earnings summary.
- **Reviews** — rating + comment, only for delivered orders; real reviews feed Home testimonials.
- **Support tickets** — inbox, composer with attachments, merged message/system-event timeline, quick-reply templates, draft autosave, close / reopen, order-linked sidebar.
- **Flash sale** — time-boxed discounted shelf (`/flash`), `% OFF` badge + countdown + strikethrough; nav entry only when active.
- **Voucher codes** — applied at checkout, previewed before placing the order.
- **Instant top-up rail** — one-page pick + delivery-info + pay for `checkout_flow: "instant"` (Digiflazz) categories.
- **Telegram login** — Telegram widget auth alongside username/password; account-linking from Settings.
- **Bilingual UI** — ID / EN via `<html lang>` + `lib/i18n.ts`, one-click server-side switch.
- **Live payment status** — `PayPage` polls `…/status` (~5s) with a countdown; `OrderDetailPage` polls while `PROCESSING` plus SSE sub-status.
