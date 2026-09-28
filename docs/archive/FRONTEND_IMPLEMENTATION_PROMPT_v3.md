# Frontend Implementation Prompt — Reverse-Engineered Design System

**Version:** 3.0
**Supersedes:** v1 (the 23-section original)
**Change summary:** Appendix A

---

## TASK

You are working on the frontend application in this repository.

The folder:

- `design-system/components.md`
- `design-system/foundations.md`
- `design-system/page-templates.md`
- `design-system/tokens.css`
- `design-system/tokens.json`
- `design-system/tailwind.preset.js`
- `design-system/README.md`

is the **canonical visual design specification** for this project.

These files were produced through reverse engineering of the reference website's visual system, layout system, component behavior, spacing, typography, responsive behavior, and page patterns.

Your job is **not to redesign the application**.

Your job is to implement the existing application using this design system with extremely high visual fidelity while adapting the **content, information architecture, data, user flow, and business logic** to this project's actual business requirements.

Three rules govern everything below:

1. **The design system defines HOW it looks. This repository defines WHAT it does.**
2. **Gaps are handled through documented mechanisms** (§26), never through silent improvisation.
3. **When genuinely blocked, follow §28.** Do not guess on high-risk decisions, and do not stall on questions the repository already answers.

Sections marked **[GATE]** require a written deliverable before you continue.

---

# 1. PRIMARY OBJECTIVE

Build the frontend so that:

**VISUAL LANGUAGE**
= follow the reverse-engineered design system as closely as possible

**BUSINESS**
= follow this project's actual business/domain requirements

**CONTENT**
= use this project's own products, services, terminology, copy, categories, pricing, CTA, and user flows

**TECHNICAL IMPLEMENTATION**
= use the existing frontend stack and architecture in this repository

Do **not** invent a new visual design system.

Do **not** introduce arbitrary UI patterns when an equivalent pattern already exists in `design-system/`.

Do **not** reinterpret the visual language unnecessarily.

**Explicit non-goals:** framework migrations, swapping the CSS or state solution, adding features not present or specified in the repository, backend/schema changes, analytics instrumentation, and building static mockups.

---

# 2. IMPORTANT DISTINCTION

The reference design is the **visual reference**.

It is **not the business model**.

Therefore:

## KEEP

- typography system
- spacing system
- grid system
- page density
- border radius
- shadows
- card geometry
- button geometry
- form styling
- navigation patterns
- header proportions
- footer structure when applicable
- responsive behavior
- visual hierarchy
- component composition
- interaction patterns
- motion timing and easing
- table/list patterns
- modal/drawer patterns
- empty/loading/error state patterns
- overall visual rhythm

## CHANGE

- branding
- logo
- product names
- product categories
- copywriting
- pricing
- business terminology
- navigation labels where business requires it
- CTA meaning
- product/service data
- checkout/order flow
- authentication flow
- account/business logic
- inventory/business states
- business-specific pages
- business-specific components

The resulting application should feel like the **same design system**, but clearly belong to **this project's business**.

---

# 3. SOURCE OF TRUTH

v1 used a single flat priority list. That is ambiguous, because prose documents and machine-readable tokens answer different kinds of question. Use this instead.

## 3.1 Authority by question type

| Question | Authoritative source |
|---|---|
| What must this screen *do*? | Repository code, types, existing requirements, tests |
| Where does it live, how is it built? | Existing application architecture and conventions |
| What is the **exact value** (color, spacing, radius, size, duration)? | `tokens.json` → `tokens.css` → `tailwind.preset.js` |
| What **structure and variants** does this component have? | `components.md` |
| How is the **page composed**? | `page-templates.md` |
| What is the **underlying principle** (rhythm, hierarchy, density)? | `foundations.md` |
| Business semantics, labels, terminology | `design-system/business-adaptation.md` (§27) |
| Anything still unresolved | §28 escalation protocol |

**Tie-break rule:** if `components.md` describes a value in prose and `tokens.json` defines it numerically, **the token wins**. Log the discrepancy in the audit (§5.2) — a prose/token mismatch usually means one of them is stale.

## 3.2 Conflict rules

When business functionality and visual specification collide:

1. Preserve the business functionality — always.
2. Preserve the design system's visual *language* (tokens, rhythm, geometry, interaction model).
3. Adapt the *composition* — add a section, change a grid span, extend a variant.
4. Never resolve a conflict by inventing a different visual style, a one-off palette, or an unstyled escape hatch.

Every conflict resolved this way is logged in `docs/implementation/deviations.md` (§29).

