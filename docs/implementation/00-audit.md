# 00 — Repository & Design-System Audit

Produced for Task 1 of the storefront redesign (`.superpowers/sdd/plan.md`).
Covers §5.2 of `FRONTEND_IMPLEMENTATION_PROMPT_v3.md`. No `TBD` cells.

> **Note on sources.** `gogogo-frontend/design-system/*` and
> `FRONTEND_IMPLEMENTATION_PROMPT_v3.md` are untracked in the main repo and
> were not present in this worktree at task start (git worktrees only copy
> tracked files). They were read directly from the main checkout
> (`C:\Users\ilham\Documents\web-and-bot-order\`) — same filesystem, same
> content, read-only. See the task report for the resulting recommendation
> that these get copied into this worktree (or committed) before later tasks
> depend on them being present here.

---

## A. Stack statement

| Aspect | Value | Evidence |
|---|---|---|
| Framework | React 18.3.1 | `apps/storefront/client/package.json` |
| Build tool | Vite 6.0.3 (`@vitejs/plugin-react`, `@tailwindcss/vite`) | same |
| Router | `react-router-dom` v7, **declarative mode** (`<Routes>`/`<Route>` in `App.tsx`, not the data router/loader API) | `App.tsx` |
| Styling | **Tailwind v4, CSS-first** — no `tailwind.config.js` anywhere in `apps/storefront/client`. Config lives as an `@theme static { ... }` block in `apps/storefront/client/src/index.css` lines 55–80, plus a plain-CSS layer (`apps/storefront/static/app.css`, imported verbatim at `index.css:51`) that defines the actual `:root` custom properties (`--pine`, `--ink`, `--r-lg`, …) and the `.card/.btn/.field/.chip` component classes. | `index.css`, `app.css` |
| State / data | TanStack Query v5.59 for all server state (`useQuery`/`useMutation` per page). No Redux/Zustand/Jotai — local UI state is plain `useState`. `CartPage`/`CheckoutPage` mirror the query result into local state so mutation responses can update the page without a refetch. | grepped every page |
| Form / validation library | **None.** No `react-hook-form`, `zod`, `yup`, or any schema library in `package.json` or source. Every form (Login, Register, Forgot, Reset, Checkout's guest-email + info-collection step, Settings, WalletTopup amount, Reviews rating/comment, Support/Ticket composer) uses **controlled React state + native HTML5 validation attributes** (`required`, `minLength`, `maxLength`, `pattern`) **plus hand-written TypeScript validators** in `src/lib/deliveryFields.ts` (`fieldError`, `isValidEmail`) that mirror the server's `packages/core/src/deliveryFields.ts` rule-for-rule. Server is always the real authority; client validation is UX-only (documented in every form's comments). | Read all 10 form-bearing pages + `lib/deliveryFields.ts` |
| Test runner | Vitest (root `vitest.config.ts`), `@testing-library/react` + `jsdom`. Storefront tests are colocated `*.test.tsx` next to the component/page (e.g. `CartPage.test.tsx`, `Callout.test.tsx`). | `vitest.config.ts`, file listing |
| E2E | Playwright (`playwright.config.ts` at repo root, `tests/e2e/checkout.spec.ts` — added per recent commit `b0c00acf`). | repo root |
| Package manager | pnpm (`pnpm-workspace.yaml`, `pnpm-lock.yaml`). `apps/storefront/client` is its own workspace package (`@app/storefront-client`), listed explicitly in `pnpm-workspace.yaml`. | `pnpm-workspace.yaml` |
| TypeScript strictness | `tsconfig.base.json`: `target: ES2022`, `strict: true`, **`noUncheckedIndexedAccess: true`**, **`noImplicitOverride: true`**, `moduleResolution: Bundler`, `isolatedModules: true`, `resolveJsonModule: true`, `skipLibCheck: true`. `strict` + `noUncheckedIndexedAccess` together mean every array/object index access is `T \| undefined` — visible throughout the codebase (`denominations[i]!` non-null assertions, `.find() ?? fallback` patterns). | `tsconfig.base.json` |
| Icons | `lucide-react` v1.21 — one icon library, used everywhere, sized/stroke-weighted per local convention (e.g. `Layout.tsx`'s `DRAWER_ICON = { className: "h-5 w-5 shrink-0", strokeWidth: 1.75 }` constant). | grep |
| Animation | `framer-motion` v12.42 — already a dependency; `src/lib/motion.ts` centralizes `EASE = [0.22,1,0.36,1]` and `DURATION.fast = 0.15s`, which **already matches** the design system's signature ease-out (`foundations.md` §8). No new animation library needed. | `lib/motion.ts` |
| Fonts | Self-hosted via `@fontsource/{outfit,manrope,jetbrains-mono}`, Latin subset only, weights pinned to what's actually rendered (see `index.css`'s own comment). Matches `foundations.md` §3's Outfit/Manrope/JetBrains Mono system exactly — **already the correct font stack**, no change needed. | `index.css` |

**Constraints on implementation:**

- **No SSR.** This is a client-rendered SPA. A separate Nunjucks-rendered
  "SEO shell" (`apps/storefront/src/routes/spaShell.ts`) serves a crawler-
  visible pre-hydration snapshot for some routes; `StaticPage.tsx`'s own
  comment warns that whatever renders there must stay byte-for-byte in sync
  with that shell (cloaking risk) — relevant for any future task that
  touches About/Terms/Privacy/Refund/How-to-Order copy or layout.
- **Tailwind v4 has no `tailwind.config.js`.** All theme values are CSS
  custom properties under `@theme` in `index.css`. `gogogo-frontend/design-
  system/tailwind.preset.js` is explicitly a **v3-syntax portable reference
  only** (its own file header says so) — it must be hand-translated into
  `@theme` syntax, never imported directly.
  - Effect: `--radius-xl2: 1.25rem` is the **only** extra radius token
    currently declared in `@theme`; the token set's own `radius.{xs,sm,md,
    lg,full}` scale is *not* mirrored into `@theme` today — those values are
    only reachable today via the plain-CSS `.card/.btn/.field` classes'
    hard-coded `var(--r-*)`, not as Tailwind utilities. See §D.
- **Two coexisting radius systems today** (see §D/§E): the `app.css`
  component classes use a small `--r-*` scale (4/8/12/16px), while raw
  Tailwind default radius utilities (`rounded-2xl`=16px, `rounded-3xl`=24px)
  are used ad hoc across page JSX for anything that isn't `.card`/`.btn`/
  `.field`. `rounded-3xl` has no equivalent in either the app's own `--r-*`
  scale or the design system's `radius` token (`xs/sm/md/lg/full` =
  4/8/12/16/9999px — nothing at 24px).
- **`framer-motion`/`lucide-react`/fonts are pinned, not to be swapped** —
  Global Constraints bans new dependencies beyond what a task explicitly
  calls for, and none of these three needs replacing (see rows above).
- **Money formatting is off-limits.** `src/lib/format.ts` mirrors
  `packages/core/formatters.ts` byte-for-byte (Decimal, half-up rounding,
  IDR grouping, USDT display) — restyle only, never touch the arithmetic.

---

## B. Route inventory

All 27 `<Route>` entries in `App.tsx` plus the catch-all (`*`) = 31 rows.
Priority derives from the plan's stated order: **core commerce > funnel >
auth > account > content** (P1–P5).

| Route | Purpose | Data source | Auth required | Current state (brief) | Target template | Priority |
|---|---|---|---|---|---|---|
| `/` | Home / landing: hero, features, "how to order", categories, featured products, testimonials, FAQ, contact | `GET /api/v1/pages/home` (+ `GET /api/v1/pages/context` via `useShopContext`) | No (public) | Full-featured, single 668-line file; hand-rolled scroll-reveal, hero product-preview cards | Home / Landing (`page-templates.md` §1) — direct match | P1 |
| `/c/:slug` | Category listing | `GET /api/v1/pages/category/:slug?sort=` | No (public) | Breadcrumb-free header, category-switch pills, product grid, sort, empty state | Category listing (§2) — direct match | P1 |
| `/categories` | Category index (grid of category tiles) | `GET /api/v1/pages/categories` | No (public) | Grid of tiles reusing Home's category-card treatment | Category listing (§2), **adapted** — grid of category tiles, not products (no dedicated "category index" template exists) — `ASSUMPTION` | P1 |
| `/products` | Browse-all-products shelf | `GET /api/v1/pages/products?sort=` | No (public) | Same grid/sort/empty pattern as Category, minus category pills | Category listing (§2), **adapted** — no category filter — `ASSUMPTION` | P1 |
| `/flash` | Flash-sale product shelf | `GET /api/v1/pages/flash?sort=` | No (public) | Same grid/sort/empty pattern; `Zap` icon heading | Category listing (§2), **adapted** — `ASSUMPTION` | P1 |
| `/p/:slug` | Product detail: image, denomination picker, buy/add-to-cart, reviews, related products. Branches to `InstantBuyPage` for `checkout_flow: "instant"` categories (Digiflazz pilot). | `GET /api/v1/pages/product/:slug`; mutations `POST /api/v1/cart`, `POST /api/v1/restock/:id` | No (public) | 2-col desktop / 1-col + sticky bar mobile; live plan-picker state; instant-buy variant folds account-field + payment into one page | Product detail (§3) | P1 |
| `/search` | Search results | `GET /api/v1/pages/search?q=&sort=` | No (public) | Currently a **full dedicated results page**, not an overlay | Search (§10) — **but per Global Constraints, `/search` must become the overlay pattern; route stays resolvable (prefilled query, overlay open) instead of a full-page view.** This is a pre-declared deviation, not this audit's call — log formally in `deviations.md` when implemented. | P1 |
| `/cart` | Cart: line items (qty update/remove with inline confirm), summary, checkout CTA | `GET /api/v1/cart`; mutations `.../update`, `.../remove` | No (guest cart via cookie/session) | Desktop 2-col + summary card; mobile sticky checkout bar | composed — no direct template | P2 |
| `/checkout` | Checkout: guest-email (if guest), manual-info collection step, voucher, payment method, place order | `GET /api/v1/checkout`; `POST /api/v1/checkout/voucher/preview`; `POST /api/v1/checkout` | No (guest checkout supported — server serves anonymous visitors) | 3-col form; sticky mobile total bar; shares `OrderSummaryCard`/`PaymentMethodSelector` with `InstantBuyPage` | composed — no direct template | P2 |
| `/checkout/:code/pay` | Payment instructions + live status poll + countdown + cancel | `GET /api/v1/orders/:code/pay`, `.../status` (5s poll), `POST .../cancel` | Session required (guest or registered) — 401 → `/login?next=...` | Branches per gateway (QRIS/Binance/Bybit/PayDisini/NOWPayments); **Cancel button has NO confirmation dialog today** (fires immediately) | composed — no direct template | P2 |
| `/track` | Guest order-code lookup → establishes session → redirects | `POST /api/v1/track` | No (public — the point of the page is recovering access without one) | Single form, one generic failure message for both "not found" and "wrong account" (deliberate, anti-enumeration) | Transaction history / **Tracker variant** (§6 — page-templates.md explicitly: "the public tracker is the same form without login, keyed by transaction ID") | P2 |
| `/wallet/topup` | Buy wallet credit via existing gateways | `GET`/`POST /api/v1/wallet/topup` | Yes — 401 → `/login?next=...` | Currency toggle → amount → gateway picker → submit | composed — no direct template | P2 |
| `/wallet/topup/:code/pay` | Same `PayPage` component, `variant="topup"` | `GET /api/v1/wallet/topup/:code/pay`, `.../status`, `.../cancel` | Yes (session) | Identical UI to `/checkout/:code/pay` with top-up-specific destinations | composed — no direct template | P2 |
| `/login` | Sign in (identifier + password) + Telegram-widget login | `GET /api/v1/auth/telegram-widget`; `POST /api/v1/auth/login` | No (public; **no "already signed in → redirect away" guard observed**) | Full-viewport, outside `<Layout/>`; shares `<main>` with `AuthBrandPanel` | Auth flow (§4) — email/phone step shape | P3 |
| `/register` | Create account | `POST /api/v1/auth/register` | No (public) | Same shell as Login; inline Terms/Privacy consent notice (not a checkbox) | Auth flow (§4) | P3 |
| `/forgot` | Request password-reset email | `POST /api/v1/auth/forgot` | No (public) | Same shell; SMTP-unavailable branch surfaces after submit (no GET twin) | Auth flow (§4), **adapted** — no email/OTP capture step in the gogogo.id source capture for this specific screen — `ASSUMPTION` | P3 |
| `/reset/:token` | Set new password from emailed link | `GET /api/v1/auth/reset/:token/check`; `POST /api/v1/auth/reset/:token` | No (public; token-gated) | Pre-checks token validity before rendering the form; "request a new link" escape hatch on any dead end | Auth flow (§4), **adapted** — `ASSUMPTION` | P3 |
| `/account` | Account dashboard: identity, wallet/orders/referral summary tiles, grouped nav menu, desktop-only Recent Orders widget | `GET /api/v1/account`; `GET /api/v1/account/orders` (dashboard only); `POST /api/v1/auth/logout` | Yes — 401 → `/login?next=...` | Guest accounts see a reduced 1-tile/1-menu-group view | Account (§5) | P4 |
| `/account/orders` | Order history list | `GET /api/v1/account/orders` | Yes | Table ≥768px, cards <768px (never both mounted) | Transaction history (§6) | P4 |
| `/account/orders/:code` | Order detail: items, totals, manual-info edit (while `PROCESSING`), credentials/delivered-content reveal | `GET /api/v1/account/orders/:code`; `PATCH .../info`; SSE `.../digiflazz/stream` | Yes | Polls every 5s while `PROCESSING`; layered SSE for faster sub-status | composed — no direct template (page-templates.md §6 only describes the order **list**, not a detail view) | P4 |
| `/account/referral` | Referral code/link + earnings summary | `GET /api/v1/account/referral` | Yes | Two stat tiles + copyable code/link card | composed — no direct template | P4 |
| `/account/reviews` | Pending-review forms + submitted reviews | `GET /api/v1/account/reviews`; `POST /api/v1/account/reviews` | Yes | Rating via native `<select>` (5..1), one form per pending order | composed — no direct template | P4 |
| `/account/support` | Ticket inbox + new-ticket form (message + order picker + attachments) | `GET /api/v1/account/support`; `GET /api/v1/account/orders` (order picker); `POST /api/v1/account/support` (multipart when attachments present) | Yes | Table ≥768px / cards <768px for the list | composed — no direct template. `page-templates.md` §8 "Support" describes gogogo.id's **FAQ-only** page — this app's ticketing inbox is a business-specific feature the reference never had — `ASSUMPTION`, note in `business-adaptation.md` | P4 |
| `/account/support/:id` | Ticket detail: merged message/system-event timeline, composer (quick-reply templates, attachments, Ctrl/Cmd+Enter, debounced draft autosave), close/reopen, order/trust/recent-tickets sidebar | `GET /api/v1/account/support/:id`; `GET /api/v1/account/support` (recent list); `POST .../reply\|close\|reopen` | Yes | Two-column ≥1024px, collapses to one column below; sidebar sections are native `<details open>` | composed — no direct template | P4 |
| `/account/settings` | Username/email/password + Telegram account linking | `GET /api/v1/account/settings`; `POST .../credentials` | Yes | Two-card layout; Telegram-link flow stays server-redirect-driven (`?saved=1`/`?linked=1`/`?err=...`) | composed — no direct template | P4 |
| `/about` | Shop "about us" (4 numbered blocks) | none (i18n copy only) + `useShopContext` (shop name interpolation) | No (public) | `StaticPage` composition (title + intro + `StepTimeline`) | Content/legal (§7), **adapted** — gogogo.id capture has no "About" screenshot at all; §7's plain-prose shape is the closest generic informational-page template — `ASSUMPTION` | P5 |
| `/how-to-order` | How ordering works (5 blocks incl. a merged payment-methods step) | none (i18n copy) | No (public) | `StaticPage`, one custom `render` step (side-by-side QRIS/USDT cards) | Content/legal (§7), **adapted** — `ASSUMPTION` | P5 |
| `/terms` | Terms & Conditions (5 blocks) | none + `useShopContext` | No (public) | `StaticPage` | Content/legal (§7) — direct match | P5 |
| `/privacy` | Privacy Policy (5 blocks + conditional analytics block) | none + `useShopContext` | No (public) | `StaticPage` | Content/legal (§7) — direct match | P5 |
| `/refund` | Refund Policy (5 blocks) | none | No (public) | `StaticPage` | Content/legal (§7), **adapted** — no gogogo.id screenshot captured for this specific page, but structurally identical narrow-prose legal page — `ASSUMPTION` | P5 |
| `*` (unknown route) | 404 | none (`ErrorPage` static; SPA shell already sent a real HTTP 404) | No (public) | Centered message + status code + "back home" button | 404 / Not found (§11) — direct match | P5 |

**Legal-copy note (Global Constraints):** `/terms`, `/privacy`, `/refund`
restyle container/typography/layout only — no wording changes. Not
re-flagged per-row above to avoid repeating it five times.

---

## C. Component mapping

Per the brief: (1) every component/variant in `design-system/components.md`,
(2) every existing component under `components/shop/*` plus `Layout.tsx`,
`AuthBrandPanel.tsx`, `PageTransition.tsx`. Grouped into three sets so a
component appearing in both lists gets exactly one merged row.

**Action legend:** `adopt` = keep as-is, retoning only · `refactor` =
keep the component, restructure internals onto new primitives once they
exist · `replace` = build fresh, delete the old implementation · `build` =
no existing equivalent, create new · `delete` = dead code, remove.

### C1 — `components.md` entries with no existing component (12)

| Reference pattern | design-system spec | Existing repo component | Action | Target path |
|---|---|---|---|---|
| Button (Primary/Soft/Ghost/Danger/Icon/Disabled) | `components.md` "Button" | none — raw `<button className="btn btn-primary">` etc. at 40+ call sites; variants live only as `app.css` classes (`.btn-primary/-soft/-ghost/-danger/-sm`) | build | `src/components/ui/Button.tsx` |
| Text field (label/error/focus states) | `components.md` "Text field" | none — raw `<input className="field">` at 20+ call sites (`app.css` `.field`/`.field-label`) | build | `src/components/ui/Input.tsx` + `src/components/ui/FormField.tsx` (label+hint+error wrapper) |
| OTP input (6-box) | `components.md` "Text field › OTP input" | none — this app's login has no OTP step at all (identifier+password + Telegram-widget login instead) | build (**deferred** — no current call site; see §F) | `src/components/ui/OtpInput.tsx` |
| Card / surface panel | `components.md` "Card" | none as a component — every card is `<div className="card card-pad">` (`app.css` `.card`) | build | `src/components/ui/Card.tsx` |
| Badge – Hot (flame + sales copy) | `components.md` "Badge & chip" | none — no "X RB+ Terjual" sales-count copy exists anywhere in this app | build (**deferred** — no current business data for a sales counter; business-mapping question, not this task's to decide) | `src/components/ui/Badge.tsx` (variant `hot`) |
| Badge – Savings (`Hemat RpX`) | `components.md` "Badge & chip" | none as a badge — "Hemat"/savings language exists only as plain text in `OrderSummaryCard`/checkout copy, not a chip | build | `src/components/ui/Badge.tsx` (variant `savings`) |
| Badge – Trust row (icon+text inline strip) | `components.md` "Badge & chip" | none as a component — the exact same 4-item trust strip is **copy-pasted independently** in `HomePage.tsx` (hero) and `AuthBrandPanel.tsx` (see §E debt) | refactor (dedupe both call sites onto one component) | `src/components/ui/TrustBadgeRow.tsx` |
| Badge – Category label (`topup` pill) | `components.md` "Badge & chip" | none as a component — inline `chip` class usage in `ProductPage.tsx`/`CategoryPage.tsx` | build (fold into Badge primitive, variant `category`) | `src/components/ui/Badge.tsx` (variant `category`) |
| Badge – Coin balance (header pill) | `components.md` "Badge & chip" | none — **this app has no coins/points loyalty system.** `wallet_idr`/`wallet_usdt` is a different, non-gamified credit balance shown in `AccountPage`'s summary tiles, not a header pill | build (**deferred** — no current business equivalent; see §F) | `src/components/ui/Badge.tsx` (variant `balance`) if ever defined |
| Segmented control / tabs | `components.md` "Segmented control / tabs" | none — `SortSelect.tsx` is a native `<select>` (not a segmented control); `CategoryPage`'s category switcher is plain `<Link>` chips, not a true tab/segmented pattern | build | `src/components/ui/Tabs.tsx` (or `SegmentedControl.tsx`) |
| Carousel / banner | `components.md` "Carousel / banner" | none — `HomePage`'s hero is one static image/gradient band, not a carousel; no promo-banner carousel exists anywhere | build (**deferred** — no current multi-banner content model; business-mapping question) | `src/components/ui/Carousel.tsx` if a later task defines banner content |
| Accordion (FAQ) | `components.md` "Accordion (FAQ)" | none as a component — `HomePage.tsx`'s FAQ hand-rolls native `<details>/<summary>` styling inline (not reused elsewhere; `TicketOrderSummaryCard`/`TicketSidebar`'s `<details open>` is a **different** always-open collapsible-section pattern, covered separately in C3) | build | `src/components/ui/Accordion.tsx` |

### C2 — `components.md` entries with a matching existing component (10)

| Reference pattern | design-system spec | Existing repo component | Action | Target path |
|---|---|---|---|---|
| Product card (catalog tile) | `components.md` "Product card" | `src/components/shop/ProductCard.tsx` | refactor (internals onto new Card/Badge/Price primitives once built; external API/behavior unchanged) | `src/components/shop/ProductCard.tsx` |
| Denomination / package card | `components.md` "Denomination / package card" | `src/components/shop/DenominationCard.tsx` | refactor | `src/components/shop/DenominationCard.tsx` |
| Breadcrumb | `components.md` "Breadcrumb" | `src/components/shop/Breadcrumb.tsx` | adopt (already business-agnostic, token-aligned; promote to `ui/` optional) | `src/components/shop/Breadcrumb.tsx` |
| Toast / notifications | `components.md` "Toast / notifications" | `src/components/shop/Toast.tsx` | adopt | `src/components/shop/Toast.tsx` (or promote to `src/components/ui/Toast.tsx`) |
| Badge – Discount (`15% OFF`) | `components.md` "Badge & chip" | `src/components/shop/FlashBadge.tsx` | refactor (fold into Badge primitive once built; keep `FlashBadge` as the domain wrapper owning countdown/strike-through logic) | `src/components/shop/FlashBadge.tsx` |
| Badge – Status chip | `components.md` "Badge & chip" | `src/components/shop/StatusBadge.tsx` **and** `src/components/shop/TicketStatusBadge.tsx` (two implementations — deliberate divergence, ticket-specific copy; see §E) | refactor (both) | `src/components/shop/StatusBadge.tsx`, `src/components/shop/TicketStatusBadge.tsx` |
| Top navigation (desktop) | `components.md` "Top navigation" | `src/components/Layout.tsx` (header block) | refactor (split out) | `src/components/layout/Navbar.tsx` |
| Bottom navigation (mobile) | `components.md` "Bottom navigation" | `src/components/Layout.tsx` (hamburger + slide-in **left drawer** — structurally different pattern) | **escalate — see §F** (not a component-mapping decision) | n/a until decided |
| Footer | `components.md` "Footer" | `src/components/Layout.tsx` (footer block) | refactor (split out) | `src/components/layout/Footer.tsx` |
| Sticky purchase bar | `components.md` "Sticky purchase bar" | **three independent hand-rolled implementations**: `ProductPage.tsx`, `InstantBuyPage.tsx`, `CheckoutPage.tsx` (mobile sticky total bar) — see §E debt | refactor (consolidate three call sites into one parameterized component) | `src/components/shop/StickyPurchaseBar.tsx` |

### C3 — Existing `shop/`+root components with no `components.md` equivalent (30)

Business/utility components the reference site's structure never needed —
kept in `src/components/shop/` per the repo's existing convention (Global
Constraints: repo convention wins over introducing `src/features/<domain>/`).

| Reference pattern | design-system spec (file+section) | Existing repo component | Action | Target path |
|---|---|---|---|---|
| — (evidence/attachment thumbnail gallery) | none | `AttachmentGallery.tsx` | adopt | `src/components/shop/AttachmentGallery.tsx` |
| — (ticket-evidence file picker) | none | `AttachmentPicker.tsx` | refactor (`.btn.btn-sm` dependency → Button primitive) | `src/components/shop/AttachmentPicker.tsx` |
| — (tone+icon content aside) | none in `components.md`; conceptually the "Alert/Callout" composite named in the source prompt §8.1 | `Callout.tsx` | adopt (already business-agnostic, token-aligned) | `src/components/ui/Callout.tsx` (promote to primitive) |
| — (manual-info field: label+input/select+error) | none | `DeliveryFieldInput.tsx` | refactor (`.field`/`.field-label` → Input/FormField primitives) | `src/components/shop/DeliveryFieldInput.tsx` |
| — ("nothing here yet" pattern, unified from 8 prior ad hoc shapes) | none in `components.md`; source prompt §8.1 "EmptyState" | `EmptyState.tsx` | refactor (`.btn`-styled `ActionLink` + `ProductCard` deps) | `src/components/shop/EmptyState.tsx` (or promote shared shell to `ui/EmptyState.tsx`) |
| — (page-level info/success/error banner) | none — **overlaps Callout's tone+icon shape** (see §E: candidate duplication, different tone sets) | `Flash.tsx` | refactor (merge into one Alert primitive with a superset of tones: info/success/warning/error/tip) | `src/components/ui/Alert.tsx` (absorbing `Flash.tsx` + `Callout.tsx`) |
| — (checkout/instant-buy voucher+totals+submit card) | none | `OrderSummaryCard.tsx` | refactor (heavy `.card`/`.btn`/`.field` deps) | `src/components/shop/OrderSummaryCard.tsx` |
| — (show/hide password input) | none | `PasswordInput.tsx` | refactor (wraps `.field` → Input primitive) | `src/components/shop/PasswordInput.tsx` |
| — (gateway/wallet-credit radio picker) | none | `PaymentMethodSelector.tsx` | refactor (`.card` + radio rows → Card/Radio primitives) | `src/components/shop/PaymentMethodSelector.tsx` |
| — (central IDR+derived-USDT price display) | none — money formatting is out of scope to touch, restyle only | `Price.tsx` | adopt | `src/components/shop/Price.tsx` |
| — (ProductCard-shaped loading placeholder) | none | `ProductCardSkeleton.tsx` | adopt (composes `Skeleton`, no `.btn`/`.card` dep) | `src/components/shop/ProductCardSkeleton.tsx` |
| — (determinate upload-progress bar) | none | `ProgressBar.tsx` | adopt | `src/components/shop/ProgressBar.tsx` |
| — (lazy-route Suspense fallback) | none | `RouteFallback.tsx` | adopt (composes `Skeleton`) | `src/components/shop/RouteFallback.tsx` |
| — (pulsing loading placeholder primitive) | none in `components.md`; source prompt §8.1 "Skeleton" | `Skeleton.tsx` | adopt | `src/components/ui/Skeleton.tsx` (promote to primitive) |
| — (shared sort `<select>` for 4 grids) | none | `SortSelect.tsx` | refactor (native select → Select primitive) | `src/components/shop/SortSelect.tsx` |
| — (14-copies-consolidated inline loading dot) | none in `components.md`; source prompt §8.1 "Spinner" | `Spinner.tsx` | adopt | `src/components/ui/Spinner.tsx` (promote to primitive) |
| — (5-star rating display) | none | `Stars.tsx` | adopt | `src/components/shop/Stars.tsx` |
| — (shared layout for About/HTO/Terms/Privacy/Refund) | Content/legal (§7) is the composition target; `StaticPage.tsx` is the composing component, not a `components.md` entry itself | `StaticPage.tsx` | refactor (help-CTA `.btn` link + `Callout`/`StepTimeline` deps) | `src/components/shop/StaticPage.tsx` |
| — (checkout 1·Cart→2·Payment→3·Done progress) | none | `Stepper.tsx` | refactor (`chip` class → Badge primitive) | `src/components/shop/Stepper.tsx` |
| — (numbered step list w/ connector, 2 layouts) | none | `StepTimeline.tsx` | adopt (no `.btn`/`.card` dependency) | `src/components/shop/StepTimeline.tsx` |
| — (stock-availability pill) | conceptually the same visual family as "Badge & chip → Status chip", but not literally that named variant | `StockBadge.tsx` | refactor (→ Badge primitive once built) | `src/components/shop/StockBadge.tsx` |
| — (Telegram brand glyph) | none | `TelegramIcon.tsx` | adopt (pure SVG) | `src/components/shop/TelegramIcon.tsx` |
| — (native-styled Telegram OAuth button) | none | `TelegramLoginButton.tsx` | refactor (`.btn.btn-soft` → Button primitive) | `src/components/shop/TelegramLoginButton.tsx` |
| Ticket reply composer (chat/thread pattern) | **§26.2 extension — no design-system template for chat/thread pattern, derive from Card/palette/spacing tokens, log in extensions.md** | `TicketComposer.tsx` | **build** | `src/components/shop/TicketComposer.tsx` |
| Ticket message thread (chat bubbles) | **§26.2 extension — no design-system template for chat/thread pattern, derive from Card/palette/spacing tokens, log in extensions.md** | `TicketMessageThread.tsx` | **build** | `src/components/shop/TicketMessageThread.tsx` |
| — (linked-order context card in ticket sidebar) | none | `TicketOrderSummaryCard.tsx` | refactor (`.card`/`.btn` + `<details>` deps) | `src/components/shop/TicketOrderSummaryCard.tsx` |
| — (ticket sidebar: order/trust/recent/help sections) | none | `TicketSidebar.tsx` | refactor (`.card` deps, composes `TicketOrderSummaryCard`/`TicketStatusBadge`) | `src/components/shop/TicketSidebar.tsx` |
| — (ticket-flavoured status chip, distinct copy from `StatusBadge`) | conceptually "Status chip", ticket-specific wording — see C2 row above | `TicketStatusBadge.tsx` | refactor | `src/components/shop/TicketStatusBadge.tsx` |
| — (auth-page brand/trust side panel) | none — business-specific addition (Task 16), not in gogogo.id's captured auth screens | `AuthBrandPanel.tsx` | refactor (`rounded-3xl` → depends on the radius-token gap resolution, §D) | `src/components/AuthBrandPanel.tsx` |
| — (route enter/exit motion wrapper) | none — pure `framer-motion` orchestration, zero visual/token surface | `PageTransition.tsx` | adopt | `src/components/PageTransition.tsx` |

**Coverage check:** 22 `components.md` entries → 12 (C1) + 10 (C2) = 22 ✓.
37 existing components (34 `shop/*` + `Layout.tsx` + `AuthBrandPanel.tsx` +
`PageTransition.tsx`) → `Layout.tsx` appears 3× in C2 (Top nav/Bottom
nav/Footer, one file) + 6 more shop files in C2 + 28 shop files + 2 root
files in C3 = 1 + 6 + 28 + 2 = 37 ✓.

---

## D. Token coverage

### D1. Tokens defined in `tokens.json` that are unused anywhere in current app code

- **`layout.bottomNavHeight: "56px"`** — this app has no fixed bottom tab
  bar at all (see §C2's escalated "Bottom navigation" row); the token is
  unreachable until/unless that navigation-model decision is made.
- **`layout.productGridColumns.desktop: 5`** — every product grid in this
  app tops out at **4** columns (`CategoryPage`/`ProductsPage`/`SearchPage`/
  `FlashPage`: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`) or **3**
  (`HomePage`'s featured grid: `sm:grid-cols-2 lg:grid-cols-3`). No route
  renders a 5-up desktop grid today — this value is currently unused and its
  adoption is a visual-density decision for the route-migration phase, not
  this audit.

### D2. Values current app code needs that the token set doesn't define (feeds §26.2)

- **`rounded-3xl` (24px)** — used extensively (`HomePage`'s hero/"Our
  Promise" bands, `AuthBrandPanel`, the mobile nav drawer panel). The
  token set's `radius` scale tops out at `lg` = 16px; nothing at 24px.
  Candidate extension: a `radius.xl` step. `ASSUMPTION`: logged here as a
  gap, not decided — the actual extension value is a Task 2/4 call.
- **Violet accent** (`text-violet-600`/`bg-violet-50`) — used in
  `HomePage.tsx` ("Dukungan" feature card icon well, "Sosmed" upcoming-
  service card) and nowhere else. The design system's palette is strictly
  pine/grass/amberx/rust/ink/paper/sand/line — no violet anywhere.
  Candidate extension or a business-mapping call to retire the violet
  accent onto an existing hue. `ASSUMPTION`: logged, not decided.
- **Star-rating gold** (`text-amber-400`/`fill-amber-400`, Tailwind's
  built-in amber) — used by `Stars.tsx` and `AuthBrandPanel.tsx`'s "instant"
  bullet icon. The design system's `amberx` (`#b45c0a`) is a **burnt-orange
  warning color**, visually distinct from and not a substitute for a
  star-rating gold. This is a second, separate gap from `amberx`.
  `ASSUMPTION`: logged, not decided.
- Assorted ad hoc alpha-blended neutrals baked directly into `app.css`
  (`rgba(238,241,246,.6)`/`.5`/`.3` for `.codeish`/table-header/table-hover)
  and `bg-[rgba(15,23,42,0.35)]` (mobile-drawer scrim) — all derived from
  existing hues (`sand`/`ink`), lower severity than the two color gaps
  above, but still raw values outside the token files per §7.2's
  token-first order. Candidate: named `sand/40`, `ink/35` alpha tokens.

### D3. `font-size` `base` naming inconsistency — **resolved with line evidence**

- `gogogo-frontend/design-system/tokens.json:64` — `"base": "14px"`.
- `gogogo-frontend/design-system/tokens.css:95` — `--gg-text-base: 0.875rem;
  /* 14px — buttons, field text (desktop) */`.
- `gogogo-frontend/design-system/tailwind.preset.js:40-41`:
  ```
  base: ['16px', { lineHeight: '1.5' }],   // storefront field text (mobile, iOS-zoom safe)
  'base-desktop': ['14px', { lineHeight: '1.5' }],
  ```
- **Ground truth**, `apps/storefront/static/app.css:120-125`:
  ```css
  /* 16px on small screens is not a style choice: Safari on iOS zooms the whole
     viewport in when a focused input's text is smaller than that ... */
  .field { ... font-size: 1rem; /* 16px */ ... }
  @media (min-width: 640px) { .field { font-size: .875rem; } /* 14px */ }
  ```
- **Verdict: `tokens.json`/`tokens.css`'s flat `base = 14px` is the stale
  entry.** It silently drops the mobile-first 16px value and the
  accessibility rationale behind it (iOS Safari auto-zoom-on-focus
  prevention — a real, documented behavior in this app's own CSS, not a
  hypothetical). `tailwind.preset.js`'s `base` (16px) + `base-desktop`
  (14px) pair is the accurate representation, matching `app.css` exactly.
  Per §3.1's tie-break rule this is a token-vs-token disagreement (not a
  prose-vs-token one); the app's actual shipped CSS sides unambiguously
  with `tailwind.preset.js`. **Recommendation for the future token-porting
  task:** define `--text-base: 1rem` (16px, mobile-first default) in
  `@theme`, with the ≥640px step-down to 14px expressed the same way
  `tailwind.preset.js` does (a distinct `base-desktop`/responsive override),
  not `tokens.json`'s single flat value. Log this as a §26.1 design-system
  inconsistency (source-spec issue) when that task edits the token files —
  this audit only identifies it, per the plan's "prefer correcting the
  implementation, but write the proposal first" rule.

### D4. `transitionTimingFunction`/`transitionDuration` `DEFAULT` override — **confirmed, documented as deliberate**

`gogogo-frontend/design-system/tailwind.preset.js:70-76`:
```js
transitionTimingFunction: {
  DEFAULT: 'cubic-bezier(0.22, 1, 0.36, 1)', // this repo's "rise" ease-out
},
transitionDuration: {
  DEFAULT: '150ms',
  entrance: '500ms',
},
```
This globally overrides Tailwind's stock `transition`/`duration` DEFAULTs
(normally `150ms ease-in-out`) app-wide, so a bare `transition`/`transition-
colors` utility class picks up the signature 150ms ease-out instead. This
is **not a bug** — it matches `foundations.md` §8 verbatim ("Default
transition: 150ms... Signature ease-out curve... used everywhere, not
Tailwind's default `cubic-bezier(0.4, 0, 0.2, 1)`") and matches this app's
own `src/lib/motion.ts` (`EASE = [0.22, 1, 0.36, 1]`, `DURATION.fast =
0.15`) and `app.css`'s hand-written `.card`/`.btn`/`.field` transitions
(all `cubic-bezier(.22,1,.36,1)` already). **Carry forward** into Tailwind
v4 `@theme` syntax as:
```css
--default-transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
--default-transition-duration: 150ms;
```
Note: v4's `DEFAULT`-override slot has no room for a second named duration
the way v3's `transitionDuration.entrance` could sit beside `DEFAULT` — the
500ms "rise" entrance duration will need its own explicit `--duration-
entrance: 500ms` custom property and a corresponding utility (e.g.
`duration-entrance`), not a second `DEFAULT`. Currently the 500ms entrance
is implemented via a plain CSS `@keyframes rise` animation in `app.css`
(not a `transition-duration` utility at all), so this only matters once/if
that animation is re-expressed through Tailwind utilities.

---

## E. Debt register

| Item | Description | Disposition |
|---|---|---|
| No UI primitives exist at all | Button/Input/Card/Badge/etc. are 100% raw `className="btn ..."` / `className="card ..."` markup repeated across 40+ files; no component wraps them (see §C1). This is the largest single item and is squarely what Task 4–6 exist to fix. | `fix-later` (Tasks 4–6, not this task) |
| Two coexisting radius systems | `app.css`'s `--r-*` scale (4/8/12/16px, used by `.card/.btn/.field`) vs. raw Tailwind default radius utilities (`rounded-2xl`=16px, `rounded-3xl`=24px, used ad hoc in page JSX). `rounded-3xl` has no token anywhere (§D2). | `fix-now` when Task 4 ports tokens — must be resolved before/alongside the token layer, not silently carried forward |
| `Flash.tsx` vs `Callout.tsx` | Near-duplicate tone+icon banner components with **different but overlapping tone vocabularies** (Flash: info/success/error; Callout: info/tip/warning) and different visual treatment (Flash = flat border+bg banner; Callout = icon-well + bg card). Both exist because they grew independently (Flash for form-level errors, Callout for content asides) rather than by design. | `fix-later` — merge into one `Alert` primitive with the union of tones (§C3) |
| Three independent sticky-purchase-bar implementations | `ProductPage.tsx`, `InstantBuyPage.tsx`, and `CheckoutPage.tsx` each hand-roll their own fixed-bottom-bar markup/logic rather than sharing one component, despite being visually and behaviorally near-identical (price + primary CTA, safe-area padding, same show/hide trigger pattern). | `fix-later` — consolidate per §C2 |
| Duplicated trust-strip markup | The exact same 4-item trust chip row (instant/QRIS+USDT/warranty/support) is copy-pasted independently in `HomePage.tsx`'s hero and `AuthBrandPanel.tsx`, with the comment in `AuthBrandPanel.tsx` explicitly acknowledging it's "the same four claims as HomePage's hero trust strip." | `fix-later` — extract shared component per §C1 |
| `DenominationCard`/`PaymentMethodRow` radio-card duplication | Both hand-roll a near-identical "card wrapping a radio input, `has-[:checked]:` styled" pattern independently rather than sharing one selectable-card primitive. | `fix-later` |
| **No `Modal`/`Dialog`/`AlertDialog` primitive exists anywhere** | Zero modal/dialog components in the entire storefront client. `CartPage`'s remove-confirmation is an inline two-state row (not a modal); **`PayPage`'s "Cancel order" button has literally no confirmation of any kind** — it fires the cancel mutation immediately on click (carried over verbatim from `pay.njk`'s original behavior, per that file's own header comment). Global Constraints explicitly requires: *"Destructive actions (logout, cancel order if it exists) — MUST show a confirmation dialog... Do not silently keep the old direct-execute behavior."* | **`fix-now`** — this blocks a named, explicit plan requirement; whichever task migrates `PayPage`/`AccountPage` cannot satisfy Global Constraints without first building a `Modal`/`AlertDialog` primitive. Flagged again in §F since destructive-action confirmation semantics are always-escalate. |
| No `PermissionDenied` state exists | Every "not authorized" case in this app (11 pages check `error?.status === 401`) resolves to an immediate hard redirect to `/login?next=...` — none render a distinct permission-denied screen. Global Constraints §16 requires "Permission denied" as a state **distinct from error/not-found**. | `fix-later` — likely moot for most routes (redirect-on-401 is arguably correct UX for "not signed in"), but worth a controller read: does this app have any *authenticated-but-forbidden* (403, not 401) case that needs a real `PermissionDenied` screen, or does redirect-to-login cover every real case? Not decided here — low-risk either way, `ASSUMPTION`: treat redirect-on-401 as intentional and correct unless a later task finds a genuine 403 case. |
| Repeated `(error as Error & { status?: number })` casts | ~10+ call sites cast the TanStack Query error object the same way instead of a shared typed API-error helper. | `fix-later` — minor, not visual |
| `StatusBadge.tsx` vs `TicketStatusBadge.tsx` | Two status-chip implementations with different label/tone maps — **confirmed intentional** (TicketStatusBadge's own header comment: ticket-specific wording can't live in the shared badge without changing behavior everywhere else it's used). | `out-of-scope` — working as designed, not accidental drift; just register that "Status chip" in `components.md` maps to two real components, not one |
| No schema-driven form/validation library | See §A. Every form is manual state + native attributes + hand-written validators. Not itself broken (server re-validates everything, per every form's own comments), but the source prompt's §11 explicitly says to "use the repository's existing form and validation library, schema-driven" — this repo has none. | See §F — this is a plan-tension question, not decided here |

---

## F. Open questions and assumptions

Per the plan's decision procedure (derivable → derive; low-risk/reversible →
smallest assumption, tag, proceed; high-risk/irreversible/business-meaning →
escalate). Derived assumptions are listed first, escalations last.

### Derived (low-risk, tagged `ASSUMPTION:`, proceed)

1. `ASSUMPTION:` `/categories`, `/products`, `/flash` all target Category
   listing (§2), adapted, since `page-templates.md` has no dedicated
   "category index" or "browse all" or "flash sale" template. All three
   are visual-composition-only decisions, reversible without touching
   business logic.
2. `ASSUMPTION:` `/track` targets the Tracker variant of §6 — directly
   supported by `page-templates.md`'s own text ("the public tracker is the
   same form without login, keyed by transaction ID").
3. `ASSUMPTION:` `/account/orders/:code` (order **detail**) is
   "composed — no direct template" even though it wasn't in the brief's
   explicit list for that label — `page-templates.md` §6 only describes the
   order **list**, never a detail view. Derived from reading the actual
   template file, not assumed.
4. `ASSUMPTION:` `/account/support` is "composed — no direct template."
   gogogo.id's own `/support` page (§8) is FAQ-only; this app's ticket-
   inbox-plus-creation-form is a business-specific feature the reference
   never had. Log the semantic gap in `business-adaptation.md` when that
   file is created (Task 3), not here.
5. `ASSUMPTION:` `/about` and `/how-to-order` target Content/legal (§7),
   adapted, as the closest generic informational-page template — gogogo.id's
   capture has no screenshot for either (README's "Known gaps" section
   doesn't call these out specifically because they're simply outside
   gogogo.id's own IA, not a capture failure).
6. `ASSUMPTION:` Token gaps in §D2 (radius `xl`≈24px, violet accent, star-
   rating gold) are logged as candidates for `tokens.extensions.*` /
   `extensions.md` (§26.2 mechanism) rather than decided here — picking the
   actual extension values is a visual-design call for Task 2 or 4, not an
   audit finding.
7. `ASSUMPTION:` `PermissionDenied` state — treating the existing
   redirect-on-401 pattern as sufficient/correct unless a later task
   surfaces a genuine authenticated-but-forbidden (403) case. See §E.

### Escalate — do not decide, listed for the controller

1. **Mobile navigation model conflicts with the design system.** This app's
   mobile nav is a hamburger + slide-in left drawer (`Layout.tsx`); the
   design system specifies a **fixed bottom tab bar** (`Home · Transaksi ·
   Promo · Bantuan · Akun`, `foundations.md` §7 + `components.md` "Bottom
   navigation (mobile)"), and `tokens.json` even reserves
   `layout.bottomNavHeight`. Adopting the design system's bottom-tab-bar
   would change the app's core navigation model on **every** mobile page —
   reserved safe-area space, which of the app's actual destinations (Home /
   Cart / Orders / Account / Support? — none of gogogo.id's five map
   cleanly onto this shop's IA) get permanent bottom-bar billing, and
   direct interaction with the **existing** sticky purchase/checkout bars
   that already dock at the bottom on mobile (`ProductPage`, `CheckoutPage`,
   `InstantBuyPage`) — two fixed bottom elements would collide on the
   product/checkout screens specifically. This is an information-
   architecture and business-terminology decision with real reachability
   consequences app-wide, not a token or component detail. **Not decided
   here.**
2. **Form/validation library tension.** The source prompt's §11 says "use
   the repository's existing form and validation library, schema-driven."
   This repository has **no** schema-driven form library (§A) — every form
   is manual state + native HTML validation + hand-written TS validators
   that already mirror the server rule-for-rule. Two readings are possible:
   (a) treat the existing manual-validation convention itself as "the
   repository's existing... library" and keep it, or (b) introduce a real
   schema library (e.g. `react-hook-form` + `zod`) for the Integration
   phase (Task 9). Reading (b) is a **new dependency**, which Global
   Constraints elsewhere prohibits unless a task explicitly calls for it.
   This is a direct tension between two constraints in the plan — **not
   decided here**, needs a controller call before Task 9/11 builds on it.
3. **`PayPage`'s missing cancel-order confirmation is a live, shipped gap
   against an explicit named requirement**, not a design-system ambiguity.
   Global Constraints requires a confirmation dialog for "cancel order if
   it exists" — it exists, and currently has none (§E). Flagging to confirm
   this is in-scope, expected behavior-change work for whichever task
   migrates `PayPage`, not something the controller wants left alone as
   "existing behavior, don't touch."
4. **Worktree is missing `gogogo-frontend/` and `FRONTEND_IMPLEMENTATION_
   PROMPT_v3.md`.** Both are untracked in the main checkout and were not
   copied into this worktree by `EnterWorktree`/`git worktree add` (which
   only mirrors tracked files). This audit read them from the main
   checkout's filesystem path directly (read-only, no conflict), but every
   later task in this plan will hit the same gap unless these files are
   either committed to the repo or manually copied into this worktree.
   Not a design decision, but worth a controller decision on which fix to
   take before Task 2 starts. Reported in the task report, not a design
   escalation, but recorded here too since it affects every subsequent task's
   ability to `Read` these files without a workaround.
