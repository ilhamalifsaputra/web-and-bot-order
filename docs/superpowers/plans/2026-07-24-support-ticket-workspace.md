# Storefront Support Ticket Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the storefront's customer-facing ticket thread (`apps/storefront/client/src/pages/TicketDetailPage.tsx`) into a two-column support workspace — real chat bubbles, an order/product context sidebar, self-serve close/reopen, and a richer composer — without touching branding/tokens or the admin design system.

**Architecture:** One additive schema change (`SupportTicket.orderId`, nullable FK to `Order`) unlocks order context. Backend gains two small self-service mutations (close, reopen) and an enriched ticket-detail response. Frontend gets several new small, focused components (`TicketStatusBadge`, `TicketMessageThread`, `TicketComposer`, `TicketOrderSummaryCard`, `TicketSidebar`) plus two pure-logic modules (`ticketTimeline.ts`, `ticketDraft.ts`), composed into a rewritten `TicketDetailPage.tsx`. Everything stays inside the storefront's existing hand-authored CSS system (`card`, `chip`, `field`, `btn-*`).

**Tech Stack:** Fastify (JSON API), Prisma/SQLite, React 18 + TanStack Query + react-router, Vitest + Testing Library, storefront's own CSS classes (not the admin Tailwind/shadcn design system).

## Global Constraints

- No changes to colors, typography, spacing, radius, shadows, or any admin design-system token — `docs/ui/*` does not apply to this app.
- No raw SQL — all DB access through `packages/db/src/crud/support.ts` (and `orders.ts` reads via already-exported helpers).
- Money stays `Decimal`/string end-to-end; dates stored UTC, formatted for display server-side via `localize()`/`dt()`.
- Every mutating route keeps the `csrfProtect`/`x-csrf-token` pattern and the happy/auth-fail/bad-CSRF test trio.
- Never send Telegram from the web app directly (not applicable here — no new outbox writes in this plan).
- All new customer-facing strings go through `t()` against `packages/core/locales/{en,id}.json`, both keysets kept identical.
- `pnpm typecheck` and `pnpm test` must stay green after every task.
- **Test commands run from the repo root as `pnpm test -- <file-or-pattern>`.** There is one shared `vitest.config.ts` at the repo root (`environmentMatchGlobs` gives client packages jsdom automatically) — no package has its own `test` script. `pnpm --filter <pkg> test` silently no-ops (empty output, exit 0) instead of erroring, which produces false "all passing" confidence — this bit Task 2's own review once already (packages/db/src/crud/support.test.ts commit `9f59fb5`) before this line was added; do not repeat it.

---

## File Structure

**New files:**
- `apps/storefront/client/src/lib/ticketTimeline.ts` — pure function merging ticket message/legacy reply/thread/system events into one sorted feed
- `apps/storefront/client/src/lib/ticketTimeline.test.ts`
- `apps/storefront/client/src/lib/ticketDraft.ts` — localStorage draft save/load/clear helpers
- `apps/storefront/client/src/lib/ticketDraft.test.ts`
- `apps/storefront/client/src/components/shop/TicketStatusBadge.tsx` — ticket-specific status chip (icon + friendly label), separate from the generic `StatusBadge`
- `apps/storefront/client/src/components/shop/TicketStatusBadge.test.tsx`
- `apps/storefront/client/src/components/shop/TicketMessageThread.tsx` — renders the merged timeline as grouped chat bubbles
- `apps/storefront/client/src/components/shop/TicketMessageThread.test.tsx`
- `apps/storefront/client/src/components/shop/TicketComposer.tsx` — reply textarea + attachments + char counter + shortcut + draft autosave
- `apps/storefront/client/src/components/shop/TicketComposer.test.tsx`
- `apps/storefront/client/src/components/shop/TicketOrderSummaryCard.tsx` — linked-order sidebar card
- `apps/storefront/client/src/components/shop/TicketOrderSummaryCard.test.tsx`
- `apps/storefront/client/src/components/shop/TicketSidebar.tsx` — composes order summary / trust badges / recent tickets / help links

