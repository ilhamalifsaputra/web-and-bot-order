# Implementation deviations & design-system inconsistency log

Per FRONTEND_IMPLEMENTATION_PROMPT §26.1: when the implementation and the
design-system spec disagree, or when a recommended approach can't be followed
exactly, the deviation is recorded here **before** the code/spec change is made.

---

## A1 — Tailwind `@theme` block kept as a literal mirror, not `var()` forwards (Task 3, Part A)

**Context.** Task 3 single-sources every storefront design-token value into
`apps/storefront/client/src/styles/tokens.css` (`--gg-*` set + legacy short-name
aliases). The brief's recommended approach also rewrote the Tailwind v4
`@theme static` block in `apps/storefront/client/src/index.css` to reference
those values via `var()` (`--color-pine: var(--gg-pine)` etc.).

**Deviation.** The `@theme` block is **left as literal hex / font-stack /
box-shadow values**, exactly as before this task, now with a
`values mirror src/styles/tokens.css — keep in sync` note. The brief's own
fallback clause ("If `@tailwindcss/vite` … or the built CSS output changes vs.
baseline, revert only this block to literal values … and record the limitation
here. Try the `var()` version first.") — the `var()` version was tried first
and rejected on evidence.

**Why.** Tailwind v4 (4.3.1) does not *error* on `var()` in `@theme`, but it
only pre-resolves a token when it can read the literal value at build time.
With a `var()` value the built CSS changes in two ways that alter computed
style:

1. **Opacity-modified colour utilities lose their alpha.** Baseline emits
   `.bg-card\/90{background-color:#ffffffe6}` (pre-blended). With
   `--color-card: var(--gg-card)` Tailwind cannot compute the blend, so it
   drops the modifier — `.bg-card,.bg-card\/90{background-color:var(--color-card)}`
   renders `bg-card/90` fully opaque. Same for `bg-ink/5`, `bg-pine-tint/30`,
   `bg-amberx-tint/60`, `bg-grass/10`, `border-amberx/30`, `border-grass/30`,
   `border-grass/40`, `border-rust/30`, `border-rust/40` — all of which appear
   in the storefront's compiled CSS, i.e. are in use.
2. **`shadow-soft` / `shadow-lift` lose the `--tw-shadow-color` recolour
   channel** (`--tw-shadow:0 1px 2px var(--tw-shadow-color,#1018280a),…` →
   `--tw-shadow:var(--gg-shadow-soft)`). Bare computed value is unchanged and
   the storefront never recolours a shadow, but it is still a build-output
   change.

**Net effect on single-sourcing.** `tokens.css` is the single source for the
plain-CSS `app.css` component layer (its `:root` block was deleted; `.card` /
`.btn` / `.field` / `.chip` now read `--pine` / `--r-lg` / … as `var()`
forwards to `--gg-*`). The `@theme` block remains a second hand-maintained
copy of the ~23 colour/font/shadow values — unchanged from before the task,
but now explicitly labelled as a mirror with the canonical file named.
Eliminating that copy needs a Tailwind-side fix (or a build step that inlines
tokens.css into `@theme`) and is out of scope here.

**Files.** `apps/storefront/client/src/index.css` (`@theme` block + header
comment).

---

## A2 — literal `:root` token block retained in the build-free error shell (Task 3, Part A)

**Context.** `apps/storefront/static/app.css`'s `:root { --paper … }` token
block was removed (moved to `src/styles/tokens.css`). `app.css` is normally
pulled into the SPA bundle via `index.css`'s `@import`, so the tokens travel
with it.

**Deviation.** `apps/storefront/src/lib/spaFallback.ts`'s `staticFallbackHtml()`
— the hand-written last-resort page served only when the built `index.html`
can't be read (fresh clone before `pnpm build`, or a corrupt `dist`) — links
`/static/app.css` **standalone**, without the SPA bundle CSS. It therefore
never sees `src/styles/tokens.css`. A small literal `:root` block (the 25
legacy-name aliases, values copied from `tokens.css`) is now inlined as a
`<style>` in that shell's `<head>` so `.card` / `.btn` / `.wait-dot` keep
rendering there.

**Why not another option.** Serving `tokens.css` as a second static file would
re-introduce exactly the two-copies-kept-in-sync-by-comment drift this task
removes. The inline block is scoped to this one build-free shell, is the only
deliberate duplicate, and carries a keep-in-sync comment.

**Impact: none.** The normal SPA path and the normal error/404/503 shell path
(which read the built `index.html`) are unaffected; only the zero-build
last-resort page uses this inline block, and it renders exactly as before.

**Files.** `apps/storefront/src/lib/spaFallback.ts`.

---

## B1 — stale `font-size` `base` token in the design-system spec (Task 3, Part B)

Type: §26.1 design-system source-spec inconsistency (spec is wrong; the app's
shipped CSS is right). **Proposal written before the spec edit, per §26.1.**

**The inconsistency.** The design system carries two contradictory
representations of the `base` font size:

| File | Current `base` | Correct? |
|---|---|---|
| `gogogo-frontend/design-system/tokens.json:64` | `"base": "14px"` (flat, no responsive step) | **stale** |
| `gogogo-frontend/design-system/tokens.css:95` | `--gg-text-base: 0.875rem; /* 14px — buttons, field text (desktop) */` | **stale** — folds the mobile 16px into `--gg-text-md` under a different name and loses the responsive pairing |
| `gogogo-frontend/design-system/tailwind.preset.js:40-41` | `base: ['16px', …]` + `'base-desktop': ['14px', …]` | correct |

**Evidence** (Task 1 audit §D3, `00-audit.md:247-279`):

- Ground truth, `apps/storefront/static/app.css:120-125`:
  ```css
  /* 16px on small screens is not a style choice: Safari on iOS zooms the whole
     viewport in when a focused input's text is smaller than that … */
  .field { … font-size: 1rem; /* 16px */ … }
  @media (min-width: 640px) { .field { font-size: .875rem; } /* 14px */ }
  ```
- The audit's verdict: "`tokens.json`/`tokens.css`'s flat `base = 14px` is the
  stale entry. It silently drops the mobile-first 16px value and the
  accessibility rationale behind it (iOS Safari auto-zoom-on-focus
  prevention). `tailwind.preset.js`'s `base` (16px) + `base-desktop` (14px)
  pair is the accurate representation, matching `app.css` exactly."

**Which of the six canonical files are already correct** (checked, not assumed):

| File | State | Action |
|---|---|---|
| `foundations.md` | §3 typography table already says "Body — Manrope, 16px … mobile field text is 16px on purpose … desktop fields drop to 14px from 640px up" and "Button label — 14px/600" | none |
| `components.md` | "Text field" already says "Text: 16px on mobile (prevents iOS Safari's auto-zoom-on-focus), 14px from 640px up" | none |
| `page-templates.md` | §7 legal pages say "Body 16px/1.5 Manrope"; no `base`-token claim to correct | none |
| `tailwind.preset.js` | `base: 16px` + `base-desktop: 14px` already correct | none |
| `tokens.json` | `fontSize.base` is the flat stale `14px` | **edit** |
| `tokens.css` | `--gg-text-base` is the stale `0.875rem` | **edit** |

The three prose files and `tailwind.preset.js` already agree with `app.css`;
only the two token files disagree, and they disagree with the other four, not
with each other about anything deeper. No wider spec inconsistency found.

**Proposed change** (mirror `tailwind.preset.js`'s `base` / `base-desktop`
split; leave `md` = 16px untouched, exactly as `tailwind.preset.js` keeps both
`base` and `md` at 16px):

- `tokens.json` — `fontSize.base` → `"16px"`, add `"base-desktop": "14px"`.
- `tokens.css` — `--gg-text-base` → `1rem` (16px, mobile-first, iOS-zoom-safe),
  add sibling `--gg-text-base-desktop: 0.875rem` (14px, ≥640px); update the
  inline comments.
- `apps/storefront/client/src/styles/tokens.css` — the app's own copy of the
  `--gg-*` set (added in Part A) gets the identical edit in the same commit, so
  the app token file and the spec stay byte-identical.

**Impact on the app: none.** `--gg-text-base` is not referenced anywhere in
`apps/storefront` or `packages/web-ui` — the `.field` / `.btn` font sizes in
`app.css` are literal (`1rem` / `.875rem`), and Tailwind's `text-base` utility
is Tailwind core's own `--text-base`, unrelated to `--gg-text-base`. This
corrects the spec to match already-shipped behaviour; it changes no computed
value.

**Files.** `gogogo-frontend/design-system/tokens.json`,
`gogogo-frontend/design-system/tokens.css`,
`apps/storefront/client/src/styles/tokens.css`.
