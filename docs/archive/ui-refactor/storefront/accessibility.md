# Accessibility Findings

## Keyboard navigation

- Tab order through the header (logo -> search -> language -> account -> cart) is logical and matches
  visual order.
- **STO-003 (High):** focus on the homepage hero's "Browse products" CTA is effectively invisible — measured
  via `getComputedStyle` on the actually-focused element: `outline-color: rgba(37, 99, 235, 0.4)`,
  `outline-width: 2px`, rendered over a solid blue gradient background. This fails WCAG 2.4.11 (Focus
  Appearance) in practice, even if the outline exists in the DOM/CSSOM. The same risk likely applies to any
  interactive element placed on the page's other saturated-color surfaces (e.g. the pine-colored "Our
  Promise" band) — worth an explicit audit pass over every `bg-ink`/`bg-pine` surface once STO-003 is fixed
  on the hero.
- Elsewhere (search box, form fields on Login/Register/Checkout), the default focus ring showed clear
  contrast against the light backgrounds used there — no other focus-visibility issues found in the pages
  tabbed through.

## Heading hierarchy

Every crawled page followed a sound H1 -> H2 -> H3 structure with no skipped levels (confirmed via
accessibility-tree snapshots, e.g. homepage: H1 hero title, H2 per section, H3 per card/feature). No
findings here.

## Form labels

Every tested form input had a properly associated accessible name (confirmed via the accessibility tree
showing `textbox "Label text"` rather than an unnamed generic input) across Register, Login, Checkout
(including the voucher code field and per-unit Email fields), and Support ticket forms. No unlabeled-input
issues found.

## Images / alt text

Product card and product-detail images use the product name as `alt` text (`ProductCard.tsx`,
confirmed in rendered accessibility snapshots as `img "Capcut Pro 1 Month"`) — decorative icons throughout
(feature-card icons, trust chips) are not exposed as separate accessible objects, which is appropriate since
they're paired with their own text labels.

## Color contrast

Body copy and card text (`text-ink`, `text-ink-soft`) read at comfortable contrast in every screenshot
reviewed. Secondary/muted text (`text-ink-faint`, used for USD-equivalent price hints like "≈ $0.80" and
helper text under form fields) is deliberately lighter and should be run through an automated contrast
checker (e.g. axe or a Lighthouse pass) against the actual computed hex values before sign-off — this audit
did not have a contrast-ratio tool available and is flagging it as a **verify, don't assume** item rather
than a confirmed finding.

## Accessible error messages

- Checkout's voucher error ("Voucher code not found.") is rendered as visible text (not just a color change)
  with an icon, which is good — but see **STO-005**: its placement far from the triggering input is itself
  an accessibility concern beyond the visual one, since a screen-reader user tabbing linearly would not
  necessarily associate the error announcement with the voucher field either (the error is not wired to the
  input via `aria-describedby`/`aria-invalid` as far as the rendered DOM shows).
- Register/Login errors render via a shared `Flash` component with visible text — no issues found there.

## Reduced motion

The homepage's scroll-reveal animation correctly respects `prefers-reduced-motion: reduce`
(`HomePage.css:33-38` forces `opacity:1; transform:none; transition:none`) — a genuine accessibility
strength, not just a CRO/perf one. See STO-006 in `performance.md`/`homepage.md` for the separate,
motion-independent visibility gap this same mechanism creates for non-scrolling consumers of the page.

## Recommendation summary

1. Fix STO-003 (focus contrast) first — concrete, WCAG-mapped, and already precisely located.
2. Wire the voucher error to its input via `aria-describedby`/`aria-invalid` while fixing STO-005's visual
   placement — the two fixes belong in the same change.
3. Run an automated contrast pass (axe-core or Lighthouse) over the `ink-faint`/`ink-soft` text tokens as a
   follow-up verification step; this audit could not confirm or rule out a violation without that tooling.
