# API error handling

How each failure reaches the UI on this branch. Clients:
`apps/web-admin/client/src/api/client.ts` and
`apps/storefront/client/src/api/client.ts`.

| Condition | Web admin | Storefront |
|---|---|---|
| 400 / 422 | `{ error, error_args }` mapped by `describeError` / `errorMessages.ts`; inline or toast | `humanError` / `tError` with locale keys; raw strings can leak for unknown keys (SF-M8) |
| 401 | Sets the session-expired flag (banner), still throws so inputs stay; queries do not retry (ADM-H3) | Pages with a redirect go to `/login?next=`; checkout and cart show a session notice (SF-H2); other mutations generic (SF-M11) |
| 403 (role, text body) | "You don't have permission to do this. Ask a super admin if you need access." (f848a5ef); no role-aware UI (ADM-M6) | Ownership uses 404; `PermissionDeniedState` unused |
| 403 `csrf_failed` | "Reload this page" message, carries status 403 (25d91357) | Checkout adopts a fresh token from its GET; elsewhere stuck until reload (SF-M6) |
| 404 | Page-level not-found states on detail pages; Edit Denomination fixed (ADM-M9) | `ErrorPage` / `NotFoundState` on detail pages |
| 409 idempotency in progress / key reused | Copy exists; key held for in-progress | Checkout treats in-progress as unanswered, key_reused as inconclusive (SF-H1); two keys lack copy (SF-L1) |
| 409 quote changed | n/a | Checkout re-prices; voucher re-price failure silent (SF-M5) |
| 429 | Bulk dismiss stops at the first 429 (ADM-H6); retry hook keeps the key | Checkout treats a retry 429 as inconclusive |
| 5xx | Unknown-outcome copy on wallet and broadcast; Retry on queries | Unknown-outcome on checkout and cancel; Retry on queries |
| Network failure | Unknown outcome on keyed mutations; query Retry | Same; upload onerror split into offline vs storage-blocked (UPL-02) |
| Timeout | **None** (ADM-M3) | **None** (SF-M3); uploads have a 120 s XHR timeout |
| Malformed 2xx | `parseJsonOrThrow` | Idempotency hook keeps the key when the body cannot be read (2d5ae303) |
| Render error | ErrorBoundary keyed by path, now `role="alert"` | Root + per-route ErrorBoundary, one guarded stale-chunk reload (SF-H6) |

## Retry rules

- Admin queries: no retry on 401/403, default 3 otherwise (`api/queryClient.ts`).
- Mutations are never retried automatically. A same-key retry is offered only
  where the server dedupes: payments, wallet adjustment, broadcast (admin);
  checkout, instant buy (storefront).
- Settlements deliberately have no key (ADM-C2).

## Safe error text

Storefront `ErrorState` never receives the error object. Admin
`describeError` maps keys to copy; bulk panels have copy for every key the bulk
routes send (e1ff9c49). Remaining raw strings: storefront `tError` fallback
(SF-M8), two admin pages with raw i18n keys (ADM-L1).