**Modified files:**
- `prisma/schema.prisma` — `SupportTicket.orderId`, `Order.tickets` back-relation
- `prisma/migrations/20260724150000_add_support_ticket_order_link/migration.sql` — new migration
- `packages/db/src/crud/support.ts` — `createTicket` gains `orderId`, add `getTicketWithOrder`, `closeTicketByUser`, `reopenTicket`, `TICKET_REOPEN_WINDOW_DAYS`
- `packages/db/src/crud/support.test.ts` — tests for the above
- `apps/storefront/src/lib/ticketAttachments.ts` — parse an `order_code` multipart field
- `apps/storefront/src/routes/apiAccount.ts` — `order_code` on create, enriched `GET /account/support/:id`, new close/reopen routes
- `apps/storefront/test/spa-api.test.ts` — route coverage for all of the above
- `apps/storefront/client/src/api/types.ts` — `TicketOrderSummary`, `TicketOrderItem`, extended `TicketDetailData`
- `apps/storefront/client/src/pages/TicketDetailPage.tsx` — full rewrite using the new components
- `apps/storefront/client/src/pages/TicketDetailPage.test.tsx` — rewritten to match
- `apps/storefront/client/src/pages/SupportPage.tsx` — order picker on the create-ticket form
- `apps/storefront/client/src/pages/SupportPage.test.tsx` — coverage for the picker
- `apps/storefront/client/src/pages/OrderDetailPage.tsx` — `id="credentials"` anchor + scroll-to-hash effect (so the ticket sidebar's "Download Credentials" link actually lands on the credentials block)
- `apps/storefront/client/src/pages/OrderDetailPage.test.tsx` — coverage for the scroll effect
- `packages/core/locales/en.json`, `packages/core/locales/id.json` — new keys (see Task 5)

---

### Task 1: Schema — link a ticket to an order

**Files:**
- Modify: `prisma/schema.prisma` (`SupportTicket` model, `Order` model)
- Create: `prisma/migrations/20260724150000_add_support_ticket_order_link/migration.sql`

**Interfaces:**
- Produces: `SupportTicket.orderId: number | null`, Prisma relation field `SupportTicket.order: Order | null`, `Order.tickets: SupportTicket[]`.

- [ ] **Step 1: Edit the schema**

In `prisma/schema.prisma`, inside `model SupportTicket { ... }`, add the FK field right after `closedAt` and the relation/index alongside the existing ones:

```prisma
model SupportTicket {
  id             Int       @id @default(autoincrement())
  userId         Int       @map("user_id")
  message        String
  photoFileIds   String?   @map("photo_file_ids")
  attachmentUrls String?   @map("attachment_urls")
  status         String    @default("OPEN")
  adminReply     String?   @map("admin_reply")
  adminId        Int?      @map("admin_id")
  createdAt      DateTime  @default(now()) @map("created_at")
  repliedAt      DateTime? @map("replied_at")
  closedAt       DateTime? @map("closed_at")
  /// Optional link to the order this ticket is about — customer-picked at
  /// creation time. Null for general-purpose tickets (account issues,
  /// pre-purchase questions). Unlocks the storefront ticket page's Order/
  /// Product Summary sidebar and warranty/credential context.
  orderId        Int?      @map("order_id")

  user     User            @relation("TicketUser", fields: [userId], references: [id], onDelete: Cascade, onUpdate: NoAction)
  admin    User?           @relation("TicketAdmin", fields: [adminId], references: [id], onDelete: NoAction, onUpdate: NoAction)
  order    Order?          @relation(fields: [orderId], references: [id], onUpdate: NoAction)
  messages TicketMessage[]

  @@index([userId], map: "ix_support_tickets_user_id")
  @@index([closedAt], map: "ix_support_tickets_closed_at")
  @@index([orderId], map: "ix_support_tickets_order_id")
  @@map("support_tickets")
}
```

In `model Order { ... }`, add the back-relation next to the other list relations (near `reviews Review[]`):

```prisma
  tickets            SupportTicket[]
```

- [ ] **Step 2: Write the migration SQL**

`prisma/migrations/20260724150000_add_support_ticket_order_link/migration.sql`:

```sql
-- Optional link from a support ticket to the order it's about (customer-
-- picked at creation time) — unlocks the storefront ticket page's Order/
-- Product Summary sidebar. Null for general-purpose tickets.
ALTER TABLE "support_tickets" ADD COLUMN "order_id" INTEGER;

CREATE INDEX "ix_support_tickets_order_id" ON "support_tickets"("order_id");
```

- [ ] **Step 3: Apply the migration and regenerate the client**

Run: `pnpm prisma migrate dev --name add_support_ticket_order_link`
Expected: prisma reports the migration as already present on disk (since we hand-wrote it) and applies it, then regenerates `@prisma/client`. If it instead tries to generate a *different* migration, stop and reconcile — the SQL above must be exactly what gets applied.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: passes (no consumer references `orderId` yet, so this is just confirming the generated client compiles).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260724150000_add_support_ticket_order_link
git commit -m "feat(db): link support tickets to an order (nullable FK)"
```

---

### Task 2: crud/support.ts — order-aware create, order-joined read, self-close, reopen

**Files:**
- Modify: `packages/db/src/crud/support.ts`
- Modify: `packages/db/src/crud/support.test.ts`

**Interfaces:**
- Consumes: `TicketStatus`, `SenderType` from `@app/core/enums`; `addDays` from `@app/core/datetime`; `Db` from `./_types`.
- Produces:
  - `createTicket(db, userId, message, photoFileIds?, attachmentUrls?, orderId?: number | null)` — extended, backward-compatible (new param is optional/trailing).
  - `getTicketWithOrder(db, ticketId): Promise<(SupportTicket & { order: (Order & { items: (OrderItem & { product: Denomination })[]; voucher: Voucher | null }) | null }) | null>`
  - `closeTicketByUser(db, ticketId): Promise<boolean>` — true iff this call flipped it to CLOSED.
  - `TICKET_REOPEN_WINDOW_DAYS: number` (= 7).
  - `reopenTicket(db, ticketId): Promise<{ ok: true } | { ok: false; reason: "not_closed" | "window_expired" }>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/db/src/crud/support.test.ts` (add the import and new `describe` blocks; keep the existing `closeTicket atomic guard` / `attachmentUrls` blocks untouched):

```ts
import {
  closeTicket,
  createTicket,
  addTicketMessage,
  getTicketWithOrder,
  closeTicketByUser,
  reopenTicket,
  TICKET_REOPEN_WINDOW_DAYS,
} from "./support";
```

(replace the existing `import { closeTicket, createTicket, addTicketMessage } from "./support";` line with the block above)

```ts
describe("createTicket + getTicketWithOrder — order linkage", () => {
  it("createTicket with no orderId leaves the ticket unlinked, order comes back null", async () => {
    const user = await makeUser(900n);
    const ticket = await createTicket(prisma, user.id, "general question");
    expect(ticket.orderId).toBeNull();

    const withOrder = await getTicketWithOrder(prisma, ticket.id);
    expect(withOrder!.order).toBeNull();
  });

  it("createTicket with an orderId links it, getTicketWithOrder returns the order + items + voucher", async () => {
    const user = await makeUser(901n);
    const voucher = await prisma.voucher.create({
      data: { code: `TICKV${Math.random()}`, type: "PERCENT", value: "10" },
    });
    const category = await prisma.category.create({ data: { name: `Cat${Math.random()}`, slug: `cat-${Math.random()}` } });
    const product = await prisma.product.create({
      data: { categoryId: category.id, name: "Prod", slug: `prod-${Math.random()}` },
    });
    const denom = await prisma.denomination.create({
      data: { productId: product.id, name: "1 Month", slug: `denom-${Math.random()}`, type: "auto", durationLabel: "1 month", price: "10000" },
    });
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-TICKV-${Math.random()}`,
        userId: user.id,
        subtotalAmount: "10000",
        totalAmount: "10000",
        voucherId: voucher.id,
        status: "DELIVERED",
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: denom.id, unitPrice: "10000", warrantyDaysSnapshot: 30 },
    });

    const ticket = await createTicket(prisma, user.id, "issue with this order", null, null, order.id);
    expect(ticket.orderId).toBe(order.id);

    const withOrder = await getTicketWithOrder(prisma, ticket.id);
    expect(withOrder!.order!.orderCode).toBe(order.orderCode);
    expect(withOrder!.order!.voucher!.code).toBe(voucher.code);
    expect(withOrder!.order!.items).toHaveLength(1);
    // OrderItem's `product` relation resolves to the Denomination row (a
    // pre-existing schema naming quirk — see the "Phase 5 cleanup" comment
    // on OrderItem in prisma/schema.prisma), not the Product row, so this
    // asserts the Denomination's own `name`/`durationLabel` — the same
    // fields apiAccount.ts's GET /account/orders/:code route already reads
    // this same way (Task 4 mirrors that exact convention).
    expect(withOrder!.order!.items[0]!.product.name).toBe("1 Month");
    expect(withOrder!.order!.items[0]!.product.durationLabel).toBe("1 month");
    expect(withOrder!.order!.items[0]!.warrantyDaysSnapshot).toBe(30);
  });

  it("getTicketWithOrder returns null for a non-existent ticket", async () => {
    expect(await getTicketWithOrder(prisma, 999999)).toBeNull();
  });
});

describe("closeTicketByUser", () => {
  it("closes an OPEN ticket and returns true", async () => {
    const user = await makeUser(910n);
    const ticket = await createTicket(prisma, user.id, "help");
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(true);
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
    expect(fresh!.closedAt).not.toBeNull();
  });

  it("a second call on an already-CLOSED ticket returns false (no-op)", async () => {
    const user = await makeUser(911n);
    const ticket = await createTicket(prisma, user.id, "help");
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(true);
    expect(await closeTicketByUser(prisma, ticket.id)).toBe(false);
  });
});

describe("reopenTicket", () => {
  it("reopens a ticket closed within the window, clearing closedAt", async () => {
    const user = await makeUser(920n);
    const ticket = await createTicket(prisma, user.id, "help");
    await closeTicket(prisma, ticket.id);

    const result = await reopenTicket(prisma, ticket.id);
    expect(result).toEqual({ ok: true });
    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.OPEN);
    expect(fresh!.closedAt).toBeNull();
  });

  it("refuses to reopen a ticket that isn't CLOSED", async () => {
    const user = await makeUser(921n);
    const ticket = await createTicket(prisma, user.id, "help"); // still OPEN
    const result = await reopenTicket(prisma, ticket.id);
    expect(result).toEqual({ ok: false, reason: "not_closed" });
  });

  it("refuses to reopen once the window has expired", async () => {
    const user = await makeUser(922n);
    const ticket = await createTicket(prisma, user.id, "help");
    await closeTicket(prisma, ticket.id);
    // Backdate closedAt past the window — no real clock waiting needed.
    const wayPast = new Date(Date.now() - (TICKET_REOPEN_WINDOW_DAYS + 1) * 86_400_000);
    await prisma.supportTicket.update({ where: { id: ticket.id }, data: { closedAt: wayPast } });

    const result = await reopenTicket(prisma, ticket.id);
    expect(result).toEqual({ ok: false, reason: "window_expired" });
  });

  it("returns not_closed for a non-existent ticket", async () => {
    expect(await reopenTicket(prisma, 999999)).toEqual({ ok: false, reason: "not_closed" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- support.test.ts`
Expected: FAIL — `getTicketWithOrder`, `closeTicketByUser`, `reopenTicket`, `TICKET_REOPEN_WINDOW_DAYS` are not exported yet.

- [ ] **Step 3: Implement**

In `packages/db/src/crud/support.ts`, change the top import and add the new functions:

```ts
import { TicketStatus, SenderType } from "@app/core/enums";
import { addDays } from "@app/core/datetime";
import type { Db } from "./_types";
```

Replace the existing `createTicket` with:

```ts
export function createTicket(
  db: Db,
  userId: number,
  message: string,
  photoFileIds: string | null = null,
  attachmentUrls: string | null = null,
  orderId: number | null = null,
) {
  return db.supportTicket.create({ data: { userId, message, photoFileIds, attachmentUrls, orderId } });
}
```

Add, right after the existing `getTicket`:

```ts
/** Ticket + its linked order (items with denomination, voucher) when one is
 * set — a single query, `order: null` when the ticket isn't linked. Used by
 * the storefront ticket detail page's Order/Product Summary sidebar; the
 * admin route and the reply/close/reopen ownership checks keep using the
 * lighter `getTicket` since they don't need the join. */
export function getTicketWithOrder(db: Db, ticketId: number) {
  return db.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      order: {
        include: { items: { include: { product: true } }, voucher: true },
      },
    },
  });
}
```

Add, after `closeTicket`:

```ts
/** Customer self-close ("Issue Solved"). Same atomic conditional guard as
 * closeTicket, but the caller (the route) already verified ownership via
 * getTicket before calling this — this function only guards against a
 * double-tap / race with an admin closing the same ticket concurrently.
 * Returns false when there was nothing to close. */
export async function closeTicketByUser(db: Db, ticketId: number): Promise<boolean> {
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: { not: TicketStatus.CLOSED } },
    data: { status: TicketStatus.CLOSED, closedAt: new Date() },
  });
  return res.count === 1;
}

/** How long after closedAt a customer can still self-reopen a ticket before
 * being told to open a new one instead. */
export const TICKET_REOPEN_WINDOW_DAYS = 7;

export type ReopenFailureReason = "not_closed" | "window_expired";

/** Reopen a CLOSED ticket back to OPEN, only within TICKET_REOPEN_WINDOW_DAYS
 * of closedAt. The caller (the route) already verified ownership via
 * getTicket before calling this. */
export async function reopenTicket(
  db: Db,
  ticketId: number,
): Promise<{ ok: true } | { ok: false; reason: ReopenFailureReason }> {
  const ticket = await db.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket || ticket.status !== TicketStatus.CLOSED || !ticket.closedAt) {
    return { ok: false, reason: "not_closed" };
  }
  if (addDays(ticket.closedAt, TICKET_REOPEN_WINDOW_DAYS).getTime() < Date.now()) {
    return { ok: false, reason: "window_expired" };
  }
  await db.supportTicket.update({
    where: { id: ticketId },
    data: { status: TicketStatus.OPEN, closedAt: null },
  });
  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- support.test.ts`
Expected: PASS, all tests including the pre-existing `closeTicket atomic guard` / `attachmentUrls` ones.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/crud/support.ts packages/db/src/crud/support.test.ts
git commit -m "feat(db): add order-joined ticket read, customer self-close, and reopen"
```

---

### Task 3: Multipart ticket submission accepts an order_code field

**Files:**
- Modify: `apps/storefront/src/lib/ticketAttachments.ts`

**Interfaces:**
- Produces: `TicketSubmission` gains `orderCode: string | null`.

- [ ] **Step 1: Implement (no isolated unit test file exists for this module — it's covered via the route tests in Task 4)**

In `apps/storefront/src/lib/ticketAttachments.ts`, change the interface and parser:

```ts
export interface TicketSubmission {
  message: string;
  attachmentUrls: string | null;
  orderCode: string | null;
}
```

```ts
export async function parseTicketMultipart(req: FastifyRequest): Promise<TicketSubmission> {
  let message = "";
  let orderCode = "";
  const urls: string[] = [];
  let fileCount = 0;
  for await (const part of req.parts({ limits: { fileSize: MAX_VIDEO_BYTES } })) {
    if (part.type === "field" && part.fieldname === "message") {
      message = String(part.value ?? "");
      continue;
    }
    if (part.type === "field" && part.fieldname === "order_code") {
      orderCode = String(part.value ?? "");
      continue;
    }
    if (part.type !== "file") continue;
    if (part.fieldname !== "attachments") {
      part.file.resume();
      continue;
    }
    fileCount += 1;
    if (fileCount > MAX_TICKET_ATTACHMENTS) {
      part.file.resume();
      throw new ValidationError("web.support_attach_error_count");
    }
    const mimetype = part.mimetype;
    const chunks: Buffer[] = [];
    for await (const chunk of part.file) chunks.push(chunk);
    if (part.file.truncated) throw new ValidationError("web.support_attach_error_size");
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) continue;
    urls.push(await saveAttachment(buffer, mimetype));
  }
  return {
    message: message.trim().slice(0, MAX_MESSAGE_LENGTH),
    attachmentUrls: urls.length ? urls.join(",") : null,
    orderCode: orderCode.trim() || null,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: fails at this point because nothing destructures `orderCode` yet from the one call site — that's fixed in Task 4. If your tool requires a clean typecheck before committing, do Task 3 and Task 4 as one commit instead of stopping here.

- [ ] **Step 3: Commit together with Task 4** (see Task 4's commit step — this file's change has no independent test, so it's committed as part of the route task).

---

### Task 4: apiAccount.ts — order_code on create, enriched detail, self-close, reopen

**Files:**
- Modify: `apps/storefront/src/routes/apiAccount.ts`
- Modify: `apps/storefront/test/spa-api.test.ts`

**Interfaces:**
- Consumes: `createTicket`, `getTicketWithOrder`, `closeTicketByUser`, `reopenTicket`, `TICKET_REOPEN_WINDOW_DAYS`, `getOrderByCodeFull` from `@app/db`; `customerStatusLabel` from `@app/core/enums`; `addDays` from `@app/core/datetime`.
- Produces: `POST /account/support` accepts optional `order_code`; `GET /account/support/:id` response gains `ticket.replied_at_display`, `ticket.closed_at_display`, `ticket.reopenable`, and top-level `order: TicketOrderSummary | null`; new `POST /account/support/:id/close`, `POST /account/support/:id/reopen`.

- [ ] **Step 1: Write the failing tests**

In `apps/storefront/test/spa-api.test.ts`, add `OrderStatus` is already imported; add `getOrderByCodeFull` isn't needed in the test file. Insert these new `it()` blocks right after the existing `it("another user's ticket 404s (never 403)", ...)` block (still inside the `describe("signed in", ...)` block, so `cookie`/`csrf`/`buyerId` are in scope):

```ts
    it("support ticket: create with an order_code links it; GET :id returns the order summary", async () => {
      const stock = await prisma.stockItem.create({
        data: { productId: denomId, credentials: "tick-order@mail.com:pw", status: "SOLD" },
      });
      const order = await prisma.order.create({
        data: {
          orderCode: `ORD-TICKORD-${Math.random()}`,
          userId: buyerId,
          subtotalAmount: "40000",
          totalAmount: "40000",
          status: OrderStatus.DELIVERED,
          paidAt: new Date(),
          deliveredAt: new Date(),
        },
      });
      await prisma.orderItem.create({
        data: { orderId: order.id, productId: denomId, stockItemId: stock.id, unitPrice: "40000", warrantyDaysSnapshot: 30 },
      });

      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "issue with this order", order_code: order.orderCode },
      });
      expect(create.statusCode).toBe(200);
      const ticketId = create.json().ticket_id as number;

      const detail = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      expect(detail.statusCode).toBe(200);
      const body = detail.json();
      expect(body.order.code).toBe(order.orderCode);
      expect(body.order.delivered).toBe(true);
      expect(body.order.items).toHaveLength(1);
      expect(body.order.items[0].warranty_days).toBe(30);
      expect(body.order.items[0].warranty_active).toBe(true);
      expect(typeof body.order.status_label).toBe("string");
    });

    it("support ticket: create with an order_code belonging to someone else is rejected", async () => {
      await makeUser("ticketorderthief", "thief-pw-1234", "TICKTHIEF");
      const other = await loginAs("ticketorderthief", "thief-pw-1234");
      const otherOrder = await prisma.order.create({
        data: {
          orderCode: `ORD-NOTMINE-${Math.random()}`,
          userId: buyerId, // belongs to buyerId, not the "other" session below
          subtotalAmount: "1000",
          totalAmount: "1000",
          status: OrderStatus.DELIVERED,
        },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie: other.cookie, "x-csrf-token": other.csrf },
        payload: { message: "not my order", order_code: otherOrder.orderCode },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "error.order_not_found" });
    });

    it("support ticket without an order_code still creates fine, GET :id returns order: null", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "general question, no order" },
      });
      expect(create.statusCode).toBe(200);
      const ticketId = create.json().ticket_id as number;
      const detail = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      expect(detail.json().order).toBeNull();
    });

    it("close (trio) then GET :id shows closed + reopenable; reopen (trio) flips it back to open", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "will self-close this one" },
      });
      const ticketId = create.json().ticket_id as number;

      const anonClose = await app.inject({ method: "POST", url: `/api/v1/account/support/${ticketId}/close` });
      expect(anonClose.statusCode).toBe(401);
      const badClose = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie, "x-csrf-token": "bad" },
      });
      expect(badClose.statusCode).toBe(403);
      const okClose = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(okClose.statusCode).toBe(200);

      const afterClose = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      expect(afterClose.json().ticket.closed).toBe(true);
      expect(afterClose.json().ticket.reopenable).toBe(true);

      const secondClose = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(secondClose.statusCode).toBe(409);

      const anonReopen = await app.inject({ method: "POST", url: `/api/v1/account/support/${ticketId}/reopen` });
      expect(anonReopen.statusCode).toBe(401);
      const badReopen = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/reopen`,
        headers: { cookie, "x-csrf-token": "bad" },
      });
      expect(badReopen.statusCode).toBe(403);
      const okReopen = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/reopen`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(okReopen.statusCode).toBe(200);

      const afterReopen = await app.inject({ method: "GET", url: `/api/v1/account/support/${ticketId}`, headers: { cookie } });
      expect(afterReopen.json().ticket.status.toLowerCase()).toBe("open");
      expect(afterReopen.json().ticket.closed).toBe(false);
    });

    it("reopen past the window returns 400 error.ticket_reopen_expired", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "will expire" },
      });
      const ticketId = create.json().ticket_id as number;
      await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      await prisma.supportTicket.update({
        where: { id: ticketId },
        data: { closedAt: new Date(Date.now() - 8 * 86_400_000) },
      });
      const reopen = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/reopen`,
        headers: { cookie, "x-csrf-token": csrf },
      });
      expect(reopen.statusCode).toBe(400);
      expect(reopen.json()).toEqual({ error: "error.ticket_reopen_expired" });
    });

    it("close/reopen on another user's ticket 404s (never 403)", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/api/v1/account/support",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { message: "mine" },
      });
      const ticketId = create.json().ticket_id as number;
      await makeUser("ticketclosethief", "closethief-pw1", "TICKCLOSE1");
      const other = await loginAs("ticketclosethief", "closethief-pw1");
      const probe = await app.inject({
        method: "POST",
        url: `/api/v1/account/support/${ticketId}/close`,
        headers: { cookie: other.cookie, "x-csrf-token": other.csrf },
      });
      expect(probe.statusCode).toBe(404);
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- spa-api.test.ts`
Expected: FAIL — `order_code` is ignored, `/close` and `/reopen` routes don't exist (404 for wrong reason / route-not-found), `order` field missing from the GET response.

- [ ] **Step 3: Implement**

In `apps/storefront/src/routes/apiAccount.ts`:

Update the `@app/core/enums` import to add `OrderStatus` is already imported — also add `customerStatusLabel`:

```ts
import { SenderType, OrderStatus, TicketStatus, customerStatusLabel } from "@app/core/enums";
```

Add `addDays` to the datetime import:

```ts
import { localize, addDays } from "@app/core/datetime";
```

Update the `@app/db` import block to add the new crud functions:

```ts
import {
  prisma,
  setSetting,
  listUserOrders,
  countUserOrders,
  getOrderByCodeFull,
  updateOrderCustomerData,
  listUserDeliveredOrders,
  listUserTickets,
  listTicketMessages,
  getTicket,
  getTicketWithOrder,
  createTicket,
  addTicketMessage,
  closeTicketByUser,
  reopenTicket,
  TICKET_REOPEN_WINDOW_DAYS,
  createReview,
  listReviews,
  subscribeToRestock,
  getDenominationWithProduct,
  setLoginCredentials,
  LOGIN_USERNAME_RE,
} from "@app/db";
```

Replace the `POST /account/support` handler:

```ts
  app.post<{ Body: { message?: string; order_code?: string } }>("/account/support", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    let message: string;
    let attachmentUrls: string | null = null;
    let orderCodeInput: string | null = null;
    if (req.isMultipart()) {
      try {
        ({ message, attachmentUrls, orderCode: orderCodeInput } = await parseTicketMultipart(req));
      } catch (e) {
        if (e instanceof ValidationError) return reply.code(400).send({ error: e.key });
        throw e;
      }
    } else {
      message = (req.body?.message ?? "").trim().slice(0, 2000);
      orderCodeInput = (req.body?.order_code ?? "").trim() || null;
    }
    let orderId: number | null = null;
    if (orderCodeInput) {
      const order = await getOrderByCodeFull(prisma, orderCodeInput);
      if (!order || order.userId !== customer.userId) {
        return reply.code(400).send({ error: "error.order_not_found" });
      }
      orderId = order.id;
    }
    let ticketId: number | null = null;
    if (message) {
      const ticket = await createTicket(prisma, customer.userId, message, null, attachmentUrls, orderId);
      ticketId = ticket.id;
    }
    // STO-020: the client shows a "Ticket #N created" success toast — needs
    // the new ticket's id, which `{ ok: true }` alone never carried.
    return reply.send({ ok: true, ticket_id: ticketId });
  });
