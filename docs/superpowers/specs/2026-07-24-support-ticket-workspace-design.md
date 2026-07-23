# Design: Storefront Support Ticket Workspace (Phase 1)

## Context

The customer-facing ticket thread (`apps/storefront/client/src/pages/TicketDetailPage.tsx`) is currently header → flat message list → reply box. The goal is to turn it into a premium SaaS-style support workspace (Stripe/Linear/Intercom-level) — better information architecture, visual hierarchy, and communication flow — **without** touching branding, color tokens, typography, or introducing the admin design system (`docs/ui/*` is scoped to `apps/web-admin/client` only; storefront has its own hand-authored CSS system: `card`, `card-pad`, `chip`, `field`, `btn-*`, etc., and this design stays inside that system).

**Scope decisions (confirmed with user):**
- Storefront customer page only. `apps/web-admin` ticket queue/detail is untouched (and there's an unmerged worktree, `support-tickets-queue`, already reworking the admin side — not this project's concern).
- Tickets currently have no relation to an order (`SupportTicket` has no `orderId`/`productId`/`subject`/`priority`/`category`). This design **adds order linkage** (one nullable FK) because nearly every "context" requirement (Order Summary, Product Summary, credential state, warranty) depends on it.
- The user's full feature wishlist (~20 items: SLA/queue position, dynamic Knowledge Base, satisfaction rating, resolution summary, customer health, ticket labels, notification preferences, fine-grained credential lifecycle, automatic cross-subsystem events) is **decomposed**: this spec covers only what's deliverable from data that already exists (or the one new FK). Everything else is listed under "Deferred to Phase 2" and needs its own spec once prioritized.

## Existing Assets to Reuse (Do Not Rewrite)

| Asset | Path | Use |
|---|---|---|
| `AttachmentPicker` | `apps/storefront/client/src/components/shop/AttachmentPicker.tsx` | Base for the restyled composer dropzone |
| `AttachmentGallery` | `apps/storefront/client/src/components/shop/AttachmentGallery.tsx` | Base for message-bubble attachment rendering |
| `ProgressBar`, `Spinner`, `Toast`, `Skeleton`, `EmptyState` | `apps/storefront/client/src/components/shop/*.tsx` | Loading/feedback primitives, unchanged |
| `StatusBadge` | `apps/storefront/client/src/components/shop/StatusBadge.tsx` | Extend tone map for ticket statuses if missing, don't replace |
| `listUserOrders`, order lookup crud | `packages/db/src/crud/orders.ts` (via `apps/storefront/src/routes/apiAccount.ts:100-115`) | Order picker at ticket creation, Recent Orders sidebar |
| `listUserTickets` | `packages/db/src/crud/support.ts` | Recent Tickets sidebar |
| `customerStatusLabel()` | `packages/core/src/enums.ts` | Coarse order status → i18n label, reused for the linked-order summary |
| Credential reveal + copy | `apps/storefront/client/src/pages/OrderDetailPage.tsx:339-363` | Ticket page deep-links here rather than re-implementing secret reveal |
| `formatIdr`, `Price` | `apps/storefront/client/src/lib/format.ts`, `components/shop/Price.tsx` | Order total / amounts |
| `t()`, `en.json`/`id.json` | `packages/core/locales/*.json` | All new copy goes through i18n, both keysets stay in sync |

## Data Model Change

Add one nullable FK to `SupportTicket` in `prisma/schema.prisma`:

```prisma
model SupportTicket {
  // ...existing fields...
  orderId Int? @map("order_id")
  order   Order? @relation(fields: [orderId], references: [id], onUpdate: NoAction)

  @@index([orderId], map: "ix_support_tickets_order_id")
}
```

`Order` needs a back-relation field added (`tickets SupportTicket[]`) for Prisma's relation to resolve. No other schema changes. Migrate via `pnpm prisma migrate dev` (or `db push` in dev per repo convention) — this is an additive nullable column, safe on the live SQLite DB with no backfill needed (existing tickets simply have `orderId = null`, rendered as general-purpose tickets).

## Backend Changes

