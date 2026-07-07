# Backend Audit Prompt — Data, Money, Security, Logging

Use this as a standing brief when auditing this project's backend: Prisma
data layer, core money/logging/config utilities, the Fastify route layer's
data-handling and security behavior, and the notification outbox pipeline.
Audit only — do not change business/data logic until findings are
reviewed and prioritized with the user.

## Ground rules
- Report findings as a prioritized list (Critical / High / Medium / Low),
  each with: location (`file:line`), what's wrong, concrete impact (data
  corruption, financial discrepancy, security exposure, ops blind spot),
  and a suggested fix.
- A prior security audit exists at `docs/audit-security-2026-06-23.md` —
  check whether its findings were actually fixed before re-flagging them;
  don't re-derive what it already covered from scratch.
- Cite the specific `CLAUDE.md` convention a finding violates rather than
  proposing a new convention.
- This is a shared-SQLite, single-writer system by design (see
  `docs/DATABASE.md`) — don't flag "should use Postgres" as a finding on
  its own; only flag concrete write-contention or long-transaction issues.

## 1. Money and financial correctness
- Every money value must flow through `packages/core/src/money.ts`
  (Decimal) — grep for raw `Number`/`float` arithmetic on prices, balances,
  wallet credits, or FX conversions (`packages/core/src/fx.ts`) and flag
  any that bypass Decimal.
- Check `packages/db/src/crud/wallet*.ts`, `pricing.ts`, `orders.ts`,
  `reconciliation.test.ts` / the `diag-reconcile-drift` tool's output for
  unit mismatches (e.g. the recent USDT wallet-credit unit bug) — verify
  currency/unit is consistent at every boundary a value crosses.
- Verify voucher/discount math (`vouchers.ts`, `bulk_pricing.test.ts`)
  can't produce negative totals or double-apply.

## 2. Data integrity & transactions
- **No raw SQL in routes/handlers** — mutations should go through
  `packages/db/src/crud/*`, not inline Prisma raw queries in
  `apps/*/src/routes/*`. Flag any route file that reaches into the DB
  directly.
- Every `$transaction` should be short (single-writer SQLite) — flag any
  transaction that does slow work (network calls, file I/O, loops over
  large datasets) inside the transaction body instead of before/after it.
- Check `packages/db/src/crud/integrity.ts` and `stock_deduction.test.ts`
  for race conditions in stock/credential allocation (two orders racing
  for the same unit).
- UTC-in-DB / local-on-display: verify `datetime.ts` (`localize`) and the
  web `localdt` filter are used consistently — flag any place a raw UTC
  timestamp is shown to a user, or a user-local time is stored without
  conversion.

## 3. Security
- **CSRF** — every mutating route in `apps/web-admin`/`apps/storefront`
  must use the `csrfProtect` preHandler; check newer route files weren't
  added without it (the happy/auth-fail/bad-csrf test trio should exist
  per route).
- **Settings whitelist** — confirm `apps/web-admin`'s settings-edit
  whitelist wasn't silently widened; this is the main "don't brick the
  bot" guardrail per `CLAUDE.md`.
- **Storefront auth** (`apps/storefront/src/auth.ts`) — this is the public
  untrusted surface; check password hashing (`packages/core/src/
  password.ts`), forgot/reset-password token expiry and single-use
  enforcement, and rate limiting or lack thereof on login/register.
- **Secrets** — grep logger calls and audit-log `details` strings for
  credentials, payment-proof `file_id`, password hashes, or full DB URLs
  being logged; check `web_secret.ts`/`webauth.ts` for how tokens are
  generated and stored.
- **Telegram-from-web boundary** — confirm nothing in `apps/web-admin` or
  `apps/storefront` calls the Telegram API directly; all outbound
  notifications must enqueue to `notification_outbox` and be delivered by
  `packages/outbox-dispatcher`.

## 4. Outbox / notification delivery
- `packages/outbox-dispatcher/src/dispatcher.ts` — check retry/backoff
  behavior on delivery failure, at-least-once vs. at-most-once guarantees,
  and whether a stuck/failed row can block the queue indefinitely.
- `templates.ts` — verify templates pull from `packages/core/locales/
  {en,id}.json` (no hardcoded English) and don't interpolate unbounded
  user input into a Telegram message.

## 5. Logging & auditability
- **Audit log** (`logAdminAction`) — `details` must read as a natural-
  language sentence per `docs/LOGGING.md`, not `key=value` shorthand;
  every admin state-change should call it with the acting admin id.
- **Pino logs** — full English sentences, no bare abbreviations, no
  truncated id/name lists (should summarize by count instead); warn/error
  logs should explain why it matters or what's next.
- Check for state changes (order status transitions, stock adjustments,
  wallet credits) that skip the audit log entirely.

## 6. Schema & deploy discipline
- Check `prisma/migrations/*` are additive/backward-compatible where
  possible; flag any migration that would need the DB migrated and
  order-bot restarted in a specific order to avoid `P2022`, per
  `CLAUDE.md`'s deploy note, and confirm `docs/MIGRATIONS.md` /
  `docs/ROLLBACK.md` reflect the actual current process.

## Output format
For each of the 6 areas above, produce:
1. A prioritized findings list (per the ground rules above).
2. A short "systemic patterns" summary — issues worth fixing once across
   many files rather than file-by-file.
