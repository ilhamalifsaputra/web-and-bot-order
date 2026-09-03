# 99 — Final verification (§23, §30)

Branch: `worktree-storefront-redesign` · 55 commits from `795fa2ca`.
Executed via `superpowers:subagent-driven-development` — one fresh implementer
subagent per task, an independent spec+quality review after each, fix loops
until each review came back clean.

---

## 1. Automated gates (§23 verification matrix)

| Layer | Method | Result |
|---|---|---|
| **Tokens** | ESLint `no-restricted-syntax` gate — no arbitrary Tailwind values carrying hex/rgba/px, no raw hex in `.tsx`, no hardcoded px/rem/em in inline `style` — scoped to `apps/storefront/client/src/**`, wired into the root `pretest` chain (Task 4) | `pnpm --filter @app/storefront-client lint` → **exit 0** |
| **Types** | `tsc --noEmit` across all 9 workspace packages + `tsconfig.test.json` | `pnpm typecheck` → **clean** |
| **Components** | Every `ui/` primitive + composite + state component has a co-located `*.test.tsx` and is registered in the DEV-only `/__ui` gallery route (`import.meta.env.DEV`-guarded, tree-shaken from the production bundle) | present; gallery not in prod build |
| **Behaviour** | Vitest, full monorepo | `pnpm test` → **6389 / 6390 passing**. The single failure is `apps/web-admin/test/storage-api.test.ts` (`dbBytes > 0`) — a **pre-existing** web-admin bug from the SQLite→Postgres engine swap (`storage.ts` still `stat()`s a bot.db path); this branch touched **zero** web-admin/storage files. Documented as a known non-blocker in project memory. |
| **E2E** | Playwright, real Fastify server + real seeded Postgres schema | `pnpm e2e` → **2 / 2 passing** — the golden path (catalog → product → checkout → wallet-credit pay → delivered credentials) and the stock-race recoverable-rejection case, both driven through the **fully migrated UI**. |
| **Build** | `vite build` | **succeeds**. Initial route JS 200.5 KB gzipped (was ~195.9 KB pre-redesign; +4.6 KB for the `ui/` primitive library, `AlertDialog`, `SearchOverlay`). At §20's soft 200 KB line; the repo enforced no stricter budget. Flagged under §3 below. |
| **A11y** | Per-component tests assert ARIA wiring (combobox/listbox/dialog/tabs/accordion patterns, `aria-current`, `aria-describedby`/`aria-invalid`, focus trap + Esc + focus-restore). No automated axe run was wired into CI this pass. | partial — see §3 |
| **Visual** | Live Playwright sweep against a seeded server, plus the §17 drift checklist applied per-route during Fase 7. | see §2 |
| **Responsive** | Manual + scripted checks at 320 / 375 / 768 / 1280 / 1920; `scrollWidth === clientWidth` assertion. | see §2 |

## 2. Live visual sweep (Playwright MCP, seeded server)

A storefront `start` server was run against the e2e-seeded Postgres schema
(1 category, 2 products, 1 registered user) and driven with Playwright MCP.
Every route below rendered with the design system applied — tokens, geometry,
the `ui/` primitives, the new chrome (fixed top nav + mobile bottom tab bar)
— with **zero real console errors** and **no horizontal scroll** at the
tested widths.

| Route | Widths | Verdict |
|---|---|---|
| `/` Home | 1280, 375 | Dark `bg-ink`/pine hero band (`--radius-3xl`), `TrustBadgeRow` (amber→grass / violet→pine-tint maps applied), feature `Card`s, `StepTimeline` "how it works", category grid, `ProductCard` shelf (`shadow-soft`→`shadow-lift`, 16px radius, `StockBadge` amberx), pine "what every order comes with" band, trust-checklist `Card`, FAQ `Accordion`, sand footer. **Mobile bottom tab bar present** (Beranda · Cari · Keranjang · Pesanan · Akun), active tab pine-tinted with top indicator. No mega-menu, no coin chip. |
| `/c/:slug` Category | 1280 | Spec-aligned `Breadcrumb` (14px, `›`, bold current), `.btn-soft` segmented category pills (`pine-tint`/`pine-dark`, **not** solid), `Sort` `Select`, product grid (`xl:grid-cols-5` gate), sand footer. |
| `/p/:slug` Product detail | 1280 | 2-column split; image in a `.card` (4:3); `DenominationCard` selected state = **2px pine border + focus ring, no fill** (per spec); live-summary `Card` with price in **`grass-dark` ~20px/700**; "Add to cart" (soft) + "Buy now" (primary); `ShareRow` as `Button size="sm"`. |
| `/login` Auth | 1280 | **Full-screen, no chrome**; `AuthBrandPanel` (pine, `--radius-3xl`, `TrustBadgeRow`) + card split; `FormField` + `PasswordInput` (eye toggle) + full-width primary; no OTP boxes / Flip modal (correctly mapped). |
| `/search?q=…` | 1280 | `SearchRedirect` → `/` + overlay open, query prefilled, live result row (thumb + name + `Price` → `/p/:slug`) against the existing `/api/v1/pages/search` endpoint, scrim over Home, no empty-`<main>` flash (`useLayoutEffect` fix). |
| `*` 404 | 1280 | Standard chrome retained; composes `NotFoundState` (`PackageX` icon, "Page not found", "Back to home" primary); status number is a small `aria-hidden` caption, **not** the headline (§16); HTTP 404 from the shell. |
| `/terms` Legal | 1280 | **Plain §7 prose**: ~768px column, `<h1>` + section `<h2>`s (Outfit 600), Manrope body on `paper`, **no card chrome, no numbered badges**; one block in an `<Alert variant="panel" tone="warning">`; **legal copy byte-unchanged** (cloaking guard held — `spaShell.ts` untouched, same `t()` keys/order). |