**`packages/db/src/crud/support.ts`**
- `createTicket(prisma, { userId, message, ..., orderId? })` — accepts optional `orderId`; if provided, caller must have already verified the order belongs to `userId` (done in the route, not the crud helper, consistent with existing patterns).
- `getTicket(prisma, id)` — when `ticket.orderId` is set, join/include the order + its items + denomination (name, durationLabel) + voucher, shaped into the response the client needs (see below). Keep this a single query (Prisma `include`), not N+1.
- New: `closeTicketByUser(prisma, ticketId, userId)` — same atomic conditional-close pattern as the existing `closeTicket` (prevent double-transition), but scoped to the ticket's own `userId` instead of an admin. Sets `status = CLOSED`, `closedAt = now()`.
- New: `reopenTicket(prisma, ticketId, userId)` — only succeeds if `status === CLOSED` and `closedAt` is within the reopen window (7 days, `packages/core` config constant, not hardcoded in the crud file). Sets `status = OPEN`, clears `closedAt`. Returns a typed failure reason (`not_closed` | `window_expired`) so the route can map it to the right i18n error key.
- `listUserTickets` — unchanged signature; already sufficient for the Recent Tickets sidebar (cap at ~5, most recent first).

**`apps/storefront/src/routes/apiAccount.ts`**
- `POST /account/support` — accepts optional `order_code` in the body (multipart and JSON paths). Looks up the order by code + `userId` (reuse the existing order-lookup helper from the orders route); 400/validation error if the code doesn't belong to the requester. Passes resolved `orderId` to `createTicket`.
- `GET /account/support/:id` — response gains an `order` object (nullable) when the ticket is linked:
  ```ts
  order: {
    code: string;
    status: string;
    status_label: string;        // via customerStatusLabel()
    created_at_display: string;
    paid_at_display: string | null;
    payment_method: string;
    total: string;               // Decimal → string, same convention as OrderDetailData
    voucher_code: string | null;
    delivered: boolean;
    items: Array<{
      name: string;
      duration: string | null;
      warranty_days: number;
      warranty_expires_at_display: string | null;
      warranty_active: boolean;
    }>;
  } | null
  ```
- New `POST /account/support/:id/close` — customer self-close ("Issue Solved"). Calls `closeTicketByUser`. 404 if the ticket isn't the requester's; no-op error if already closed.
- New `POST /account/support/:id/reopen` — calls `reopenTicket`; maps `not_closed`/`window_expired` to i18n error keys (`error.ticket_not_closed`, `error.ticket_reopen_expired`).
- All four routes keep the existing `csrfProtect` preHandler and the happy/auth-fail/bad-csrf test trio per `web-fastify-conventions`.

## Information Architecture

**Header** (no fabricated subject — the schema has none):
- `Ticket #{id}` as the primary identifier
- Status pill (icon + color + text, see taxonomy below)
- Created / Last updated timestamps (relative, e.g. "2 minutes ago", full date on hover)
- If linked: subline `Re: Order #{code}` (links to the order)
- Static "Estimated reply" copy from an i18n string / config constant (e.g. "Usually within a few hours") — never a fabricated live number

**Status taxonomy** — only the three states that exist get real treatment; no invented statuses:

| Stored value | Customer label | Icon/tone |
|---|---|---|
| `OPEN` | "Waiting for Support" | Clock, pine |
| `REPLIED` | "Waiting for Your Reply" | MessageCircle, amber |
| `CLOSED` | "Closed" (+ Reopen banner if within 7 days of `closedAt`) | CheckCircle, neutral |

("In Progress" / "Resolved" / "Escalated" require new ticket states — deferred, see below.)

**Layout** — desktop ≥1024px: two-column (conversation ~70%, sidebar ~30%) using a CSS grid inside the existing storefront layout container. Tablet: sidebar sections stack below the conversation as native `<details>` accordions (no new accordion component needed). Mobile: single column, sticky reply composer (`position: sticky; bottom: 0`), sidebar content collapses into accordions so nothing is lost, just deprioritized.