```

Replace the `GET /account/support/:id` handler:

```ts
  app.get<{ Params: { id: string } }>("/account/support/:id", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const ticket = await getTicketWithOrder(prisma, Number(req.params.id));
    if (!ticket || ticket.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const messages = await listTicketMessages(prisma, ticket.id, 30);
    const order = ticket.order;
    const reopenable =
      ticket.status === TicketStatus.CLOSED && ticket.closedAt != null
        ? addDays(ticket.closedAt, TICKET_REOPEN_WINDOW_DAYS).getTime() >= Date.now()
        : false;
    return reply.send({
      ticket: {
        id: ticket.id,
        message: ticket.message,
        status: ticket.status,
        created_at_display: dt(ticket.createdAt),
        admin_reply: ticket.adminReply,
        replied_at_display: ticket.repliedAt ? dt(ticket.repliedAt) : null,
        closed: ticket.status === TicketStatus.CLOSED,
        closed_at_display: ticket.closedAt ? dt(ticket.closedAt) : null,
        reopenable,
        attachments: splitAttachments(ticket.attachmentUrls),
      },
      messages: messages.map((m) => ({
        from_user: m.senderType === SenderType.USER,
        content: m.content,
        created_at_display: dt(m.createdAt),
        attachments: splitAttachments(m.attachmentUrls),
      })),
      order: order
        ? {
            code: order.orderCode,
            status: order.status,
            status_label: customerStatusLabel(order.status),
            created_at_display: dt(order.createdAt),
            paid_at_display: order.paidAt ? dt(order.paidAt) : null,
            payment_method: order.paymentMethod,
            total: order.totalAmount.toString(),
            voucher_code: order.voucher?.code ?? null,
            delivered: order.status === OrderStatus.DELIVERED,
            items: order.items.map((i) => ({
              name: i.product.name,
              duration: i.product.durationLabel,
              warranty_days: i.warrantyDaysSnapshot,
              warranty_expires_at_display: order.deliveredAt
                ? dt(addDays(order.deliveredAt, i.warrantyDaysSnapshot))
                : null,
              warranty_active: order.deliveredAt
                ? addDays(order.deliveredAt, i.warrantyDaysSnapshot).getTime() > Date.now()
                : false,
            })),
          }
        : null,
    });
  });
```

Add two new routes right after it (still inside `// ---- Support ----`):

```ts
  app.post<{ Params: { id: string } }>("/account/support/:id/close", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const ticket = await getTicket(prisma, Number(req.params.id));
    if (!ticket || ticket.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const closed = await closeTicketByUser(prisma, ticket.id);
    if (!closed) return reply.code(409).send({ error: "error.ticket_already_closed" });
    return reply.send({ ok: true });
  });

  app.post<{ Params: { id: string } }>("/account/support/:id/reopen", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const ticket = await getTicket(prisma, Number(req.params.id));
    if (!ticket || ticket.userId !== customer.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const result = await reopenTicket(prisma, ticket.id);
    if (!result.ok) {
      const key = result.reason === "window_expired" ? "error.ticket_reopen_expired" : "error.ticket_not_closed";
      return reply.code(400).send({ error: key });
    }
    return reply.send({ ok: true });
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- spa-api.test.ts`
Expected: PASS, all tests including the pre-existing support-ticket ones.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: passes (this also closes out Task 3's dangling typecheck failure).

- [ ] **Step 6: Add the two new error keys used above**

In `packages/core/locales/en.json`, add near the other `error.ticket_*`/`error.order_*` keys (e.g. right after `"error.ticket_not_found": "Ticket not found.",`):

```json
  "error.ticket_already_closed": "This ticket is already closed.",
  "error.ticket_not_closed": "This ticket isn't closed.",
  "error.ticket_reopen_expired": "This ticket can no longer be reopened — please create a new ticket.",
```

In `packages/core/locales/id.json`, same position:

```json
  "error.ticket_already_closed": "Tiket ini sudah ditutup.",
  "error.ticket_not_closed": "Tiket ini belum ditutup.",
  "error.ticket_reopen_expired": "Tiket ini sudah tidak bisa dibuka lagi — silakan buat tiket baru.",
```

- [ ] **Step 7: Commit**

```bash
git add apps/storefront/src/lib/ticketAttachments.ts apps/storefront/src/routes/apiAccount.ts apps/storefront/test/spa-api.test.ts packages/core/locales/en.json packages/core/locales/id.json
git commit -m "feat(storefront): order-linked ticket creation, self-close, and reopen routes"
```

---

### Task 5: Remaining i18n keys for the new UI

**Files:**
- Modify: `packages/core/locales/en.json`
- Modify: `packages/core/locales/id.json`

**Interfaces:**
- Produces: every `web.ticket_*`/`web.date_*` key the frontend tasks below reference.

- [ ] **Step 1: Add the English keys**

In `packages/core/locales/en.json`, insert this block right after the existing `"web.ticket": "Ticket",` line:

```json
  "web.ticket_status_open": "Waiting for Support",
  "web.ticket_status_replied": "Waiting for Your Reply",
  "web.ticket_status_closed": "Closed",
  "web.ticket_event_created": "Ticket created",
  "web.ticket_event_closed": "Ticket closed",
  "web.ticket_sender_you": "You",
  "web.ticket_sender_support": "Support",
  "web.date_today": "Today",
  "web.date_yesterday": "Yesterday",
  "web.ticket_re_order": "Re: Order",
  "web.ticket_created_at": "Created {date}",
  "web.ticket_estimated_reply": "Usually within a few hours",
  "web.ticket_waiting_title": "Waiting for Support",
  "web.ticket_waiting_desc": "Our team usually replies within a few hours.",
  "web.ticket_closed_reopenable": "This ticket is closed. You can still reopen it if the issue isn't resolved.",
  "web.ticket_closed_expired": "This ticket is closed.",
  "web.ticket_reopen_btn": "Reopen ticket",
  "web.ticket_quick_issue_solved": "Issue solved",
  "web.ticket_quick_still_not_working": "Still not working",
  "web.ticket_quick_request_refund": "Request a refund",
  "web.ticket_quick_replace_credentials": "Replace credentials",
  "web.ticket_template_still_not_working": "This still isn't working after your last reply. Here's what I'm still seeing: ",
  "web.ticket_template_request_refund": "I'd like to request a refund for this order. Reason: ",
  "web.ticket_template_replace_credentials": "Could you replace the credentials for this order? What's wrong with them: ",
  "web.ticket_composer_shortcut": "Ctrl/Cmd + Enter to send",
  "web.ticket_order_summary_title": "Order summary",
  "web.ticket_no_order_linked": "This ticket isn't linked to a specific order.",
  "web.ticket_warranty_until": "Warranty until {date}",
  "web.ticket_warranty_expired": "Warranty expired",
  "web.ticket_payment_method": "Payment method",
  "web.ticket_voucher_used": "Voucher used",
  "web.ticket_view_order": "View order",
  "web.ticket_download_credentials": "Download credentials",
  "web.ticket_copy_order_code": "Copy order number",
  "web.ticket_trust_title": "Why trust us",
  "web.ticket_trust_warranty": "Warranty included",
  "web.ticket_trust_verified": "Verified purchase",
  "web.ticket_trust_delivery": "Automatic delivery",
  "web.ticket_trust_encrypted": "Encrypted credentials",
  "web.ticket_recent_title": "Your recent tickets",
  "web.ticket_help_title": "Need more help?",
  "web.ticket_help_telegram": "Message us on Telegram",
  "web.ticket_help_email_hint": "Or reply directly on this ticket — our team monitors it.",
  "web.ticket_new_ticket_link": "Start a new ticket",
  "web.ticket_order_picker_label": "Which order is this about? (optional)",
  "web.ticket_order_picker_none": "General question, not order-specific",
```

- [ ] **Step 2: Add the matching Indonesian keys**

In `packages/core/locales/id.json`, insert this block in the same position (right after `"web.ticket": "Tiket",`):

```json
  "web.ticket_status_open": "Menunggu Dukungan",
  "web.ticket_status_replied": "Menunggu Balasanmu",
  "web.ticket_status_closed": "Ditutup",
  "web.ticket_event_created": "Tiket dibuat",
  "web.ticket_event_closed": "Tiket ditutup",
  "web.ticket_sender_you": "Kamu",
  "web.ticket_sender_support": "Support",
  "web.date_today": "Hari ini",
  "web.date_yesterday": "Kemarin",
  "web.ticket_re_order": "Re: Pesanan",
  "web.ticket_created_at": "Dibuat {date}",
  "web.ticket_estimated_reply": "Biasanya dibalas dalam beberapa jam",
  "web.ticket_waiting_title": "Menunggu Dukungan",
  "web.ticket_waiting_desc": "Tim kami biasanya membalas dalam beberapa jam.",
  "web.ticket_closed_reopenable": "Tiket ini sudah ditutup. Kamu masih bisa membukanya lagi jika masalahnya belum selesai.",
  "web.ticket_closed_expired": "Tiket ini sudah ditutup.",
  "web.ticket_reopen_btn": "Buka lagi tiket",
  "web.ticket_quick_issue_solved": "Masalah selesai",
  "web.ticket_quick_still_not_working": "Masih belum berhasil",
  "web.ticket_quick_request_refund": "Minta refund",
  "web.ticket_quick_replace_credentials": "Minta ganti kredensial",
  "web.ticket_template_still_not_working": "Masih belum berhasil setelah balasan terakhir. Berikut yang masih saya alami: ",
  "web.ticket_template_request_refund": "Saya ingin mengajukan refund untuk pesanan ini. Alasan: ",
  "web.ticket_template_replace_credentials": "Bisa tolong ganti kredensial untuk pesanan ini? Masalahnya: ",
  "web.ticket_composer_shortcut": "Ctrl/Cmd + Enter untuk kirim",
  "web.ticket_order_summary_title": "Ringkasan pesanan",
  "web.ticket_no_order_linked": "Tiket ini tidak terkait dengan pesanan tertentu.",
  "web.ticket_warranty_until": "Garansi sampai {date}",
  "web.ticket_warranty_expired": "Garansi berakhir",
  "web.ticket_payment_method": "Metode pembayaran",
  "web.ticket_voucher_used": "Voucher dipakai",
  "web.ticket_view_order": "Lihat pesanan",
  "web.ticket_download_credentials": "Unduh kredensial",
  "web.ticket_copy_order_code": "Salin nomor pesanan",
  "web.ticket_trust_title": "Kenapa percaya kami",
  "web.ticket_trust_warranty": "Termasuk garansi",
  "web.ticket_trust_verified": "Pembelian terverifikasi",
  "web.ticket_trust_delivery": "Pengiriman otomatis",
  "web.ticket_trust_encrypted": "Kredensial terenkripsi",
  "web.ticket_recent_title": "Tiket terbarumu",
  "web.ticket_help_title": "Butuh bantuan lagi?",
  "web.ticket_help_telegram": "Chat kami di Telegram",
  "web.ticket_help_email_hint": "Atau balas langsung di tiket ini — tim kami memantaunya.",
  "web.ticket_new_ticket_link": "Buat tiket baru",
  "web.ticket_order_picker_label": "Tiket ini soal pesanan yang mana? (opsional)",
  "web.ticket_order_picker_none": "Pertanyaan umum, bukan soal pesanan tertentu",
```

- [ ] **Step 2: Verify the two locale files still have identical key sets**

Run: `pnpm test -- i18n` (finds and runs `apps/storefront/client/src/lib/i18n.test.ts`, and any other i18n-named test file in the repo — the single root `vitest.config.ts` covers every package, there is no per-package `test` script)
Expected: PASS — same key count/set in both files.

- [ ] **Step 3: Commit**

```bash
git add packages/core/locales/en.json packages/core/locales/id.json
git commit -m "feat(i18n): add copy for the redesigned ticket workspace"
```

---

### Task 6: api/types.ts — new response shapes

**Files:**
- Modify: `apps/storefront/client/src/api/types.ts`

**Interfaces:**
- Produces: `TicketOrderItem`, `TicketOrderSummary`, extended `TicketMessage`/`TicketDetailData`.

- [ ] **Step 1: Implement**

In `apps/storefront/client/src/api/types.ts`, replace the `TicketMessage`/`TicketDetailData` block (currently right after `SupportData`) with:

```ts
/** A single message on the ticket thread (either side). */
export interface TicketMessage {
  from_user: boolean;
  content: string;
  created_at_display: string;
  attachments: string[];
}

/** One line item on a ticket's linked order — JSON twin of the shape
 * apiAccount.ts's GET /account/support/:id builds from getTicketWithOrder(). */
export interface TicketOrderItem {
  name: string;
  duration: string | null;
  warranty_days: number;
  warranty_expires_at_display: string | null;
  warranty_active: boolean;
}

/** The linked order's summary shown in the ticket page's sidebar — null when
 * the ticket isn't linked to an order. */
export interface TicketOrderSummary {
  code: string;
  status: string;
  status_label: string;
  created_at_display: string;
  paid_at_display: string | null;
  payment_method: string;
  total: string;
  voucher_code: string | null;
  delivered: boolean;
  items: TicketOrderItem[];
}

/** GET /api/v1/account/support/:id. */
export interface TicketDetailData {
  ticket: {
    id: number;
    message: string;
    status: string;
    created_at_display: string;
    admin_reply: string | null;
    /** Timestamp of the legacy single admin_reply field, if set — null when
     * admin_reply is null. Used to place that bubble correctly in the merged
     * timeline (see ticketTimeline.ts). */
    replied_at_display: string | null;
    closed: boolean;
    closed_at_display: string | null;
    /** True while a closed ticket is still within the self-reopen window. */
    reopenable: boolean;
    attachments: string[];
  };
  messages: TicketMessage[];
  order: TicketOrderSummary | null;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: fails in `TicketDetailPage.tsx`/`TicketDetailPage.test.tsx` (they reference the old shape without `order`/`replied_at_display`/etc.) — that's expected and fixed in Task 14. If your workflow requires green typecheck per commit, fold this task's commit into Task 14's instead of committing standalone.

- [ ] **Step 3: Commit**

```bash
git add apps/storefront/client/src/api/types.ts
git commit -m "feat(storefront-client): add TicketOrderSummary types, extend TicketDetailData"
```

---

### Task 7: ticketTimeline.ts — merge ticket + messages + system events

**Files:**
- Create: `apps/storefront/client/src/lib/ticketTimeline.ts`
- Create: `apps/storefront/client/src/lib/ticketTimeline.test.ts`

**Interfaces:**
- Consumes: `TicketMessage` from `../api/types`.
- Produces: `TicketTimelineEntry`, `TicketTimelineInput`, `buildTicketTimeline(ticket, messages): TicketTimelineEntry[]`.

- [ ] **Step 1: Write the failing test**

`apps/storefront/client/src/lib/ticketTimeline.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTicketTimeline } from "./ticketTimeline";
import type { TicketMessage } from "../api/types";

