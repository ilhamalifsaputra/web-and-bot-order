# /help Playwright visual check - Task 20 evidence

Ran against the rebuilt storefront client (`pnpm --filter @app/storefront-client build`,
executed fresh before this pass so the 3 fixes from commit `60aafae5` are actually in the
served bundle) on `http://localhost:8130`, DB pointed at the isolated Postgres schema
`help_check_visual`. Seed data was already present from a prior partial run (2 users,
3 products, 6 tickets) and was reused as-is.

Login for populated views: `help-qa-209493` / `HelpQa!2026` (6 tickets).
Login for empty-state views: `help-qa-empty-209493` / `HelpQaEmpty!2026` (0 tickets).

Testing-environment note: this session's browser control showed an unstable CSS-pixel
scale factor (`window.devicePixelRatio` drifted between 0.75 and 0.333 across calls,
unrelated to the app itself), so each `browser_resize` call to a nominal width was
re-verified against `window.innerWidth` and recalibrated until the real rendered
viewport matched the target before taking the measurement/screenshot for that row.

## Shot list

1. `01-desktop-empty-state.png` - empty-state user, desktop: hero + empty form + "No support tickets yet" + pills at (0). PASS
2. `02-mobile-empty-state.png` - same, mobile single-column stack. PASS
3. `03-desktop-populated-tickets.png` - populated user, desktop, all 6 tickets, 5 distinct badge tones readable. PASS
4. `04-desktop-create-ticket-form.png` - create-ticket form close-up (Subject, Category+Product, Order, Description, evidence dropzone, safety notice, Send ticket). PASS
5. `05-desktop-filter-pill-applied.png` - "Waiting for support" pill clicked, list narrows 6 to 2 (#TK-6, #TK-1), confirmed via DOM query. PASS
6. `06-desktop-inline-panel.png` - InlineTicketPanel for ticket #TK-2 (In Progress), both message bubbles + reply composer visible. PASS
7. `07-mobile-populated-and-panel.png` - mobile, populated list + panel open, stacked cards, no horizontal scroll. PASS
8a. `08a-desktop-1024-no-hscroll-check.png` - 1024x800 real viewport. Document-level PASS, but see new finding below (table clipping). Overall: FAIL for check intent.
8b. `08b-desktop-1440-no-hscroll-check.png` - 1440x900 real viewport. Same as above: FAIL for check intent.
8c. `08c-mobile-390-no-hscroll-check.png` - 390x844 real viewport. PASS.
9. `09-desktop-long-subject-wrap.png` - InlineTicketPanel header for the 104-char long-subject ticket (#TK-6) at 1440px. PASS

## The 3 previously-fixed bugs (commit 60aafae5) - re-verified against the fresh build

1. Search input icon/placeholder overlap: CONFIRMED FIXED. Measured padding-left on
   the "Search tickets..." input = 32px (`!pl-8`); text start position clears the
   icon right edge by about 6px. No overlap. Visible cleanly in shots 03/04/05/07.
2. Status badges wrapping to 2-3 lines: CONFIRMED FIXED. Measured all 6 rendered badges
   in the populated list (both "Waiting for Support" instances, "Closed", "Resolved",
   "Waiting for You", "In Progress"): every one is exactly 22px tall (single line) with
   white-space nowrap computed; widths scale only with text length (82-154px).
3. Page-level 100vw-scrollbar overflow at 100% zoom: CONFIRMED FIXED. At real mobile
   width (about 390-410px), document.documentElement.scrollWidth matches the rendered
   screenshot width exactly (410px both ways), no visible cutoff (08c/07). The
   calc(50% - 50vw) fix holds at the document level. (A different, newly-found
   overflow issue below is not this bug.)

## No-horizontal-scroll numeric check (brief step 4.8) plus a new finding

After calibrating the real viewport width:

- 1024 nominal, real innerWidth 1024: scrollWidth 1024 vs clientWidth 1024 (equal), technically PASS at document level
- 1440 nominal, real innerWidth 1440: scrollWidth 1440 vs clientWidth 1440 (equal), technically PASS at document level
- 390 nominal, real innerWidth 390: scrollWidth 410 vs clientWidth 360, PASS (matches screenshot width exactly, visually clean, no cutoff)

However, per the brief's own warning that overflow-x-clip can mask internal overflow
rather than prevent it, digging one level in with getBoundingClientRect surfaced a
real, previously-unreported bug:

- MyTicketsCard's ticket table has a fixed intrinsic width of about 837px (6 columns:
  Ticket, Subject, Status, Last update, Date, chevron) that does not shrink with its
  container.
- At real 1024px viewport the card holding it is only 450px wide, so the table
  overflows its own card by 413px.
- At real 1440px viewport the card is 658px wide, so the table overflows by 205px.
- Because the page's outer breakout wrapper carries overflow-x-clip (by design, to
  suppress the page-level scrollbar per bug 3 above), this internal overflow is
  silently clipped rather than made scrollable: the "Date" column, part of "Last
  update", and the row chevron are rendered outside the visible card and are not
  reachable by any scrollbar at either 1024px or 1440px. Confirmed visually in 08a and
  08b screenshots, both show only 4-5 of the table's 6 columns; "Date" is entirely
  missing in both.
  - Row clicks still work (the row's own click handler isn't affected), so this is a
    display/information-loss bug, not a hard blocker, but on very common laptop
    resolutions (1024-1440px, both explicitly required by this check) users currently
    cannot see when a ticket was created, only a partial "last update".
  - New finding, distinct from the 3 bugs already fixed in 60aafae5. Suggested
    follow-up: give the table itself (not the whole card) overflow-x-auto, or drop a
    lower-priority column at this breakpoint. Not fixed here, verification only, per
    the brief's scope.

