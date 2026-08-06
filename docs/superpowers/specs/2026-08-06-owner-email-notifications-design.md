# Owner Email Notifications — Design

Date: 2026-08-06

## Problem

The shop owner has no email channel for events that need a human.

- **Support tickets opened from the web notify nobody.** `apps/storefront/src/routes/apiAccount.ts:304` creates a `SupportTicket` and enqueues nothing. The ticket is invisible until an admin happens to open the Support page. The bot path (`apps/order-bot/src/conversations/support.ts:156`) does send Telegram, but directly, bypassing the outbox.
- **Paid orders only alert admins over Telegram DM**, which requires each admin to have started the bot. An owner not watching Telegram misses hand-fulfilment work sitting in the queue.

Everything needed to send mail already exists and is admin-configurable: the `smtp_host`/`smtp_port`/`smtp_user`/`smtp_pass`/`smtp_from`/`smtp_secure` Settings keys, `getSmtpCreds()` (`packages/db/src/crud/smtp.ts:29`), `sendMail()` (`packages/core/src/mailer.ts:22`), and a working "Test Connection" button. What is missing is a recipient setting and the trigger points.

## Outcome

The owner sets one email address in Settings and receives mail when:

1. a paid order lands (auto-delivered),
2. a paid order queues for hand-fulfilment,
3. a support ticket is opened,
4. a customer replies to a support ticket.

Mail is delivered through the existing `notification_outbox` queue, so it inherits retry, exponential backoff, anti-double-send claiming, and the `/outbox` monitoring page.

## Scope

**In:** the four events above; a single owner address; a master toggle plus per-event toggles.

**Out:** payment anomalies (`ADMIN_OVERPAID`, `ADMIN_STALE_PAYMENT`, `ORDER_PIPELINE_FAILED` keep their Telegram-only path); unpaid newly-created orders (too high-volume, mostly never paid); multiple recipients; digest batching; HTML mail.

## Design

### Transport: the existing outbox, with an explicit channel

Add one column to `NotificationOutbox` (`prisma/schema.prisma:761`):

```prisma
channel String @default("TELEGRAM") @map("channel")   // TELEGRAM | EMAIL
```

The default keeps every existing row and every existing `enqueue*` call working untouched.

Transport becomes explicit row data rather than being inferred from the event name. Today the dispatcher infers it from the `ADMIN_DM_EVENTS` name Set (`packages/outbox-dispatcher/src/dispatcher.ts:52`), which distinguishes DM from channel post but has no notion of a second transport.

Rejected alternatives:

- **Send inline at the event site** (as the guest order-code mail does). Fewest moving parts, but no retry and no audit: SMTP down means the notification is lost silently, and an SMTP timeout would slow the checkout request.
- **A separate `email_outbox` table and dispatcher loop.** Cleaner separation, but duplicates the entire claim/backoff/stale-reclaim machinery and the `/outbox` page for no benefit at this volume.

### Settings

Six new keys in the `EDITABLE` map (`apps/web-admin/src/routes/api/settings.ts:38`), rendered in the existing `settings-email` Card (`apps/web-admin/client/src/pages/SettingsPage.tsx:930`) directly under the SMTP fields:

| Key | Meaning |
|---|---|
| `owner_email` | Recipient address |
| `owner_email_enabled` | Master on/off |
| `owner_email_on_paid_order` | Auto-delivered order was paid |
| `owner_email_on_manual_queue` | Paid order queued for hand-fulfilment |
| `owner_email_on_new_ticket` | New support ticket |
| `owner_email_on_ticket_reply` | Customer replied to a ticket |

`owner_email` is validated on save with a plain-address regex, alongside the existing `SMTP_FROM_RE` check (`settings.ts:100`). It is **not** a secret and must not be added to `SECRET_KEYS`. Settings writes already audit through `logAdminAction`.

New resolver, `packages/db/src/crud/ownerEmail.ts`:

```ts
export async function resolveOwnerEmailRecipient(
  db: Db, event: OwnerEmailEvent,
): Promise<string | null>
```

Returns the trimmed address, or `null` when the master toggle is off, that event's toggle is off, the address is blank, or the address fails the regex. `null` means "do not enqueue" — the feature is inert until configured, exactly as `getSmtpCreds` returning `null` leaves the forgot-password mail off today.

### Events

Four new `NotificationEvent` values (`packages/core/src/enums.ts:273`), each documented in the style of its neighbours:

`OWNER_EMAIL_ORDER_PAID`, `OWNER_EMAIL_MANUAL_ORDER_QUEUED`, `OWNER_EMAIL_NEW_TICKET`, `OWNER_EMAIL_TICKET_REPLY`.

Distinct events — rather than reusing `ADMIN_MANUAL_ORDER_QUEUED` with `channel=EMAIL` — keep the Telegram `render()` if-chain and the email renderer from ever having to handle each other's payload shapes, and make `/outbox` rows self-describing.

### Enqueue

In `packages/db/src/crud/notifications.ts`, following the shape of `enqueueManualOrderAdminAlert` (:146): an internal `enqueueOwnerEmail(db, event, orderId, payload)` plus four thin wrappers. The internal helper calls `resolveOwnerEmailRecipient`, returns early on `null`, and otherwise writes one row with `channel: "EMAIL"` and a payload carrying `to` plus the display fields. Money is carried as `Decimal.toString()`, never `number`.

Called with the caller's `tx`, so the row lands atomically with the state change that triggered it.

