# Accessibility Findings

All items below were confirmed directly — either via Playwright's
accessibility-tree snapshot (`browser_snapshot`), keyboard interaction, or
`getComputedStyle`/`querySelectorAll` run in the live page — not inferred
from visual inspection alone.

## Confirmed issues

### 1. Icon-only Search button loses its accessible name below `sm` (Finding F-009 — High)
`apps/web-admin/client/src/components/layout/TopBar.tsx` lines 41-51: the
search trigger `<button>` has no `aria-label`; its only text content is a
`<span className="hidden sm:inline">Search...</span>`, which Tailwind removes
from layout (and the accessibility tree) below the `sm` breakpoint. Confirmed
via accessibility snapshot at 375px width: the element appears as an unnamed
`button`, in contrast to the `Open navigation` and `Quick actions` buttons
right next to it, which both correctly keep their `aria-label`s at every
width. **Fix:** add `aria-label="Search"` directly on the button.

### 2. Dashboard section titles are not real headings (Finding F-010 — Medium)
Ran `document.querySelectorAll('h1,h2,h3,h4,h5,h6')` against the live
Dashboard DOM: only **two** heading elements exist on the entire page — `H1:
Dashboard` and `H2: Operation Center`. Every other visually-heading-styled
section title ("Critical Stock", "Upcoming Expirations", "Sales Analytics",
"Recent Orders", "Business Health", "Top Products · Last 30 Days") is a plain
`div`/`span`. A screen-reader user navigating by heading (a primary
navigation method, e.g. NVDA/JAWS "next heading" or VoiceOver's rotor) would
perceive the Dashboard as having just two sections instead of eight. **Fix:**
use real `<h2>`/`<h3>` tags for these titles (styling can stay identical via
the same CSS classes).

### 3. Low text contrast on muted/secondary text (Finding F-011 — Medium)
Measured via `getComputedStyle` on the live topbar: the "Search..." label
text computes to `rgb(151, 161, 177)`. Against a white/near-white background,
this is approximately a **2.6:1** contrast ratio — below the WCAG 2.1 AA
minimum of 4.5:1 for normal-size text (and below the 3:1 minimum even under
the more lenient large-text/UI-component threshold, since this is small
14px text). This exact color/utility is likely reused elsewhere in the app
(seen as a general "faint" text style) — a full sweep for the same computed
color across `apps/web-admin/client/src` is recommended before fixing, so
the token is corrected once rather than patched ad hoc per instance.

## Spot-checked and passing

- **Keyboard shortcut discoverability:** `Ctrl+K` opens the search modal and
  focus lands correctly in the search input (confirmed: pressing `Ctrl+K` on
  Dashboard moved focus to `textbox "Search orders, products, users..."`,
  marked `[active]` in the snapshot).
- **Focus visibility on Login:** tabbing from page load on `/login` moves
  focus to the Telegram ID field with a visible focus outline in the
  screenshot (`screenshots/login-focus-indicator-desktop.png`) — not
  exhaustively tested across every interactive element on every page, but the
  one spot-check performed showed a visible indicator, not a suppressed
  outline.
- **Form error announcement:** submitting invalid login credentials surfaces
  a visible, correctly-associated error message ("Invalid credentials.")
  directly above the form fields (`screenshots/login-invalid-credentials-desktop.png`)
  — not confirmed whether this is wired to `aria-live` for screen-reader
  announcement (would need a screen reader or DOM inspection of the specific
  element's ARIA attributes to confirm; flagged as **needs deeper check in
  phase 2**, not asserted as passing or failing).
- **Icon buttons with labels elsewhere:** `Open navigation` (hamburger),
  `Close navigation` (drawer close), and `Quick actions` buttons in
  `Sidebar.tsx`/`TopBar.tsx` all correctly carry `aria-label`s at every
  viewport tested — the Search button (issue #1 above) is the outlier, not
  the pattern.
- **Disabled-state semantics:** buttons disabled pending required form input
  (e.g. "Create Product", "Create Denomination", "Send now") use the native
  `disabled` attribute (confirmed via accessibility snapshot showing
  `[disabled]`), which is correctly exposed to assistive tech, rather than a
  purely visual/CSS-only disabled look.

## Not fully assessed (needs phase 2 follow-up)

- **Full keyboard-only navigation of a complete workflow** (e.g. tab all the
  way through creating a product without touching the mouse) was not
  exhaustively walked end-to-end; only individual-page focus/tab spot-checks
  were performed given the scope of this pass.
- **Color contrast sweep** — only one instance (Search label) was measured
  concretely; a full automated contrast audit (e.g. axe-core or a Playwright
  + axe integration) across every page is recommended before implementation,
  since the muted-text pattern likely recurs (helper text under form fields,
  table secondary text, badge text, etc.).
- **ARIA roles on custom combobox/select components**
  (`components/ui/select.tsx`) — these render as `role="combobox"` with a
  `listbox`/`option` popup pattern (confirmed via snapshots on the Orders
  status filter and Denomination Account Type field) which is the correct
  pattern, but full keyboard operability (arrow keys, typeahead, Escape to
  close) of this shared component was not exhaustively tested across every
  instance.
- **Screen-reader testing with an actual screen reader** (NVDA/VoiceOver) was
  not performed — all findings above come from the accessibility tree
  (Playwright's `browser_snapshot`) and computed styles, which is a strong
  proxy but not a full substitute for real assistive-tech testing.
