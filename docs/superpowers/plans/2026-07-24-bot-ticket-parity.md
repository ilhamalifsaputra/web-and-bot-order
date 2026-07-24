# Order-Bot Support Ticket Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the Telegram order-bot's (`apps/order-bot`) support ticket flow up to feature parity with the already-shipped storefront redesign — order linkage on ticket creation, correct customer self-close, ticket reopen, and an order summary in the ticket detail view.

**Architecture:** All backend capability already exists and is shared via `packages/db/src/crud/support.ts` (untouched by this plan). This plan is purely additive bot-side wiring: one new pure formatter, two keyboard changes, one conversation-wizard step, and two handler fixes/additions — all following this bot's existing grammY conventions (`smartEdit`, single-active-keyboard, `t(ctx, key, args)` i18n, `conversation.external()` for pre-wait DB reads).

**Tech Stack:** grammY (+ `@grammyjs/conversations`), Prisma via `@app/db`, Vitest with the bot's `FakeConversation`/`makeCtx` test harness (`apps/order-bot/test/helpers/ctx.ts`).

## Global Constraints

- Do not modify `packages/db/src/crud/support.ts`, `prisma/schema.prisma`, or anything under `apps/storefront/**` — all already correct and shipped.
- Do not touch admin-facing bot flows: `apps/order-bot/src/handlers/admin.ts` (`closeTicketAdmin`) or `apps/order-bot/src/jobs/index.ts` (auto-close job) — both correctly keep using the admin-only `closeTicket`.
- The order-picker step in `/support` must be **skippable** — many tickets are general questions, not order-specific (matches the storefront's nullable `orderId`). If the customer has zero past orders, skip the step entirely (no empty prompt).
- All customer-facing text goes through `t(ctx, key, args)` / `coreT(key, lang, args)` against `packages/core/locales/{en,id}.json` — both keysets stay identical. Never hardcode English.
- Reopen gating is a **two-tier split**, mirroring the storefront exactly: a lightweight, non-mutating inline check (`closedAt` + `TICKET_REOPEN_WINDOW_DAYS`) decides whether to *show* the Reopen button; the actual tap calls the real `reopenTicket()` (atomic, authoritative) and re-renders the screen on failure so a stale button disappears.
- Test commands run from the repo root as `pnpm test -- <file-or-pattern>` — there is no per-package `test` script in this monorepo; `pnpm --filter <pkg> test` silently no-ops (empty output, exit 0) instead of running anything.
- `pnpm typecheck` and the covering test files must stay green after every task.

---

## File Structure

**New files:**
- `apps/order-bot/test/ticket-order-summary.test.ts` — tests for the new pure formatter

**Modified files:**
- `apps/order-bot/src/util/format.ts` — new `summarizeTicketOrder()` + supporting types
- `apps/order-bot/src/keyboards/customer.ts` — `ticketViewKb` gains a `reopenable` param; new `orderPickerKb`
- `apps/order-bot/src/handlers/customer.ts` — `viewMyTicket` uses `getTicketWithOrder`, renders the order summary, computes `reopenable`
- `apps/order-bot/src/handlers/callbacks.ts` — `closeTicketUser` fixed to use `closeTicketByUser` (+ error-key bug fix); new `reopenTicketUser`; `dispatchTicket` gains a `reopen` branch
- `apps/order-bot/src/conversations/support.ts` — new optional order-picker wizard step; `createTicket` call gains the `orderId` arg
- `apps/order-bot/test/conversations.test.ts` — new test for the order-picker step (existing support test stays green unchanged — sample user has no orders)
- `apps/order-bot/test/handlers.test.ts` — new tests for `closeTicketUser`/`reopenTicketUser`/`viewMyTicket`'s order summary
- `packages/core/locales/en.json`, `packages/core/locales/id.json` — 8 new keys each

---

### Task 1: Locale keys

**Files:**
- Modify: `packages/core/locales/en.json`
- Modify: `packages/core/locales/id.json`

**Interfaces:**
- Produces: every key later tasks reference via `t(ctx, key, args)` / `coreT(key, lang, args)`.

- [ ] **Step 1: Add the English keys**

In `packages/core/locales/en.json`, insert into the existing `ticket.*` block (right after `"ticket.auto_closed": "...",` at line 308, keeping the block's existing key order otherwise untouched):

```json
  "ticket.btn_reopen": "🔓 Reopen",
  "ticket.order_summary": "🧾 <b>Related order:</b> <code>#{code}</code> — {status}\n{product}{warranty}",
  "ticket.order_warranty_expired": "⚠️ Warranty expired",
  "ticket.order_warranty_until": "🛡 Warranty until {date}",
  "ticket.reopened_toast": "Ticket reopened.",
```

Insert into the existing `support.*` block (right after `"support.btn_submit_photos": "...",` at line 299):

```json
  "support.ask_order": "Is this ticket about a specific order? Pick one below, or skip for a general question.",
  "support.order_linked_toast": "Linked to order #{code}.",
  "support.order_picker_skip": "⏭ General question (skip)",
```

- [ ] **Step 2: Add the matching Indonesian keys**

In `packages/core/locales/id.json`, same positions (after `"ticket.auto_closed"` and after `"support.btn_submit_photos"` respectively):

```json
  "ticket.btn_reopen": "🔓 Buka Kembali",
  "ticket.order_summary": "🧾 <b>Order terkait:</b> <code>#{code}</code> — {status}\n{product}{warranty}",
  "ticket.order_warranty_expired": "⚠️ Garansi telah berakhir",
  "ticket.order_warranty_until": "🛡 Garansi hingga {date}",
  "ticket.reopened_toast": "Tiket dibuka kembali.",
```

```json
  "support.ask_order": "Apakah tiket ini terkait pesanan tertentu? Pilih salah satu di bawah, atau lewati untuk pertanyaan umum.",
  "support.order_linked_toast": "Terhubung ke order #{code}.",
  "support.order_picker_skip": "⏭ Pertanyaan umum (lewati)",
```

`error.ticket_not_closed` and `error.ticket_reopen_expired` **already exist** in both files (added by the storefront work) — reused as-is in Task 5, no changes needed here.

- [ ] **Step 3: Verify key parity**

Run: `pnpm test -- i18n`
Expected: PASS — same key set in both files.

- [ ] **Step 4: Commit**

```bash
git add packages/core/locales/en.json packages/core/locales/id.json
git commit -m "feat(order-bot): add locale copy for ticket order-linkage, reopen, and picker"
```

---

### Task 2: `summarizeTicketOrder` — order-summary formatter

**Files:**
- Modify: `apps/order-bot/src/util/format.ts`
- Create: `apps/order-bot/test/ticket-order-summary.test.ts`

**Interfaces:**
- Consumes: `groupOrderItems`, `statusBadge` (already in this file); `addDays` from `@app/core/datetime`; `OrderStatus` from `@app/core/enums` (already imported in this file).
- Produces: `TicketOrderLike`, `TicketOrderSummary`, `summarizeTicketOrder(order: TicketOrderLike): TicketOrderSummary`.

- [ ] **Step 1: Write the failing test**

`apps/order-bot/test/ticket-order-summary.test.ts`:

```ts
// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { describe, it, expect } from "vitest";
import { OrderStatus } from "@app/core/enums";
import { summarizeTicketOrder, type TicketOrderLike } from "../src/util/format";

const baseItem = {
  productId: 1,
  quantity: 1,
  unitPrice: "45000",
  product: { id: 1, name: "Smoke Test Netflix", durationLabel: "1 month" },
};

const baseOrder: TicketOrderLike = {
  orderCode: "ORD-TICK-1",
  status: OrderStatus.DELIVERED,
  deliveredAt: new Date(),
  items: [{ ...baseItem, warrantyDaysSnapshot: 30 }],
};

describe("summarizeTicketOrder", () => {
  it("marks warranty active when delivered within the warranty window", () => {
    const s = summarizeTicketOrder(baseOrder);
    expect(s.orderCode).toBe("ORD-TICK-1");
    expect(s.productLine).toContain("Smoke Test Netflix");
    expect(s.warranty).not.toBeNull();
    expect(s.warranty!.active).toBe(true);
  });

  it("marks warranty expired when the delivery date is well past the warranty window", () => {
    const deliveredAt = new Date(Date.now() - 60 * 86_400_000); // 60 days ago
    const s = summarizeTicketOrder({ ...baseOrder, deliveredAt, items: [{ ...baseItem, warrantyDaysSnapshot: 30 }] });
    expect(s.warranty!.active).toBe(false);
  });

  it("returns warranty: null for an order that hasn't been delivered yet", () => {
    const s = summarizeTicketOrder({ ...baseOrder, status: OrderStatus.PROCESSING, deliveredAt: null });
    expect(s.warranty).toBeNull();
  });

  it("returns warranty: null when status is DELIVERED but deliveredAt is somehow null", () => {
    const s = summarizeTicketOrder({ ...baseOrder, deliveredAt: null });
    expect(s.warranty).toBeNull();
  });

  it("builds the status badge via the existing statusBadge helper", () => {
    const s = summarizeTicketOrder(baseOrder);
    expect(s.statusBadge).toContain("DELIVERED");
  });

  it("escapes HTML-significant characters in the product name", () => {
    const s = summarizeTicketOrder({
      ...baseOrder,
      items: [{ ...baseItem, product: { ...baseItem.product, name: "A & B <Plan>" }, warrantyDaysSnapshot: 30 }],
    });
    expect(s.productLine).not.toContain("<Plan>");
    expect(s.productLine).toContain("&amp;");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- ticket-order-summary.test.ts`
Expected: FAIL — `summarizeTicketOrder`/`TicketOrderLike` don't exist yet.

- [ ] **Step 3: Implement**

In `apps/order-bot/src/util/format.ts`, change the `@app/core/datetime` import line (currently `import { ensureUtc } from "@app/core/datetime";`) to:

```ts
import { ensureUtc, addDays } from "@app/core/datetime";
```

Add, right after `groupOrderItems`'s closing brace:

```ts
export interface TicketOrderLike {
  orderCode: string;
  status: string;
  deliveredAt: Date | null;
  items: (OrderItemLike & { warrantyDaysSnapshot: number })[];
}

export interface TicketOrderSummary {
  orderCode: string;
  statusBadge: string;
  productLine: string;
  warranty: { active: boolean; untilDisplay: string } | null;
}

/**
 * Condensed order facts for a ticket's linked order — a few lines for a chat
 * bubble, not the full viewOrder() card (which branches on payment
 * countdowns, credentials, manual-fields — none relevant inside a ticket).
 * Warranty is computed from the FIRST item's warrantyDaysSnapshot only: a
 * ticket's linked order is normally single-product, and a multi-product
 * order with divergent per-item warranty windows is a rare edge this
 * condensed line doesn't attempt to fully resolve.
 */
export function summarizeTicketOrder(order: TicketOrderLike): TicketOrderSummary {
  const groups = groupOrderItems(order.items);
  const g = groups[0];
  const productLine = g ? `${esc(g.product.name)} × ${g.quantity}` : "-";
  let warranty: TicketOrderSummary["warranty"] = null;
  if (order.status === OrderStatus.DELIVERED && order.deliveredAt && order.items[0]) {
    const until = addDays(order.deliveredAt, order.items[0].warrantyDaysSnapshot);
    warranty = { active: until.getTime() > Date.now(), untilDisplay: ensureUtc(until).toFormat("dd/LL/yyyy") };
  }
  return { orderCode: order.orderCode, statusBadge: statusBadge(order.status), productLine, warranty };
}
```

`esc` is already imported/re-exported in this file (line 12, `export { esc, ... } from "@app/core/formatters";`) — no new import needed for it, but since it's re-exported (not locally bound), add a local import too: change the re-export line's neighboring plain import. Concretely, add this import near the top of the file (it currently only re-exports `esc`, doesn't bind it locally for use inside this file):

```ts
import { esc } from "@app/core/formatters";
```

(Place this new import line directly above the existing `export { esc, ... } from "@app/core/formatters";` block — both a local-use import and the pre-existing re-export can coexist targeting the same module.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- ticket-order-summary.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add apps/order-bot/src/util/format.ts apps/order-bot/test/ticket-order-summary.test.ts
git commit -m "feat(order-bot): add summarizeTicketOrder formatter for the ticket detail view"
```

---

### Task 3: Keyboard changes — `ticketViewKb` reopen button + `orderPickerKb`

**Files:**
- Modify: `apps/order-bot/src/keyboards/customer.ts`

(No dedicated test file — both changes are exercised end-to-end by Task 4's and Task 6's tests, matching this codebase's existing convention where keyboard builders are validated via the handler/conversation tests that inspect `sink`'s rendered markup, not standalone.)

**Interfaces:**
- Consumes: `cb`, `ik`, `Btn`, `truncLabel`, `coreT`, `TicketStatus` (all already imported/defined in this file).
- Produces: `ticketViewKb(ticketId: number, statusValue: string, lang: string, reopenable?: boolean): InlineKeyboard` (signature extended, backward-compatible via default); `orderPickerKb(orders: OrderPickerLike[], lang: string): InlineKeyboard`.

- [ ] **Step 1: Implement**

Replace the existing `ticketViewKb` (lines 638-651):

```ts
/** Ticket detail view keyboard: Reply/Close if open, Reopen if closed-and-still-in-window, always Back/Main. */
export function ticketViewKb(ticketId: number, statusValue: string, lang: string, reopenable = false): InlineKeyboard {
  const rows: Btn[][] = [];
  if (statusValue !== TicketStatus.CLOSED) {
    rows.push([
      { text: coreT("support.btn_reply", lang), data: cb("ticket", "reply", ticketId) },
      { text: coreT("support.btn_close", lang), data: cb("ticket", "close", ticketId) },
    ]);
  } else if (reopenable) {
    rows.push([{ text: coreT("ticket.btn_reopen", lang), data: cb("ticket", "reopen", ticketId) }]);
  }
  rows.push([
    { text: coreT("menu.back", lang), data: cb("ticket", "list") },
    { text: coreT("menu.main", lang), data: cb("menu", "main") },
  ]);
  return ik(rows);
}
```

Add, right after `ticketViewKb`'s closing brace:

```ts
interface OrderPickerLike {
  id: number;
  orderCode: string;
  items?: Array<{ product: { name: string } }>;
}

/** One button per recent order (+ a skip/general-question row) for the
 * /support conversation's optional order-linking step. Deliberately a
 * separate function from ordersListKb — that one only makes PENDING_PAYMENT
 * rows tappable (order details render as plain text there); this needs
 * EVERY order tappable regardless of status, for a "pick which order"
 * wizard step, not a status list. */
export function orderPickerKb(orders: OrderPickerLike[], lang: string): InlineKeyboard {
  const rows: Btn[][] = orders.map((o) => {
    const productName = o.items?.[0]?.product.name ?? "";
    return [{ text: truncLabel(`#${o.orderCode} — ${productName}`, 30), data: cb("support", "order", o.id) }];
  });
  rows.push([{ text: coreT("support.order_picker_skip", lang), data: cb("support", "order", "skip") }]);
  return ik(rows);
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: passes (this only fails if a call site of `ticketViewKb` passes a 4th positional arg of the wrong type — none do yet; the new 4th param is optional so the one existing call site in `customer.ts:1053`, still calling with 3 args, keeps compiling).

- [ ] **Step 3: Commit**

```bash
git add apps/order-bot/src/keyboards/customer.ts
git commit -m "feat(order-bot): add Reopen button to ticketViewKb and a new orderPickerKb"
```

---

### Task 4: `viewMyTicket` — show linked order, compute reopenable

**Files:**
- Modify: `apps/order-bot/src/handlers/customer.ts`
- Modify: `apps/order-bot/test/handlers.test.ts`

**Interfaces:**
- Consumes: `getTicketWithOrder`, `TICKET_REOPEN_WINDOW_DAYS` (from `@app/db`, both already exported by `packages/db/src/crud/support.ts`); `addDays` (from `@app/core/datetime`); `summarizeTicketOrder` (Task 2); `ckb.ticketViewKb`'s new `reopenable` param (Task 3).
- Produces: `viewMyTicket` renders an order-summary block when the ticket has one, and passes the correct `reopenable` to the keyboard.

- [ ] **Step 1: Write the failing test**

Add to `apps/order-bot/test/handlers.test.ts`, inside the existing `describe` block that contains the current `"viewMyTicket never strands the user when the ticket isn't found"` test (around line 477) — add these three new tests right after it:

```ts
  it("viewMyTicket shows the linked order's summary (product, status, warranty) when the ticket has one", async () => {
    const stock = await prisma.stockItem.create({
      data: { productId: sample.product.id, credentials: "tick@mail.com:pw", status: "SOLD" },
    });
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-TICKVIEW-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        status: OrderStatus.DELIVERED,
        deliveredAt: new Date(),
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: sample.product.id, stockItemId: stock.id, unitPrice: "45000", warrantyDaysSnapshot: 30 },
    });
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", orderId: order.id },
    });

    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, ticket.id);

    const body = JSON.stringify(sink);
    expect(body).toContain(order.orderCode);
    expect(body).toContain(sample.product.name);
  });

  it("viewMyTicket renders no order block when the ticket has no linked order", async () => {
    const ticket = await prisma.supportTicket.create({ data: { userId: sample.user.id, message: "general question" } });
    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, ticket.id);
    const body = JSON.stringify(sink);
    expect(body).not.toContain("Related order");
  });

  it("viewMyTicket shows a Reopen button only for a CLOSED ticket still within the 7-day window", async () => {
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.CLOSED, closedAt: new Date() },
    });
    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, ticket.id);
    expect(sentIncludes(sink, "v1:ticket:reopen")).toBe(true);
  });

  it("viewMyTicket shows no Reopen button once the 7-day window has passed", async () => {
    const wayPast = new Date(Date.now() - 8 * 86_400_000);
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.CLOSED, closedAt: wayPast },
    });
    const { ctx, sink } = customerCtx();
    await customer.viewMyTicket(ctx, ticket.id);
    expect(sentIncludes(sink, "v1:ticket:reopen")).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- handlers.test.ts`
Expected: FAIL on the 4 new tests (order summary never rendered; Reopen button never rendered) — the existing tests in this large file continue to pass.

- [ ] **Step 3: Implement**

In `apps/order-bot/src/handlers/customer.ts`:

Change the `@app/core/datetime` import (line 14, currently `import { ensureUtc, localize } from "@app/core/datetime";`) to:

```ts
import { ensureUtc, localize, addDays } from "@app/core/datetime";
```

In the `@app/db` import block (lines 18-45), replace `getTicket,` with `getTicketWithOrder,\n  TICKET_REOPEN_WINDOW_DAYS,` (keeping every other line unchanged):

```ts
import {
  prisma,
  upsertUser,
  botOverallStats,
  userTotalSpent,
  listCatalogProducts,
  soldCountsByProduct,
  getCatalogProductWithDenominations,
  getDenomination,
  getDenominationWithProduct,
  countAvailableStock,
  getBulkPricingForDenomination,
  countUserOrders,
  listUserOrders,
  getOrder,
  getUser,
  setUserLanguage,
  subscribeToRestock,
  productRating,
  soldCountForDenomination,
  soldCountForProduct,
  getSetting,
  setSetting,
  searchCatalog,
  listUserTickets,
  getTicketWithOrder,
  TICKET_REOPEN_WINDOW_DAYS,
  listTicketMessages,
} from "@app/db";
```

Change the `../util/format` import (line 52) to add `summarizeTicketOrder`:

```ts
import { esc, formatUsdtAmount, formatIdr, statusBadge, groupOrderItems, formatCountdown, formatFlashRemaining, priceIdr, orderAmount, mixedAmount, renderBybitBscTrackingScreen, summarizeTicketOrder } from "../util/format";
```

Replace `viewMyTicket` (lines 1011-1054) with:

```ts
export async function viewMyTicket(ctx: MyContext, ticketId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const ticket = await getTicketWithOrder(prisma, ticketId);
  if (ticket === null || ticket.userId !== info.id) {
    await smartEdit(ctx, t(ctx, "error.ticket_not_found"), ckb.backToMain(lang));
    return;
  }
  const messages = await listTicketMessages(prisma, ticketId, 10);

  const statusLabels: Record<string, string> = {
    [TicketStatus.OPEN]: "Open",
    [TicketStatus.REPLIED]: "Replied",
    [TicketStatus.CLOSED]: "Closed",
  };
  const header = t(ctx, "ticket.view_title", {
    id: ticketId,
    status: statusLabels[ticket.status] ?? ticket.status,
    date: ensureUtc(ticket.createdAt).toFormat("yyyy-LL-dd HH:mm"),
  });

  const parts = [header];
  if (ticket.order) {
    const s = summarizeTicketOrder(ticket.order);
    const warrantyLine = s.warranty
      ? s.warranty.active
        ? `\n${t(ctx, "ticket.order_warranty_until", { date: s.warranty.untilDisplay })}`
        : `\n${t(ctx, "ticket.order_warranty_expired")}`
      : "";
    parts.push(
      t(ctx, "ticket.order_summary", {
        code: ticket.order.orderCode,
        status: s.statusBadge,
        product: s.productLine,
        warranty: warrantyLine,
      }),
    );
  }
  parts.push("");

  if (messages.length) {
    for (const msg of messages) {
      const timeStr = ensureUtc(msg.createdAt).toFormat("HH:mm dd/LL");
      const key = msg.senderType === SenderType.USER ? "ticket.message_user" : "ticket.message_admin";
      parts.push(t(ctx, key, { time: timeStr, content: esc(msg.content) }));
    }
  } else {
    parts.push(
      t(ctx, "ticket.message_user", {
        time: ensureUtc(ticket.createdAt).toFormat("HH:mm dd/LL"),
        content: esc(ticket.message),
      }),
    );
    if (ticket.adminReply) {
      const replyTime = ticket.repliedAt ? ensureUtc(ticket.repliedAt).toFormat("HH:mm dd/LL") : "—";
      parts.push(t(ctx, "ticket.message_admin", { time: replyTime, content: esc(ticket.adminReply) }));
    }
  }

  const reopenable =
    ticket.status === TicketStatus.CLOSED && ticket.closedAt != null
      ? addDays(ticket.closedAt, TICKET_REOPEN_WINDOW_DAYS).getTime() >= Date.now()
      : false;

  await smartEdit(ctx, parts.join("\n\n"), ckb.ticketViewKb(ticketId, ticket.status, lang, reopenable));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- handlers.test.ts`
Expected: PASS, all tests in the file (this is a large shared file — confirm nothing else broke, not just the 4 new tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add apps/order-bot/src/handlers/customer.ts apps/order-bot/test/handlers.test.ts
git commit -m "feat(order-bot): show linked-order summary and gate Reopen in viewMyTicket"
```

---

### Task 5: `callbacks.ts` — fix self-close, add reopen

**Files:**
- Modify: `apps/order-bot/src/handlers/callbacks.ts`
- Modify: `apps/order-bot/test/handlers.test.ts`

**Interfaces:**
- Consumes: `closeTicketByUser`, `reopenTicket` (from `@app/db`, Task-2-of-the-storefront-plan exports, already live); `customer.viewMyTicket` (Task 4, for re-rendering after reopen attempts).
- Produces: `closeTicketUser` now calls `closeTicketByUser` with the correct error key; new `reopenTicketUser(ctx, ticketId)`; `dispatchTicket` gains a `reopen` branch.

- [ ] **Step 1: Write the failing tests**

Add to `apps/order-bot/test/handlers.test.ts`, in the "Callback router (routeCallback)" describe block (the one starting around line 1828) — add these tests:

```ts
  it("v1:ticket:close:<id> closes the caller's own ticket via routeCallback and shows the closed-confirmation keyboard", async () => {
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.OPEN },
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:ticket:close:${ticket.id}` });
    await routeCallback(ctx);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
    expect(sentIncludes(sink, "resolved")).toBe(true);
  });

  it("closing someone else's ticket shows 'ticket not found', not 'order not found' (bug fix)", async () => {
    const otherUser = await upsertUser(prisma, { telegramId: 5001, username: "other" });
    const ticket = await prisma.supportTicket.create({ data: { userId: otherUser.id, message: "not yours" } });
    const { ctx, sink } = customerCtx({ callbackData: `v1:ticket:close:${ticket.id}` });
    await routeCallback(ctx);

    const toasts = calls(sink, "answerCallbackQuery");
    const body = JSON.stringify(toasts);
    expect(body).not.toContain("Order not found");
  });

  it("v1:ticket:reopen:<id> reopens a closed ticket within the window and re-renders the detail screen", async () => {
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.CLOSED, closedAt: new Date() },
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:ticket:reopen:${ticket.id}` });
    await routeCallback(ctx);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.OPEN);
    expect(sentIncludes(sink, "v1:ticket:reply")).toBe(true); // re-rendered screen now offers Reply again
  });

  it("v1:ticket:reopen:<id> past the 7-day window shows an error toast and leaves the ticket closed", async () => {
    const wayPast = new Date(Date.now() - 8 * 86_400_000);
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "help", status: TicketStatus.CLOSED, closedAt: wayPast },
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:ticket:reopen:${ticket.id}` });
    await routeCallback(ctx);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
    const toasts = calls(sink, "answerCallbackQuery");
    expect(JSON.stringify(toasts).length).toBeGreaterThan(0);
  });

  it("reopening another user's ticket does nothing (ownership check)", async () => {
    const otherUser = await upsertUser(prisma, { telegramId: 5002, username: "other2" });
    const ticket = await prisma.supportTicket.create({
      data: { userId: otherUser.id, message: "not yours", status: TicketStatus.CLOSED, closedAt: new Date() },
    });
    const { ctx } = customerCtx({ callbackData: `v1:ticket:reopen:${ticket.id}` });
    await routeCallback(ctx);

    const fresh = await prisma.supportTicket.findUnique({ where: { id: ticket.id } });
    expect(fresh!.status).toBe(TicketStatus.CLOSED);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- handlers.test.ts`
Expected: FAIL — `reopen` isn't a routed action yet (falls through to no-op in `dispatchTicket`), and the bug-fix test may or may not already pass depending on exact toast text (verify it currently fails for the right reason: the un-fixed code sends `"Order not found"` copy, not `"Ticket not found"`).

- [ ] **Step 3: Implement**

In `apps/order-bot/src/handlers/callbacks.ts`:

Remove the `TicketStatus` import (line 12) — becomes fully unused after this change.

Change the `@app/db` import block (lines 14-18) from:

```ts
import {
  prisma,
  getTicket,
  closeTicket,
} from "@app/db";
```

to:

```ts
import {
  prisma,
  getTicket,
  closeTicketByUser,
  reopenTicket,
} from "@app/db";
```

Replace `closeTicketUser` (lines 306-337) with:

```ts
async function closeTicketUser(ctx: MyContext, ticketId: number): Promise<void> {
  const info = ctx.session.dbUser!;
  const ticket = await getTicket(prisma, ticketId);
  if (ticket === null || ticket.userId !== info.id) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.ticket_not_found"), show_alert: true });
    return;
  }
  const closed = await closeTicketByUser(prisma, ticketId);
  if (!closed) {
    await ctx.answerCallbackQuery({ text: t(ctx, "support.already_closed"), show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: t(ctx, "support.ticket_closed_user") });
  // Edit the ticket bubble into a closed-confirmation (with navigation) rather
  // than just stripping its buttons and relying on the ephemeral toast.
  await smartEdit(ctx, t(ctx, "support.ticket_closed_user"), ckb.ticketClosedKb(ctx.session.lang));

  const targets = config.SUPPORT_GROUP_ID ? [config.SUPPORT_GROUP_ID] : adminIds();
  for (const chatId of targets) {
    if (!chatId) continue;
    try {
      await ctx.api.sendMessage(
        chatId,
        `✅ Ticket #${ticketId} marked as resolved by user <code>${ctx.from!.id}</code>.`,
        { parse_mode: "HTML" },
      );
    } catch (err) {
      logger.error({ err }, `Failed to notify admin chat ${chatId} that user ${ctx.from!.id} closed support ticket #${ticketId} — admins relying on that chat won't see the resolution`);
    }
  }
}

