# Web Admin UI/UX Audit — Phase 1 (Audit & Document Only)

**Date:** 2026-07-14
**Scope:** `apps/web-admin` React SPA dashboard (`apps/web-admin/client`), served by the Fastify backend at `apps/web-admin/src`.
**Constraint:** Audit and document only — no application source code was modified. The only writes in this phase are under `docs/ui-refactor/`.

## How the app was run

The repo's shared dev database (`data/bot.db`) already contains a real admin account
(Telegram ID `5840513237`) with a live password hash set in the `Setting` table
(`web_admin_password_hash:5840513237`). That credential belongs to the project owner
and was **not** touched, reset, or reused — modifying or reading around it was
correctly refused by the permission system, and re-using it would have required
guessing a real password.

Instead, this audit ran against a **separate, disposable SQLite database**, so the
real dev data and the real admin credential were never at risk:

```bash
# 1. One-time: push the schema to a fresh, empty SQLite file
DATABASE_URL_PRISMA="file:C:/Users/ilham/Documents/web-and-bot-order/.audit-data/audit.db" \
  npx prisma db push --skip-generate

# 2. Start web-admin against that DB, on a different port than any already-running
#    instance (port 8000 was occupied by what looked like the user's own dev server —
#    left untouched), with a throwaway ADMIN_IDS allow-list and cookie secret:
DATABASE_URL_PRISMA="file:C:/Users/ilham/Documents/web-and-bot-order/.audit-data/audit.db" \
  ADMIN_IDS="99999999" \
  WEB_COOKIE_SECRET="<32+ char random hex, generated fresh for this run>" \
  WEB_COOKIE_SECURE="false" \
  WEB_PORT="8010" \
  pnpm dev:web
```

The client SPA build under `apps/web-admin/static/dashboard-app/` was already
present and newer than the working-tree source changes, so no rebuild was needed
(verify with `pnpm --filter @app/web-admin-client build` if source under
`apps/web-admin/client/` has changed since).

The fresh DB had **no seed data and no admin account**, which routed the very first
request to the app's own first-run **Setup Wizard** (`/setup` → `/setup/owner` →
`/setup/shop` → `/setup/done`), not the older `/bootstrap` page. The owner account
(Telegram ID `99999999`, username `ui_audit_admin`) was created entirely through
that in-app wizard UI — no direct DB writes, no password reset script. This
also meant the wizard itself got audited as a byproduct (screenshots
`setup-wizard-step1/2/3-desktop.png`, `setup-wizard-done-desktop.png`).

To exercise populated tables/detail pages/empty-vs-non-empty states, a small amount
of realistic data was created **through the app's own forms**: one category
("Streaming"), one product ("Netflix Premium"), one denomination ("1 Month",
50000). No orders/payments/tickets/reviews exist in this DB — those pages were
audited in their empty state only (see `responsive.md` / `findings.md` for what
that means for coverage).

**For phase 2:** restart with the same two commands above (the audit DB and
generated cookie secret are not committed; regenerate `WEB_COOKIE_SECRET` with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` if the
`.audit-data/audit.db` file was deleted, or reuse it if still present to keep the
seeded product/denomination/owner account).

## What was covered

- **Every route** in `apps/web-admin/client/src/App.tsx`: Dashboard, Orders,
  Catalog (+ product create, product detail, denomination create), Stock (+ stock
  detail), Customers/Users (+ detail), Vouchers, Admins, Payments, Outbox, Reports,
  Reviews, Audit Log, Broadcast, Support, Settings (+ inline edit), Branding,
  Search, Login, Forgot Password, Setup Wizard (all 4 steps), 404/NotFound.
- **Interactions**: sidebar nav (all items), topbar search modal (`Ctrl+K`), quick
  actions dropdown, user avatar dropdown, status filter dropdowns, inline
  category-create, product/denomination create forms (validation + disabled
  states), voucher inline-create form, admin inline-add row, invalid login
  submission, logout (both entry points — see Finding F-002).
- **Viewports**: Desktop 1440×900 (full crawl), Tablet 768×1024 (Dashboard incl.
  drawer-open state, Orders), Mobile 375×812 (Dashboard, Orders, Catalog, Stock,
  Settings, Product Detail, nav-closed topbar state).
- **Not reachable in this DB**: Order Detail, Ticket Detail, and any table's
  populated-row interactions (sort/paginate a >1-row table) for Orders, Payments,
  Reviews, Support, Reports, Outbox — there is no order/payment/ticket/review data
  in this fresh DB and none of these are creatable from the admin UI itself
  (orders originate from the bot/storefront). These are flagged as **coverage
  gaps** in `findings.md` / `responsive.md`, not asserted as bug-free.

## Findings summary

See `findings.md` for the full list (IDs `F-001`…`F-018`) and `report.json` for
the machine-readable version. Rough counts: 2 Critical, 5 High, 7 Medium, 4 Low.

## Documents in this folder

- `overview.md` — this file.
- `findings.md` — full finding list with severity, screenshots, current/expected
  behavior, recommendation, implementation notes.
- `navigation.md` — sidebar/IA simplification analysis.
- `ux.md` — cross-cutting UX recommendations.
- `responsive.md` — per-viewport, per-page responsive notes.
- `accessibility.md` — a11y findings (contrast, headings, labels, focus, keyboard).
- `design-system.md` — component inconsistencies with file references.
- `before-after.md` — structure only; filled in during phase 2 implementation.
- `report.json` — machine-readable findings.
- `implementation-plan.md` — phase 2 execution plan, grouped by priority, with
  target files and out-of-scope flags.
- `screenshots/` — all screenshots captured during the crawl.
