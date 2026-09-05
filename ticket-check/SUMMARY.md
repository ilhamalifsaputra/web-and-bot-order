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
