# /help Playwright visual check — post design-system port

Supersedes the earlier Task-20 pass. That one predates the rebase onto master's
storefront design-system migration and the four port commits (`7aec93e0`,
`1d3076b4`, `d9624f68`, `68f9f3c2`), so its screenshots no longer show what
ships. Its findings are preserved in git history.

## Environment

- Storefront served from a **freshly rebuilt client bundle**
  (`pnpm --filter @app/storefront-client build` run immediately before the pass,
  and again after the `!border-rust` fix below). Screenshotting a stale bundle
  is the one trap that produces a confident false pass on exactly the CSS that
  changed, so the build is not optional.
- `http://localhost:8130`, DB pointed at the **isolated Postgres schema
  `help_check_visual`** — never `public`, which is shared across worktrees and
  would receive this branch's new `support_tickets.subject` / `product_id`
  columns.
- Seed reused from the prior pass: 2 users, 3 products, 6 tickets covering all
  six statuses (one per bucket, including `WAITING_CUSTOMER` — the case the new
  plum badge exists for).
- Login used: `help-qa-209493` (6 tickets).

**Measurement caveat, unchanged from last time:** this browser reports
`devicePixelRatio` ≈ 0.333, so a requested viewport of *N* renders at *3N* CSS
pixels. Every viewport below was set by resizing to `target / 3` and then
confirming `window.innerWidth` really equalled the target before measuring.
Screenshots are therefore capped at the 480px physical window and are
supporting evidence only — **the numbers below are the actual verification.**

## Results

| # | Check | Measured | Verdict |
|---|---|---|---|
| 1 | **Nested card (L2) is not camouflaged** | parent `.card` `rgb(255,255,255)` / radius 16px / has shadow; nested `.card-2` `rgb(238,241,246)` / radius 12px / `box-shadow: none` | **PASS** |
| 1b | L2 separation vs parent | ΔL\* **4.95** (rule: ≥ 3); differs on fill **and** shadow = 2 of 3 channels | **PASS** |
| 1c | L2 never repeats parent fill | `differsFromParent: true` | **PASS** |
| 1d | L2 radius ≤ parent radius | 12px < 16px | **PASS** |
| 2 | Container width unchanged by the token swap | `.max-w-wide` computes `max-width: 1440px`, actual width 1440 | **PASS** |
| 3 | Five distinct badge tones | amberx `rgb(253,237,207)` · sand `rgb(238,241,246)` · grass `rgb(231,246,236)` · **plum `rgb(241,235,254)`** · pine `rgb(230,239,254)` — 5 unique | **PASS** |
| 3b | Badges stay one line | all 6 rendered badges 22px tall, `white-space: nowrap` | **PASS** |
| 4 | Table scrolls inside its card, not clipped | wrapper `scrollWidth 675 > clientWidth 606`; card 658px, does not exceed viewport | **PASS** |
| 5 | No horizontal page scroll @1440 | `scrollWidth 1410 == clientWidth 1410` | **PASS** |
| 5b | @1024 | `994 == 994`; both cards 450px, both within viewport | **PASS** |
| 5c | @390 | `360 == 360`; layout switches to stacked cards | **PASS** |
| 6 | Filter pills scroll on mobile (not the page) | pill strip `scrollWidth 675 > clientWidth 298`, inside `flex-nowrap overflow-x-auto` | **PASS** |
| 7 | Search icon clears placeholder | `padding-left: 32px`; text starts 989 vs icon right edge 983 (+6px) | **PASS** |
| 8 | Panel entrance animates | `animation: rise`, `0.15s` (`--gg-duration-fast`), `cubic-bezier(0.22,1,0.36,1)` (`--gg-ease`) | **PASS** |
| 8b | Animation leaves no transform | `animation-fill-mode: backwards`; computed `transform: none` after | **PASS** |
| 8c | Reduced motion honoured | `.enter-rise` is nested inside `@media (prefers-reduced-motion: no-preference)` in app.css — structurally cannot run under `reduce` | **PASS** |
| 9 | Form fields via `FormField` | all 5 render; `aria-invalid=true` and `aria-describedby` (hint + error) wired on each | **PASS** |
| 9b | Errors announced | 4 × `role="alert"` with the right copy; focus moves to the first invalid field | **PASS** |
| 9c | Invalid fields show a rust border | **initially FAILED — see below**; after fix all four compute `rgb(220,38,38)` | **PASS (after fix)** |

## Bug found and fixed during this pass

**`invalid` on `Input` / `Select` / `Textarea` rendered no rust border — anywhere
in the storefront.** Pre-existing on master; not introduced by this branch, but
this branch is the first to depend on it (`NewTicketCard` now composes those
primitives for its error state).

Root cause, confirmed by static analysis of the built bundle rather than by eye:

- `.field` (app.css) sets the **`border` shorthand**: `border: 1px solid var(--line)`
- `.border-rust` sets only `border-color`
- both have specificity `(0,1,0)`, and `app.css` is `@import`ed *after*
  `tailwindcss` in `index.css`
- in the built CSS, `.border-rust` sits at byte **22457** and `.field` at
  **62951** — 40KB later, so the shorthand always won and `border-rust` was dead

Measured before: invalid fields computed `rgb(227,232,239)` (the ordinary `--line`
grey) — an invalid field was pixel-identical to a valid one.

This is the same root cause as `MyTicketsCard`'s `!pl-8` (the search-icon overlap
fixed earlier). It escaped the unit tests because those assert the *class is
present*, which it always was; only a computed-style check catches it.

Fix: `invalid && "!border-rust"` in all three primitives, tests updated to match.
Verified live afterwards: all four invalid fields compute `rgb(220,38,38)`.

Blast radius of the fix (restores documented behaviour, not a new visual):
`CheckoutPage`, `SettingsPage`, `RegisterPage`, `ResetPage`, `NewTicketCard`.

## Shot list

1. `01-desktop-1440-nested-card-l2.png` — inline panel open on the closed ticket;
   the "This ticket is closed…" panel renders as a recessed sand L2 surface
   inside the white L1 card.
2. `02-desktop-1440-form-validation-errors.png` — create-ticket form after
   submitting empty: rust borders on Subject / Category / Product / Description
   with the error copy beneath. (This is the shot that would have been all-grey
   before the fix above.)
3. `03-desktop-1440-help-full.png` — full page at 1440: hero, two-column grid,
   filter pills with counts, six tickets showing all five badge tones.
4. `04-mobile-390-stacked.png` — 390px: single column, Category/Product stacked
   rather than side by side, full-width Send ticket, tickets as stacked cards.

## Not covered

- The `EvidenceUploader` staged-file rows (the second `.card-2` consumer) were
  verified in source and via the shared `.card-2` computed style, not by
  actually attaching a file in the browser.
- No axe/keyboard-only accessibility sweep was run this pass.