**Not swept live at every breakpoint** (covered by co-located component/page
tests + the e2e golden path + per-task visual QA notes): Cart, Checkout, Pay,
WalletTopup, Track, Categories/Products/Flash, the Account family
(Account/Orders/OrderDetail/Referral/Reviews), Support/TicketDetail, Settings,
Register/Forgot/Reset, About/HowToOrder/Privacy/Refund. The e2e run does
render Cart → Checkout → Pay end to end through the migrated components.
A full seeded pass at 320/768/1280/1920 + 200 % zoom on **every** route is
listed as an integrator step in §4.

## 3. Known items carried into hardening / integration

1. **Bundle size** — 200.5 KB gz initial route JS, marginally over §20's soft
   200 KB. No code-split of the `ui/` library was done. Candidate: lazy-load
   `Modal`/`AlertDialog`/`SearchOverlay` (only reached after interaction).
2. **No axe/Lighthouse CI run** this pass. ARIA correctness is asserted at the
   component-test level (dialog focus-trap, combobox pattern, `aria-current`,
   form `aria-describedby`/`aria-invalid`, tabs/accordion keyboard), and the
   two new confirmation dialogs reuse the reviewed `useDialogA11y` machinery —
   but an automated scan + a manual keyboard pass over checkout / auth / the
   ticket thread should run before merge.
3. **Entity-state colour divergence** (`deviations.md` §14 / §16) —
   `StatusBadge.tsx` maps `pending_payment→pine`, `pending/processing→amberx`,
   `cancelled/refunded→rust`; `PayPage`'s `StatusStrip` uses `waiting→amberx`,
   `confirming→pine`, `closed→sand`. Pre-existing, unchanged by this branch,
   **deliberately not recoloured** mid-re-skin. Needs a design-owner decision
   to converge — tracked, out of scope here.
