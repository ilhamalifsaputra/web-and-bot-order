# Design-token extensions (spec §26.2)

Values the running storefront needs that the design-system spec
(`gogogo-frontend/design-system/tokens.css` → `apps/storefront/client/src/styles/tokens.css`)
does not define. Each is a reviewed, scoped exception recorded here and
implemented in `apps/storefront/client/src/styles/tokens.extensions.css`
(value) + the `@theme` block in `apps/storefront/client/src/index.css`
(Tailwind utility name).

This is not a second token source. Prefer promoting a stable extension into the
real spec over letting the file grow. Anything added here must first be checked
against every existing `--gg-*` token for a fit.

| Token | Value | Scope | Why it exists | Added |
|---|---|---|---|---|
| `--gg-grass-dark-aa` (`text-grass-dark-aa`) | `#157e3b` | `StockBadge` "in stock" pill foreground only | The shared `--gg-grass-dark` (`#15803d`) on `--gg-grass-tint` measures **4.49:1** — 0.01 short of WCAG AA (4.5:1) for the pill's `text-xs`. This marginally darker green clears AA (~4.55:1) with no perceptible hue shift. Must not replace `--gg-grass-dark` where the shared success green is used (StatusBadge, ProductCard, money deltas). Previously hard-coded as the arbitrary class `text-[#157e3b]`; moved to a token when the §7.3 ESLint gate (Task 4) banned raw hex in `.tsx`. | Task 4 (2026-09) |
| `--gg-radius-xl` (`rounded-3xl`) | `1.5rem` (24px) | Full-bleed **marketing bands** only — the dark hero, the pine "Our Promise" band, the hero loading-skeleton, and `AuthBrandPanel`'s pine panel | The project's radius scale (`tokens.css` §5) is deliberately small and tops out at `--gg-radius-lg` (16px), the **content-card** radius (`.card`). A band spanning the full content width needs a larger corner to read as proportional; 24px is that step. Must not be used for content cards, buttons, fields or icon wells. Mirrored as `--radius-3xl` (not `--radius-xl`) in the `@theme` block: overriding Tailwind v4 core's `--radius-xl` (`0.75rem`) would silently re-radius ~33 existing `rounded-xl` call sites storefront-wide; core's `--radius-3xl` is coincidentally already `1.5rem`, so the mirror pins that value and ties the `rounded-3xl` class to this documented exception with no computed-style change. See `deviations.md` §D2-radius. | Task 9 (2026-09) |
| `--gg-text-2xs` (`text-2xs`) | `0.625rem` (10px) | `Badge` `discount` / `savings` variant label; `TicketMessageThread` avatar initial (Task 17) | `components.md` "Badge & chip" specifies **~10px/700** for the Discount and Savings badges. The design-system type scale (`tokens.css` §TYPOGRAPHY) bottoms out at `--gg-text-xs` (`0.75rem` / 12px), 2px above the spec, and the Task 4 ESLint gate bans `text-[10px]` (px arbitrary value), so there is no in-scale way to reach it. This is the single 10px step. Scoped to those Badge variants and the single-letter chat-avatar initial (Task 17 replaced its off-scale `text-[11px]` with this) — must not replace `--gg-text-xs` where the shared 12px chip size is used. Mirrored as `--text-2xs` in the `@theme` block of `index.css` to generate the `text-2xs` utility (Tailwind v4 has no built-in `2xs`). | Task 6a (2026-09); consumer added Task 17 |
| `--gg-plum` / `--gg-plum-tint` (`text-plum` / `bg-plum-tint`) | `#6d28d9` / `#f1ebfe` | The `Badge` `attention` variant only, whose single consumer is `TicketStatusBadge`'s `waiting_customer` ("Waiting for you") bucket on `/help` | The palette (`tokens.css` §1) has no purple and does not need one for anything else — pine carries "informational", amberx "waiting", grass "done", rust "failed". `/help` is the first surface where a fifth chip meaning exists: its status filter pills expose **"waiting for you" as its own filter with its own count** (`SupportTicketStats.waiting_for_you`, served by `getUserTicketStats`). Reusing any of the four existing tones would make the filter and the list contradict each other — filter to "Waiting for you" and every row reads "In progress". Contrast `#6d28d9` on `#f1ebfe` is ~7.1:1, clearing AA for the chip's small text. Must not introduce purple anywhere else without first promoting it into the real palette. Mirrored as `--color-plum` / `--color-plum-tint` in the `@theme` block of `index.css`. | `/help` (2026-09) |

