# Owner Email Notifications — Implementation Plan

Spec: `docs/superpowers/specs/2026-08-06-owner-email-notifications-design.md`

## Global Constraints

Binding on every task. Copied from `.claude/CLAUDE.md` and the spec.

**Money & data**
- All money is `Decimal` from `@app/core/money`, never `float`/`number`. Outbox payloads carry money as `.toString()`.
- No raw SQL in routes/handlers. DB access goes through helpers in `packages/db/src/crud/*`, covered by colocated Vitest `*.test.ts`.
- UTC in the DB; `TIMEZONE` only on display.
- Shared SQLite is single-writer — keep each `$transaction` short.

**Never**
- Never send Telegram from the web (admin or storefront) — enqueue to `notification_outbox`; the notifier/bot delivers.
- Never log secrets: credentials, payment-proof `file_id`, password hashes, full DB URLs.
- **Never put the order code in an email subject.** `packages/core/src/mailer.ts:29-40` logs every subject, and the order code is half the guest `/track` credential. Subjects stay generic; the code goes in the body.
- Never interpolate a truncated/sliced id or name list into a log string — summarise by count.

**Logging**
- Pino logs (`packages/core/src/logger.ts`) are for developers/ops: English, full sentences, enough context to judge significance without reading surrounding code. For warn/error, say why it matters or what happens next. Spell out internal abbreviations (no bare `cb`/`cmd`/`idx`/`tx`).
- Audit log (`logAdminAction`) is read by shop admins, not developers: `details` is a short natural-language sentence, never `key=value` shorthand. See `docs/LOGGING.md`.
- Structured metadata (the object arg) is exempt from the sentence convention — only the message string follows it.

**Tests**
- `pnpm typecheck` and `pnpm test` must stay green. Add tests with each behaviour change; prefer crud-level unit tests for logic.
- There is **no per-package `test` script** — `pnpm --filter <pkg> test` exits 0 running nothing. Use `pnpm exec vitest run <path>` from the repo root.
- Baseline in this worktree: 3553 passing, plus **one known pre-existing environmental failure**, `apps/web-admin/test/storage-api.test.ts > dbBytes`, which needs a real `data/bot.db` that a worktree does not have. That single failure is expected — do not try to fix it, and do not treat it as caused by your change.

**Naming**
- The four new events are `OWNER_EMAIL_ORDER_PAID`, `OWNER_EMAIL_MANUAL_ORDER_QUEUED`, `OWNER_EMAIL_NEW_TICKET`, `OWNER_EMAIL_TICKET_REPLY`.
- The six new settings keys are `owner_email`, `owner_email_enabled`, `owner_email_on_paid_order`, `owner_email_on_manual_queue`, `owner_email_on_new_ticket`, `owner_email_on_ticket_reply`.
- The channel column values are the strings `TELEGRAM` and `EMAIL`.

Follow the surrounding code's comment density and idiom. This codebase writes substantial explanatory comments on non-obvious decisions — match that, and explain *why*, not *what*.

---

## Task 1: Schema + enums foundation

Add the `channel` column and the new enum values. Nothing consumes them yet.

**`prisma/schema.prisma`** — in `model NotificationOutbox` (~:761), add:

```prisma
channel String @default("TELEGRAM") @map("channel")
```

Add a doc-comment in the style of the surrounding fields explaining that transport is explicit row data (the dispatcher previously inferred DM-vs-channel from the event name via `ADMIN_DM_EVENTS`, which has no notion of a second transport), and that the default keeps every existing row and every existing `enqueue*` call working untouched.

**`packages/core/src/enums.ts`** — add next to `NotificationStatus`:

```ts
export const NotificationChannel = {
  TELEGRAM: "TELEGRAM",
  EMAIL: "EMAIL",
} as const;
export type NotificationChannel =
  (typeof NotificationChannel)[keyof typeof NotificationChannel];
export const zNotificationChannel = z.nativeEnum(NotificationChannel);
```

Match the exact export shape of the neighbouring enums (const object + type + `z.nativeEnum`).

Add the four `OWNER_EMAIL_*` values to `NotificationEvent` (~:273), each with a doc-comment in the same style as the existing entries — say who receives it, over which transport, what triggers it, and what the payload carries. Note in each that these are EMAIL-channel events with a `to` in the payload rather than a `chat_id`.

