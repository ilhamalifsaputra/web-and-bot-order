# UI states audit (Storefront and Web Admin)

Audit of the ten core UI states, the admin ticket attachment upload, and the
visual state standard, run on branch `worktree-ui-states-audit` (base
`2ebb5de0`, 2026-10-31 to 2026-11-02). Scope follows the owner's spec,
"Trustance Core UI States & Interaction Reliability Audit", revised scope A–G:
Storefront and Web Admin only. The Telegram bot is out of scope.

## Read first

| Document | What it holds |
|---|---|
| [FINDINGS.md](FINDINGS.md) | Every finding in the spec template, with status and commit |
| [report.json](report.json) | The same findings, machine readable (spec section 11 schema) |
| [TICKET_ATTACHMENT_UPLOAD_INVESTIGATION.md](TICKET_ATTACHMENT_UPLOAD_INVESTIGATION.md) | P0: why admin uploads failed (R2 CORS), acceptance matrix |
| [REPOSITORY_DISCOVERY.md](REPOSITORY_DISCOVERY.md) | Stack, entry points, route inventory |
| [STOREFRONT_UI_STATES_AUDIT.md](STOREFRONT_UI_STATES_AUDIT.md) | Storefront per-route state coverage, before and after |
| [WEB_ADMIN_UI_STATES_AUDIT.md](WEB_ADMIN_UI_STATES_AUDIT.md) | Web admin per-route state coverage, before and after |
| [STATE_TRANSITION_MAP.md](STATE_TRANSITION_MAP.md) | Spec section 5 transitions, per surface |
| [API_ERROR_HANDLING.md](API_ERROR_HANDLING.md) | How each HTTP status and network failure reaches the UI |
| [AUTH_SESSION_AUDIT.md](AUTH_SESSION_AUDIT.md) | 401/403, session expiry, CSRF, readonly role |
| [VISUAL_STATE_DESIGN_AUDIT.md](VISUAL_STATE_DESIGN_AUDIT.md) | Spec section D: icons, tones, motion |
| [ACCESSIBILITY_RESPONSIVE_AUDIT.md](ACCESSIBILITY_RESPONSIVE_AUDIT.md) | Roles, live regions, focus, viewports |
| [TEST_COVERAGE.md](TEST_COVERAGE.md) | Tests added and what was and was not run |

## Status in one paragraph

65 findings: 24 Fixed (commits and targeted tests), 5 Verified (Fixed and also
exercised in a real browser), 35 Open with recommendations, and 1 Not Tested:
the admin ticket upload after the owner's R2 CORS change (UPL-01, awaiting the
owner). The audits themselves were static code traces; "Needs reproduction" in
a finding means the result depends on runtime behaviour nobody observed.

**Browser verification (2026-11-02, HEAD `e3ddb406`).** Six scenarios ran in
headless Chromium against built bundles with dummy data in a disposable
Postgres schema (dropped afterwards): admin first-load 502 on Orders keeps the
search box and recovers on Retry (ADM-M5); admin 401 plus window-focus refetch
on Edit Denomination keeps the typed value, shows exactly one session banner
(ADM-H3); a storefront checkout whose response was dropped leaves exactly one
order and one debit, shows the unknown-outcome notice with no Place order
button, and the same-key retry opens that order (SF-H1); a storefront
`/account/orders` 500 shows the error, not a skeleton (SF-H3); an aborted lazy
chunk shows the boundary fallback with the header intact (SF-H6). The
reload-once-per-window guard for a stale deploy was **not** exercised there.
Limits: headless Chromium, dummy data, one viewport, no screen reader, no R2,
no real payment gateway. Everything not listed stays Fixed (code and tests
only), Open or Not Tested.

**Full gate at `e3ddb406`:** `pnpm doctor:full` 0/0, `doctor:bugs` clean,
`pnpm typecheck` exit 0, pretest checks exit 0, full vitest 715 files /
13,823 tests with 1 failure: `packages/outbox-dispatcher/src/dispatcher.test.ts`
"still sends the ORDER_DELIVERED_DM when the flush hook hangs past its bound",
a timing test under load in a file this branch does not touch; re-run alone it
passes 101/101. The former finding TEST-01 ("full suite not run") was removed
because it was a gate item, not a defect, and the gate has now run.

## Decisions the owner still owns

- **Settlement replay (ADM-C2):** `apps/web-admin/src/routes/api/settlements.ts:26-32`
  deliberately has no Idempotency-Key. Not changed. Decide whether a same-key
  replay should collapse.
- **`Order.customerData` plaintext (SEC-01):** stored verbatim
  (`packages/db/src/crud/orders.ts` ~942-975). The owner rule of 2026-11-01 says
  sensitive data must be protected. Needs its own branch (data migration).
- **Admin upload acceptance (UPL-01):** confirm one image and one MP4 from the
  admin ticket screen after the CORS change, then one customer upload.
- Unknown-outcome guest replay (SF-M10) and wallet adjustment throttling (ADM-L3).

## Out-of-branch follow-ups

Open Medium/Low items from both audits (ADM-M1..M15 open ones, SF-M2..M11,
SF-L1, SF-L2, VIS-08..VIS-11), the DigiflazzSync SSE status that can skeleton
forever (ADM-M15), .

## Source material

Findings come from the two static audits run at the start of the branch
(storefront and web admin), the per-task implementation reports and reviews,
the upload investigation with the owner, and `git log master..HEAD`. No domain,
secret, token, signed URL or customer data is reproduced here; origins are
written as `https://shop.<shop-domain>` and `https://admin.<shop-domain>`.