---

# 4. BUSINESS ADAPTATION

For every page/component, determine:

> What is this UI pattern supposed to accomplish in the reference?

Then translate that **purpose** into this project's business.

Example:

**Reference:** Product card
**This project:** the card for whatever entity this business actually sells or manages

**Reference:** Purchase CTA
**This project:** the real action — Buy, Order, Subscribe, Contact, Add to cart, Continue, Redeem, Book, Request quote — depending on the actual business flow

Do **not** blindly copy labels simply because they exist in the reference.

**Preserve the interaction pattern; replace the business semantics.**

Every CTA in the application is registered once in the CTA table in `business-adaptation.md` (§27). This is what prevents four different words for the same action appearing on four screens.

---

# 5. FIRST: REPOSITORY AUDIT

## 5.1 What to inspect

**Repository:** existing routes · current pages · existing components · existing layouts · data models and types · API clients · state management · authentication and authorization · forms · validation · existing Tailwind configuration · `package.json` (stack, versions, constraints) · test setup · assets · current UI implementation · unfinished pages · TODOs · dead components · duplicated components · inconsistent styling.

**Design system:** every file in `design-system/`, including `README.md`. Read all of it before writing any code.

Do not start major implementation until you understand the design system.

Do not ask unnecessary questions if the answer can be derived from the repository.

## 5.2 Required audit output

v1 asked for an "internal mapping." Make it an artifact — an audit nobody can inspect is unverifiable. Produce `docs/implementation/00-audit.md` containing:

**A. Stack statement** — framework and version, router, styling solution, state library, form/validation library, test runner, package manager, TypeScript strictness. Note anything that constrains implementation.

**B. Route inventory**

| Route | Purpose | Data source | Auth required | Current state | Target template | Priority |
|---|---|---|---|---|---|---|

**C. Component mapping** — the core artifact of this phase:

| Reference pattern | `design-system/` spec | Existing repo component | Action | Target path |
|---|---|---|---|---|

Action ∈ `adopt` · `refactor` · `replace` · `build` · `delete`. No `TBD` permitted.

**D. Token coverage** — tokens defined but unused; values the business needs that the token set does not define (feeds §26.2); any prose/token discrepancies found under §3.1.

**E. Debt register** — duplicated components, dead code, inconsistent styling, missing validation, untyped data. Mark each `fix-now` / `fix-later` / `out-of-scope`.

**F. Open questions and assumptions** (§28).

---

# 6. DO NOT CODE IMMEDIATELY **[GATE]**

Before modifying application files, produce a concise implementation plan containing:

1. Current application routes
2. Current page/component architecture
3. Design-system primitives available
4. Page templates available
5. Mapping of existing routes → design-system templates
6. Components that can be reused
7. Components that must be created
8. Business-specific UI that must replace reference-site semantics
9. Potential conflicts between existing architecture and the design system
10. Ordered implementation plan

**Exit condition:** every route has a target template; every component in `components.md` has an action; the debt register is triaged.

After producing the audit, proceed with implementation without waiting for confirmation — **except** for the items listed in §28.2, which always require an answer before you build on them.

---

# 7. PIXEL-LEVEL VISUAL FIDELITY

## 7.1 Standard

Fidelity is measured against **tokens and defined values**, not against screenshots of the reference site. Where the design system defines a value, reproduce it exactly. Where it does not, derive from the nearest scale step — never from taste.

Attributes under strict control: exact spacing · typography scale · font weights · line heights · letter spacing · container widths · section spacing · card dimensions · button height · input height · border thickness · border radius · shadows · icon sizes · alignment · vertical rhythm · grid column counts · breakpoints · responsive stacking · navigation behavior · image aspect ratios · content density · whitespace · motion duration and easing.

Do not approximate values when the design system already defines them.

## 7.2 Token-first implementation

Order of preference, strictly:

```
design token  →  Tailwind preset utility  →  reusable component primitive  →  (last resort) documented exception
```

## 7.3 Enforcement

v1 banned arbitrary values twice (§7, §14) but nothing enforced it. An unenforced rule is decoration. Make it mechanical:

- ESLint/Stylelint rule failing the build on arbitrary Tailwind values (`w-[437px]`, `text-[#3B82F6]`, `mt-[13px]`) outside an allowlist.
- CI check: no hex colors or raw `px` values in application code — only in `tokens.css` and `tokens.extensions.css`.
- Allowlist limited to third-party component overrides and genuinely content-derived geometry. Each entry carries a one-line comment stating why.