**Then run `pnpm prisma generate`** so the client picks up `channel`.

**Verify:** `pnpm typecheck` passes; `pnpm exec vitest run packages/core/src/` passes.

---

## Task 2: Owner-email settings resolver

**New file `packages/db/src/crud/ownerEmail.ts`.** Follow the structure and comment style of the sibling `packages/db/src/crud/smtp.ts` — exported key constants, a resolver returning `null` when unconfigured.

```ts
export const OWNER_EMAIL_KEY = "owner_email";
export const OWNER_EMAIL_ENABLED_KEY = "owner_email_enabled";
// ...one per-event key

export type OwnerEmailEvent =
  | "paid_order" | "manual_queue" | "new_ticket" | "ticket_reply";

export async function resolveOwnerEmailRecipient(
  db: Db, event: OwnerEmailEvent,
): Promise<string | null>
```

Returns the trimmed address, or `null` when: the master toggle is off, that event's toggle is off, the address is blank, or the address fails a plain-email regex. `null` means "do not enqueue" — the feature is inert until configured, the same way `getSmtpCreds` returning `null` leaves the forgot-password mail off today.

Read settings via `getSetting` from `./settings`. Toggles are stored as the strings `"true"`/`"false"`; treat a missing/blank toggle value as **off** so the feature never starts mailing on upgrade without the owner opting in. Use the same `.toLowerCase() === "true"` parse `smtp.ts:48` uses.

Export the new symbols from `packages/db/src/index.ts` alongside the other crud re-exports.

**Tests — `packages/db/src/crud/ownerEmail.test.ts`** (write first, TDD). Follow the setup style of neighbouring crud tests (`tests/helpers/testdb.ts`, `resetDb`). Cover: master toggle off → `null`; master on but the per-event toggle off → `null`; blank address → `null`; malformed address → `null`; everything set → the trimmed address; whitespace around the address is trimmed; each of the four events reads its own toggle independently.

Note `getSetting` caches for 30s per `Db` instance — use `__clearSettingsCacheForTests` if a test mutates a setting it already read.

**Verify:** `pnpm exec vitest run packages/db/src/crud/ownerEmail.test.ts`.

---

## Task 3: Enqueue helpers

**`packages/db/src/crud/notifications.ts`** — add an internal `enqueueOwnerEmail(db, event, orderId, payload)` plus four exported wrappers, following the shape and doc-comment depth of `enqueueManualOrderAdminAlert` (:146):

- `enqueueOwnerOrderPaidEmail(db, { orderId, orderCode, total, currency, itemCount })`
- `enqueueOwnerManualQueueEmail(db, { orderId, orderCode, items, total, currency })`
- `enqueueOwnerNewTicketEmail(db, { ticketId, userId, category?, message })`
- `enqueueOwnerTicketReplyEmail(db, { ticketId, userId, message })`

`enqueueOwnerEmail` calls `resolveOwnerEmailRecipient` and returns early on `null` (no row written at all), otherwise writes one row with `channel: "EMAIL"` and `payloadJson` carrying `to` plus the display fields.

Money is `Decimal.toString()`, never `number`. Truncate free-text (`message`) to a sane length in the payload the way `enqueueOrderPipelineFailed` does with `reason.slice(0, 300)` — the outbox table is admin-visible, and an unbounded customer-authored message does not belong in it at full length. Ticket rows have no order, so pass `orderId: null`.

Called with the caller's `tx`, so the row lands atomically with the state change that triggered it.

**Tests** — extend `packages/db/src/crud/notifications.test.ts`. Cover: writes `channel="EMAIL"` and the exact payload; writes **no row at all** when the resolver returns `null`; `Decimal` is serialised as a string, not a number; ticket events write `orderId: null`; long messages are truncated.

**Verify:** `pnpm exec vitest run packages/db/src/crud/notifications.test.ts`.

---

## Task 4: Ticket triggers

Hook the CRUD layer, not the four routes — both the storefront and the bot create tickets, so enqueueing inside `packages/db/src/crud/support.ts` covers every call site at once and cannot drift.

- `createTicket` (:9) becomes `async` and enqueues `OWNER_EMAIL_NEW_TICKET` for the ticket it just created.
- `addTicketMessage` (:201) enqueues `OWNER_EMAIL_TICKET_REPLY` **only when `args.senderType === SenderType.USER`**. An admin's own reply must never mail the owner — this is the single most important behavioural detail in the task.