**Sidebar sections, top to bottom:**
1. Order & Product Summary (only rendered if `ticket.order` present; otherwise a generic "Need help with an order? Start a new ticket from your order page" prompt — never an empty box)
2. Quick actions: View Order, Copy Order Number, Create New Ticket
3. Trust badges (Warranty Included / Verified Purchase — real; Secure Purchase / Encrypted Credentials — static copy, clearly non-numeric)
4. Recent Tickets (via `listUserTickets`, last 5)
5. Need More Help (static: Telegram support link, support email, docs link — whichever of these already exist in config; omit any that don't rather than fabricate one)

**Order & Product Summary card** — order #, item(s) with name/duration, purchase date, payment method, status pill (via `status_label`), order total, voucher code if used, per-item warranty ("Active until {date}" / "Expired {date}" computed from `deliveredAt + warrantyDaysSnapshot`), credential state (binary: Ready / Not Delivered, from `order.status === DELIVERED`). "View Order" / "Download Credentials" both deep-link to `OrderDetailPage`'s existing credentials block (`/account/orders/:code#credentials`) rather than re-rendering secret values a second place — keeps the one existing reveal/copy implementation as the single source of truth for that sensitive UI.

Not shown (not reliably derivable from current schema): brand, stock type, flash-sale-applied flag.

**Conversation** — real chat bubbles: customer right-aligned (blue accent per existing tint tokens), support left-aligned (neutral), system events centered as small timeline cards. System events (`Ticket Created`, `Support Replied`, `Ticket Closed`, `Ticket Reopened`) are **synthesized client-side** from existing timestamps (`createdAt`, `repliedAt`, `closedAt`) merged into the message list and sorted — no new event-log table. Messages grouped by date with inline dividers ("Today" / "Yesterday" / localized date), avoiding a repeated full timestamp on every bubble (relative time + a `title` attribute with the exact time). Each bubble: initials-based avatar (no avatar images in the schema), sender label, relative timestamp, attachments via the restyled `AttachmentGallery`.

**Composer** — existing `AttachmentPicker` restyled with a visible dropzone (drag&drop wrapper, dashed border, thumbnail chips — the picker's existing file/size/type validation is unchanged). Adds: character counter, Ctrl/Cmd+Enter submit shortcut, localStorage-backed per-ticket draft autosave (debounced ~500ms, cleared on successful send), submit disabled while a request is in flight. Hidden/replaced by the Reopen banner when `status === CLOSED`.

**Quick-reply row** above the composer, contextual to status:
- "Issue Solved" (only shown when not already closed) — calls `POST /account/support/:id/close` directly, not a template.
- "Still not working" / "Request a refund" / "Replace credentials" — insert a canned starter sentence into the textarea and focus it. These are **not** automated workflows (no refund/replacement backend exists yet) — they're worded as message templates the customer sends to a human, not as self-service actions, so nothing is promised that isn't real.
- "Escalate" is dropped from Phase 1 — there's no escalation concept in the schema; a template like "please escalate this" is just a regular message anyway, so a dedicated button adds a control without adding real capability (violates the "does it reduce clicks / improve decisions" bar from the admin UX doctrine, which the same discipline applies to here even off the admin system).

**Empty state** (ticket has no admin reply yet): icon + "Waiting for Support" + static "Our team usually replies within a few hours." — no fabricated countdown.

## Error Handling

- Order-code validation on ticket creation: reuse the existing order-lookup 404/ownership check pattern from the orders route; surface as a field-level error on the picker, not a page-level failure.
- Reopen outside the window / already reopened: mapped i18n error shown inline near the Reopen banner, not a toast-and-forget (the customer needs to see *why* — "This ticket can no longer be reopened; please create a new ticket" with a Create New Ticket action right there).
- Self-close race (ticket already closed by admin, or already replied-to since the button was shown): 409-style response re-fetches ticket state and re-renders rather than showing a raw error.
- All new routes follow existing `describeError()` / CSRF / auth-fail conventions already used elsewhere in `apiAccount.ts`.

## Testing

- `packages/db/src/crud/support.test.ts` (colocated, per repo convention): `reopenTicket` window boundary (exactly 7 days, 7 days + 1s), `closeTicketByUser` ownership + double-close race, `createTicket`/`getTicket` with `orderId` set/unset, `getTicket` order-join shape.
- Route tests for the four touched/new endpoints (`/account/support`, `/account/support/:id`, `/account/support/:id/close`, `/account/support/:id/reopen`): happy path, auth-fail, bad-CSRF trio per `web-fastify-conventions`, plus the order-ownership-mismatch case.
- Component tests (`TicketDetailPage.test.tsx`): order summary renders when linked / generic prompt when not; status taxonomy labels; Reopen banner visible only within window; quick-reply template insertion; self-close flow updates status without a full reload; composer draft survives a remount (localStorage).

## Deferred to Phase 2 (needs its own spec)

Priority/category exposed to the customer, live SLA/queue-position/support-online status, dynamic Knowledge Base / Smart FAQ engine, satisfaction rating + admin analytics, resolution summary (problem/root cause/solution), customer health (staff-only — arguably belongs on the *admin* ticket view, not this page, regardless of phase), ticket labels/tags, notification preferences (Telegram/email/push per event), fine-grained credential lifecycle (Downloaded/Expired/Replaced/Regenerated + reveal/mask permissions), automatic system events sourced from *other* subsystems (payment verified, credentials regenerated), file virus-scan status, flash-sale-applied flag on order items.
