# Storefront React Migration — tracking doc

Migrating `apps/storefront` from Nunjucks+HTMX to a React SPA, **pixel-identical**
design, **identical** backend behavior. Full approved plan:
`C:\Users\manda\.claude\plans\precious-roaming-flurry.md` (2026-07-04). This file
is the cross-session resume point — tick boxes as work lands, keep it honest.

## Decisions (locked 2026-07-04)

| Question | Decision |
|---|---|
| Pattern | Clone `apps/web-admin` SPA: Vite + React 18 + react-router 7 + TanStack Query 5 + Tailwind v4; shell HTML with `__CSRF_TOKEN__` substitution served by wildcard `GET /*` registered **last** (`apps/web-admin/src/routes/spaShell.ts`) |
| SEO | Full SPA + server-injected `<title>`/OG meta/**real 404 status** per route in the shell. No SSR, no hybrid. |
| Strategy | Incremental: 4 page clusters; each pixel-verified vs the live Nunjucks page **before** its old routes are deleted |
| Old HTML routes | Deleted per cluster after React covers them (URLs preserved — React Router serves the same paths) |
| API | Grow existing `/api/v1`; page-shaped reads under `/api/v1/pages/*`; reuse `performCheckout`/`loadCartLines`/`establishSession`/`shopContext` — never duplicate business logic |
| i18n | Ship `packages/core/locales/{en,id}.json` to client; `t()` replicated client-side; lang via `__LANG__` in shell `<html lang>`; `GET /lang` stays a server route |
| Dates | Pre-formatted server-side in JSON (`*_display` via same `localize()` as `localdt` filter) + ISO fields |
| CSRF | Meta tag in shell (web-admin pattern); full page reload after login/logout/register/password-change to refresh token |
| Client imports | **No `@` alias** (root vitest maps `@` → web-admin client); relative imports only |

**Never touched:** payment webhooks (`/pay/*/callback`), `GET /auth/telegram`,
`GET /account/settings/link-telegram`, `GET /lang`, `/healthz`, `/static/`,
`/uploads/`, session-cookie model (`shop_session` + jti), guest-cart cookie
`shop_cart_v2` + merge-on-login, rate limiters, setup gate.

## Tailwind v3 (templates) → v4 (TSX) mapping

Apply mechanically while porting markup 1:1; screenshot diff is the real gate.

| v3 | v4 |
|---|---|
| `shadow-sm` | `shadow-xs` |
| bare `rounded` | `rounded-sm` |
| `backdrop-blur` | `backdrop-blur-sm` |
| `bg-gradient-to-br` | `bg-linear-to-br` |
| `flex-shrink-0` | `shrink-0` |
| leading `!` (`!text-2xl`) | trailing (`text-2xl!`) |
| bare `border` (no color) | audit each: v3 default gray-200, v4 currentColor |

Compat layer in client `index.css`: `button:not(:disabled){cursor:pointer}`,
`@custom-variant hover (&:hover);`, lucide svg baseline. Unchanged:
`rounded-xl/2xl/3xl/full`, `ring-*`, `has-[:checked]:`, arbitrary values,
`line-clamp-*`; `shadow-soft/lift` + `rounded-xl2` come from the `@theme` block.

## API endpoints (all under `/api/v1`)

Existing (byte-stable): GET `categories`, `categories/:slug/products`, `products`,
`products/:slug`, `products/:slug/denominations`; POST `cart` (=add), `checkout`.

New — pages: GET `pages/context`, `pages/home`, `pages/category/:slug`,
`pages/product/:slug`, `pages/search?q=`.
New — auth (public, no CSRF, same rate limits/generic errors): POST `auth/login`,
`auth/register`, `auth/logout`, `auth/forgot`, `auth/reset/:token`.
New — cart (guests exempt via shared `csrfOk()`): GET `cart`; POST `cart/update`,
`cart/remove`.
New — checkout: GET `checkout` (401 JSON anon); POST `checkout/voucher/preview`;
POST `checkout` extended with `use_wallet_idr`/`use_wallet_usdt`; GET
`orders/:code/pay`, `orders/:code/status` (`{state, redirect?}`); POST
`orders/:code/cancel`.
New — account (401 JSON anon): GET `account`, `account/orders`,
`account/orders/:code`, `account/referral`, `account/reviews`, `account/support`,
`account/support/:id`, `account/settings`; POST `account/reviews`,
`account/support`, `account/support/:id/reply`, `restock/:id`,
`account/settings/credentials`.

Every mutating endpoint gets the happy / 401-anon / 403-bad-CSRF test trio
(`apps/storefront/test/spa-api*.test.ts`).

## Phase checklist

### Phase 0 — this doc
- [x] `docs/REACT_STOREFRONT_MIGRATION.md` created

### Phase 1 — client scaffolding (additive) — DONE 2026-07-04
- [x] `apps/storefront/client/` package `@app/storefront-client` (Vite 6, base `/static/shop-app/`, outDir `../static/shop-app`; registered in `pnpm-workspace.yaml`)
- [x] `index.html` placeholders `__CSRF_TOKEN__` / `__LANG__` / `__TITLE__` / `<!--__HEAD_META__-->`
- [x] `src/index.css`: tailwind v4 + @fontsource (Outfit/Manrope/JetBrains Mono) + `@import "../../static/app.css"` + `@theme static` (byte-for-byte from `_theme.njk`) + v3-compat layer
- [x] `src/lib/i18n.ts` + tests (imports core locales, replicates `t()`; note: client signature is `t(key, args?, lang?)`)
- [x] `src/lib/format.ts` + tests (`formatIdr`, `formatUsdt`, `money4` exact strings)
- [x] `src/api/client.ts` + test (clone web-admin; errors carry `.status` for 401 redirects)
- [x] `src/main.tsx` / `src/App.tsx` route table (all URLs → `Placeholder`), `src/components/Layout.tsx` (base.njk port, `useShopContext()` hook)
- [x] Root: vitest `environmentMatchGlobs` + `.gitignore` `static/shop-app/` + CLAUDE.md build contract

### Phase 2 — JSON API + SPA shell (additive; Nunjucks still serves all pages) — DONE 2026-07-04
- [x] `apiPages.ts` (context/home/category/product/search — shaped by the new shared `src/pageData.ts`, which the HTML routes now also consume)
- [x] `apiAuth.ts` (login/register/logout/forgot/reset + `GET auth/telegram-widget` params)
- [x] `apiCart.ts` (GET cart, update, remove; shared `csrfOk`/`clampQty` exported from `routes/cart.ts`; guest-cookie patch)
- [x] `apiCheckout.ts` (GET checkout, voucher preview, GET/POST orders/:code pay|status|cancel; `payView()`/`payState()`/`checkoutView()` now exported from `routes/checkout.ts`; POST /api/v1/checkout extended with wallet flags)
- [x] `apiAccount.ts` (all account/settings reads + mutations, `*_display` dates)
- [x] `spaShell.ts` wildcard last (`__CSRF_TOKEN__`/`__LANG__`/`__TITLE__`/HEAD_META, real 404 for unknown slugs/paths, no-referrer on /reset/*); JSON 404/500 for `/api/*`
- [x] `spa-api.test.ts` (32 tests: shell substitution, trios, guest-cart merge, jti rotation, ownership 404s); full suite 1589 green

### Phase 3 — pixel harness — N/A, superseded 2026-07-04
- [x] N/A — the pixel-diff harness was never built for cluster A; superseded by reviewer markup-parity verification (no browser tooling) instead
- [x] N/A — same as above

### Phase 4 — Cluster A: catalog + cart (React pages → verify → delete NJK) — DONE 2026-07-04
- [x] Home / Category / Product / Search / Cart / Error pages + `_shop.njk` macro components
- [x] Sign-off via reviewer markup-parity verification (no browser tooling); visual QA in a real browser pending as manual follow-up
- [x] Cutover: delete `GET /` (keep `/lang`), `catalog.ts`, HTML cart handlers, 5 templates; migrate tests

### Phase 5 — Cluster B: auth
- [ ] Login (+ Telegram widget) / Register / Forgot / Reset pages
- [ ] `GET /auth/telegram` failure → `303 /login?err=…`
- [ ] Cutover: delete HTML auth+forgot handlers, 4 templates; migrate rate-limit tests

### Phase 6 — Cluster C: checkout + pay
- [ ] Checkout page (methods/wallet/voucher preview) + Pay page (all state×method branches, countdown, 5s poll)
- [ ] Cutover: delete HTML/HTMX checkout handlers + 4 templates; **webhooks + their tests untouched & green**

### Phase 7 — Cluster D: account + settings
- [ ] 8 account-area pages
- [ ] Cutover: delete `account.ts`/`settings.ts` HTML handlers + 8 templates; migrate tests

### Phase 8 — cleanup
- [ ] Delete `_shop.njk`; strip `base.njk` to skeleton for `error.njk`/`setup_pending.njk` (drop htmx)
- [ ] Keep `views.ts`/nunjucks/error/setup_pending (setup gate + 500 fallback)
- [ ] Deploy story ships `static/shop-app/`; CLAUDE.md + DOCS.md updated

## Verification (per cluster)

1. `pnpm --filter @app/storefront-client build` (shell must exist before server tests)
2. `pnpm typecheck` && `pnpm test`
3. Pixel overlay diff per page ×3 breakpoints before each template deletion
4. Manual click-through: guest cart → login (merge) → checkout+voucher → pay poll →
   cancel → orders → delivered credentials → review → support → password change →
   lang toggle → forgot/reset → Telegram login/link; webhook curl replay