## Component-pattern exceptions (no design-system template)

Not token-value extensions — cases where `components.md` has **no template**
for a component the app needs, so its treatment is composed from existing
tokens/primitives and recorded here instead.

| Component | Basis | Why it exists | Added |
|---|---|---|---|
| `Modal` / `AlertDialog` (`components/ui/`) | Visual: `Card` (white `.card` surface, `radius-lg`, `shadow-*`) + an `ink/45` scrim. A11y: the `MobileDrawer` (Task 5) dialog contract — `role="dialog"`/`alertdialog` + `aria-modal`, focus trap, Esc, scrim-click, body scroll-lock with scrollbar compensation, focus restore, `createPortal` to `document.body`, `prefers-reduced-motion` via the app-wide `<MotionConfig>` — extracted to `components/ui/useDialogA11y.ts` and shared by both. | The reverse-engineered storefront barely used modals, so `components.md` has no "Modal" section. No new token or off-token value is introduced; styling is entirely existing token utilities + the `.card` class. `MobileDrawer` keeps its own inline copy of the a11y logic (already-reviewed Task 5 code) — the hook only de-duplicates the two new dialog primitives. | Task 7b (2026-09) |
| Ticket chat/thread — `TicketMessageThread` (`components/shop/`) | `components.md` has **no template** for a message-bubble timeline. Derived entirely from existing tokens/primitives: each bubble is a `<Card>` surface (`.card` fill, `radius-lg`, `shadow-soft`, `card-pad` 20→24px); the customer bubble adds the `pine-tint/30` tint and `ml-auto`, the support bubble `mr-auto`, system events are centered `text-xs ink-faint`; the avatar is a 24px `pine` (customer) / `sand` (support) circle; the date-group divider is a `bg-line` hairline rule with an `ink-faint` `text-xs` label; timestamps are `text-xs ink-faint`; message text keeps `text-sm whitespace-pre-line break-words`. **No new hue, no new radius, no new shadow.** The one off-scale value — the `text-[11px]` avatar initial — is now the `text-2xs` utility (`--gg-text-2xs`, 0.625rem, Task 6a extension row above), which removed this file's entry from the ESLint Group-B `text-[11px]` allowlist (`apps/storefront/client/eslint.config.js`). Task 1 marked this component `build`; it was in fact already a token-composed `refactor`/`adopt`, so it was refactored onto the `<Card>` primitive in place, not rebuilt, and the bubble geometry (customer right/tinted, support left/neutral, system centered, date-group dividers) is byte-unchanged. Not a §28.2 escalation — no pricing / auth / legal / destructive semantics. | Task 17 (2026-09) |

## Considered but NOT extended

- **Mobile nav-drawer scrim** — was `bg-[rgba(15,23,42,0.35)]` in `Layout.tsx`.
  Resolved with the existing `--gg-ink` token via Tailwind's opacity modifier
  (`bg-ink/35`), not a new token. The audit (§D2) had floated a named
  `ink/35` alpha token; the opacity modifier makes it unnecessary.
- **Telegram contact card** — was `bg-[#eff6ff]` / `text-[#2563eb]` in
  `HomePage.tsx`. `#2563eb` is exactly `--gg-pine`; the sibling contact cards
  already use `bg-pine-tint` / `text-pine`. Fixed by making the card
  consistent, no new value.