/** Customer self-reopen (Reopen button on a CLOSED ticket's detail view).
 * Re-validates atomically at tap-time via reopenTicket — authoritative,
 * independent of whatever `reopenable` the screen was rendered with (which
 * can go stale between render and tap as the 7-day window elapses). */
async function reopenTicketUser(ctx: MyContext, ticketId: number): Promise<void> {
  const info = ctx.session.dbUser!;
  const ticket = await getTicket(prisma, ticketId);
  if (ticket === null || ticket.userId !== info.id) {
    await ctx.answerCallbackQuery({ text: t(ctx, "error.ticket_not_found"), show_alert: true });
    return;
  }
  const result = await reopenTicket(prisma, ticketId);
  if (!result.ok) {
    const key = result.reason === "window_expired" ? "error.ticket_reopen_expired" : "error.ticket_not_closed";
    await ctx.answerCallbackQuery({ text: t(ctx, key), show_alert: true });
    await customer.viewMyTicket(ctx, ticketId); // re-render so a now-stale Reopen button disappears
    return;
  }
  await ctx.answerCallbackQuery({ text: t(ctx, "ticket.reopened_toast") });
  await customer.viewMyTicket(ctx, ticketId);
}
```

Update `dispatchTicket` (lines 182-188):

```ts
const dispatchTicket: DomainDispatcher = async (ctx, parts) => {
  // user-side ticket management; 'reply' is owned by the ticket-reply conv
  const action = parts[2];
  if (action === "list") await customer.listMyTickets(ctx);
  else if (action === "view") await customer.viewMyTicket(ctx, parseInt(parts[3]!, 10));
  else if (action === "close") await closeTicketUser(ctx, parseInt(parts[3]!, 10));
  else if (action === "reopen") await reopenTicketUser(ctx, parseInt(parts[3]!, 10));
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- handlers.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add apps/order-bot/src/handlers/callbacks.ts apps/order-bot/test/handlers.test.ts
git commit -m "fix(order-bot): customer self-close uses closeTicketByUser + correct error key; add reopen"
```

---

### Task 6: `/support` conversation — optional order-picker step

**Files:**
- Modify: `apps/order-bot/src/conversations/support.ts`
- Modify: `apps/order-bot/test/conversations.test.ts`

**Interfaces:**
- Consumes: `listUserOrders` (from `@app/db`, already exported by `packages/db/src/crud/orders.ts`); `ckb.orderPickerKb` (Task 3); `createTicket`'s 6th `orderId` param (already live).
- Produces: `supportConversation` links the created ticket to a picked order when one exists and is chosen.

- [ ] **Step 1: Write the failing test**

Add to `apps/order-bot/test/conversations.test.ts`, inside the `describe("support + reject conversations", ...)` block, right after the existing `"support: description + submit creates a ticket..."` test:

```ts
  it("support: with an existing order, picking it from the order picker links orderId on the ticket", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-SUPPORTPICK-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        status: OrderStatus.DELIVERED,
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: sample.product.id, unitPrice: "45000", warrantyDaysSnapshot: 30 },
    });

    const sink: SentCall[] = [];
    const entry = entryCust(sink, "v1:support:open");
    const conv = new FakeConversation([
      msg(sink, { text: "My account stopped working yesterday" }),
      msg(sink, { callbackData: `v1:support:order:${order.id}` }),
      msg(sink, { callbackData: "v1:support:photos:done" }),
    ]);
    await supportConversation(conv.asMyConversation(), entry);

    const ticket = await prisma.supportTicket.findFirst({ where: { userId: sample.user.id } });
    expect(ticket).toBeTruthy();
    expect(ticket!.orderId).toBe(order.id);
  });

  it("support: skipping the order picker still creates a ticket with orderId: null", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-SUPPORTSKIP-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "45000",
        totalAmount: "45000",
        status: OrderStatus.DELIVERED,
      },
    });
    await prisma.orderItem.create({
      data: { orderId: order.id, productId: sample.product.id, unitPrice: "45000", warrantyDaysSnapshot: 30 },
    });

    const sink: SentCall[] = [];
    const entry = entryCust(sink, "v1:support:open");
    const conv = new FakeConversation([
      msg(sink, { text: "General question, not order-specific" }),
      msg(sink, { callbackData: "v1:support:order:skip" }),
      msg(sink, { callbackData: "v1:support:photos:done" }),
    ]);
    await supportConversation(conv.asMyConversation(), entry);

    const ticket = await prisma.supportTicket.findFirst({ where: { userId: sample.user.id } });
    expect(ticket!.orderId).toBeNull();
  });
