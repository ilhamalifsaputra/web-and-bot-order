# Storefront UI states audit

Static code trace of `apps/storefront/client/src` and the storefront routes it
calls, at `2ebb5de0`. Nothing was run in a browser. Fixes on this branch are
listed with their findings in [FINDINGS.md](FINDINGS.md) (IDs `SF-*`).

No Critical finding: no double charge, no client-driven status change, no open
redirect was found.

## Per-route state coverage

"Before" is the audit at `2ebb5de0`; "Now" is this branch. Key: OK handled,
Weak partial, SK endless skeleton, BL blank, SIL silent, n/a not applicable,
? not read. Offline and slow-network are not handled anywhere (SF-M3), so that
column is the same everywhere and is shown once.

| Route | Empty | Loading | Query error before → now | 401 / expiry before → now | Validation | Success before → now |
|---|---|---|---|---|---|---|
| Home `/` | Weak | OK | SK → OK (SF-H3) | n/a | n/a | n/a |
| `/products`, `/categories`, `/flash` | OK | OK | SK → OK (SF-H3) | n/a | n/a | n/a |
| `/c/:slug` | ? | ? | OK | n/a | n/a | n/a |
| `/g/:slug` | OK | OK | OK | n/a | n/a | n/a |
| `/p/:slug` + InstantBuy | ? | OK | OK | ? | OK | OK |
| `/cart` | false-empty → OK | OK | SK → OK | false-empty → session notice (SF-H2) | SIL (SF-M4, Open) | OK |
| `/checkout` | OK | OK | Weak, no retry (SF-L1) | wrong email error → session notice (SF-H2) | OK | lost response → unknown-outcome notice (SF-H1) |
| Pay (order, top-up) | n/a | OK | OK; poll SIL (SF-M2, Open) | OK | n/a | false cancel → honest (SF-H7, SF-M1) |
| `/wallet/topup` | OK | OK | Weak | Weak (SF-M11, Open) | OK | OK |
| `/track` | n/a | OK | OK | n/a | OK | OK; scoped session → notice (SF-H5) |
| `/account` | ? | OK | SK → OK | OK | n/a | Weak (copy claim, SF-L1) |
| `/account/orders` | OK | OK | SK → OK | OK | n/a | n/a |
| `/account/orders/:code` | n/a | OK | BL → OK (SF-H4) | OK | OK | OK |
| `/account/support/:id` | OK | OK | BL → OK (SF-H4) | Weak | OK | OK |
| `/help` | OK | OK, skeleton | OK | Weak, draft lost (SF-M9, Open) | silent busy block (SF-L2, Open) | OK |
| `/account/settings` | n/a | BL → skeleton | BL → OK | OK | ? | OK |
| `/account/referral`, `/account/reviews` | ? | OK | SK → OK | OK | ? | ? |
| Search overlay | OK | OK | blank (SF-M7, Open) | n/a | n/a | n/a |
| Any route, render throw / stale chunk | — | — | white page → boundary (SF-H6) | — | — | — |

Not audited in depth: Register, Forgot, Reset, Contact, static pages, UI gallery.

## Ten states, storefront summary

| State | Result |
|---|---|
| Empty | `EmptyState` everywhere, with an action; false-empty cart on session loss fixed |
| Loading | Labelled skeleton live regions, `Button pending`, one `RouteFallback` (LD-01) |
| Error | `LoadFailedState` / `RefreshFailedNotice` / `loadFailureView`, ErrorBoundary; raw strings remain (SF-M8) |
| Offline | Not handled (SF-M3, VIS-08) |
| Slow network | No timeout (SF-M3); checkout unknown outcome handled (SF-H1) |
| Zero search results | Correct when data is empty; overlay error blank (SF-M7) |
| Permission denied | App uses 404 for ownership; `PermissionDeniedState` unused (VIS-09); recovery scope notice (SF-H5) |
| Session expiry | Checkout and cart handled (SF-H2); other mutations generic (SF-M11), stale CSRF outside checkout (SF-M6) |
| Form validation | Inline errors preserved on failure; guest email error lingers (SF-L1) |
| Success | Gated by server state; cancel truth fixed (SF-H7) |

## Checked and found OK at audit time

Double submit (checkout, instant buy, top-up, track, cart lines, ticket
forms); idempotency key lifecycle; quote binding with `expected_total`; no
client-advanced status; no pending-as-success; SSE only invalidates; open
redirect protection (`safeNext`); logout clears cache by full reload; ticket
composer draft autosave; search staleness keyed by debounced term; track
errors distinct.

## Still open from this audit

SF-M2 to SF-M11 (except SF-M1, fixed), SF-L1 (the ten Low items), SF-L2. See
[FINDINGS.md](FINDINGS.md).