Update every call site for the now-`async` `createTicket`: `apps/storefront/src/routes/apiAccount.ts:304`, `apps/order-bot/src/conversations/support.ts:144`, and any others `grep -rn "createTicket" apps packages --include=*.ts` finds. `addTicketMessage` is already `async`; confirm its callers await it (`apiAccount.ts:335`, `conversations/customer.ts:74`, `web-admin/src/routes/api/support.ts:291`).

**Tests** — extend the support crud tests. Cover: `createTicket` enqueues one `EMAIL` row when configured and none when the toggle is off; `addTicketMessage` with `senderType: USER` enqueues; `addTicketMessage` with `senderType: ADMIN` enqueues **nothing**; the payload carries the ticket id.

**Verify:** `pnpm exec vitest run packages/db/src/crud/` and the bot/storefront suites that touch tickets (`pnpm exec vitest run apps/order-bot/test/conversations.test.ts apps/storefront/test/`).

---

## Task 5: Order triggers

**`packages/db/src/crud/orders.ts`**, in `settlePaidOrder` (:1548) — one email per settled order, never two:

- MANUAL branch (~:1596, beside the existing `enqueueManualOrderAdminAlert`) → `enqueueOwnerManualQueueEmail`
- AUTO branch (~:1575, beside `approveOrder`) → `enqueueOwnerOrderPaidEmail`

The branches are mutually exclusive, which is what guarantees a manual order never produces two owner emails. Add a brief comment saying so, so a later edit does not accidentally hoist one of them above the branch.

Use the same `tx` the surrounding settlement uses, so the row commits atomically with the state change.

**Tests** — extend `packages/db/src/crud/orders.test.ts`. Cover: an AUTO settlement enqueues exactly one `OWNER_EMAIL_ORDER_PAID` row; a MANUAL settlement enqueues exactly one `OWNER_EMAIL_MANUAL_ORDER_QUEUED` row **and no `OWNER_EMAIL_ORDER_PAID` row**; nothing is enqueued when the toggles are off; the existing `ADMIN_MANUAL_ORDER_QUEUED` Telegram row is still enqueued alongside it (this task must not disturb the existing Telegram alert).

**Verify:** `pnpm exec vitest run packages/db/src/crud/orders.test.ts`.

---

## Task 6: Email templates

**New file `packages/outbox-dispatcher/src/emailTemplates.ts`.**

```ts
export function renderEmail(
  event: string, payload: Record<string, unknown>,
): { subject: string; text: string } | null
```

A flat if-chain on `event`, mirroring the structure of `render()` in `templates.ts:186`, returning `null` for an unknown event (the caller turns that into a permanent failure, same as the existing `""` sentinel does for Telegram).

Output is **plain text** for nodemailer's `text` field — no HTML, so no `escape()` and no `parse_mode`. Copy is English, matching the admin panel (the customer-facing Telegram templates are bilingual because customers are; the owner reads an English admin UI).

**The subject constraint is the point of this task:** subjects are generic — "New paid order", "Order queued for manual fulfilment", "New support ticket", "New reply on a support ticket". The order code, ticket id, amounts and message text go in the **body** only. `sendMail` logs the subject on every send (`mailer.ts:29-40`), and the order code is half the guest `/track` credential.

Bodies should give the owner enough to act without opening the panel: order code, item summary, total (already a formatted string from the payload), or ticket id and the customer's message. End with a pointer to where to act in the admin panel.

**Tests — `packages/outbox-dispatcher/src/emailTemplates.test.ts`.** Cover: each of the four events returns a subject and a non-empty body containing the key facts; an unknown event returns `null`; and — as an explicit regression guard — **no subject contains the order code** for any event, asserted by passing a distinctive order code and checking `subject` does not include it.

**Verify:** `pnpm exec vitest run packages/outbox-dispatcher/src/emailTemplates.test.ts`.

---

## Task 7: Dispatcher email lane

**`packages/outbox-dispatcher/src/dispatcher.ts`**, inside `drainBatch` (:110). Branch on `row.channel === NotificationChannel.EMAIL` **before** the `render()`/Telegram path, after the payload parse:

```ts
if (row.channel === NotificationChannel.EMAIL) {
  await deliverOwnerEmail(row, payload);
  continue;                 // Telegram's rate-limit bailout does not apply
}
```