```

Note: the pre-existing `"support: description + submit creates a ticket, a message, and forwards to admins"` test (immediately above these) is expected to keep passing unmodified — `sample.user` (from `buildSampleData`) has no orders by default, so the new order-picker step is skipped entirely for it, and its scripted `FakeConversation` queue (description → photos:done) still matches exactly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- conversations.test.ts`
Expected: FAIL — `ticket.orderId` is always `null` regardless of the picker tap (the step doesn't exist yet), so the "picking it" test fails; the "skipping" test may pass vacuously (already `null`) until the picker step exists to prove skip is a real path, which Step 3 fixes structurally.

- [ ] **Step 3: Implement**

In `apps/order-bot/src/conversations/support.ts`, change the `@app/db` import (line 12) from:

```ts
import { prisma, getSetting, createTicket, addTicketMessage } from "@app/db";
```

to:

```ts
import { prisma, getSetting, createTicket, addTicketMessage, listUserOrders } from "@app/db";
```

Insert this new block between the end of the description loop (after line 60's closing `}`) and the existing `await ctx.api.sendMessage(ctx.chat!.id, t(ctx, "support.ask_photos"), ...)` call (currently line 62):

```ts
  // --- AWAITING_ORDER (optional): link a past order, or skip ---
  // listUserOrders is a DB read that happens BEFORE the photo step's wait()
  // calls below — it must be wrapped in conversation.external() (same reason
  // getSetting is, above line 34) so a replay triggered by a later wait()
  // doesn't re-run it.
  const orders = await conversation.external(() => listUserOrders(prisma, info.id, 5, 0));
  let orderId: number | null = null;
  if (orders.length) {
    await ctx.api.sendMessage(ctx.chat!.id, t(ctx, "support.ask_order"), {
      parse_mode: "HTML",
      reply_markup: ckb.orderPickerKb(orders, lang),
    });
    for (;;) {
      const u = await conversation.wait();
      if (isCmd(u, "start")) return void (await startCommand(u));
      if (isCmd(u, "cancel")) return void (await smartEdit(u, t(u, "menu.main"), ckb.backToMain(lang)));
      const labelText = u.message?.text;
      if (labelText && ckb.isPersistentLabel(labelText)) return void (await handleProductNumber(u));
      const data = u.callbackQuery?.data ?? "";
      if (data === "v1:support:order:skip") {
        await u.answerCallbackQuery();
        break;
      }
      const m = /^v1:support:order:(\d+)$/.exec(data);
      if (m) {
        const picked = parseInt(m[1]!, 10);
        const match = orders.find((o) => o.id === picked);
        if (match) {
          orderId = picked;
          await u.answerCallbackQuery({ text: t(u, "support.order_linked_toast", { code: match.orderCode }) });
          break;
        }
      }
      // Anything else (stray text, unrecognized tap) — ignore and keep waiting.
    }
  }

```

Change the `createTicket` call (currently line 93) from:

```ts
  const ticket = await createTicket(prisma, info.id, body, photoFileIds);
```

to:

```ts
  const ticket = await createTicket(prisma, info.id, body, photoFileIds, null, orderId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- conversations.test.ts`
Expected: PASS, all tests including the pre-existing `"support: description + submit creates a ticket..."` one (unmodified, still green).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add apps/order-bot/src/conversations/support.ts apps/order-bot/test/conversations.test.ts
git commit -m "feat(order-bot): optional order-picker step in the /support conversation"
```

---

### Task 7: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Full test suite**

Run: `pnpm test`
Expected: PASS. Note: this monorepo's full suite has pre-existing, unrelated flakiness under repeated heavy runs (different `apps/order-bot`/`apps/web-admin` tests fail each run due to resource contention, not code defects — already observed and documented during the storefront plan's execution). If the full run shows failures, re-run the specific files this plan touched (`ticket-order-summary.test.ts`, `handlers.test.ts`, `conversations.test.ts`, `i18n`) in isolation to confirm they're clean, and treat unrelated failures as the known pre-existing flakiness unless they reproduce consistently.

- [ ] **Step 3: Manual smoke check** (if a local bot token is available; otherwise document as skipped)

1. `/support` → type a description → order picker appears (if the test account has orders) → pick one → confirm toast shows the order code → attach 0-3 photos → submit → check the new ticket's `orderId` in the DB matches the picked order.
2. Same flow, tap the skip button instead → confirm `orderId` is `null`.
3. Open the linked ticket via "My Tickets" → confirm the order summary block (product, status, warranty) renders above the message thread.
4. Tap Close on an open ticket → confirm the closed-confirmation screen, and that DB `status` flips to `CLOSED`.
5. Reopen the same ticket from its detail view → confirm the Reopen button appears, tapping it flips status back to `OPEN`, and the Reply/Close row reappears.
6. (If feasible) manually backdate a ticket's `closedAt` >7 days in the DB, reload its detail view, confirm no Reopen button appears.

Report what was actually observed, not just "it works," per this repo's verification-before-completion convention.
