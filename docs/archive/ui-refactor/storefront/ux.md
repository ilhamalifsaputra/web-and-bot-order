# General UX Recommendations

Cross-cutting observations that don't belong to one single page.

## Copy accuracy

- **STO-009 (Medium):** the cart's "You'll sign in with Telegram at checkout" line is simply inaccurate —
  this audit completed the entire authenticated journey via plain username/password registration, no
  Telegram involved. Any copy that names a specific mechanism as if it were the only one needs to be kept in
  sync with what auth methods actually exist; recommend a generic "Sign in to continue" instead.
- **STO-014 (Low):** register page helper text ("lowercase letters, numbers, underscores") doesn't match the
  actual `pattern` attribute (which accepts uppercase).

## Forms

- **STO-015 (Low):** no password field anywhere (login, register, settings) has a show/hide toggle. Small
  addition, meaningfully reduces failed-submit frustration, especially on mobile where retyping a password
  is more error-prone.
- Good: every tested form (register, login, support ticket, checkout voucher) uses a real associated
  `<label>`, and buttons show an inline spinner + `disabled` state while their mutation is pending (confirmed
  in source across Login/Register/Checkout — a `data-submit-once`-style double-submit guard is applied
  consistently).

## Confirmations / toasts

- **STO-020 (Low):** creating a support ticket gives no toast — the only feedback is a new row appearing in
  a table below the form, easy to miss on a longer ticket history.
- **STO-016 (Low):** Orders/Reviews empty states have good specific copy but no follow-up CTA button, leaving
  the customer to self-navigate back to browsing.

## Empty states (general)

Across the app, empty-state copy is consistently good and specific — never a bare "No X" — matching the
audit brief's own example almost exactly in most places (search: "Nothing found — try another keyword.",
orders: "No orders yet — your purchases will show up here.", support: "No support tickets yet."). The one
consistent gap is the missing actionable button/link alongside that copy (STO-016 for orders/reviews,
STO-012 for the checkout payment-methods empty state).

## Third-party integration leakage

- **STO-013 (Low):** the Telegram Login widget, when its domain isn't authorized, renders its own raw
  English error text ("Bot domain invalid") in an unstyled serif font inside an otherwise fully-themed card.
  This is a third-party UI leaking into the storefront's design system with zero app-level handling.

## What's already working well (worth protecting, not changing)

- Auth-gate redirect preserves both destination (`?next=`) and cart contents across a full register/login
  round-trip — a real strength, not a paper cut.
- Live quantity/subtotal recalculation in the cart is instant and correct.
- FAQ accordion, FAQ content, and the testimonials-hidden-when-empty pattern are all sound, honest UX
  choices (no fabricated social proof).
- No Telegram-send-from-web violations were observed anywhere in the storefront during this audit — all
  Telegram-related surfaces (bot link, Telegram Login widget, "see the bot for your balance") are either
  outbound links to the bot or client-side widget embeds, never a server-side send from the storefront
  itself, consistent with the project's CLAUDE.md constraint.
