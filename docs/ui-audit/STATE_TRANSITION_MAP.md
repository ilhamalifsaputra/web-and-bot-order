# State transition map (spec section 5)

Read from code; not observed in a browser. "Now" reflects this branch.

| From | Event | Expected | Storefront now | Web admin now |
|---|---|---|---|---|
| Empty | User starts action | Loading, no duplicate | `Button pending` disables and sets `aria-busy`; idempotency keys on checkout, instant buy | Same; payment, wallet and broadcast mutations keyed |
| Loading | Backend confirms | Success from the response | Success cards gated by server status | Toast after the response; bulk counts from the response (ADM-H6) |
| Loading | Request fails | Error, input kept | Inputs kept; checkout freezes on an unknown outcome (SF-H1) | Inputs kept; page stays mounted (ADM-H3) |
| Loading | Threshold exceeded | Slow-network message | **Missing**: no timeout or threshold (SF-M3) | **Missing** (ADM-M3) |
| Slow network | Response arrives | Final result once | Same-key retry replays the stored answer | Same for keyed routes |
| Offline | Connection restored | Safe reconnect | **Risk**: paused mutations resume without a new tap (SF-M3) | **Risk** (ADM-M1) |
| Search | No match | Zero results, query kept | OK; overlay error blank (SF-M7) | OK; Clear Filters offered |
| Authenticated | Session invalid | Re-auth without loop | Checkout/cart: notice + login in new tab + continue (SF-H2); elsewhere redirect to `/login?next=` | Banner, Log in in a new tab, Reload; no redirect (ADM-H3) |
| Form invalid | Input corrected | Error updated | Mostly; guest email error lingers until submit (SF-L1) | Inline errors clear on edit |
| Authorized | Access rejected | Nothing forbidden opens | Recovery scope notice (SF-H5); 404 for ownership | Server 403; readonly projections (ADM-H1); client shows actions anyway (ADM-M6) |

## Additional checks

| Check | Result |
|---|---|
| No infinite loading | Fixed for first-load failures in both apps; remaining: no timeout (SF-M3, ADM-M3), Digiflazz SSE status (ADM-M15) |
| No success and error for one operation | Bulk outcomes now one kind each (ADM-H6); cancel truth (SF-H7) |
| No stale response over newer state | Query keys include filters; search debounced; possible cart focus-refetch overwrite (SF-L1, needs reproduction) |
| No transition loses a draft | Fixed for refetch failures and session expiry in admin and checkout; open: help-page ticket description (SF-M9), order-detail info edit after a 401 (SF-M11) |
| State recoverable after refresh/navigation | Checkout answers are memory only by owner rule (no sessionStorage); ticket composer draft persists |
| Race conditions and cancellation tested | Idempotency concurrency tests (wallet, broadcast); no client cancellation tests |
| Consistent across list, detail, dashboard | Not verified end to end |
