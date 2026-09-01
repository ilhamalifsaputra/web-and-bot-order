# gogogo-frontend

Front-end reference material for **gogogo.id**, captured 2026-09-01 (logged in
as `ilhmalif@gmail.com`).

```
gogogo-frontend/
├── screenshots/
│   ├── desktop/   full-page PNGs @ 1440×900   (19 captures)
│   └── mobile/    full-page PNGs @ 390×844    (17 captures)
├── assets/
│   └── icons/     58 currency/denomination icon assets, one per game
│                  (+ shared "Diamond" icon) — see assets/icons/README.md
└── design-system/
    ├── README.md            start here
    ├── foundations.md       colour, type, spacing, radius, elevation, layout
    ├── components.md        component-by-component specs
    ├── page-templates.md    how pages are assembled
    ├── tokens.css           portable --gg-* custom properties
    ├── tokens.json          machine-readable tokens
    └── tailwind.preset.js   Tailwind theme extension
```

**Colour values in `design-system/` are this repo's own brand** (paper/pine/
grass/amberx/rust — see `apps/storefront/static/app.css`), not gogogo.id's.
Only the layout/component *structure* below was reverse-engineered from
gogogo.id; see `design-system/README.md` for the full explanation.

## Screenshot index

Same numbering across `desktop/` and `mobile/` = same page (a few desktop-only
extras at the end).

| # | Page | URL |
|---|---|---|
| 01 | Home / landing | `/` |
| 02 | Category — Top Up | `/p/topup` |
| 03 | Category — Voucher | `/p/voucher` |
| 04 | Category — Entertainment | `/p/entertainment` |
| 05 | Category — Steam Game | `/p/steam-games` |
| 06 | Product detail — Mobile Legends | `/p/topup/mobile-legends-games` |
| 07 | Product detail — Free Fire | `/p/topup/free-fire-games` |
| 08 | Promo | `/promo` |
| 09 | Support / Bantuan | `/support` |
| 10 | Transaction tracker | `/track-transaction` |
| 11 | Transaction history (empty state) | `/transaction` |
| 12 | Login — OTP step | `/login/otp` |
| 13 | Account / profile | `/user` |
| 14 | Terms — Syarat & Ketentuan | `/syarat-ketentuan` |
| 15 | Privacy — Kebijakan Privasi | `/kebijakan-privasi` |
| 16 | 404 / not found | `/install` (any unknown route) |
| 17 | Search (results / overlay) | header search |
| 18 | desktop: "Semua Produk" mega-menu · mobile: search overlay + product validation error | — |
| 19 | desktop only: product-detail purchase column close-up | — |

## Not captured (see design-system/README.md "Known gaps")

Clean `/login` email screen (account was already authed), the checkout /
payment-method screen (would place a live order), and a populated transaction
list (account has no orders).
