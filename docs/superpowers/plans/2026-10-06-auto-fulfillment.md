# Automatic fulfillment implementation plan

> Execute the supplied `prompt-auto-fulfillment-digiflazz-ui-order.md` specification. Use test-driven development; independent UI and Telegram work use dispatching-parallel-agents.

**Goal:** Paid Digiflazz purchases process automatically, with truthful live website status, one persisted Telegram status message, and actionable notifications only.

**Architecture:** Keep existing settlement, provider client, callback verification, reference ID, claim leases, reconciliation and SSE infrastructure. Freeze provider/SKU on the order, derive buyer state centrally, and persist Telegram message tracking. No new services or dependencies.

**Tech stack:** Fastify, Prisma/PostgreSQL, React/Tailwind, grammY, Vitest.

## Audit

1. Payment rails call `settlePaidOrder` after PENDING_VERIFICATION; wallet purchases follow the same settlement.
2. Digiflazz denominations use MANUAL_WITH_INFO for target collection. Settlement branches solely on deliveryTypeSnapshot, wrongly enqueueing manual notifications although the Digiflazz cron subsequently dispatches automatically.
3. Order.status, paidAt, and digiflazz* fields are the durable truth. Existing retry window is bounded at 24h and repeats the same orderCode reference.
4. `orders.ts` calls `enqueueOwnerManualQueueEmail` and `enqueueManualOrderAdminAlert` unconditionally for this branch. `digiflazz.ts` also reuses the manual alert for failures, without dedupe.
5. Outbox sends separate ORDER_PROCESSING_DM and ORDER_MANUAL_DELIVERED_DM; payment bubble anchors are independent and cleared after settlement.
6. React polls PROCESSING every 5s, but SSE merges only digiflazz_status. Narrow stacked cards and a detached summary create unnecessary whitespace.
7. Add nullable order provider/SKU snapshots and one small message tracking table. Existing order/payment lifecycle enums remain compatible.
8. Provider dispatch already claims atomically. Customer data edit lacks a guarded write; terminal provider outcome lacks a failed-state guard; post-delivery item statuses are not updated by Digiflazz.
9. Legacy rows need metadata fallback. Provider API behavior and payment rails must remain intact. Telegram send acknowledgement loss cannot be made exactly-once; uncertain initial sends must stop automatic resend and alert once.

## Constraints and review focus

- Preserve manual and stock delivery, money formatting and both languages.
- No provider purchases against live credentials during tests.
- Use stable reference and bounded existing retries; permanent rejection is actionable immediately, never repurchase under a new reference.
- Concurrent dispatch/edit must not mutate the submitted target; catalog edits must not reroute new orders.
- SSE ownership checks and buyer-safe responses must remain intact.
- Telegram edits survive restart; ambiguity after an initial send must not spam.
- Preserve unrelated user file deletions and untracked audit/config files; implement in the requested checkout.

## Task 1: Backend routing and durable state

Files: `prisma/schema.prisma`, additive migration, `packages/core/src/orderFulfillment.ts`, package export, `packages/db/src/crud/orders.ts`, `digiflazz.ts`, `notifications.ts`, `apps/order-bot/src/jobs/index.ts`, existing settlement/provider tests.

- [x] Add regression tests for zero happy-path manual alerts, duplicate settlement/dispatch, target edit lock, provider snapshot, terminal alert dedupe and delivered item status.
- [x] Run and confirm expected failures.
- [x] Freeze fulfillmentProvider/fulfillmentSku on order creation (legacy null falls back to explicit denomination metadata); AUTO DIGIFLAZZ settlement queues without manual notifications.
- [x] Create FulfillmentMessage tracking once for a paid Telegram buyer; stop separate automatic processing/delivered DMs.
- [x] Central mapper `getOrderFulfillment(order)` returns mode, provider, status, payment_status, can_edit_customer_data. QUEUED before dispatch, SUBMITTING while first call is leased, PROCESSING after provider pending/retry, NEEDS_REVIEW on terminal provider failure, SUCCESS on delivery.
- [x] Reuse provider claims/backoff; dedupe actionable ORDER_PIPELINE_FAILED per order/admin; prevent repeat terminal transition. Missing credentials become actionable rather than silently stuck.
- [x] Update delivered items and guest receipt; guard target edits against concurrent dispatch. Run backend tests.

## Task 2: Website API and SSE

Files: `apps/storefront/src/routes/apiAccount.ts`, `apiOrderDigiflazzStream.ts`, API/SSE tests.

- [x] Return `order.fulfillment` with the canonical mapper and snapshot field configuration. Keep legacy digiflazz_status for compatibility.
- [x] SSE returns canonical fulfillment alongside existing fields, uses 5s DB fallback and existing subscription. React invalidates full detail on snapshot changes; polling covers disconnect and payment states.
- [x] Verify authentication, ownership, payment-to-processing and delivery automatic update.

## Task 3: Order detail UI (delegated)

Files: storefront client types, OrderDetailPage, new reusable progress component/mapper, relevant layout, StatusBadge, frontend locales and tests.

Contract: optional `order.fulfillment` = `{mode: 'AUTO'|'MANUAL', provider: 'DIGIFLAZZ'|'MANUAL'|'STOCK', status: 'NOT_STARTED'|'QUEUED'|'SUBMITTING'|'PROCESSING'|'SUCCESS'|'FAILED'|'NEEDS_REVIEW'|'CANCELLED', payment_status: 'PENDING'|'PAID'|'FAILED'|'EXPIRED'|'REFUNDED', can_edit_customer_data: boolean}`. SSE includes `fulfillment` in addition to orderStatus/digiflazzStatus. Full detail refetch drives final content and flags.

- [x] Test automatic copy, progress, final/review/failure rendering, SSE full refetch, locked edits and mobile layout.
- [x] Implement using existing tokens; desktop minmax(0,1fr)/320px grid, compact aligned cards, robust wrapping and 44px controls. Keep settlement amounts/discount rows unchanged.
- [x] Verify tests/lint/typecheck/build.

## Task 4: Telegram status worker (delegated)

Files: new `packages/outbox-dispatcher/src/fulfillmentMessages.ts` and tests, package exports, server startup/shutdown wiring.

Contract: Prisma FulfillmentMessage fields orderId (PK/FK), chatId BigInt, messageId Int?, state String default READY, claimedAt DateTime?, nextUpdateAt DateTime default now, lastText String?, finishedAt DateTime?; relation order with cascade delete. Root creates tracking table/rows. Canonical mapper from Task 1; raw order query includes items.product. Worker uses MAIN bot token, 2s interval, guarded leases, updates messageId durably and edits the same message; spinner is presentation only. Suppress unknown initial-send retries and log/alert ambiguity once. Deleted messages must not produce a fresh replacement automatically. Resume tracked edits on restart and render final order after transition; mark finished after final edit. Bound calls and honor flood control.

- [x] Write real worker behavior tests with fake Telegram and isolated PostgreSQL (or injectable persistence test adapter); initial once, edits/spinner, terminal stop, restart, competing workers and flood control.
- [x] Confirm failures, implement worker and boot integration, run tests/typecheck.

## Task 5: Verification and review

- [x] Run targeted tests then appropriate suite, frontend lint, workspace/test typechecks, both client builds, migration timestamp/drift and boundary checks.
- [x] Review changes for duplicate fulfillment, status divergence, notification noise, startup/shutdown and deployment compatibility.
- [x] Record commands/results and remaining external validation requirements. Do not deploy, push or contact real customers.
