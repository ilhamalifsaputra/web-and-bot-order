# Auth and session audit

## Web admin

| Check | Result |
|---|---|
| Authorization enforced on the server | Yes: `currentAdmin`, `roleGate`, `requireSuper`, `blockReadonlyReads`, `canMutate` default-deny (`apps/web-admin/src/plugins/auth.ts`) |
| Readonly cannot read what the order route refuses | Fixed: ticket detail, recentOrders, order list, user detail and payments lists use typed allow-lists (`lib/readonlyOrders.ts`, ADM-H1); export and ticket photos blocked (ADM-H2) |
| Frontend permission as UX only | The SPA has no role knowledge; all buttons show (ADM-M6, Open) |
| 401 handled centrally, no redirect loop | Yes: one flag, one banner, no redirect, no retry (ADM-H3) |
| Draft kept on expiry | Yes: pages stay mounted; Log in opens a new tab |
| Return URL after login | Admin login has no return-to; the banner avoids needing it |
| CSRF | Every `/api` mutation; POST /logout has none (ADM-L1) |
| Multi-tab | Re-login in another tab leaves a stale CSRF token: clear reload message |

## Storefront

| Check | Result |
|---|---|
| Session expiry at checkout | Notice, Log in in a new tab, explicit continue; answers kept in memory, nothing written to storage (SF-H2, owner rule on sensitive data) |
| Session expiry on cart | Additive `signed_in` detects it; guest-checkout sessions are not "signed in" |
| Order-recovery scoped session | Additive `order_scope`; notice with View order and Log out (SF-H5) |
| Return URL | Server `safeNext` covers `//`, backslash, control characters |
| Logout | Full reload clears query cache and CSRF meta; server rotates the session id; no onError (SF-L1) |
| Stale CSRF | Adopted from the checkout GET only (SF-M6) |
| Sensitive data in storage | Checkout draft storage removed (2d5ae303); ticket drafts and recent searches stay in localStorage after logout (SF-L1) |

## Data protection follow-up

`Order.customerData` (buyer checkout answers) is stored as plaintext
(`packages/db/src/crud/orders.ts` ~942-975, also ~1263-1292 and ~3512).
The owner rule of 2026-11-01 says sensitive data must be protected
(credentialCrypto). Open as SEC-01, for a separate branch.
