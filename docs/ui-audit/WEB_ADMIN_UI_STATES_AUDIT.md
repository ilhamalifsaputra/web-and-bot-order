# Web admin UI states audit

Static code trace of `apps/web-admin/client/src`, `apps/web-admin/src/routes`
and `plugins/auth.ts` at `2ebb5de0`. Nothing was run in a browser. Fixes are in
[FINDINGS.md](FINDINGS.md) (IDs `ADM-*`).

## Per-route state coverage

Before → now. Y present, P partial, N missing, ! the whole page was replaced
by an error on a background refetch (fixed by ADM-H3/ADM-M5 where marked).
Offline, request timeout and permission denied are missing on every route
(ADM-M1, ADM-M3, ADM-M6).

| Route | Empty | Loading | Error before → now | Zero search / clear | Validation | Success before → now |
|---|---|---|---|---|---|---|
| Dashboard `/` | Y | Y | Y per widget, no retry | n/a | n/a | n/a |
| Orders | Y | Y | ! → Y with filters kept | Y | P | false success → honest (ADM-H6), Deliver confirm (ADM-H5) |
| Order detail | Y | P text → skeleton | ! → Y | n/a | P post-dialog (ADM-M7) | N mostly (ADM-M7, Open) |
| Payments | Y | Y | ! → Y | P (q ignored for copy) | Y | bulk false → honest |
| Settlements | P | Y | P + empty (ADM-M4, Open) | P | server only | Y; replay (ADM-C2, Open) |
| Users | Y | Y | ! → Y | Y | Y | Y |
| User detail | Y | P → skeleton | ! → Y | n/a | server → confirm dialog | double-apply → once (ADM-C1) |
| Wallet ledger | Y | Y | P + empty (ADM-M4, Open) | P | n/a | n/a |
| Vouchers | Y | Y | ! → Y | not checked | not checked | bulk false → honest |
| Stock / stock product | Y | Y | ! → Y | Y | P | Y |
| Catalog / categories | Y | Y | Y retry | Y | Y | Y |
| Product/denomination create, edit | n/a | P infinite → fixed (ADM-M9) | P none on create (ADM-M12) | n/a | Y | Y |
| Digiflazz sync | Y | Y | error shown as empty → fixed (ADM-M14); SSE status (ADM-M15, Open) | n/a | n/a | Y |
| Flash sales | Y | Y | ! → Y | Y | not checked | not checked |
| Broadcast | Y | Y | ! → Y | n/a | Y | twice → once (ADM-H4) |
| Support / ticket | Y | Y | ! polling → Y | Y | Y | Y; assignees empty for support role (ADM-M8) |
| Tasks, Reviews | Y | Y | ! → Y | Y | not checked | Y |
| Audit | P | Y | P + empty (ADM-M4, Open) | P | n/a | n/a |
| Outbox, Reports, Branding, Storage | Y | Y | Y inline | P | n/a | Y |
| Search | Y | Y → skeleton | Y | Y | n/a | P back-trap (ADM-M10) |
| Admins | Y | Y | ! (not changed) | n/a | not checked | Y |
| Settings, Email notifications, Pricing | n/a | Y | Y | n/a | Y (not deep-audited) | Y |

Depth at audit time: orders, payments, wallet, tickets and session were traced
fully; Reviews, Tasks, Flash Sales, Settings and Pricing got a state-branch
scan only, so "not checked" cells are genuinely unaudited.

## Ten states, admin summary

| State | Result |
|---|---|
| Empty | `EmptyState` with entity icons on lists; empty no longer claimed on failed first load (ADM-M5); three pages still show error + empty (ADM-M4) |
| Loading | Skeletons, `LoadingRegion`, `Button pending`, one `RouteFallback` (LD-01) |
| Error | `QueryErrorNotice` / `QueryFailureGate`, Retry, ErrorBoundary keyed by path |
| Offline | Not handled (ADM-M1, ADM-M2, VIS-08) |
| Slow network | No timeout (ADM-M3); wallet/broadcast unknown outcomes worded (ADM-C1, ADM-H4) |
| Zero search results | Filtered vs first-time empty distinguished by copy and Clear Filters; page reset on filter change confirmed |
| Permission denied | Server enforces; readonly leaks closed (ADM-H1, ADM-H2); client has no role state (ADM-M6) |
| Session expiry | Central banner, drafts kept, no redirect loop (ADM-H3) |
| Form validation | Inline; wallet adjust disabled until readable (ADM-C1); reject/fulfil validated after the dialog (ADM-M7) |
| Success | Bulk outcomes honest (ADM-H6); order detail feedback thin (ADM-M7) |

## Checked and found OK at audit time

CSRF on every `/api` mutation; `canMutate` default-deny; SSE auth; masked
credentials with audited reveal; payment routes use `useIdempotentPost`; ticket
reply `request_id`; no redirect loop; malformed 2xx handled; page reset on
filter change and no stale overwrite on the listed pages; dashboard widgets
fail independently; ErrorBoundary keyed by pathname.