If the allowlist keeps growing, the component mapping (§5.2C) is wrong. Stop and revisit it.

---

# 8. COMPONENT ARCHITECTURE

## 8.1 Inventory

Build reusable components based on the definitions inside `design-system/components.md`. One canonical component per concept, with variants.

**Primitives:** Button · IconButton · Input · Textarea · Select · Checkbox · Radio · Switch · Label · FormField · Badge · Avatar · Icon · Link · Divider · Skeleton · Spinner · Tooltip

**Composites:** Card · Modal · Drawer · Tabs · Dropdown / Menu · Accordion · Toast · Pagination · Table · Breadcrumb · Alert / Callout

**Layout:** AppShell · Navbar · Footer · Sidebar · PageHeader · Section · Container · Grid · Stack

**State:** EmptyState · LoadingState · ErrorState · NotFound · PermissionDenied

**Domain:** derived from this project's business — an entity card, a price display, a status indicator, a quantity control. Name these in **this project's** vocabulary, not the reference's.

Prohibited: `Button1`, `Button2`, `SpecialButton`, `ProductCardA`/`ProductCardB`, `NewModal`, `CardV2`.

## 8.2 API conventions

- Variants are props (`variant`, `size`, `tone`, `state`) — never separate components, never boolean prop explosions.
- Every variant enumerated in `components.md` must exist; no extras invented.
- Primitives are **business-agnostic**: no domain types, no API calls, no routing knowledge inside them.
- Domain components compose primitives; they may know domain types but not data fetching.
- Forward refs; pass through `className` and native element props; never swallow `aria-*` or `data-*`.
- Every interactive component is keyboard-operable and supports controlled/uncontrolled use where applicable.

## 8.3 Placement

```
src/components/ui/         primitives          (business-agnostic)
src/components/layout/     shells and chrome
src/components/patterns/   reusable composites (still business-agnostic)
src/features/<domain>/     domain components, hooks, adapters
src/styles/                tokens.extensions.*, global styles
```

Where the repository already has a convention, **the repository's convention wins**.

---

# 9. PAGE TEMPLATES

Use `design-system/page-templates.md` as the canonical structure for page composition.

Do not invent page layouts from scratch when an existing template can be adapted.

For each route:

1. identify the closest template
2. map business data into the template
3. preserve visual hierarchy
4. preserve spacing and layout behavior
5. adapt business-specific sections only where necessary — built from existing primitives, following the same rhythm
6. record the mapping in the route inventory

If **no** template plausibly fits a route, that is an escalation (§28.2), not a license to freestyle.

---

# 10. RESPONSIVE DESIGN

The desktop design is not sufficient. Reproduce the intended responsive behavior across **mobile · tablet · desktop · large desktop**.

Pay particular attention to: navigation collapse · grid transformations · card stacking · content width · typography scaling · button behavior · horizontal scrolling · table behavior (scroll vs. stack vs. priority columns — pick per the spec, then apply that choice consistently) · modal/drawer behavior · spacing reduction · image cropping · section ordering.

Do not simply shrink desktop CSS. The mobile composition must follow the design system's responsive rules.

**Verification requirements:**

- Test at **320 / 768 / 1280 / 1920** px, plus 200% browser zoom on desktop.
- No horizontal page scroll at any width from 320px upward.
- Touch targets ≥ 44×44 CSS px on touch tiers.
- Sticky or fixed chrome must not obscure content or form controls on short viewports.

---

# 11. BUSINESS LOGIC

Do not build a static mockup. The frontend must work with the existing application architecture.

Implement: real routing · real state · real forms · real validation · real loading states · real error states · real empty states · real API integration where available · real authentication state where available · real business actions.

Do not replace functional behavior with hardcoded fake interactions.

Do not invent backend endpoints that do not exist.

**Missing endpoints:** define a typed adapter interface in `src/features/<domain>/api/` and back it with a clearly marked mock implementation. The UI depends on the interface only — never on the mock's shape. Every mocked adapter is listed in `docs/implementation/mocked-adapters.md` with its expected contract, so nothing ships silently faked.

**Forms:** use the repository's existing form and validation library, schema-driven. Validation messages come from a shared message map, not inline strings. Validate on blur, re-validate on change after first error, block submit while invalid, show pending state during submission, map server errors to field level where possible with a form-level `Alert` fallback.

---

# 12. DATA

Do not hardcode business information throughout JSX. Create appropriate typed data structures.

