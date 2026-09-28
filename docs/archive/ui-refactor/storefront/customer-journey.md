# Customer Journey Walkthrough

Landing -> Browse -> Search -> Filter -> Product -> Cart/Buy -> Checkout -> Payment -> Confirmation,
as actually driven end-to-end during this audit with a fresh throwaway account.

## 1. Landing (`/`)

Hero loads clean: kicker badge ("Warranty · Fast · Secure"), a clear H1 ("Digital products, delivered
instantly"), a one-line value prop, two CTAs ("Browse products", "Contact support"), and four trust
chips. Good above-the-fold clarity for a niche digital-goods shop.

- **Friction:** below the hero, every section is scroll-revealed (opacity 0 until scrolled into view) —
  invisible on first paint if you don't scroll (STO-006). Not something a real scrolling visitor notices,
  but it does mean a first full-page capture, print, or non-JS crawler sees a mostly blank page after the
  hero.
- **Friction:** tabbing to the hero CTAs shows no visible keyboard focus ring (STO-003) — keyboard users
  cannot tell which button is about to activate.

## 2. Browse products

Clicking "Browse products" anchors to `#produk` ("Latest products"), and "Find your service" links to the
one live category card ("Premium Apps"). The category page (`/c/premium-apps`) lists the single product.

- **Friction:** the product card shows a red "Out of stock" badge (STO-001) — a first-time visitor
  reasonably concludes there is nothing to buy and bounces here, even though the product is actually
  purchasable (confirmed later in this same journey).
- **Gap:** no sort/filter/pagination controls exist on the category page (STO-007) — not a problem with one
  product, but there is no scaffolding for when that changes.

## 3. Search products

Searching "capcut" from the header search box returns the one matching product with a correct
`Results for "capcut"` heading. Searching a nonsense term returns a clean, actionable empty state
("Nothing found — try another keyword." + "Back to home").

- **Bug:** the browser tab title for any `/search` URL always reads "Search products… — Trustance"
  regardless of the query (STO-017) — cosmetic, but visible in every browser tab/history entry/bookmark.

## 4. Filter products

No filter UI exists on Category or Search (STO-007) — this step of the canonical journey has nothing to
test yet in this build.

## 5. Open product / View details (`/p/capcut-pro-1-month`)

Clean breadcrumb (Home / Premium Apps / Capcut Pro 1 Month), single product image, two selectable plans
("1 Month", "1 month preorder") both priced identically, a live price readout, quantity stepper, and two
CTAs ("Add to cart", "Buy now"). Reviews section correctly shows "No reviews yet."

- **Contradiction:** despite the listing card's "Out of stock" badge, both plans on this page are fully
  selectable and purchasable with no in-page stock warning at all (STO-001 root cause: the page's own
  `purchasable()` helper already treats non-auto delivery as always buyable — the badge upstream just never
  learned that rule).
- **Gap:** no description, specs, image gallery, or related-products section exists (STO-011).

## 6. Add to Cart / Buy Now

Clicking "Add to cart" added the item and redirected straight to `/cart` (no toast on the product page
itself — the cart page becoming the confirmation is an acceptable pattern, but it does mean there's no
"added to cart" toast if you're re-adding from a product page while already mid-review of the cart).

Cart page (`/cart`):
- Correct 3-step stepper (Cart / Payment / Done), line item with image, live-editable quantity (tested:
  1 -> 3, subtotal recalculated live from Rp15.000 to Rp45.000 correctly), remove button, and a Summary
  card with subtotal + "Continue to payment".
- **Friction:** no "Continue shopping" link anywhere on this page (STO-008).
- **Friction:** copy says "You'll sign in with Telegram at checkout" (STO-009) — inaccurate given the
  password login used throughout this very journey.

## 7. Checkout gate (sign-in)

Clicking "Continue to payment" while signed out correctly redirects to `/login?next=/checkout`, preserving
the destination. Registering a new account (username/email/password, no Telegram/OTP needed) redirects
straight back into `/checkout` with the cart intact — this part of the flow works well and is a genuine
strength: the auth gate does not lose cart state or force a restart.

## 8. Checkout (`/checkout`)

- Order-details: one repeated "Email" field per unit (STO-010) since the product used
  `manual_with_info` delivery and quantity was 3 at this point in the audit.
- Payment: "No payment methods are available right now. Please check back soon or contact support." — an
  environment limitation (no gateway configured), not a code bug, but the "contact support" phrase should
  be a link (STO-012).
- Discount code: applying an invalid code correctly surfaces "Voucher code not found.", but the message
  renders in the right-hand Summary column, disconnected from the input in the left column on desktop
  (STO-005) — verified this is fine on the stacked mobile layout.
- "Place order & pay" stays correctly disabled throughout (filling all three email fields did not enable it
  while no payment method is selectable) — the button's gating logic is behaving correctly given the
  environment.

## 9. Payment / Confirmation

**Not reachable in this environment** — no payment methods are configured, so this leg of the journey could
not be exercised. Per the audit brief, checkout testing was scoped to stop at "picking a payment method",
which is exactly where this build stops customers today.

## Post-purchase account surfaces (tested independently of a completed order)

- `/account` — dashboard shows order count (0), referral code, IDR/USDT wallet balances (Rp0 / 0.0000 USDT),
  and quick links. **Bug:** "Signed in as" shows a blank name (STO-002).
- `/account/orders` — clean, specific empty state, no CTA button (STO-016).
- `/account/referral` — code + shareable Telegram deep-link + copy button; balance deferred to the bot
  (STO-019).
- `/account/reviews` — clean empty state.
- `/account/support` — created a real ticket end-to-end (form -> table row -> detail page -> reply box);
  works well, but no success toast on creation (STO-020).
- `/account/settings` — username/email/password form pre-filled correctly; Telegram-link widget shows a raw,
  unstyled "Bot domain invalid" error (STO-013, environment-dependent).

## Overall journey verdict

The functional backbone of the journey (browse -> cart -> auth-gated checkout -> voucher/errors) is
solid and mostly well-engineered — cart state survives the login detour, quantity/subtotal math is live and
correct, and empty/error states are generally present with real copy rather than generic placeholders. The
issues found are concentrated in **cross-referencing gaps between the listing layer and the product-detail
layer** (STO-001), **one missing account field** (STO-002), and a handful of **polish-level friction points**
(STO-005, STO-008, STO-009, STO-010) rather than structural flow breakage.