`deliverOwnerEmail(row, payload)`:

1. `renderEmail(row.event, payload)` → `null` marks the row failed with `maxAttempts=1`, mirroring the existing "no template for event" drop at :151.
2. Read `to` from the payload; missing or non-string → `markNotificationFailed(..., 1)`, mirroring the existing "missing chat_id" handling.
3. `getSmtpCreds(prisma)` → `null` calls `releaseNotificationClaimWithBackoff`. **SMTP being unconfigured is the shop's configuration, not the row's fault** — the same treatment a channel post gets when `PUBLIC_CHANNEL_ID` is unset (:161). The mail goes out once the owner fills in SMTP, instead of failing away permanently. Do not mark it FAILED.
4. `sendMail(creds, { to, subject, text })` inside a `trySendEmail` helper doing the same `markNotificationSent` / `markNotificationFailed(config.NOTIF_MAX_ATTEMPTS)` bookkeeping as `trySend` (:299), minus the grammY-specific `retry_after` and 403 handling, which have no email analogue.

`runDispatcher(bot, signal)` keeps its signature — email needs no new injected dependency, since `getSmtpCreds` reads from the DB.

Update the file's header comment, which currently says the loop drains "notification_outbox -> Telegram", to describe both lanes.

**Tests** — extend `packages/outbox-dispatcher/src/dispatcher.test.ts`; mock `@app/core/mailer` the way the storefront suites already do (`vi.mock("@app/core/mailer", …)`). Cover: an `EMAIL` row calls `sendMail` and **never** `bot.api.sendMessage`; SMTP unconfigured leaves the row `PENDING` with a `nextRetryAt` and **not** `FAILED`; a `sendMail` throw marks it failed and retries up to `NOTIF_MAX_ATTEMPTS`; an unknown email event fails at once with `maxAttempts=1`; a `TELEGRAM` row still goes to Telegram and is completely unaffected.

**Verify:** `pnpm exec vitest run packages/outbox-dispatcher/src/`.

---

## Task 8: Settings API + admin UI

**`apps/web-admin/src/routes/api/settings.ts`** — add the six keys to `EDITABLE` (:38) with clear admin-facing labels. Validate `owner_email` on save with a plain-address regex, alongside the existing `SMTP_FROM_RE` check (:100); reject with a message the shop admin can act on, in the style of the existing validation messages. `owner_email` is **not** a secret — do not add it to `SECRET_KEYS`.

**`apps/web-admin/client/src/pages/SettingsPage.tsx`** — render the new fields in the **existing** `settings-email` Card (:930), directly under the SMTP fields, so mail configuration stays in one place. Follow the existing field-grouping mechanism (:45, "must match the server-side EDITABLE keys exactly") and the existing toggle/boolean field pattern used by e.g. `bulk_purchase_broadcast_enabled`.

Before writing UI, load the `ui-development-dispatch` and `web-fastify-conventions` skills — this repo requires them for admin-panel and Fastify route work.

Settings writes already audit through `logAdminAction`, so no extra audit wiring is needed. Confirm that is true for these keys rather than assuming it.

**Tests** — extend `apps/web-admin/test/settings-security-api.test.ts` (or the closest existing settings route test) for the validation, and `SettingsPage.test.tsx` for rendering/saving the new fields.

**Verify:** `pnpm exec vitest run apps/web-admin/`.

---

## Task 9: /outbox channel badge + docs

**Surface the channel** so email rows are distinguishable from Telegram rows and the existing Retry button reads sensibly: include `channel` in `listNotifications` (`packages/db/src/crud/notifications.ts:719`) and in the route response (`apps/web-admin/src/routes/outbox.ts`), then render it as a badge in `apps/web-admin/client/src/pages/OutboxPage.tsx` using the existing `StatusBadge`/badge idiom on that page. Extend `humanizeEventCode`/`eventLabel` (:39/:47) to give the four new events readable labels.

**Docs — `docs/QUEUE_SYSTEM.md`** (written in Indonesian; match that): document the `channel` column in the "Skema kolom" table, and add a short section on the email lane — what it delivers, that SMTP-unconfigured releases with backoff rather than failing, and the subject-line rule about the order code.

**Verify:** `pnpm exec vitest run apps/web-admin/`, then the full `pnpm typecheck` and `pnpm test`.