Mobile (390px) does not hit this because MyTicketsCard switches to a card-list layout
below the lg breakpoint instead of the table.

## Long-subject wrap check (brief step 4.9)

Ticket #TK-6's 104-character subject in InlineTicketPanel's header: at real 1440px the
subject span renders on a single line (670px needed, about 1344px available), stays
fully inside the panel, and the status badge (right-aligned via justify-between) is
untouched, no overflow, no push-off-screen. PASS. The header row's outer container is
flex flex-wrap, so at a narrower width the badge would drop to its own line rather
than being squeezed or clipped (confirmed by source inspection).

## Padding and spacing review

No hard defects found.
- NewTicketCard and MyTicketsCard start flush at the same y-offset, same card/
  card-pad conventions, consistent internal padding.
- Gaps between form fields (Subject to Category/Product to Order to Description to
  evidence to safety notice/Send ticket) are visually even.
- InlineTicketPanel's outer spacing (mt-7 from the two cards above) reads as a
  consistent step in the same rhythm as the gap-7 between the two cards themselves.
- Minor, not a defect: InlineTicketPanel's "Back to tickets" affordance has more
  breathing room above the ticket header than the cards' own header padding, reads as
  deliberate (room for the back action), not an inconsistency.
- The status-pill row and the search/sort toolbar both use a horizontally-scrollable
  overflow container by design at narrow widths (a partially-visible "Cl..." pill, or
  truncated "Search tic.../Latest..." placeholder text at the edge, is the intended
  scroll affordance, not a bug), same pattern on desktop and mobile.

## Keyboard tab-order walk (desktop, populated-ticket-list user)

Walked with repeated Tab plus document.activeElement reads from a fresh body.focus().
PASS, matches visual top-to-bottom order throughout; the decorative hero image
correctly has no tab stop.

1. "Skip to content" link
2. Header: logo, search box, language toggle, Track order, Account, Cart
3. (hero illustration skipped, decorative, no focus stop)
4. Create-ticket form, in visual order: Subject, Category, Product, Order,
   Description, Attach files, Send ticket
5. My-tickets toolbar: Search tickets, Sort
6. Status pills, in visual order: All, Waiting for you, Waiting for support,
   In progress, Resolved, Closed
7. Ticket rows, in visual top-to-bottom order: #TK-6, #TK-5, #TK-4, #TK-3,
   #TK-2, #TK-1
8. Pager: no focusable controls (only 1 page for 6 tickets at page-size 10, so nothing
   to render), falls through cleanly to the footer's "All products" link, no dead stop
   or illogical jump.

No skips, no out-of-order jumps, nothing unreachable.

## Other observations

- Native select/input placeholder text gets clipped by the browser at narrow widths
  ("Search tic...", "Latest..."), standard native-control behavior given the fixed
  width classes; cosmetic only, not blocking.
- The MyTicketsCard table-overflow finding above is the one item worth prioritizing as
  a follow-up; everything else checked out clean.

## Cleanup

- Disposable seed script `.superpowers/sdd/task-20-seed.ts` deleted.
- Disposable one-off check script `.superpowers/sdd/task-20-check.ts` (used only to
  confirm existing seed data before deciding whether to re-seed) deleted.
- Storefront dev server stopped.
- `help_check_visual` Postgres schema and its seed rows left in place per the brief.

## Follow-up: My-tickets table overflow (min-w-0 fix verification)

Verifies commits `acd2a8ec` (table wrapped in `overflow-x-auto`) and `31a94510`
(`min-w-0` added to `MyTicketsCard`'s root `<section>`, the `lg:grid-cols-2` grid
item) against the same rebuilt client and the same `help_check_visual` seed data/user
(`help-qa-209493`) reused from the pass above. New screenshots: `10-desktop-1024-
table-overflow-fixed.png`, `11-desktop-1440-table-overflow-fixed.png` (both captured
after scrolling the table's `overflow-x-auto` wrapper to its max `scrollLeft`, so the
"Date" column and chevron are visible in-frame — proving the scroll actually reaches
them, not just that a scrollbar renders).

### Card vs. table width