```ts
// src/features/catalog/types.ts
export type ItemStatus = 'draft' | 'active' | 'paused' | 'archived';

export type Money = {
  amount: number;   // minor units — never floats for currency
  currency: string; // ISO 4217
};

export type Item = {
  id: string;
  name: string;
  slug: string;
  category: CategoryId;
  price: Money;
  status: ItemStatus;
  updatedAt: string; // ISO 8601
};
```

Rules:

- **Currency in minor units**, formatted at the render boundary by a single `Price` component. Never `toFixed` inline.
- **Dates as ISO strings** in data, formatted at the render boundary by a shared formatter.
- **Enums as string unions** with exhaustive `switch` handling — adding a status must fail type-check, not fail silently at runtime.
- Static content (nav items, categories, feature copy) lives in typed config modules, not scattered literals.
- No `any` in domain types. No unvalidated `as` casts on API responses.

Business data stays separated from presentation.

---

# 13. BRANDING

The project must use **this project's branding**.

Replace reference-site: logo · brand name · favicon · reference-specific colors · copy · product naming · business terminology · imagery · illustrations · promotional content.

However, do not casually change the underlying visual system defined by the design-system files.

- If a color belongs to the design system itself, use its token.
- If a color is clearly reference-brand-specific, adapt it to this project's brand tokens.

---

# 14. IP AND ASSET GUARDRAILS

The design system was reverse-engineered from a live third-party website. v1 never framed this as a constraint. It is one, and it is the highest-consequence section in this document.

| Prohibited | Permitted |
|---|---|
| The reference's logo, wordmark, or brand marks | This project's own brand assets |
| Reference imagery, illustrations, photography | Original or properly licensed assets |
| Reference marketing copy, taglines, microcopy | Copy written for this business |
| A proprietary or licensed icon set copied verbatim | An openly licensed icon set matched to the spec's sizing and stroke tokens |
| Distinctive trade dress that identifies the reference brand | Abstracted layout, spacing, type scale, grid, and interaction patterns |
| Font files used without a license | Fonts licensed for this project, or metric-compatible substitutes |

**Test:** if a decision only makes sense as *"so it looks like the reference brand,"* it is out of bounds. Raise it under §28.

You are implementing an **abstracted system of proportions and behaviors**, not cloning a specific site. Record any font, icon, or asset whose license you could not verify in the assumptions log.

---

# 15. DO NOT DO THESE THINGS

Never:

- redesign the application without being asked
- create a fashionable alternative UI
- introduce random gradients
- randomly change border radii
- randomly change spacing
- introduce arbitrary colors
- add animations merely because they look nice
- replace established components with unrelated UI
- duplicate components
- create arbitrary Tailwind values
- hardcode data inside reusable UI components
- break existing business logic for visual similarity
- delete working functionality merely to match the reference
- weaken or delete a test to make a migration pass
- create unnecessary dependencies
- create speculative abstractions that are not required
- ship a route with two visual languages visible on the same screen

Most importantly:

> Do not optimize for "looks similar."

Optimize for:

> **accurately implementing the reverse-engineered design system while expressing this application's own business.**

---

# 16. REQUIRED UI STATES

v1 mentioned states in four separate places without ever enumerating them. Every data-bound view implements all applicable states below, using the components from §8.1.

| State | Requirement |
|---|---|
| Loading | Skeleton matching the loaded layout's geometry — no layout shift on resolve. Never a bare spinner for a full-page load. |
| Empty | Explains *why* it is empty and offers the next action. Distinguish "no data yet" from "no results for this filter." |
| Error | Human-readable message with a retry affordance. No raw stack traces or status codes in the UI. |
| Permission denied | Distinct from error and from not-found. |
| Not found | Distinct from empty. |
| Partial / stale | If the stack supports background refetch, indicate staleness without blocking the view. |
| Success | Confirmation via toast or inline state, consistent across the application. |

---

# 17. VISUAL QA

Visual QA is **continuous**, not a final phase. Run it at the end of every route migration, not once at the end of the project — drift found after thirty screens is thirty screens of rework.

Check each page against `design-system/`. Verify: typography · spacing · colors · component dimensions · layout · hierarchy · responsive behavior · states · consistency between pages.

**Drift taxonomy** — look specifically for:

- button heights that differ between screens
- cards using inconsistent radius
- sections with inconsistent vertical spacing
- headings using off-scale font sizes
- inputs with different heights
- containers with different max widths
- inconsistently sized icons
- grids with inconsistent gaps
- similar components with subtly different internal padding
- one-off shadows or borders
- motion durations that vary between equivalent interactions

Fix these systematically, at the primitive layer. Fixing drift screen by screen recreates it.