const baseTicket = {
  message: "It broke",
  created_at_display: "2026-07-01 09:00",
  admin_reply: null as string | null,
  replied_at_display: null as string | null,
  closed_at_display: null as string | null,
  attachments: [] as string[],
};

describe("buildTicketTimeline", () => {
  it("starts with a Created system event and the ticket's own message", () => {
    const entries = buildTicketTimeline(baseTicket, []);
    expect(entries[0]).toMatchObject({ kind: "system", key: "created" });
    expect(entries[1]).toMatchObject({ kind: "message", from_user: true, content: "It broke" });
  });

  it("sorts messages, legacy admin_reply, and the closed event chronologically", () => {
    const messages: TicketMessage[] = [
      { from_user: false, content: "reply 1", created_at_display: "2026-07-01 09:05", attachments: [] },
      { from_user: true, content: "follow up", created_at_display: "2026-07-01 09:10", attachments: [] },
    ];
    const entries = buildTicketTimeline(
      {
        ...baseTicket,
        admin_reply: "legacy reply",
        replied_at_display: "2026-07-01 09:02",
        closed_at_display: "2026-07-01 09:20",
      },
      messages,
    );
    const order = entries.map((e) => (e.kind === "system" ? `system:${e.key}` : e.kind === "message" ? e.content : ""));
    expect(order).toEqual([
      "system:created", // 09:00
      "It broke", // 09:00
      "legacy reply", // 09:02
      "reply 1", // 09:05
      "follow up", // 09:10
      "system:closed", // 09:20
    ]);
  });

  it("omits the legacy admin_reply entry when null, and the closed event when not closed", () => {
    const entries = buildTicketTimeline(baseTicket, []);
    expect(entries.some((e) => e.kind === "message" && e.content === "legacy reply")).toBe(false);
    expect(entries.some((e) => e.kind === "system" && e.key === "closed")).toBe(false);
  });

  it("carries attachments through on both the ticket's own message and thread messages", () => {
    const entries = buildTicketTimeline(
      { ...baseTicket, attachments: ["/uploads/tickets/a.png"] },
      [{ from_user: true, content: "more evidence", created_at_display: "2026-07-01 09:05", attachments: ["/uploads/tickets/b.png"] }],
    );
    const own = entries.find((e) => e.kind === "message" && e.content === "It broke");
    const thread = entries.find((e) => e.kind === "message" && e.content === "more evidence");
    expect(own).toMatchObject({ attachments: ["/uploads/tickets/a.png"] });
    expect(thread).toMatchObject({ attachments: ["/uploads/tickets/b.png"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- ticketTimeline.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

`apps/storefront/client/src/lib/ticketTimeline.ts`:

```ts
/**
 * Merges a ticket's own opening message, its legacy single `admin_reply`
 * field (older tickets replied-to before the TicketMessage thread existed),
 * the message thread, and synthetic Created/Closed events into one
 * chronological feed for TicketMessageThread to render.
 *
 * Every `created_at_display` the server sends is pre-formatted
 * "yyyy-LL-dd HH:mm" (shop timezone, zero-padded) — that format sorts
 * correctly as a plain string, so no separate ISO/epoch field is needed just
 * to order the merged feed.
 */
import type { TicketMessage } from "../api/types";

export interface SystemTimelineEvent {
  kind: "system";
  key: "created" | "closed";
  labelKey: string;
  created_at_display: string;
}

export interface MessageTimelineEntry {
  kind: "message";
  from_user: boolean;
  content: string;
  created_at_display: string;
  attachments: string[];
}

export type TicketTimelineEntry = SystemTimelineEvent | MessageTimelineEntry;

export interface TicketTimelineInput {
  message: string;
  created_at_display: string;
  admin_reply: string | null;
  replied_at_display: string | null;
  closed_at_display: string | null;
  attachments: string[];
}

export function buildTicketTimeline(ticket: TicketTimelineInput, messages: TicketMessage[]): TicketTimelineEntry[] {
  const entries: TicketTimelineEntry[] = [
    { kind: "system", key: "created", labelKey: "web.ticket_event_created", created_at_display: ticket.created_at_display },
    {
      kind: "message",
      from_user: true,
      content: ticket.message,
      created_at_display: ticket.created_at_display,
      attachments: ticket.attachments,
    },
    ...messages.map(
      (m): TicketTimelineEntry => ({
        kind: "message",
        from_user: m.from_user,
        content: m.content,
        created_at_display: m.created_at_display,
        attachments: m.attachments,
      }),
    ),
  ];
  if (ticket.admin_reply) {
    entries.push({
      kind: "message",
      from_user: false,
      content: ticket.admin_reply,
      created_at_display: ticket.replied_at_display ?? ticket.created_at_display,
      attachments: [],
    });
  }
  if (ticket.closed_at_display) {
    entries.push({
      kind: "system",
      key: "closed",
      labelKey: "web.ticket_event_closed",
      created_at_display: ticket.closed_at_display,
    });
  }
  return entries.sort((a, b) => a.created_at_display.localeCompare(b.created_at_display));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- ticketTimeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/client/src/lib/ticketTimeline.ts apps/storefront/client/src/lib/ticketTimeline.test.ts
git commit -m "feat(storefront-client): merge ticket messages + system events into one timeline"
```

---

### Task 8: ticketDraft.ts — localStorage draft autosave helpers

**Files:**
- Create: `apps/storefront/client/src/lib/ticketDraft.ts`
- Create: `apps/storefront/client/src/lib/ticketDraft.test.ts`

**Interfaces:**
- Produces: `loadTicketDraft(ticketId): string`, `saveTicketDraft(ticketId, value): void`, `clearTicketDraft(ticketId): void`.

- [ ] **Step 1: Write the failing test**

`apps/storefront/client/src/lib/ticketDraft.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { loadTicketDraft, saveTicketDraft, clearTicketDraft } from "./ticketDraft";

describe("ticketDraft", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a draft through save/load", () => {
    saveTicketDraft(7, "still working on this");
    expect(loadTicketDraft(7)).toBe("still working on this");
  });

  it("loadTicketDraft returns an empty string when nothing was saved", () => {
    expect(loadTicketDraft(999)).toBe("");
  });

  it("saving an empty/whitespace-only value clears any existing draft instead of storing blank", () => {
    saveTicketDraft(7, "something");
    saveTicketDraft(7, "   ");
    expect(loadTicketDraft(7)).toBe("");
  });

  it("clearTicketDraft removes a stored draft", () => {
    saveTicketDraft(7, "draft text");
    clearTicketDraft(7);
    expect(loadTicketDraft(7)).toBe("");
  });

  it("drafts for different ticket ids don't collide", () => {
    saveTicketDraft(1, "ticket one draft");
    saveTicketDraft(2, "ticket two draft");
    expect(loadTicketDraft(1)).toBe("ticket one draft");
    expect(loadTicketDraft(2)).toBe("ticket two draft");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- ticketDraft.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

`apps/storefront/client/src/lib/ticketDraft.ts`:

```ts
/** Per-ticket reply draft autosave, so a customer who navigates away (or a
 * tab crash) doesn't lose an in-progress reply. localStorage failures
 * (private browsing, quota) are swallowed — draft autosave is a convenience,
 * never worth breaking the reply flow over. */
const PREFIX = "ticket-draft:";

export function loadTicketDraft(ticketId: number): string {
  try {
    return localStorage.getItem(PREFIX + ticketId) ?? "";
  } catch {
    return "";
  }
}

export function saveTicketDraft(ticketId: number, value: string): void {
  try {
    if (value.trim()) localStorage.setItem(PREFIX + ticketId, value);
    else localStorage.removeItem(PREFIX + ticketId);
  } catch {
    // see file header comment
  }
}

export function clearTicketDraft(ticketId: number): void {
  try {
    localStorage.removeItem(PREFIX + ticketId);
  } catch {
    // see file header comment
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- ticketDraft.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/client/src/lib/ticketDraft.ts apps/storefront/client/src/lib/ticketDraft.test.ts
git commit -m "feat(storefront-client): add per-ticket reply draft autosave helpers"
```

---

### Task 9: TicketStatusBadge component

**Files:**
- Create: `apps/storefront/client/src/components/shop/TicketStatusBadge.tsx`
- Create: `apps/storefront/client/src/components/shop/TicketStatusBadge.test.tsx`

**Interfaces:**
- Consumes: `t` from `../../lib/i18n`.
- Produces: `TicketStatusBadge({ value: string })`.

- [ ] **Step 1: Write the failing test**

`apps/storefront/client/src/components/shop/TicketStatusBadge.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import TicketStatusBadge from "./TicketStatusBadge";

describe("TicketStatusBadge", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
  });

  it("shows the friendly label for OPEN", () => {
    render(<TicketStatusBadge value="OPEN" />);
    expect(screen.getByText("Waiting for Support")).toBeInTheDocument();
  });

  it("shows the friendly label for REPLIED (case-insensitive input)", () => {
    render(<TicketStatusBadge value="replied" />);
    expect(screen.getByText("Waiting for Your Reply")).toBeInTheDocument();
  });

  it("shows the friendly label for CLOSED", () => {
    render(<TicketStatusBadge value="CLOSED" />);
    expect(screen.getByText("Closed")).toBeInTheDocument();
  });

  it("falls back to the raw value for an unknown status", () => {
    render(<TicketStatusBadge value="WEIRD" />);
    expect(screen.getByText("WEIRD")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- TicketStatusBadge.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

`apps/storefront/client/src/components/shop/TicketStatusBadge.tsx`:

```tsx
/** Ticket-specific status chip — friendlier copy + an icon than the generic
 * StatusBadge (which is shared across orders/stock/etc. and can't carry
 * ticket-specific wording without changing behavior everywhere else it's
 * used). Same visual language (the shared `chip` class + tone colors). */
import { Clock, MessageCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";

const LABEL_KEY: Record<string, string> = {
  open: "web.ticket_status_open",
  replied: "web.ticket_status_replied",
  closed: "web.ticket_status_closed",
};
const ICON: Record<string, LucideIcon> = {
  open: Clock,
  replied: MessageCircle,
  closed: CheckCircle2,
};
const TONE: Record<string, string> = {
  open: "bg-pine-tint text-pine-dark",
  replied: "bg-amberx-tint text-amberx",
  closed: "bg-grass-tint text-grass-dark",
};

export default function TicketStatusBadge({ value }: { value: string }) {
  const v = String(value).toLowerCase();
  const Icon = ICON[v] ?? Clock;
  const tone = TONE[v] ?? "bg-sand text-ink-soft";
  const label = LABEL_KEY[v] ? t(LABEL_KEY[v]!) : value;
  return (
    <span className={`chip inline-flex items-center gap-1 ${tone}`}>
      <Icon className="w-3.5 h-3.5" /> {label}
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- TicketStatusBadge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/client/src/components/shop/TicketStatusBadge.tsx apps/storefront/client/src/components/shop/TicketStatusBadge.test.tsx
git commit -m "feat(storefront-client): add ticket-specific status badge"
```

---

### Task 10: TicketMessageThread component

**Files:**
- Create: `apps/storefront/client/src/components/shop/TicketMessageThread.tsx`
- Create: `apps/storefront/client/src/components/shop/TicketMessageThread.test.tsx`

**Interfaces:**
- Consumes: `TicketTimelineEntry` from `../../lib/ticketTimeline`; `AttachmentGallery`; `t`.
- Produces: `TicketMessageThread({ entries: TicketTimelineEntry[] })`.

- [ ] **Step 1: Write the failing test**

`apps/storefront/client/src/components/shop/TicketMessageThread.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import TicketMessageThread from "./TicketMessageThread";
import type { TicketTimelineEntry } from "../../lib/ticketTimeline";

describe("TicketMessageThread", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    // Fixed "now" so the Today/Yesterday grouping test (which asserts the
    // raw-date fallback for dates that are neither) can't flake depending on
    // what day the suite happens to run.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a system event's label and a message's content", () => {
    const entries: TicketTimelineEntry[] = [
      { kind: "system", key: "created", labelKey: "web.ticket_event_created", created_at_display: "2026-07-01 09:00" },
      { kind: "message", from_user: true, content: "It broke", created_at_display: "2026-07-01 09:00", attachments: [] },
    ];
    render(<TicketMessageThread entries={entries} />);
    expect(screen.getByText("Ticket created")).toBeInTheDocument();
    expect(screen.getByText("It broke")).toBeInTheDocument();
  });

  it("labels customer vs support messages distinctly", () => {
    const entries: TicketTimelineEntry[] = [
      { kind: "message", from_user: true, content: "customer msg", created_at_display: "2026-07-01 09:00", attachments: [] },
      { kind: "message", from_user: false, content: "support msg", created_at_display: "2026-07-01 09:05", attachments: [] },
    ];
    render(<TicketMessageThread entries={entries} />);
    // Sender label ("You"/"Support") appears once per bubble; the avatar next
    // to it shows only the first letter ("Y"/"S"), so it never collides with
    // these exact-text queries.
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Support")).toBeInTheDocument();
  });

  it("renders one date divider per distinct date, not per entry", () => {
    const entries: TicketTimelineEntry[] = [
      { kind: "message", from_user: true, content: "msg 1", created_at_display: "2026-07-01 09:00", attachments: [] },
      { kind: "message", from_user: true, content: "msg 2", created_at_display: "2026-07-01 09:05", attachments: [] },
      { kind: "message", from_user: true, content: "msg 3", created_at_display: "2026-07-02 09:00", attachments: [] },
    ];
    render(<TicketMessageThread entries={entries} />);
    // Two distinct dates → two divider labels rendered as the raw date string
    // (neither matches today/yesterday relative to the test run date).
    expect(screen.getByText("2026-07-01")).toBeInTheDocument();
    expect(screen.getByText("2026-07-02")).toBeInTheDocument();
  });

  it("renders attachments via AttachmentGallery", () => {
    const entries: TicketTimelineEntry[] = [
      { kind: "message", from_user: true, content: "evidence", created_at_display: "2026-07-01 09:00", attachments: ["/uploads/tickets/a.png"] },
    ];
    render(<TicketMessageThread entries={entries} />);
    expect(document.querySelector('img[src="/uploads/tickets/a.png"]')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- TicketMessageThread.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

`apps/storefront/client/src/components/shop/TicketMessageThread.tsx`:

```tsx
/** Renders a merged ticket timeline (see lib/ticketTimeline.ts) as chat
 * bubbles: customer right-aligned/tinted, support left-aligned/neutral,
 * system events centered. Groups consecutive entries under a date divider
 * ("Today"/"Yesterday" when the entry's date matches the browser's local
 * date — an intentional approximation near a midnight boundary versus the
 * shop's own timezone; this is display grouping only, not business logic). */
import { PlusCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";
import AttachmentGallery from "./AttachmentGallery";
import type { TicketTimelineEntry } from "../../lib/ticketTimeline";

const SYSTEM_ICON: Record<string, LucideIcon> = {
  created: PlusCircle,
  closed: CheckCircle2,
};

function dateGroupLabel(datePart: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (datePart === toKey(now)) return t("web.date_today");
  if (datePart === toKey(yesterday)) return t("web.date_yesterday");
  return datePart;
}

export default function TicketMessageThread({ entries }: { entries: TicketTimelineEntry[] }) {
  let lastDateKey = "";
  return (
    <div className="space-y-3">
      {entries.map((entry, idx) => {
        const datePart = entry.created_at_display.slice(0, 10);
        const timePart = entry.created_at_display.slice(11);
        const showDivider = datePart !== lastDateKey;
        lastDateKey = datePart;
        return (
          <div key={idx}>
            {showDivider && (
              <div className="my-4 flex items-center gap-3 text-xs font-semibold text-ink-faint">
                <span className="h-px flex-1 bg-line" /> {dateGroupLabel(datePart)} <span className="h-px flex-1 bg-line" />
              </div>
            )}
            {entry.kind === "system" ? (
              <SystemEventRow entry={entry} timePart={timePart} />
            ) : (
              <MessageBubble entry={entry} timePart={timePart} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SystemEventRow({ entry, timePart }: { entry: Extract<TicketTimelineEntry, { kind: "system" }>; timePart: string }) {
  const Icon = SYSTEM_ICON[entry.key] ?? PlusCircle;
  return (
    <div className="flex items-center justify-center gap-1.5 text-xs text-ink-faint">
      <Icon className="w-3.5 h-3.5" /> {t(entry.labelKey)} · {timePart}
    </div>
  );
}

function MessageBubble({
  entry,
  timePart,
}: {
  entry: Extract<TicketTimelineEntry, { kind: "message" }>;
  timePart: string;
}) {
  const senderLabel = entry.from_user ? t("web.ticket_sender_you") : t("web.ticket_sender_support");
  return (
    <div className={`card card-pad max-w-lg ${entry.from_user ? "ml-auto bg-pine-tint/30" : "mr-auto"}`}>
      <div className="mb-1 flex items-center gap-2 text-xs text-ink-faint">
        <span
          className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
            entry.from_user ? "bg-pine text-white" : "bg-sand text-ink-soft"
          }`}
        >
          {senderLabel.charAt(0).toUpperCase()}
        </span>
        <span className="font-semibold text-ink-soft">{senderLabel}</span>
        <span className="ml-auto" title={entry.created_at_display}>
          {timePart}
        </span>
      </div>
      <p className="text-sm whitespace-pre-line">{entry.content}</p>
      <AttachmentGallery urls={entry.attachments} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- TicketMessageThread.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/client/src/components/shop/TicketMessageThread.tsx apps/storefront/client/src/components/shop/TicketMessageThread.test.tsx
git commit -m "feat(storefront-client): add TicketMessageThread (grouped chat bubbles)"
```

---

### Task 11: TicketComposer component

**Files:**
- Create: `apps/storefront/client/src/components/shop/TicketComposer.tsx`
- Create: `apps/storefront/client/src/components/shop/TicketComposer.test.tsx`

**Interfaces:**
- Consumes: `saveTicketDraft` from `../../lib/ticketDraft`; `AttachmentPicker`, `ProgressBar`, `Spinner`; `t`.
- Produces: `TicketComposer(props: TicketComposerProps)` — controlled (message/files/onSubmit all owned by the parent); internally handles the char counter, Ctrl/Cmd+Enter shortcut, and debounced draft autosave.

- [ ] **Step 1: Write the failing test**

`apps/storefront/client/src/components/shop/TicketComposer.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TicketComposer from "./TicketComposer";
import { loadTicketDraft } from "../../lib/ticketDraft";

describe("TicketComposer", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    localStorage.clear();
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(onSubmit = vi.fn(), onMessageChange = vi.fn()) {
    const utils = render(
      <TicketComposer
        ticketId={7}
        message=""
        onMessageChange={onMessageChange}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={onSubmit}
        pending={false}
        uploadProgress={0}
      />,
    );
    return { ...utils, onSubmit, onMessageChange };
  }

  it("shows a character counter that updates with the message length", () => {
    const { rerender } = setup();
    expect(screen.getByText("0/2000")).toBeInTheDocument();
    rerender(
      <TicketComposer
        ticketId={7}
        message="hello"
        onMessageChange={vi.fn()}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={vi.fn()}
        pending={false}
        uploadProgress={0}
      />,
    );
    expect(screen.getByText("5/2000")).toBeInTheDocument();
  });

  it("submits on Ctrl+Enter when there's a non-empty message", () => {
    const onSubmit = vi.fn();
    render(
      <TicketComposer
        ticketId={7}
        message="ready to send"
        onMessageChange={vi.fn()}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={onSubmit}
        pending={false}
        uploadProgress={0}
      />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText("Tell us what's wrong…"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit on Ctrl+Enter while pending or while the message is empty", () => {
    const onSubmit = vi.fn();
    render(
      <TicketComposer
        ticketId={7}
        message=""
        onMessageChange={vi.fn()}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={onSubmit}
        pending={false}
        uploadProgress={0}
      />,
    );
    fireEvent.keyDown(screen.getByPlaceholderText("Tell us what's wrong…"), { key: "Enter", ctrlKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("debounce-saves the message as a draft, retrievable via loadTicketDraft", () => {
    const { rerender } = setup();
    rerender(
      <TicketComposer
        ticketId={7}
        message="in-progress reply"
        onMessageChange={vi.fn()}
        files={[]}
        onFilesChange={vi.fn()}
        onSubmit={vi.fn()}
        pending={false}
        uploadProgress={0}
      />,
    );
    vi.advanceTimersByTime(600);
    expect(loadTicketDraft(7)).toBe("in-progress reply");
  });

  it("disables the submit button while pending or when the message is blank", () => {
    setup();
    expect(screen.getByRole("button", { name: /reply/i })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- TicketComposer.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

`apps/storefront/client/src/components/shop/TicketComposer.tsx`:

```tsx
/** Reply composer for the ticket thread — textarea + attachments + char
 * counter + Ctrl/Cmd+Enter shortcut + debounced draft autosave. Fully
 * controlled: the parent owns `message`/`files` and passes `onSubmit`; this
 * component only *saves* drafts on change (see lib/ticketDraft.ts) — loading
 * the initial draft and clearing it on success are the parent's job, since
 * those need to happen exactly once at mount / on mutation success. */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { t } from "../../lib/i18n";
import { saveTicketDraft } from "../../lib/ticketDraft";
import AttachmentPicker from "./AttachmentPicker";
import ProgressBar from "./ProgressBar";
import Spinner from "./Spinner";

const MAX_MESSAGE_LENGTH = 2000;
const DRAFT_SAVE_DEBOUNCE_MS = 500;

export interface TicketComposerProps {
  ticketId: number;
  message: string;
  onMessageChange: (value: string) => void;
  files: File[];
  onFilesChange: (files: File[]) => void;
  onSubmit: () => void;
  pending: boolean;
  uploadProgress: number;
}

export default function TicketComposer({
  ticketId,
  message,
  onMessageChange,
  files,
  onFilesChange,
  onSubmit,
  pending,
  uploadProgress,
}: TicketComposerProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveTicketDraft(ticketId, message), DRAFT_SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [ticketId, message]);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && message.trim() && !pending) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="card card-pad mt-5"
    >
      <textarea
        value={message}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        required
        maxLength={MAX_MESSAGE_LENGTH}
        className="field"
        placeholder={t("web.support_placeholder")}
      />
      <div className="mt-1 flex items-center justify-between text-xs text-ink-faint">
        <span>{t("web.ticket_composer_shortcut")}</span>
        <span>
          {message.length}/{MAX_MESSAGE_LENGTH}
        </span>
      </div>
      <AttachmentPicker files={files} onChange={onFilesChange} disabled={pending} />
      {pending && files.length > 0 && (
        <div className="mt-2">
          <ProgressBar value={uploadProgress} />
        </div>
      )}
      <div className="mt-3 text-right">
        <button type="submit" className="btn btn-primary btn-sm" disabled={pending || !message.trim()}>
          {pending && <Spinner />}
          <Send className="w-3.5 h-3.5" /> {t("web.support_reply")}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- TicketComposer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/client/src/components/shop/TicketComposer.tsx apps/storefront/client/src/components/shop/TicketComposer.test.tsx
git commit -m "feat(storefront-client): add TicketComposer with char counter, shortcut, draft autosave"
```

---

### Task 12: TicketOrderSummaryCard component

**Files:**
- Create: `apps/storefront/client/src/components/shop/TicketOrderSummaryCard.tsx`
- Create: `apps/storefront/client/src/components/shop/TicketOrderSummaryCard.test.tsx`

**Interfaces:**
- Consumes: `TicketOrderSummary` from `../../api/types`; `StatusBadge`; `formatIdr`; `t`.
- Produces: `TicketOrderSummaryCard({ order: TicketOrderSummary })`.

- [ ] **Step 1: Write the failing test**

`apps/storefront/client/src/components/shop/TicketOrderSummaryCard.test.tsx`:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TicketOrderSummaryCard from "./TicketOrderSummaryCard";
import type { TicketOrderSummary } from "../../api/types";

const order: TicketOrderSummary = {
  code: "ORD-TICK-1",
  status: "delivered",
  status_label: "status.label.delivered",
  created_at_display: "2026-07-01 10:00",
  paid_at_display: "2026-07-01 10:01",
  payment_method: "BINANCE_PAY",
  total: "158000",
  voucher_code: "SAVE10",
  delivered: true,
  items: [
    { name: "Netflix", duration: "1 month", warranty_days: 30, warranty_expires_at_display: "2026-08-01 10:00", warranty_active: true },
  ],
};

describe("TicketOrderSummaryCard", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  it("renders the order code, item, and total", () => {
    render(<TicketOrderSummaryCard order={order} />, { wrapper: MemoryRouter });
    expect(screen.getByText("ORD-TICK-1")).toBeInTheDocument();
    expect(screen.getByText(/Netflix/)).toBeInTheDocument();
    expect(screen.getByText("Rp158.000")).toBeInTheDocument();
  });

  it("shows the active-warranty state with its expiry date", () => {
    render(<TicketOrderSummaryCard order={order} />, { wrapper: MemoryRouter });
    expect(screen.getByText("Warranty until 2026-08-01 10:00")).toBeInTheDocument();
  });

  it("shows warranty-expired when warranty_active is false", () => {
    render(
      <TicketOrderSummaryCard order={{ ...order, items: [{ ...order.items[0]!, warranty_active: false }] }} />,
      { wrapper: MemoryRouter },
    );
    expect(screen.getByText("Warranty expired")).toBeInTheDocument();
  });

  it("shows a Download Credentials link (hash anchor) when delivered", () => {
    render(<TicketOrderSummaryCard order={order} />, { wrapper: MemoryRouter });
    const link = screen.getByRole("link", { name: /Download credentials/i });
    expect(link).toHaveAttribute("href", "/account/orders/ORD-TICK-1#credentials");
  });

  it("shows a plain View Order link when not delivered", () => {
    render(<TicketOrderSummaryCard order={{ ...order, delivered: false }} />, { wrapper: MemoryRouter });
    const link = screen.getByRole("link", { name: /View order/i });
    expect(link).toHaveAttribute("href", "/account/orders/ORD-TICK-1");
  });

  it("copies the order code to the clipboard", () => {
    render(<TicketOrderSummaryCard order={order} />, { wrapper: MemoryRouter });
    fireEvent.click(screen.getByRole("button", { name: /Copy order number/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ORD-TICK-1");
  });

  it("omits the voucher row when voucher_code is null", () => {
    render(<TicketOrderSummaryCard order={{ ...order, voucher_code: null }} />, { wrapper: MemoryRouter });
    expect(screen.queryByText("Voucher used")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- TicketOrderSummaryCard.test.tsx`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

`apps/storefront/client/src/components/shop/TicketOrderSummaryCard.tsx`:

```tsx
/** The linked order's context card in the ticket sidebar. "Download
 * Credentials"/"View order" both deep-link to OrderDetailPage rather than
 * re-rendering the credential-reveal UI here — that page's existing
 * reveal/copy block stays the single source of truth for showing a secret
 * (see Task 13's `id="credentials"` anchor + scroll effect). Uses a native
 * `<details open>` rather than a plain `<section>` so it collapses into an
 * expandable section on narrow viewports (design spec: "sidebar collapses
 * into expandable sections" on tablet/mobile) without a dedicated accordion
 * component — `open` by default keeps desktop looking exactly like a normal
 * always-expanded card. */
import { Copy, ExternalLink, ShieldCheck, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { t } from "../../lib/i18n";
import { formatIdr } from "../../lib/format";
import type { TicketOrderSummary } from "../../api/types";
import StatusBadge from "./StatusBadge";

export default function TicketOrderSummaryCard({ order }: { order: TicketOrderSummary }) {
  const orderHref = `/account/orders/${order.code}${order.delivered ? "#credentials" : ""}`;
  return (
    <details open className="card card-pad">
      <summary className="section-title cursor-pointer">{t("web.ticket_order_summary_title")}</summary>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="font-mono text-sm">{order.code}</span>
        <StatusBadge value={order.status} />
      </div>
      <dl className="mt-3 space-y-1.5 text-sm">
        {order.items.map((item, idx) => (
          <div key={idx} className="flex justify-between gap-3">
            <dt className="text-ink-soft">
              {item.name}
              {item.duration ? ` · ${item.duration}` : ""}
            </dt>
            <dd className="text-right text-xs">
              {item.warranty_active ? (
                <span className="inline-flex items-center gap-1 text-grass-dark">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  {t("web.ticket_warranty_until", { date: item.warranty_expires_at_display ?? "" })}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-ink-faint">
                  <ShieldAlert className="w-3.5 h-3.5" /> {t("web.ticket_warranty_expired")}
                </span>
              )}
            </dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-line pt-1.5">
          <dt className="text-ink-soft">{t("web.order_date")}</dt>
          <dd>{order.created_at_display}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-soft">{t("web.ticket_payment_method")}</dt>
          <dd>{order.payment_method}</dd>
        </div>
        {order.voucher_code && (
          <div className="flex justify-between gap-3">
            <dt className="text-ink-soft">{t("web.ticket_voucher_used")}</dt>
            <dd className="font-mono">{order.voucher_code}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3 border-t border-line pt-1.5 font-semibold">
          <dt>{t("web.order_total")}</dt>
          <dd>{formatIdr(order.total)}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={orderHref} className="btn btn-soft btn-sm">
          <ExternalLink className="w-3.5 h-3.5" />
          {order.delivered ? t("web.ticket_download_credentials") : t("web.ticket_view_order")}
        </Link>
        <button type="button" className="btn btn-soft btn-sm" onClick={() => navigator.clipboard.writeText(order.code)}>
          <Copy className="w-3.5 h-3.5" /> {t("web.ticket_copy_order_code")}
        </button>
      </div>
    </details>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- TicketOrderSummaryCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/storefront/client/src/components/shop/TicketOrderSummaryCard.tsx apps/storefront/client/src/components/shop/TicketOrderSummaryCard.test.tsx
git commit -m "feat(storefront-client): add TicketOrderSummaryCard sidebar component"
```

---

### Task 13: OrderDetailPage — credentials anchor + scroll-to-hash

**Files:**
- Modify: `apps/storefront/client/src/pages/OrderDetailPage.tsx`
- Modify: `apps/storefront/client/src/pages/OrderDetailPage.test.tsx`

**Interfaces:**
- Produces: the credentials `<section>` gains `id="credentials"`; the page scrolls to it on load when the URL hash is `#credentials`.

- [ ] **Step 1: Write the failing test**

In `apps/storefront/client/src/pages/OrderDetailPage.test.tsx`, add this test inside the existing `describe("OrderDetailPage", ...)` block:

```tsx
  it("scrolls the credentials section into view when loaded with a #credentials hash", async () => {
    window.history.pushState({}, "", "/account/orders/ORD1#credentials");
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderDetail((path) => {
      if (path === "/api/v1/account/orders/ORD1") {
        return { order: { ...baseOrder, items: [{ ...baseOrder.items[0]!, credentials: "acc@mail.com:pw" }] }, delivered: true, pending_payment: false, processing: false };
      }
      throw new Error(`unexpected path ${path}`);
    });
    await screen.findByText("Your credentials"); // web.credentials, en.json
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    window.history.pushState({}, "", "/account/orders/ORD1"); // reset for other tests
  });
```

No new import is needed — the test asserts on the literal English copy, matching this file's existing convention of literal strings (the suite runs with `document.documentElement.lang = "en"`).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- OrderDetailPage.test.tsx`
Expected: FAIL — `scrollIntoView` never called (no `id="credentials"`/no effect yet).

- [ ] **Step 3: Implement**

In `apps/storefront/client/src/pages/OrderDetailPage.tsx`, add the `id` to the credentials section and a scroll effect.

Change:
```tsx
      {delivered && (
        <section className="card card-pad border-grass/40 mb-5">
```
to:
```tsx
      {delivered && (
        <section id="credentials" className="card card-pad border-grass/40 mb-5">
```

Add a new `useEffect` right after the existing `useEffect` that handles the 401 redirect (both need `data`/`error` in scope, so place it right after `data` is destructured... actually `data` isn't in scope at the top before the early returns — place it as its own hook using the query's `data` before the early-return guards, next to the existing 401 effect):

```tsx
  useEffect(() => {
    if (data && window.location.hash === "#credentials") {
      document.getElementById("credentials")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [data]);
```

(Insert this new `useEffect` block directly after the existing `useEffect(() => { if ((error as ...)?.status === 401) ... }, [error, code]);` block, still before the `if (error) { ... }` early return.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- OrderDetailPage.test.tsx`
Expected: PASS, all tests including pre-existing ones.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add apps/storefront/client/src/pages/OrderDetailPage.tsx apps/storefront/client/src/pages/OrderDetailPage.test.tsx
git commit -m "feat(storefront-client): scroll to #credentials anchor on order detail load"
```

---

### Task 14: TicketSidebar component

**Files:**
- Create: `apps/storefront/client/src/components/shop/TicketSidebar.tsx`

(No dedicated test file — it's a thin composition of already-tested pieces (`TicketOrderSummaryCard`, `TicketStatusBadge`) plus static markup; its behavior is exercised end-to-end by `TicketDetailPage.test.tsx` in Task 15, consistent with how `SupportPage.tsx` itself has no separate test for its table-vs-card branching beyond the page-level test.)

**Interfaces:**
- Consumes: `TicketOrderSummary`, `SupportTicketSummary` from `../../api/types`; `TicketOrderSummaryCard`; `TicketStatusBadge`; `t`.
- Produces: `TicketSidebar(props: TicketSidebarProps)`.

- [ ] **Step 1: Implement**

`apps/storefront/client/src/components/shop/TicketSidebar.tsx`:

```tsx
/** Composes the ticket detail page's right column: linked-order summary (or
 * a generic fallback), trust badges, recent tickets, and help links. Every
 * section is a native `<details open>` (see TicketOrderSummaryCard's header
 * comment) so the whole sidebar reads as a stack of expandable sections on
 * narrow viewports, without a dedicated accordion component. The page's own
 * grid handles the desktop 70/30 split and collapses to a single column
 * below `lg` — this component doesn't need its own breakpoint logic. */
import { Link } from "react-router-dom";
import { LifeBuoy, Mail, ShieldCheck, Lock, Zap, BadgeCheck } from "lucide-react";
import { t } from "../../lib/i18n";
import TicketOrderSummaryCard from "./TicketOrderSummaryCard";
import TicketStatusBadge from "./TicketStatusBadge";
import type { SupportTicketSummary, TicketOrderSummary } from "../../api/types";

export interface TicketSidebarProps {
  order: TicketOrderSummary | null;
  recentTickets: SupportTicketSummary[];
  currentTicketId: number;
  telegramSupportUrl: string | null;
}

export default function TicketSidebar({ order, recentTickets, currentTicketId, telegramSupportUrl }: TicketSidebarProps) {
  const others = recentTickets.filter((tk) => tk.id !== currentTicketId).slice(0, 5);
  return (
    <aside className="space-y-4">
      {order ? (
        <TicketOrderSummaryCard order={order} />
      ) : (
        <details open className="card card-pad text-sm text-ink-soft">
          <summary className="section-title cursor-pointer">{t("web.ticket_order_summary_title")}</summary>
          <p className="mt-2">{t("web.ticket_no_order_linked")}</p>
        </details>
      )}

      {order && (
        <details open className="card card-pad">
          <summary className="section-title cursor-pointer">{t("web.ticket_trust_title")}</summary>
          <ul className="mt-2 space-y-2 text-xs text-ink-soft">
            <li className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-grass" /> {t("web.ticket_trust_warranty")}
            </li>
            <li className="flex items-center gap-2">
              <BadgeCheck className="w-4 h-4 text-grass" /> {t("web.ticket_trust_verified")}
            </li>
            <li className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-grass" /> {t("web.ticket_trust_delivery")}
            </li>
            <li className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-grass" /> {t("web.ticket_trust_encrypted")}
            </li>
          </ul>
        </details>
      )}

      {others.length > 0 && (
        <details open className="card card-pad">
          <summary className="section-title cursor-pointer">{t("web.ticket_recent_title")}</summary>
          <ul className="mt-2 divide-y divide-line">
            {others.map((tk) => (
              <li key={tk.id} className="py-2 first:pt-0 last:pb-0">
                <Link to={`/account/support/${tk.id}`} className="flex items-center justify-between gap-2 text-sm hover:text-pine">
                  <span>#{tk.id}</span>
                  <TicketStatusBadge value={tk.status} />
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}

      <details open className="card card-pad">
        <summary className="section-title cursor-pointer flex items-center gap-2">
          <LifeBuoy className="w-4 h-4" /> {t("web.ticket_help_title")}
        </summary>
        <ul className="mt-2 space-y-2 text-sm">
          {telegramSupportUrl && (
            <li>
              <a href={telegramSupportUrl} target="_blank" rel="noreferrer" className="link">
                {t("web.ticket_help_telegram")}
              </a>
            </li>
          )}
          <li className="flex items-center gap-2 text-ink-soft">
            <Mail className="w-4 h-4" /> {t("web.ticket_help_email_hint")}
          </li>
          <li>
            <Link to="/account/support" className="link">
              {t("web.ticket_new_ticket_link")}
            </Link>
          </li>
        </ul>
      </details>
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add apps/storefront/client/src/components/shop/TicketSidebar.tsx
git commit -m "feat(storefront-client): add TicketSidebar composing order/trust/recent/help"
```

---

### Task 15: TicketDetailPage — full rewrite

**Files:**
- Modify: `apps/storefront/client/src/pages/TicketDetailPage.tsx`
- Modify: `apps/storefront/client/src/pages/TicketDetailPage.test.tsx`

**Interfaces:**
- Consumes: everything built in Tasks 6–14, plus `useShopContext` from `../components/Layout` (same import `OrderDetailPage.tsx` already uses).

- [ ] **Step 1: Rewrite the test file**

Replace the entire contents of `apps/storefront/client/src/pages/TicketDetailPage.test.tsx` with:

```tsx
import "@testing-library/jest-dom";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import TicketDetailPage from "./TicketDetailPage";
import { apiGet, apiPost, apiPostFormWithProgress } from "../api/client";
import type { SupportData, TicketDetailData } from "../api/types";

vi.mock("../api/client", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPostFormWithProgress: vi.fn(),
}));

const openTicket: TicketDetailData = {
  ticket: {
    id: 7,
    message: "It broke",
    status: "open",
    created_at_display: "2026-07-01 09:00",
    admin_reply: null,
    replied_at_display: null,
    closed: false,
    closed_at_display: null,
    reopenable: false,
    attachments: [],
  },
  messages: [],
  order: null,
};

const context = {
  lang: "en",
  fx: null,
  shop_name: "Toko Digital",
  shop_tagline: "",
  cart_count: 0,
  customer: { username: "alice", email: null, telegram_linked: false },
  favicon_url: "/static/favicon.svg",
  logo_url: "",
  bot_username: "tokobot",
  tzname: "Asia/Jakarta",
};

const emptySupportList: SupportData = { tickets: [] };

function renderTicket(respond: (path: string) => unknown, id = "7") {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/pages/context") return context;
    if (path === "/api/v1/account/support") return emptySupportList;
    return respond(path);
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/account/support/${id}`]}>
        <Routes>
          <Route path="/account/support/:id" element={<TicketDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TicketDetailPage", () => {
  beforeEach(() => {
    document.documentElement.lang = "en";
    vi.clearAllMocks();
    localStorage.clear();
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
  });

  it("renders the thread (opening message included) and posts a reply, then refetches", async () => {
    renderTicket(() => openTicket);
    expect(await screen.findByRole("heading", { name: "Ticket #7" })).toBeInTheDocument();
    expect(screen.getByText("It broke")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "Still broken" } });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reply", { message: "Still broken" }),
    );
  });

  it("hides the composer and shows the closed banner for a closed, non-reopenable ticket", async () => {
    renderTicket(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, status: "closed", closed: true, reopenable: false },
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.queryByPlaceholderText("Tell us what's wrong…")).not.toBeInTheDocument();
    expect(screen.getByText("This ticket is closed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reopen ticket" })).not.toBeInTheDocument();
  });

  it("shows a Reopen button for a closed, reopenable ticket, and reopening refetches", async () => {
    renderTicket(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, status: "closed", closed: true, closed_at_display: "2026-07-02 09:00", reopenable: true },
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reopen ticket" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/reopen", {}));
  });

  it("shows Issue Solved only after support has replied, and closing calls the close route", async () => {
    renderTicket(() => ({
      ...openTicket,
      messages: [{ from_user: false, content: "try this fix", created_at_display: "2026-07-01 09:05", attachments: [] }],
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    (apiPost as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Issue solved" }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support/7/close", {}));
  });

  it("does not show Issue Solved before support has replied", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.queryByRole("button", { name: "Issue solved" })).not.toBeInTheDocument();
  });

  it("a quick-reply template fills the composer instead of submitting", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    fireEvent.click(screen.getByRole("button", { name: "Request a refund" }));
    expect(screen.getByPlaceholderText("Tell us what's wrong…")).toHaveValue(
      "I'd like to request a refund for this order. Reason: ",
    );
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("renders the linked order summary in the sidebar when the ticket has one", async () => {
    renderTicket(() => ({
      ...openTicket,
      order: {
        code: "ORD-TICK-1",
        status: "delivered",
        status_label: "status.label.delivered",
        created_at_display: "2026-07-01 10:00",
        paid_at_display: "2026-07-01 10:01",
        payment_method: "BINANCE_PAY",
        total: "158000",
        voucher_code: null,
        delivered: true,
        items: [{ name: "Netflix", duration: "1 month", warranty_days: 30, warranty_expires_at_display: "2026-08-01 10:00", warranty_active: true }],
      },
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.getByText("ORD-TICK-1")).toBeInTheDocument();
    expect(screen.getByText(/Netflix/)).toBeInTheDocument();
  });

  it("shows the generic no-order sidebar text when the ticket has no linked order", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.getByText("This ticket isn't linked to a specific order.")).toBeInTheDocument();
  });

  it("renders ErrorPage on a 404", async () => {
    renderTicket(() => {
      const err = new Error("not_found") as Error & { status?: number };
      err.status = 404;
      throw err;
    });
    expect(await screen.findByText("404")).toBeInTheDocument();
  });

  it("renders evidence attachments on the initial message and thread", async () => {
    renderTicket(() => ({
      ...openTicket,
      ticket: { ...openTicket.ticket, attachments: ["/uploads/tickets/evidence-a.png"] },
      messages: [{ from_user: true, content: "more", created_at_display: "2026-07-01 09:05", attachments: ["/uploads/tickets/evidence-b.mp4"] }],
    }));
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(document.querySelector('img[src="/uploads/tickets/evidence-a.png"]')).toBeInTheDocument();
    expect(document.querySelector('video[src="/uploads/tickets/evidence-b.mp4"]')).toBeInTheDocument();
  });

  it("attaches a file to a reply and submits via apiPostFormWithProgress instead of apiPost", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "Still broken" } });
    const file = new File(["fake video bytes"], "evidence.mp4", { type: "video/mp4" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
    (apiPostFormWithProgress as Mock).mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(apiPostFormWithProgress).toHaveBeenCalled());
    expect(apiPost).not.toHaveBeenCalled();
    const [path, form] = (apiPostFormWithProgress as Mock).mock.calls[0] as [string, FormData, unknown];
    expect(path).toBe("/api/v1/account/support/7/reply");
    expect(form.get("message")).toBe("Still broken");
    expect(form.get("attachments")).toBeInstanceOf(File);
  });

  it("shows a progress bar reflecting upload progress while a reply attachment is uploading", async () => {
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "Still broken" } });
    const file = new File(["fake video bytes"], "evidence.mp4", { type: "video/mp4" });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });

    let capturedOnProgress: ((pct: number) => void) | undefined;
    (apiPostFormWithProgress as Mock).mockImplementation(
      (_path: string, _form: FormData, onProgress: (pct: number) => void) => {
        capturedOnProgress = onProgress;
        return new Promise(() => {});
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(apiPostFormWithProgress).toHaveBeenCalled());

    act(() => capturedOnProgress?.(77));
    await waitFor(() => expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "77"));
  });

  it("loads a saved draft into the composer on mount", async () => {
    localStorage.setItem("ticket-draft:7", "resuming my draft");
    renderTicket(() => openTicket);
    await screen.findByRole("heading", { name: "Ticket #7" });
    expect(screen.getByPlaceholderText("Tell us what's wrong…")).toHaveValue("resuming my draft");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- TicketDetailPage.test.tsx`
Expected: FAIL — the current page doesn't render a sidebar, quick-reply buttons, or reopen/close flows yet, and `TicketDetailData` mocks include fields the old page ignores.

- [ ] **Step 3: Rewrite the page**

Replace the entire contents of `apps/storefront/client/src/pages/TicketDetailPage.tsx` with:

```tsx
/**
 * Two-column support workspace: conversation thread (merged via
 * lib/ticketTimeline.ts) + composer on the left, order/trust/recent-tickets/
 * help sidebar on the right. Collapses to a single column at <1024px via the
 * grid's own responsive class — no separate mobile layout branch needed
 * (unlike OrderDetailPage's item table, nothing here needs a structurally
 * different mobile markup, just a narrower column).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, RotateCcw } from "lucide-react";
import { apiGet, apiPost, apiPostFormWithProgress } from "../api/client";
import type { SupportData, TicketDetailData } from "../api/types";
import { t } from "../lib/i18n";
import { useShopContext } from "../components/Layout";
import { buildTicketTimeline } from "../lib/ticketTimeline";
import { loadTicketDraft, clearTicketDraft } from "../lib/ticketDraft";
import TicketStatusBadge from "../components/shop/TicketStatusBadge";
import TicketMessageThread from "../components/shop/TicketMessageThread";
import TicketComposer from "../components/shop/TicketComposer";
import TicketSidebar from "../components/shop/TicketSidebar";
import EmptyState from "../components/shop/EmptyState";
import ErrorPage from "./ErrorPage";
import Spinner from "../components/shop/Spinner";
import Skeleton from "../components/shop/Skeleton";
import Toast from "../components/shop/Toast";

const QUICK_REPLY_TEMPLATES: Array<{ key: string; labelKey: string; templateKey: string }> = [
  { key: "still_not_working", labelKey: "web.ticket_quick_still_not_working", templateKey: "web.ticket_template_still_not_working" },
  { key: "request_refund", labelKey: "web.ticket_quick_request_refund", templateKey: "web.ticket_template_request_refund" },
  { key: "replace_credentials", labelKey: "web.ticket_quick_replace_credentials", templateKey: "web.ticket_template_replace_credentials" },
];

export default function TicketDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const ticketId = Number(id);
  const { data: ctx } = useShopContext();
  const [message, setMessage] = useState(() => loadTicketDraft(ticketId));
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);

  const { data, error, refetch } = useQuery({
    queryKey: ["account-ticket", id],
    queryFn: () => apiGet<TicketDetailData>(`/api/v1/account/support/${id}`),
    retry: false,
  });
  const { data: ticketList } = useQuery({
    queryKey: ["account-support"],
    queryFn: () => apiGet<SupportData>("/api/v1/account/support"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent(`/account/support/${id}`));
    }
  }, [error, id]);

  const replyMutation = useMutation({
    mutationFn: (vars: { message: string; files: File[] }) => {
      if (vars.files.length === 0) {
        return apiPost<{ ok: boolean }>(`/api/v1/account/support/${id}/reply`, { message: vars.message });
      }
      const form = new FormData();
      form.append("message", vars.message);
      for (const file of vars.files) form.append("attachments", file);
      return apiPostFormWithProgress<{ ok: boolean }>(`/api/v1/account/support/${id}/reply`, form, setUploadProgress);
    },
    onSuccess: () => {
      setMessage("");
      setFiles([]);
      clearTicketDraft(ticketId);
      refetch();
    },
    onError: (err) => setErrorText(t(err instanceof Error ? err.message : "error.generic")),
  });

  const closeMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>(`/api/v1/account/support/${id}/close`, {}),
    onSuccess: () => refetch(),
    onError: (err) => {
      setErrorText(t(err instanceof Error ? err.message : "error.generic"));
      // A 409 here means the ticket was already closed out from under this
      // tap (double-click, or an admin closed it concurrently) — refetch so
      // the page re-renders into the real (closed) state instead of leaving
      // a stale "not yet closed" view up next to the error toast.
      refetch();
    },
  });

  const reopenMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>(`/api/v1/account/support/${id}/reopen`, {}),
    onSuccess: () => refetch(),
    onError: (err) => setErrorText(t(err instanceof Error ? err.message : "error.generic")),
  });

  function submitReply() {
    setErrorText(null);
    setUploadProgress(0);
    replyMutation.mutate({ message, files });
  }

  function applyTemplate(templateKey: string) {
    setMessage((prev) => prev || t(templateKey));
  }

  const timeline = useMemo(() => (data ? buildTicketTimeline(data.ticket, data.messages) : []), [data]);

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-16 w-full" />
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-3/4" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const { ticket, order } = data;
  const telegramSupportUrl = ctx?.bot_username ? `https://t.me/${ctx.bot_username}` : null;
  const hasSupportReplied = data.messages.some((m) => !m.from_user) || Boolean(ticket.admin_reply);

  return (
    <>
      <Toast text={errorText} onDismiss={() => setErrorText(null)} kind="error" />

      <div className="mb-6">
        <div className="text-xs text-ink-faint mb-1">
          <Link to="/account/support" className="hover:text-pine">
            {t("web.account_support")}
          </Link>
          <span className="mx-1">/</span> #{ticket.id}
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="page-title text-2xl!">
            {t("web.ticket")} #{ticket.id}
          </h1>
          <TicketStatusBadge value={ticket.status} />
        </div>
        {order && (
          <p className="mt-1 text-sm text-ink-soft">
            {t("web.ticket_re_order")}{" "}
            <Link to={`/account/orders/${order.code}`} className="link font-mono">
              #{order.code}
            </Link>
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
          <span>{t("web.ticket_created_at", { date: ticket.created_at_display })}</span>
          {!hasSupportReplied && <span>{t("web.ticket_estimated_reply")}</span>}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="card card-pad mb-4">
            <TicketMessageThread entries={timeline} />
            {!hasSupportReplied && (
              <div className="mt-4">
                <EmptyState icon={Clock} title={t("web.ticket_waiting_title")} description={t("web.ticket_waiting_desc")} />
              </div>
            )}
          </div>

          {ticket.closed ? (
            <div className="card card-pad flex items-center justify-between gap-3 flex-wrap bg-sand">
              <div className="flex items-center gap-2 text-sm text-ink-soft">
                <CheckCircle2 className="w-4 h-4 text-grass" />
                {ticket.reopenable ? t("web.ticket_closed_reopenable") : t("web.ticket_closed_expired")}
              </div>
              {ticket.reopenable && (
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  disabled={reopenMutation.isPending}
                  onClick={() => reopenMutation.mutate()}
                >
                  {reopenMutation.isPending && <Spinner />}
                  <RotateCcw className="w-3.5 h-3.5" /> {t("web.ticket_reopen_btn")}
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                {hasSupportReplied && (
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    disabled={closeMutation.isPending}
                    onClick={() => closeMutation.mutate()}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> {t("web.ticket_quick_issue_solved")}
                  </button>
                )}
                {QUICK_REPLY_TEMPLATES.map((qr) => (
                  <button key={qr.key} type="button" className="btn btn-soft btn-sm" onClick={() => applyTemplate(qr.templateKey)}>
                    {t(qr.labelKey)}
                  </button>
                ))}
              </div>
              <TicketComposer
                ticketId={ticketId}
                message={message}
                onMessageChange={setMessage}
                files={files}
                onFilesChange={setFiles}
                onSubmit={submitReply}
                pending={replyMutation.isPending}
                uploadProgress={uploadProgress}
              />
            </>
          )}
        </div>

        <TicketSidebar
          order={order}
          recentTickets={ticketList?.tickets ?? []}
          currentTicketId={ticket.id}
          telegramSupportUrl={telegramSupportUrl}
        />
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- TicketDetailPage.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: passes (this also resolves the dangling failures noted in Task 6's step 2).

- [ ] **Step 6: Commit**

```bash
git add apps/storefront/client/src/pages/TicketDetailPage.tsx apps/storefront/client/src/pages/TicketDetailPage.test.tsx
git commit -m "feat(storefront-client): redesign TicketDetailPage as a two-column support workspace"
```

---

### Task 16: SupportPage — order picker on ticket creation

**Files:**
- Modify: `apps/storefront/client/src/pages/SupportPage.tsx`
- Modify: `apps/storefront/client/src/pages/SupportPage.test.tsx`

**Interfaces:**
- Consumes: `AccountOrdersData` from `../api/types` (already defined).
- Produces: the create-ticket form submits an optional `order_code`.

- [ ] **Step 1: Extend the `renderSupport` test helper to also serve `/api/v1/account/orders`**

The current `apps/storefront/client/src/pages/SupportPage.test.tsx` mocks `apiGet` with a single path-agnostic callback (`(apiGet as Mock).mockImplementation(async () => respond())`), because today the page only ever calls `apiGet` once. Adding the orders query in this task means `apiGet` is now called for two different paths, so the helper must branch by path. Replace the existing `renderSupport` function with:

```tsx
function renderSupport(respond: () => unknown = () => supportData, ordersRespond: () => unknown = () => ({ orders: [] })) {
  (apiGet as Mock).mockImplementation(async (path: string) => {
    if (path === "/api/v1/account/orders") return ordersRespond();
    return respond();
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/account/support"]}>
        <Routes>
          <Route path="/account/support" element={<SupportPage />} />
          <Route path="/account/support/:id" element={<div>ticket-detail-stub</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

This is backward-compatible with every existing call site in the file (`renderSupport()`, `renderSupport(() => ({ tickets: [] }))`, `renderSupport(() => { throw ... })`) — they all still pass only the first argument, and the new second argument defaults to an empty orders list, so none of the file's other 8 existing tests need to change.

- [ ] **Step 2: Write the failing test**

Add this test to `apps/storefront/client/src/pages/SupportPage.test.tsx`, inside the existing `describe("SupportPage", ...)` block (e.g. right after the `"creates a new ticket and refetches"` test):

```tsx
  it("includes the picked order_code when creating a ticket", async () => {
    renderSupport(() => supportData, () => ({
      orders: [{ code: "ORD-PICK-1", status: "delivered", total: "10000", created_at_display: "2026-07-01 09:00", items: "Netflix" }],
    }));
    await screen.findByRole("link", { name: "#1" });
    fireEvent.change(screen.getByLabelText("Which order is this about? (optional)"), { target: { value: "ORD-PICK-1" } });
    fireEvent.change(screen.getByPlaceholderText("Tell us what's wrong…"), { target: { value: "help with this order" } });
    (apiPost as Mock).mockResolvedValue({ ok: true, ticket_id: 42 });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith("/api/v1/account/support", {
        message: "help with this order",
        order_code: "ORD-PICK-1",
      }),
    );
  });
```

(The existing `"creates a new ticket and refetches"` test already asserts `apiPost` is called with exactly `{ message: "New issue" }` — no `order_code` key — when nothing is picked, so it doubles as the "omitted when unset" coverage; no separate test needed for that case.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test -- SupportPage.test.tsx`
Expected: FAIL — no order picker exists yet, `apiPost` is called without `order_code`.

- [ ] **Step 4: Implement**

In `apps/storefront/client/src/pages/SupportPage.tsx`:

Add to the imports:
```ts
import type { AccountOrdersData, SupportData } from "../api/types";
```
(replace the existing `import type { SupportData } from "../api/types";` line with the one above)

Add state and a second query, right after the existing `data`/`error`/`refetch` destructure:

```ts
  const [orderCode, setOrderCode] = useState("");
  const { data: ordersData } = useQuery({
    queryKey: ["account-orders"],
    queryFn: () => apiGet<AccountOrdersData>("/api/v1/account/orders"),
    retry: false,
  });
```

Update the mutation to include `order_code`:

```ts
  const createMutation = useMutation({
    mutationFn: (vars: { message: string; files: File[]; orderCode: string }) => {
      if (vars.files.length === 0) {
        return apiPost<{ ok: boolean; ticket_id: number | null }>("/api/v1/account/support", {
          message: vars.message,
          ...(vars.orderCode ? { order_code: vars.orderCode } : {}),
        });
      }
      const form = new FormData();
      form.append("message", vars.message);
      if (vars.orderCode) form.append("order_code", vars.orderCode);
      for (const file of vars.files) form.append("attachments", file);
      return apiPostFormWithProgress<{ ok: boolean; ticket_id: number | null }>(
        "/api/v1/account/support",
        form,
        setUploadProgress,
      );
    },
    onSuccess: (resp) => {
      setMessage(t("web.support_template"));
      setFiles([]);
      setOrderCode("");
      refetch();
      if (resp.ticket_id != null) setToastText(t("web.support_ticket_created", { id: resp.ticket_id }));
    },
    onError: (err) => {
      setToastKind("error");
      setToastText(t(err instanceof Error ? err.message : "error.generic"));
    },
  });
```

Update `onSubmit` to pass `orderCode`:

```ts
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setToastKind("success");
    setUploadProgress(0);
    createMutation.mutate({ message, files, orderCode });
  }
```

Add the picker to the form markup, right before the `<AttachmentPicker ... />` line:

```tsx
        <label className="field-label mt-3" htmlFor="ticket-order-picker">
          {t("web.ticket_order_picker_label")}
        </label>
        <select
          id="ticket-order-picker"
          value={orderCode}
          onChange={(e) => setOrderCode(e.target.value)}
          className="field"
          disabled={createMutation.isPending}
        >
          <option value="">{t("web.ticket_order_picker_none")}</option>
          {ordersData?.orders.map((o) => (
            <option key={o.code} value={o.code}>
              {o.code} — {o.items}
            </option>
          ))}
        </select>
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test -- SupportPage.test.tsx`
Expected: PASS, all tests including pre-existing ones.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/storefront/client/src/pages/SupportPage.tsx apps/storefront/client/src/pages/SupportPage.test.tsx
git commit -m "feat(storefront-client): let customers pick which order a new ticket is about"
```

---

### Task 17: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: PASS — every suite touched in this plan (`packages/db`, `apps/storefront`, `apps/storefront-client`) plus everything untouched stays green.

- [ ] **Step 3: Rebuild the storefront client bundle** (required before manual verification in a browser, per this repo's build contract)

Run: `pnpm --filter @app/storefront-client build`
Expected: builds cleanly.

- [ ] **Step 4: Manual smoke check**

Start the dev server (`pnpm dev:store` or the repo's usual storefront dev command), sign in as a customer with at least one delivered order, then:
1. Create a ticket from `/account/support`, picking that order in the new dropdown.
2. Open the created ticket — confirm the header, status pill, order summary sidebar (with warranty/payment/total), and empty-state ("Waiting for Support") all render.
3. Reply, confirm the message appears in the thread grouped under today's date.
4. As an admin (or by flipping the ticket's status directly in the DB for this check), get a support reply, reload, confirm "Issue Solved" appears and the empty-state disappears.
5. Click "Issue Solved" — confirm the closed banner + (if within 7 days, which it will be) the Reopen button appear.
6. Click "Reopen ticket" — confirm the ticket returns to "Waiting for Support" and the composer reappears.
7. Click "Download Credentials" on the order summary card — confirm it navigates to the order detail page and scrolls to the credentials block.
8. Resize the browser below 1024px — confirm the layout collapses to a single column with the sidebar below the conversation, and nothing is clipped or hidden.

No `- [ ]` step here writes code — this is a manual pass. Report what you saw, not just "it works," per this repo's verification-before-completion convention.

- [ ] **Step 5: Final commit if the smoke check turned up formatting-only fixes**

Only if Step 4 surfaced something (typo, wrong copy, minor styling) — fix it, re-run Steps 1–2, then:

```bash
git add -A
git commit -m "fix(storefront-client): address issues found in ticket workspace smoke test"
```

If Step 4 was clean, skip this step — nothing to commit.