| Viewport | Card width | Card content-box width (minus 24px padding × 2) | Table width | Table fits directly? |
|---|---|---|---|---|
| 1024px | 450px | 402px | 677px | No (275px over) |
| 1440px | 658px | 610px | 677px | No (67px over) |

The table's intrinsic width dropped from Task 20's measured ~837px to ~677px (the
`min-w-0` fix lets the card's own width finally reach its correct `1fr`-track value —
450px/658px, unchanged from Task 20's pre-fix numbers, confirming the CARD was never
the thing that needed to shrink; what changed is that the table can now shrink too,
since its parent finally has a real constrained width to shrink against). It's still
wider than the card's content box at both required widths, so this is not a "table now
fits" fix — it's a "table's overflow is now genuinely contained and scrollable
in-place instead of silently clipped by the page's outer `overflow-x-clip`" fix, which
is exactly what commit `31a94510`'s message describes.

### Is the overflow reachable now?

Yes, confirmed programmatically at both viewports, not just visually:

- **1024px**: `overflow-x-auto` wrapper reports `clientWidth` 398 / `scrollWidth` 677
  (`scrollWidth > clientWidth` → real, working scroll range). At `scrollLeft = 0` the
  "Date" `<th>` is off-screen (outside the wrapper's visible rect). After setting
  `scroller.scrollLeft = scroller.scrollWidth`, the "Date" header's rect falls fully
  inside the wrapper's visible rect. **Scrolls into view.**
- **1440px**: wrapper `clientWidth` 606 / `scrollWidth` 677. At `scrollLeft = 0`,
  "Date" and the trailing chevron column are both outside the visible rect (only
  Ticket/Subject/Status/Last update show). After scrolling to max `scrollLeft`, both
  become visible (the "Ticket" column scrolls out on the left instead, which is
  expected trade-off behavior for a horizontally-scrolling table). **Scrolls into
  view.**

So: table does not fit directly at either required width, but the DATE column (and
chevron) is now reachable by scrolling the table's own `overflow-x-auto` wrapper —
verified via `scroller.scrollLeft = scroller.scrollWidth` plus a `getBoundingClientRect`
visibility check on the "Date" `<th>` before and after, not just a visual screenshot.
This directly fixes Task 20's reported defect: previously this overflow was silently
clipped by the page's outer `overflow-x-clip` wrapper with **no way to reach it at
all**; now it's contained by the table's own scroll wrapper and is reachable.

### Page-level scrollWidth vs. clientWidth re-check (brief step 4.8, re-run)

| Viewport | scrollWidth | clientWidth | Diff |
|---|---|---|---|
| 1024px | 1010 | 994 | 16 |
| 1440px | 1426 | 1410 | 16 |
| 390px | 376 | 360 | 16 |

Task 20's own numbers for this same check were 1024/1024 (equal) and 1440/1440
(equal), so a flat 16px gap at every width now stands out. Traced it before treating
it as a regression: `document.body`'s single direct child (the app's React root div)
measures exactly 0 to `clientWidth` at every one of these viewports — i.e., no
user-visible element extends past the actual viewport edge. The only element whose own
box geometry extends past its immediate parent is the intentional
`mx-[calc(50%_-_50vw)] overflow-x-clip` breakout wrapper itself (documented at the top
of `HelpPage.tsx`), which is inherently sensitive to the exact reported `vw` value.
This same environment already had documented `devicePixelRatio` instability in Task
20's own report (drifting 0.75-0.333 with no action causing it); the 16px figure here
is constant in absolute pixels across three different viewport widths (not
proportional to width, as a genuine content-overflow would be), which points to a
fixed scrollbar-width/DPR artifact of this browser-automation session rather than a
real, newly-introduced layout defect. It reproduces even on `/` (the unrelated
homepage, no `MyTicketsCard`, no `min-w-0` in its diff) as an `innerWidth`-vs-
`clientWidth` gap of the same 30px, half of which (15-16px) leaks into the `vw`-based
breakout math on `/help` specifically because `/help` is the one page using that
technique. The `31a94510` commit diff touches only `MyTicketsCard.tsx`'s `className`
(one line), nothing on `HelpPage.tsx`'s breakout wrapper, so this can't be something
that commit introduced. Not re-confirmed outside this session's browser automation, so
flagging it rather than asserting it's definitely benign — but it is not visible in
any screenshot taken (10, 11, or Task 20's originals) and does not hide any element
that matters.

### Verdict: PASS

The `min-w-0` fix does what its commit message claims: the My-tickets table's
overflow, previously invisible and permanently unreachable (silently clipped by the
page's outer wrapper), is now contained by the table's own `overflow-x-auto` scroll
region and reachable by scrolling at both 1024px and 1440px. The table does not
shrink to fully fit the card at either width, but that was never the fix's claim — the
claim was that the already-in-place `overflow-x-auto` wrapper would finally get a
chance to do its job, which is confirmed. The 16px page-level residual noted above is
flagged as a likely environment/DPR artifact (present identically on an unrelated page
and not attributable to this commit's diff), not treated as a fail of this check.
