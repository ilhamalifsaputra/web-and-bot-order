# Currency / denomination icons

58 icon assets pulled directly from gogogo.id's CDN on 2026-09-01 — the small
art shown on each **denomination card** in a product-detail page (the "5
Diamonds" / "BP Card" / "Weekly Membership" style tiles under "Pilih Nominal
atau Paket"). These are the source assets, at their original resolution —
not the resized `_next/image` proxy URLs.

## How they were found

Every `/p/topup/<slug>` route is a Next.js client-rendered page, but fetching
it with an `RSC: 1` header returns the React Flight payload the client would
otherwise render from — image URLs included — without needing a full browser
render. That was scripted once across all 50 "Top Up" games (the only
category with a real in-game *currency*; Voucher/Entertainment items are
gift cards and subscriptions, not currencies) to pull every denomination-card
image URL, then downloaded directly.

## What's here

```
_currency-generic/       the shared "Diamonds" icon — reused across ~20 games
<game-slug>/icon.*        that game's own art (when it has one)
free-fire/, free-fire-max/, mobile-legends/   multiple named icons — these
                          games have several denomination TYPES, not just one
```

### `_currency-generic/` — the shared Diamond icon

Most games that literally call their currency "Diamonds" (Mobile Legends,
Free Fire, Magic Chess: Go Go, Honor of Kings, Wuthering Waves, Metal Slug
Awakening, Goddess of Victory: Nikke, Hago, State of Survival, Solo Leveling:
Arise, League of Legends: Wild Rift, Honkai: Star Rail, Teamfight Tactics
Mobile, Dragonheir, Fat Meat Wukong, Ys 6 Mobile, and more) **share one
uploaded diamond-icon asset** rather than getting custom art — confirmed by
correlating each `<img>` with its adjacent "N Diamonds" label:

| File | Confirmed via |
|---|---|
| `diamond-generic-1.webp` | ML "170 Diamonds", FF "70 Diamonds" — the small blue diamond cluster |
| `diamond-generic-2.webp` | ML "5 Diamonds", FF "100 Diamonds" — alt diamond-cluster art |
| `diamond-generic-3.png` | ML "370 Diamonds" (rarer, used for a handful of tiers) |

### Games with their own dedicated icon

Mobile Legends and Free Fire got bespoke, per-item art (confirmed by
correlating each icon with its on-page label — see table below). Free Fire
MAX, Magic Chess: Go Go, Honor of Kings, Ragnarok M Classic, Dragon Raja,
PUBGM (ID), Steam Wallet and Roblox each have their own icon too, just
unlabelled in the source (single denomination type, so no ambiguity).

| Game | File | Label on gogogo.id |
|---|---|---|
| Mobile Legends | `mobile-legends/weekly-diamond-pass.webp` | "Weekly Diamond Pass (Event Topup +100)" |
| Free Fire | `free-fire/diamonds.png` | "5 Diamonds" (FF's own diamond art, not the shared one) |
| Free Fire | `free-fire/bp-card.webp` | "BP Card" |
| Free Fire | `free-fire/weekly-membership.png` | "Mingguan Membership" |
| Free Fire | `free-fire/monthly-membership.png` | "Bulanan Membership" |
| Free Fire MAX | `free-fire-max/icon-{1..4}.*` | 4 denomination types (Diamond / Level Up Pass variants), unlabelled |
| Magic Chess: Go Go | `magic-chess-go-go/weekly-card.png` | Weekly card art |
| Honor of Kings | `honor-of-kings/icon.png` | — |
| Ragnarok M Classic | `ragnarok-m-classic-uid/icon.jpg` | — |
| Dragon Raja | `dragon-raja/icon.png` | — |
| PUBG Mobile (ID) | `uc-pubgm-indonesia/icon.png` | UC icon |
| Steam Wallet | `steam-wallet/icon.png` | — |
| Roblox | `roblox/icon.png` | Robux gem |

### Everything else — 26 games, one icon each

`8-ball-pool, atlantica-rebirth, cloud-song, dragonheir, dunk-city-dynasty,
eggy-party, fat-meat-wukong, garena-undawn, goddess-of-victory-nikke,
gold-dragon-nest-classic-sea, hago, heroes-evolved, honkai-star-rail,
infinite-borders, laplace-m, league-of-legends-pc,
league-of-legends-wild-rift, legends-of-runeterra, lokapala, marvel-rivals,
metal-slug-awakening, mu-origin-3-asia, octopath-traveler-cotc,
one-punch-man, perfect-world, ragnarok-forever-love, ragnarok-origin-global,
ragnarok-retro, saint-seiya-awakening, solo-leveling-arise,
state-of-survival, tarisland, teamfight-tactics-mobile, uc-pubgm-global,
undawn-garena, valorant, ys-6-mobile, zenless-zone-zero, zepeto` — each was
confirmed (Valorant, live-DOM-checked) to **reuse its own product/hero art
as the denomination-card icon** too, since no separate small icon was
uploaded for it. That's genuinely the icon gogogo.id shows on the buy screen
for these games, not banner art swapped in for convenience.

### Not included

- **Voucher / Entertainment / Steam Game categories** — gift cards and
  subscriptions (PSN, GTA V, Netflix-style entertainment apps, Steam game
  keys) don't have an in-game "currency", so there's no equivalent icon to
  extract; their product cards use the box-art thumbnail instead (already in
  `../../screenshots/`).
- `robux-username` — the page is in maintenance (`/maintenance`), no live
  denomination cards to read.
- Pure banner/hero art (`storage.googleapis.com/lpt-prod-assets/...Thumbnail...`
  filenames) was deliberately excluded — that's the product-page key art
  shown once at the top, not the repeated small currency icon.

## License / usage note

These are gogogo.id's own product art, pulled for **reference** while
building this design system (matching icon *treatment* — size, corner
radius, background — not redistributing their branded game art as your own
product's assets). Swap in your own currency iconography before shipping.