---

# 18. ACCESSIBILITY

Do not sacrifice accessibility for visual fidelity. **Target: WCAG 2.2 Level AA.** This is an acceptance criterion, not an aspiration.

- **Semantics:** semantic HTML, correct landmarks, one `h1` per page, ordered heading levels, correct button vs. link usage, ARIA only where native semantics fall short.
- **Contrast:** 4.5:1 body text, 3:1 large text and meaningful UI boundaries. If a token pairing fails, log it under §28 — do not silently darken a token.
- **Focus:** visible `:focus-visible` on every interactive element using the design system's focus token. Never `outline: none` without a compliant replacement.
- **Keyboard:** full operability. Modals and drawers trap focus, close on `Esc`, and restore focus to the trigger. Menus and tabs follow standard arrow-key patterns.
- **Forms:** every control labelled; `aria-describedby` for hints and errors; `aria-invalid` on failed fields; errors associated programmatically, not just visually.
- **Live regions:** async results, toasts, and validation summaries announced politely.
- **Motion:** honor `prefers-reduced-motion`; disable non-essential transitions and parallax.
- **Images:** meaningful `alt`; decorative images `alt=""`.
- **Color:** never the sole carrier of meaning — pair status color with text or icon.
- **Touch targets:** ≥ 44×44 CSS px.

---

# 19. THEMING

`tokens.css` and `tokens.json` imply a themeable system. Implement it as one.

- Tokens are consumed as **CSS custom properties**, so themes swap without recompiling components.
- If the token set defines light and dark scales, implement both, including no-flash initial theme resolution and `color-scheme` on the root.
- If only one scheme is defined, structure the token layer so a second can be added without touching components, and note the gap in the audit.
- **No hardcoded color anywhere in component code.** Themeability is a hard requirement, not a preference.

---

# 20. PERFORMANCE BUDGETS

| Metric | Budget |
|---|---|
| LCP (mid-tier mobile, throttled) | ≤ 2.5s |
| CLS | ≤ 0.1 |
| INP | ≤ 200ms |
| Initial route JS (gzipped) | ≤ 200KB, or the repository's existing budget if stricter |
| Web fonts | ≤ 2 families, subset, `font-display: swap`, preloaded |

Practices: explicit `width`/`height` or `aspect-ratio` on every image · responsive `srcset` · modern formats · lazy-load below the fold · code-split heavy routes and modals · virtualize lists beyond ~100 rows · no layout-shifting skeleton-to-content transitions.

Visual fidelity does not justify blowing these budgets. A pixel-perfect page that fails LCP has failed.

---

# 21. CONTENT ROBUSTNESS

§2 mandates replacing all reference copy with this business's copy. That has layout consequences v1 never addressed.

1. **Length tolerance.** Every component must survive both a very short string and a roughly 3× longer one without breaking. Test with the longest realistic value, not lorem ipsum.
2. **Overflow strategy.** Decide per component — wrap, clamp, or truncate with tooltip — and apply it consistently. Text must never collide with adjacent elements.
3. **Placeholder copy.** Mark it with a single unambiguous convention (`TODO_COPY`) and list every instance in `docs/implementation/todo-copy.md`. Placeholder copy must never ship silently.
4. **Localization posture.** Even if single-language today: no string concatenation to build sentences, no text baked into images, no layout assuming English word lengths. If RTL is plausible, use logical CSS properties (`margin-inline-start`, not `margin-left`).
5. **Formatting.** Numbers, dates, and currency go through shared formatters with explicit locale — never ad hoc.

---

# 22. CODE QUALITY

Keep the codebase maintainable. Follow existing project conventions.

Use: TypeScript types · reusable components · composition · explicit variants · semantic HTML · accessible interactive elements · proper labels · proper focus states · loading/error/empty states.

Do not sacrifice maintainability for pixel matching.

---

# 23. TESTING AND VERIFICATION

Use the existing test stack. Do not modify tests merely to make them pass — fix the implementation. If a test encodes genuinely obsolete behavior, change it deliberately and record it in the final report.

For important user flows, verify: navigation · forms · validation · business actions · loading states · error states · empty states · component variants · responsive behavior where infrastructure allows.

**Verification matrix** — v1 stated a fidelity standard but gave no way to check it:

| Layer | Method | Gate |
|---|---|---|
| Tokens | Lint: no arbitrary values, no raw hex/px outside token files | CI blocking |
| Types | `tsc --noEmit` clean, no new `any` | CI blocking |
| Components | Isolated preview of every variant (Storybook if present, else a dev-only gallery route) | Phase gate |
| Visual | Screenshot diff of key routes at all four breakpoints if tooling exists; else the §17 drift checklist per route | Per route |
| A11y | Automated scan (axe or equivalent) + manual keyboard pass on every interactive flow | CI blocking + manual |
| Behavior | Existing suite passes; new tests for forms, validation, state transitions | CI blocking |
| Performance | Lighthouse or equivalent on the three highest-traffic routes | Before completion |
| Responsive | Manual pass at 320 / 768 / 1280 / 1920 plus 200% zoom | Per route |

---

# 24. EXECUTION STRATEGY

Each phase has a deliverable and an exit condition. Do not begin a phase before its predecessor's exit condition is met.

| Phase | Work | Deliverable | Exit condition |
|---|---|---|---|
| **1. Repository audit** | Understand the existing architecture | Sections A, B, E of `00-audit.md` | Stack stated; every route inventoried |
| **2. Design-system audit** | Read and understand all `design-system/` files | Section D of `00-audit.md` | Token coverage mapped; discrepancies logged |
| **3. Business mapping** | Map business requirements to design-system patterns | `business-adaptation.md` + Section C **[GATE]** | Every route has a template; every component has an action |
| **4. Foundation** | Token layer, Tailwind wiring, fonts, theme provider, lint rules | Token proof page | Every token reachable from app code; §7.3 lint active |
| **5. Layouts** | Shared layout, navigation, header, footer, containers, responsive structure | Layout components | Shells render at all four tiers |
| **6. Primitives** | Foundational UI components from §8.1 | Component gallery | Every variant in `components.md` exists and matches spec |
| **7. Pages** | Routes, simplest data-bound route first, then by descending importance | Migrated routes | **Each route passes §30.1 individually before the next begins** |
| **8. Business components** | Domain components built from primitives | Domain layer | No domain logic inside primitives |
| **9. Integration** | State, APIs, auth, forms, business actions | Wired application | No fake interactions remain; adapters registered |
| **10. Hardening** | Responsive, a11y, performance, remaining states | Fix list cleared | §23 matrix passes |
| **11. Final verification** | Full-suite regression and cross-page consistency | `99-verification.md` | §30.2 satisfied |

Two changes from v1's ordering, both deliberate:

- **Visual QA is not Phase 10.** It runs at the end of every route in Phase 7 (§17). Batching it to the end guarantees maximum rework.
- **Testing is not Phase 11.** Tests accompany each route. Phase 11 is regression, not first contact.

**Migration posture:** routes migrate one at a time. A route is "migrated" only when it satisfies §30.1. Never ship a state where two visual languages appear on one screen.

**Commit convention:** one route or one component group per commit; the message states scope and DoD status. Never mix a token change with a route migration in the same commit.

---

# 25. BEFORE EACH PAGE IMPLEMENTATION

Before implementing a page, determine:

- which page template it uses
- which components it uses
- which design tokens it uses
- which parts are reference-derived
- which parts are business-specific
- which existing application functionality must be preserved
- which of the §16 states apply
- what the longest realistic content is for each slot (§21.1)

Then implement. Do not create speculative architecture.

---

# 26. DESIGN SYSTEM CHANGE POLICY

The `design-system/` files are canonical. Two different problems get confused here; keep them separate.

## 26.1 Design-system **inconsistency** (the spec contradicts itself or is wrong)

Do not silently rewrite the spec to make implementation easier.

1. Identify the inconsistency precisely.
2. Determine whether it is a source-specification issue or an implementation issue.
3. **Prefer correcting the implementation.**
4. If the evidence genuinely points at the source: write the proposed change to `docs/implementation/deviations.md` with the evidence **before** editing anything, and edit only after that entry exists.
5. Any change must remain internally consistent across `foundations.md`, `components.md`, `page-templates.md`, `tokens.json`, `tokens.css`, and `tailwind.preset.js` — all six, in the same commit.

v1's phrasing ("only modify when there is strong evidence") left the agent as sole judge of its own evidence. Requiring a written proposal first is what makes this checkable.

## 26.2 Design-system **insufficiency** (the business needs a value the spec never defined)

This is a different problem and needs a different answer. A new semantic status color or a domain-specific density is not a spec error — it is a gap.

1. Do **not** edit `design-system/`.
2. Add the value to `src/styles/tokens.extensions.css` and `tokens.extensions.json`, named in the same convention as the source tokens.
3. Derive it from existing primitives where possible — a new status color drawn from the existing palette ramp, not a new hue invented ad hoc.
4. Record it in `docs/implementation/extensions.md` with justification.