4. **`cancelMutation` has no `onError`** (`deviations.md` §14 item 6) — after
   the new `AlertDialog` wiring, a failed cancel-order leaves the dialog open
   with no failure feedback. Not fixed in Task 14 (would cross the "don't
   touch the mutation" boundary). Needs a dedicated follow-up.
5. **Hero sub-text / trust chips read low-contrast** on the dark hero band
   (`ink-faint` on `bg-ink`, and the mapped `grass`/`pine-tint` icons on the
   `bg-black/40` product-image overlay). Icon+text pairs still carry meaning;
   worth a contrast tune in hardening.
6. **`/how-to-order` heading order** — `StepTimeline` emits `<h3>`/`<h4>`
   before the help-CTA `<h2>`, so that one page isn't §18-clean. Pre-existing;
   the other four content pages are now compliant.
7. **`@theme` block + `spaFallback.ts` `FALLBACK_TOKENS`** remain
   hand-maintained literal copies of the token values (`deviations.md` A1/A2
   — Tailwind v4 limitation). Anyone retoning the palette edits three places.
8. **Worktree is 2 commits behind `master`** (unrelated stock-CSV work) —
   rebase before integrating.

## 4. §30 acceptance criteria

### §30.1 route-level DoD — status across the 32 routes

| Criterion | Status |
|---|---|
| Composed from a `page-templates.md` template; deviations logged | ✅ — every route mapped in `00-audit.md` §B; structural departures in `deviations.md` §9–§18 (content-richer Home, no-mega-menu chrome, flat-denomination grid, `/search`→overlay, prose-vs-timeline content pages, FAQ-vs-inbox Support). |
| Built only from §8.1 inventory components | ✅ — `ui/` primitives + composites + state components (Fase 6); domain components refactored onto them per route. Element-locked spots (`<a>`/`<Link>` styled as button/card) use the same `.btn`/`.card` token classes, logged. |
| Token lint passes — zero arbitrary values, zero raw hex/px | ✅ — `lint` exit 0; the handful of legitimate exceptions are in a commented ESLint allowlist (≤ a dozen) + `tokens.extensions.css` (`--gg-grass-dark-aa`, `--gg-text-2xs`, `--gg-radius-xl`) with `extensions.md` entries. |
| All applicable §16 states implemented | ✅ — `LoadingState`/`ErrorState`/`EmptyState`/`NotFoundState`/`PermissionDeniedState`/`StatusScreen` built (Task 8) and wired; two-way empty states where filters exist (OrdersPage). |
| Wired to real routing/state/validation; mocked data only behind a declared adapter | ✅ — **no adapter was mocked** (`mocked-adapters.md`); the re-skin never changed an endpoint, payload, or query. Money-critical tasks (13/14) reviewed line-by-line. |
| Verified at 320/768/1280/1920 + 200 % zoom; no horizontal scroll from 320px | ⚠️ partial — live-verified on the 7 representative routes in §2 at 1280/375; the rest via tests + e2e. Full seeded sweep = integrator step. |
| Keyboard-operable end to end; focus visible; automated a11y scan clean | ⚠️ partial — component-level ARIA/keyboard asserted; no automated scan wired. |
| Contrast verified on all text and meaningful boundaries | ⚠️ — token pairings are WCAG-checked in `foundations.md`; the dark-hero `ink-faint` and overlay-icon cases (§3.5) need a tune. |
| Long-content & empty-content tolerance verified (§21.1) | ✅ — `Breadcrumb`/`.page-title` `break-words`, `line-clamp`, `whitespace-pre-line` on ticket messages; empty states everywhere. One pre-existing ≤320px overflow on a pathologically long (~64-char) category name, logged. |
| §17 drift checklist run at the primitive layer | ✅ — drift fixed at the primitive/token layer, not per-screen: one `Button`/`Card`/`Badge`/`Input`/`Alert` per concept, one shadow recipe, one radius scale. |
| Types clean; no `any`; no unvalidated casts | ✅ — `typecheck` clean; no new `any` introduced (TS strict + `noUncheckedIndexedAccess`). |
| Existing tests pass; new tests for new logic | ✅ — every migrated page/component keeps its co-located suite green; new tests added for the search overlay, both confirmation dialogs, the OrdersPage filter, WalletTopupPage, `StaticPage` variants, and every `ui/` component. |
| Placeholder copy tagged and listed | ✅ — **none** (`todo-copy.md`); every migration preserved existing `t()` keys. |
| Business terminology matches `business-adaptation.md` | ✅ — CTA register applied; canonical-label drifts from the "Fix targets" list resolved during their page migrations. |

### §30.2 project-level completion

| Criterion | Status |
|---|---|
| Every in-scope route satisfies §30.1 | ✅ substantively; the visual/a11y-scan items in §30.1 are the partial ones. |
| All §29 deliverables produced and current | ✅ — `00-audit.md`, `business-adaptation.md`, `assumptions.md`, `deviations.md`, `extensions.md`, `mocked-adapters.md`, `todo-copy.md`, this file. |
| Full test suite green; no test weakened | ✅ — 6389/6390 (the 1 is an unrelated pre-existing web-admin failure); no test was weakened or deleted to pass a migration — a deleted `/checkout` nav assertion was flagged in review and **restored** (commit `bf330dda`). |
| Performance budgets met on the 3 highest-traffic routes | ⚠️ — no Lighthouse run this pass; bundle is +4.6 KB gz / at the 200 KB line. §3.1. |
| Debt register resolved or explicitly deferred with an owner | ✅ — `00-audit.md` §E items triaged; the deferrals in §3 above each name a follow-up. |
| No unresolved §28.2 escalations | ✅ — the two destructive-action gaps (cancel-order, logout) are **closed** with `AlertDialog` confirmations; the mobile-nav and form-library escalations were resolved as documented assumptions (user-vetoable); legal copy was never touched. |
| No component duplication remains | ✅ — `Flash`/`Callout`→`Alert` shims, `Toast`/`Skeleton`/`Spinner` promoted to `ui/` with re-export shims, three hand-rolled sticky bars → one `StickyPurchaseBar`, two trust-strip copies → one `TrustBadgeRow`. |
| Reference-site semantics replaced where they conflicted | ✅ — gogogo.id's dark/gold theme never entered (tokens were this repo's brand from the start); no mega-menu, no loyalty coins, no OTP flow, no Flip modal — each replaced with this shop's real IA. |
| No unlicensed/unverified asset shipped (§14) | ✅ — no fonts, icons (lucide, already in the repo), or imagery were added; the `gogogo-frontend/assets/icons/` reference set is committed as reference only and not imported by the app. |

## 5. Bottom line

The storefront's 32 routes are migrated to the reverse-engineered design
system, committed one route/component-group per commit, each behind an
independent spec+quality review (several with a money-critical deep pass).
All automated gates are green (the one test failure is an unrelated
pre-existing web-admin bug), the e2e golden checkout path runs through the
migrated UI, and a live Playwright sweep confirms the design language on the
representative routes. Remaining work is the §3 hardening list — a full
seeded visual/zoom sweep, an axe + Lighthouse pass, the entity-state colour
convergence, and the `cancelMutation` error path — none of which block the
re-skin itself.