`getSetting` caches per-`Db`-instance via a `WeakMap` (`crud/settings.ts:18`), so a `tx` client misses the shared cache and each enqueue costs roughly two extra primary-key reads inside the transaction. Acceptable at these events' volume; it lengthens the SQLite writer-lock hold only marginally.

### Trigger points

**Tickets — hook the CRUD layer, not the routes.** Both the storefront and the bot create tickets, so enqueueing inside `packages/db/src/crud/support.ts` covers every call site at once and cannot drift:

- `createTicket` (:9) enqueues `OWNER_EMAIL_NEW_TICKET`.
- `addTicketMessage` (:201) enqueues `OWNER_EMAIL_TICKET_REPLY` **only when `senderType === SenderType.USER`** — a customer reply. An admin's own reply must never mail the owner.

Both become `async`. Affected call sites: `apiAccount.ts:304` and `:335`, `conversations/support.ts:144`, `conversations/customer.ts:74`, `web-admin/src/routes/api/support.ts:291`.

**Orders — `settlePaidOrder` (`packages/db/src/crud/orders.ts:1548`), one email per settled order:**

- MANUAL branch (~:1596, beside the existing `enqueueManualOrderAdminAlert`) enqueues `OWNER_EMAIL_MANUAL_ORDER_QUEUED`.
- AUTO branch (~:1575, beside `approveOrder`) enqueues `OWNER_EMAIL_ORDER_PAID`.

The branches are mutually exclusive, so a manual order never produces two owner emails.

### Dispatcher

In `drainBatch` (`dispatcher.ts:110`), branch on `row.channel === "EMAIL"` **before** the `render()`/Telegram path. Email rows never trigger the Telegram rate-limit bailout.

`deliverOwnerEmail`:

1. `renderEmail(row.event, payload)` → `{ subject, text } | null`. `null` marks the row failed with `maxAttempts=1`, mirroring the existing "no template for event" drop at :151.
2. `getSmtpCreds(prisma)` → `null` calls `releaseNotificationClaimWithBackoff`. SMTP being unconfigured is the shop's configuration, not the row's fault — the same treatment a channel post gets when `PUBLIC_CHANNEL_ID` is unset (:161). The mail goes out once the owner fills in SMTP, instead of failing away permanently.
3. `sendMail(creds, { to, subject, text })` inside a `trySendEmail` that does the same `markNotificationSent` / `markNotificationFailed(config.NOTIF_MAX_ATTEMPTS)` bookkeeping as `trySend` (:299), minus the grammY-specific `retry_after` and 403 handling, which have no email analogue.

`runDispatcher(bot, signal)` keeps its signature: email needs no new injected dependency, since `getSmtpCreds` reads from the DB.

New `packages/outbox-dispatcher/src/emailTemplates.ts` exports `renderEmail(event, payload)`, a flat if-chain mirroring `templates.ts:186`, returning plain text for nodemailer's `text` field. No HTML, so no escaping is needed.

**Subject-line constraint.** `sendMail` logs the subject on every send, and `mailer.ts:29-40` explicitly asks callers to keep secrets out of it — naming the order code, which is half the guest `/track` credential. Subjects therefore stay generic ("New paid order", "New support ticket"); the order code and ticket detail live in the body only. This is asserted in tests.

Copy is English, matching the admin panel. The customer-facing templates are bilingual because customers are; the owner reads an English admin UI.

### `/outbox` page

Surface `channel` in the route response (`apps/web-admin/src/routes/outbox.ts`, `listNotifications` at `notifications.ts:719`) and render it as a badge in `OutboxPage.tsx`, so email rows are distinguishable from Telegram rows and the existing Retry button reads sensibly.

## Known tradeoff (inherited)

If `sendMail` succeeds but `markNotificationSent` fails, the row stays `SENDING` and becomes claimable again after `STALE_CLAIM_MS` (5 minutes), re-sending — a rare duplicate email. This is the same crash-window tradeoff the Telegram path already accepts (`docs/QUEUE_SYSTEM.md`, "Klaim atomik sebelum kirim"). The alternative — dropping the row — loses notifications instead, which is worse for an alerting feature.

## Deployment

The schema change must reach the live DB before the new code runs: `pnpm prisma db push`, then restart order-bot. Otherwise every outbox read throws `P2022 column channel does not exist`.

## Verification

Tests, written first (TDD). There is no per-package `test` script; run `pnpm exec vitest run <path>`.

- `ownerEmail.test.ts` — master off → `null`; per-event off → `null`; blank or invalid address → `null`; all set → the address.
- `notifications.test.ts` — enqueue writes `channel=EMAIL` and the correct payload; writes no row when disabled; serialises `Decimal` as a string.
- `support.test.ts` — `createTicket` enqueues; `addTicketMessage` enqueues for `USER` and not for `ADMIN`.
- `emailTemplates.test.ts` — subject and body per event; asserts no subject contains the order code.
- `dispatcher.test.ts` — an `EMAIL` row calls `sendMail` and never `bot.api.sendMessage`; SMTP unconfigured leaves the row `PENDING` with backoff, not `FAILED`; a `sendMail` throw marks it failed; a `TELEGRAM` row is unaffected.
- `SettingsPage.test.tsx` — the new fields render and save.

Gates: `pnpm typecheck` and `pnpm test` must both be green.

End-to-end: `pnpm prisma db push`, set SMTP + `owner_email` + toggles in Settings, use "Test Connection", open a ticket from the storefront, confirm an `EMAIL` row appears at `/outbox` and flips to `SENT` and that the mail arrives with no order code in the subject. Then switch the master toggle off and confirm a second ticket enqueues no row.