Extensions are a controlled surface. If the file grows past roughly a dozen entries, stop and escalate — it means the mapping in §5.2C is wrong.

---

# 27. BUSINESS ADAPTATION LAYER

Create `design-system/business-adaptation.md` as the **semantic layer** on top of the visual system. This is where business meaning lives, so the visual spec never has to carry it.

```md
# Business Adaptation

## Brand
- Brand name:
- Logo:
- Favicon:
- Primary color (token):
- Secondary color (token):
- Voice and tone:

## Product / Service
- What we sell:
- Product categories:
- Pricing model:
- Currency and formatting rules:

## Customer
- Target customer:
- Customer journey:
- Authenticated vs. anonymous capabilities:

## Core Actions
- Primary CTA:
- Secondary CTA:
- Destructive actions and their confirmation pattern:
- Checkout / order flow:

## CTA Register
| Label | Action | Destination | Auth required | Button variant |
|---|---|---|---|---|

## Navigation
- Main navigation:
- Account navigation:
- Footer navigation:
- Mobile navigation behavior:

## Pages
- Home:
- Listing:
- Detail:
- Cart:
- Checkout:
- Account:
- Other:

## Terminology
| Reference term | Our business term | Notes |
|---|---|---|

## Entity States
| State | Meaning | Badge variant | User-visible label |
|---|---|---|---|

## Features
- Feature 1
- Feature 2
- Feature 3
```

Do not copy reference-site business semantics into the application merely because the visual component looks the same.

---

# 28. ASSUMPTIONS AND ESCALATION

v1 said "do not ask unnecessary questions" and "proceed unless genuinely blocking," but never defined what counts as blocking. That leaves the riskiest decisions to silent guesswork.

## 28.1 Decision procedure

1. **Derivable** from the repository or `design-system/`? → derive it, proceed, note the derivation.
2. **Low-risk and reversible?** → make the smallest reasonable assumption, tag it `ASSUMPTION:` in code, log it, proceed.
3. **High-risk, irreversible, or changes business meaning?** → **stop and escalate.**

## 28.2 Always escalate, never assume

- Pricing, tax, currency, or payment semantics
- Authentication, authorization, or data-visibility rules
- Legal, compliance, or consent copy
- Destructive actions (delete, cancel, refund) and their confirmation semantics
- Any route with no plausible template match (§9)
- Anything that would violate §14 (IP) or §18 (accessibility)
- More than roughly a dozen token extensions needed (§26.2)

## 28.3 Log format

Maintain `docs/implementation/assumptions.md`: date · question · decision or status · risk level · what would need to change if the assumption proves wrong.

---

# 29. DELIVERABLES

1. `docs/implementation/00-audit.md` — repository and design-system audit (§5.2)
2. `design-system/business-adaptation.md` — semantic layer (§27)
3. Working implementation, committed route by route
4. `docs/implementation/assumptions.md` — assumption and escalation log
5. `docs/implementation/deviations.md` — every departure from `design-system/`, with the business requirement that forced it
6. `docs/implementation/extensions.md` — token extensions with justification
7. `docs/implementation/mocked-adapters.md` — every adapter not backed by a real endpoint, with expected contract
8. `docs/implementation/todo-copy.md` — every placeholder string awaiting real copy
9. `docs/implementation/99-verification.md` — final results against §23 and §30

---

# 30. ACCEPTANCE CRITERIA

v1's checklist was largely unfalsifiable — "no obvious visual inconsistencies remain," "feels like one coherent product." Replaced with criteria that can actually be checked.

## 30.1 Route-level Definition of Done

A route is done when **all** of these hold:

- [ ] Composed from a template in `page-templates.md`; deviations logged
- [ ] Built only from §8.1 inventory components — no ad hoc markup duplicating an existing primitive
- [ ] Token lint passes: zero arbitrary values, zero raw hex or px
- [ ] All applicable §16 states implemented
- [ ] Wired to real routing, state, and validation; mocked data only behind a declared adapter
- [ ] Verified at 320 / 768 / 1280 / 1920 plus 200% zoom; no horizontal scroll from 320px
- [ ] Keyboard-operable end to end; focus visible; automated a11y scan clean
- [ ] Contrast verified on all text and meaningful boundaries
- [ ] Long-content and empty-content tolerance verified (§21.1)
- [ ] §17 drift checklist run against the primitive layer
- [ ] Types clean; no `any`; no unvalidated casts
- [ ] Existing tests pass; new tests added for new logic
- [ ] Placeholder copy tagged and listed
- [ ] Business terminology matches `business-adaptation.md`

