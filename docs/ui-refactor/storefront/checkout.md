# Checkout

Screenshots: `screenshots/checkout-step1-desktop.png`, `screenshots/checkout-voucher-error-desktop.png`,
`screenshots/checkout-voucher-error-mobile.png`

## Steps and structure

Checkout is a single page (not a multi-step wizard) with a 3-node stepper for orientation (Cart / Payment /
Done) — this is a reasonable, low-friction structure (one page beats a multi-page wizard for a short form
like this) and matches "reduce checkout friction" guidance well structurally.

## Form usability / required fields

- Per-unit additional-info fields ("Email" for this product's `manual_with_info` delivery) render
  correctly, are clearly labelled ("Unit N of M"), and are individually required.
- **STO-010 (Medium):** no "same for all units" shortcut exists — buying quantity 3 means typing the same
  email three times if the customer is buying multiples for themselves (a very common case for this kind of
  product). Recommend a one-click "copy to all" affordance.
- Discount/voucher input has a proper associated label ("Have a discount code?") and correctly triggers on
  both Enter and the "Apply" button (confirmed via source: `onVoucherKeyDown` intercepts Enter).

## Validation and error handling

- **STO-005 (Medium):** applying an invalid voucher code correctly shows "Voucher code not found.", but on
  the desktop/laptop two-column layout the message renders in the right-hand Summary column — far from the
  input in the left column. It only reads correctly by coincidence on the mobile single-column stack. This
  is the clearest, most reproducible checkout bug found and should be an easy, contained fix (move one block
  in `CheckoutPage.tsx`).
- "Place order & pay" is correctly disabled while no valid payment method is selected — confirmed this
  holds even after filling every required order-detail field, so the gating logic itself is sound.

## Payment selection

- **Environment blocker:** "No payment methods are available right now. Please check back soon or contact
  support." — no gateway is configured in this instance. This is not a UI defect, but:
  - **STO-012 (Low):** "contact support" should be a link, not plain text — cheap, high-value fix for this
    exact empty state regardless of when payment methods return.
- Payment method radio options (QRIS, USDT/NOWPayments, IDR wallet, USDT wallet) are all conditionally
  rendered based on availability/sufficiency (`CheckoutPage.tsx` lines ~360-430) — sound design, avoids
  showing a payment path the customer cannot actually complete (e.g. wallet options only appear when the
  wallet balance covers the total outright, never as a partial-payment offer, per the code's own comment).

## Mobile experience

Checkout was re-tested at 375x812 (`screenshots/checkout-voucher-error-mobile.png`): the two-column desktop
layout correctly stacks to Order details -> Payment -> Discount code -> (voucher error, correctly
adjacent here) -> Summary. No overlapping elements, no horizontal scroll, inputs are full-width and
comfortably tappable. This is a well-executed responsive stack.

## Recommendation summary

1. Fix STO-005 (voucher error placement) — small, contained, clear win.
2. Add STO-012 (link "contact support") while touching this area.
3. Add STO-010 ("same for all units") as a checkout conversion/friction improvement.
4. Operationally: get at least one payment method configured so checkout can be verified end-to-end in this
   environment (outside this audit's scope to do directly).
