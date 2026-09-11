# gogogo-frontend — Design System

A storefront design system whose **structure** was reverse-engineered from
[gogogo.id](https://gogogo.id) (captured 2026-09-01, logged in as
`ilhmalif@gmail.com`) and whose **look** was then retoned to **this repo's own
"Clean Modern" brand**, so it drops straight into `apps/storefront` /
`apps/web-admin` instead of clashing with them.

Two inputs:

- **From gogogo.id** — page templates, grids, component inventory, the
  denomination-card / sticky-purchase-bar / bottom-nav patterns. Screenshots
  in [`../screenshots/`](../screenshots/); currency icons in
  [`../assets/icons/`](../assets/icons/).
- **From this repo** — every colour, font, radius, shadow and motion value,
  copied 1:1 from the single source of truth:
  - `apps/storefront/static/app.css` (`:root` tokens + `.card/.btn/.field/.chip`)
  - `packages/web-ui/views/_theme.njk` (the server-rendered `tailwind.config`)
  - `apps/web-admin/static/admin-theme.css` (admin's Inter/slate retune)

> gogogo.id's actual theme is dark, flat, and built on a loud golden yellow.
> **None of that survives here** — this system is light, soft-shadowed, and
> blue-primary, matching the rest of the codebase.

---

## Contents

| File | What's in it |
|---|---|
| [`foundations.md`](./foundations.md) | Brand, colour system, typography (Outfit/Manrope/JetBrains Mono), spacing, radius, elevation, layout, motion — with a11y notes |
| [`components.md`](./components.md) | Buttons, inputs, cards, badges, tabs, nav, product/denomination cards, sticky purchase bar, footer |
| [`page-templates.md`](./page-templates.md) | How pages assemble: home, category, product detail, auth, account, transactions, legal, support, promo, search, 404 |
| [`tokens.css`](./tokens.css) | Portable `--gg-*` custom properties (values = this repo's brand) |
| [`tokens.json`](./tokens.json) | Same tokens, machine-readable |
| [`tailwind.preset.js`](./tailwind.preset.js) | Tailwind theme extension |

---

## The system in 30 seconds

- **Light.** Page is `paper` `#f6f8fb`; cards are white with a **soft shadow**
  + 1px `line` border. (gogogo.id uses a dark surface ramp and no shadows —
  the reverse.)
- **One brand colour:** pine blue `#2563eb` on every primary action, **white**
  text on it.
- **One accent:** grass green `#16a34a` — savings, discounts, success, the
  positive checkout price. Used as a *soft tint + dark text*, not a solid fill.
- **Two typefaces:** Outfit for headings, Manrope for everything else;
  JetBrains Mono for order/voucher codes.
- **Shape:** buttons and fields are `12px`; cards `16px`; chips/avatars/tabs
  fully round. (No full-pill inputs like gogogo.id.)
- **Layout (kept from gogogo.id):** 1152px max column, product grid 5-up
  desktop / 2-up mobile, product detail = 2-column summary+purchase split with
  a sticky buy bar, mobile nav in a bottom tab bar.
- **Motion:** 150ms transitions, a 0.5s `rise` entrance, signature ease-out
  `cubic-bezier(0.22, 1, 0.36, 1)`.

---

## Currency / denomination icons

[`../assets/icons/`](../assets/icons/) holds **58 icon assets** pulled from
gogogo.id's CDN — the small art on each denomination card (the shared
"Diamonds" icon + per-game icons for all 50 Top Up games). See
[`../assets/icons/README.md`](../assets/icons/README.md) for the full
game-by-game breakdown (which icon is shared, which is bespoke, confirmed
against on-page labels). These are **reference** for icon *treatment* (size,
radius, chip background) — swap in your own currency art before shipping.

---

## Known gaps (not captured from gogogo.id)

- **Clean `/login` email screen** — the account was authenticated, so `/login`
  redirects; only the OTP step (`12-login-otp.png`) is captured.
- **Checkout / payment-method screen** — pressing "Lanjutkan" would place a
  live order. Templated from context in `page-templates.md §3`.
- **Populated transaction list & order detail** — account has no transactions;
  only the empty state is captured.
- Hover / focus / loading states are specified from token evidence, not all
  individually screenshotted.

---

## Regenerating / verifying

Screenshots: Playwright at `1440×900` (desktop) and `390×844` (mobile),
full-page PNGs. Icons: fetched via each product route's `RSC: 1` Flight
payload, then downloaded direct from the CDN. Re-run against gogogo.id and
diff `../screenshots/` / `../assets/icons/` to catch drift. The token files
track **this repo**, so re-sync them from `apps/storefront/static/app.css`
whenever that changes — never the reverse.