## 30.2 Project-level completion

- [ ] Every in-scope route satisfies §30.1
- [ ] All §29 deliverables produced and current
- [ ] Full test suite green; no test weakened to achieve it
- [ ] Performance budgets (§20) met on the three highest-traffic routes
- [ ] Debt register resolved or explicitly deferred with an owner
- [ ] No unresolved §28.2 escalations
- [ ] No component duplication remains
- [ ] Reference-site semantics replaced everywhere they conflicted with this project's business
- [ ] No unlicensed or unverified asset shipped (§14)

---

# FINAL PRINCIPLE

> Reuse the reference site's **design language, visual grammar, component behavior, and layout patterns**, but make the **product, content, data, branding, terminology, and business flow** belong entirely to this application.

---

# Appendix A — Changes from v1

| v1 | v3 | Reason |
|---|---|---|
| §3 flat priority list | §3.1 authority split by question type, with tie-break | Prose docs and tokens answer different questions; the flat list ranked `components.md` above `tokens.json`, which inverts on value questions |
| §5 audit with "internal mapping" | §5.2 required artifact with fixed table schemas | An audit with no deliverable is unverifiable |
| §6 plan, then proceed | §6 plus **[GATE]** exit condition and §28.2 exceptions | "Unless genuinely blocking" was never defined |
| §7 and §14 both ban arbitrary values | §7.3 mechanical enforcement, lint + CI + allowlist | Unenforceable guidance is decoration |
| §8 component list | §8.1 expanded inventory + §8.2 API conventions + §8.3 placement | v1 named components but not their contracts |
| §11 adapter isolation | §11 plus mandatory adapter register | Nothing required listing what was faked |
| §12 `price: number` | §12 `Money` in minor units, ISO dates, exhaustive unions | Float currency is a correctness bug, not a style preference |
| §13 branding | §13 kept, plus **§14 IP guardrails** | v1 never framed reverse-engineering as a legal constraint — the largest gap in the document |
| States mentioned in §11, §17, §18, §23 | §16 single enumerated table | Four partial lists, no canonical one |
| §15 Visual QA as final phase | §17 continuous, run per route | Drift found after thirty screens is thirty screens of rework |
| §16 generic accessibility list | §18 WCAG 2.2 AA with contrast ratios, focus trap/restore, live regions, reduced-motion, zoom | v1 said "sufficient contrast" without a number |
| — | **§19 theming** | `tokens.css`/`tokens.json` imply theming; v1 never mentioned it |
| — | **§20 performance budgets** | Absent; pixel fidelity can silently destroy LCP |
| — | **§21 content robustness** | v1 mandated different copy but never addressed length, overflow, or placeholder tracking |
| §18 testing | §23 plus verification matrix with CI gates | v1 stated a fidelity standard with no method to check it |
| §19 eleven phases, no gates | §24 phases with deliverables and exit conditions; QA and testing moved continuous | Phases without exit criteria are a to-do list |
| §21 change policy | §26.1 tightened (written proposal before edit) + **§26.2 token extension mechanism** | v1 conflated "spec is wrong" with "spec is insufficient"; and left the agent as sole judge of its own evidence |
| §22 business-adaptation template | §27 expanded with CTA register, entity states, currency rules | Prevents four labels for one action |
| — | **§28 escalation protocol** | v1 said what not to ask, never what to do when genuinely blocked |
| — | **§29 deliverables** | No reporting surface defined |
| §23 fourteen subjective checkboxes | §30.1 route-level DoD + §30.2 project-level, both checkable | "Feels like one coherent product" cannot be verified |

---

# Appendix B — Quick reference

```
NEVER copy the reference's brand, copy, imagery, or licensed assets
NEVER use arbitrary values in application code
NEVER hardcode business data in JSX
NEVER invent backend endpoints
NEVER edit design-system/ without a written proposal first
NEVER weaken a test to make a migration pass
NEVER ship a route without its required states
NEVER optimize for "looks similar"

ALWAYS derive values from tokens
ALWAYS build one component per concept, with variants
ALWAYS wire real routing, state, and validation
ALWAYS run visual QA per route, not at the end
ALWAYS verify 320 / 768 / 1280 / 1920 and keyboard operation
ALWAYS log assumptions, deviations, extensions, mocks, and placeholder copy
ALWAYS escalate pricing, auth, legal, and destructive actions
```
