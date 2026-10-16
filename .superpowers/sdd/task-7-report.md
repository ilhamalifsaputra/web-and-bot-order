# Task 7 report (B6): ticket-closed notifications

Defect reproduced: RED, 5 of 6 new tests failed in `support.test.ts` ("ticket-closed buyer notification (B6)"): closeTicket, bulkCloseTickets, transitionTicketStatus->CLOSED and auto_closed all enqueued nothing.

Fix (no schema change):
- `closeTicket(db, id, {autoClosed?})` (packages/db/src/crud/support.ts) is now the single shared helper. Given a client it wraps close + enqueue in one `$transaction`; given a tx it joins it. It enqueues one TICKET_CLOSED_DM only when this call flipped the ticket (already-closed or missing => nothing; web-only buyer without telegramId => nothing). Dedupe key `ticket-closed:<ticketId>:<closedAt ms>` (per close; reopen-then-close notifies again).
- `transitionTicketStatus(... to CLOSED)` enqueues through the same internal helper (web `/status` route).
- `enqueueTicketClosedDm` (notifications.ts) gained `dedupeKey` (raw INSERT ... ON CONFLICT DO NOTHING, orderId NULL, so a collision never aborts the tx) and `autoClosed`.
- Callers: web close route and bulkCloseTickets get it automatically; bot `closeTicketAdmin` dropped its own post-hoc enqueue (now in the close tx); `autoCloseStaleTickets` drops the direct `api.sendMessage` (param renamed `_api`).
- Dispatcher template: payload `auto_closed:true` renders the existing `ticket.auto_closed` wording (EN/ID, HTML) so auto-close text is unchanged; the plain path is byte-identical to before.

Tests (GREEN): support.test.ts, notifications.test.ts, templates.test.ts: 314 passed; jobs.test.ts autoCloseStaleTickets 2 passed (failure injection moved from updateMany spy to `$transaction` spy since close is now transactional; asserts no direct send, one outbox row with auto_closed); handlers.test.ts "ticket close" 3 passed; dispatcher TICKET_CLOSED 13 passed; web-admin users-vouchers-support-audit-api 114 passed. Typecheck clean: db, outbox-dispatcher, order-bot, web-admin.

Concerns: auto-close buyers now get the message via the outbox tick (slight delay, but retried) instead of instantly; the bulk loop runs one tx per ticket.
