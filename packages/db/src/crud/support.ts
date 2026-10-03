/**
 * Support tickets + ticket messages — port of those sections of Python crud.py.
 */
import { Prisma } from "@prisma/client";
import type { SupportTicket } from "@prisma/client";
import { TicketStatus, TicketPriority, TicketCategory, SenderType } from "@app/core/enums";
import { addDays, addMinutes, startOfDayUtc } from "@app/core/datetime";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { enqueueOwnerNewTicketEmail, enqueueOwnerTicketReplyEmail } from "./notifications";
import { logAdminAction } from "./audit";
import { withoutDeliveredContent } from "./orders";

/**
 * Mint a `ticketNumber` candidate: `TCK-YYYYMMDD-NNNNN` (current UTC date +
 * today's ticket count so far + 1, 5-digit zero-padded) — sequential, unlike
 * `Order.orderCode`'s random 4-char suffix (`generateOrderCode`/
 * `uniqueOrderCode`, packages/db/src/crud/orders.ts and packages/core/src/
 * formatters.ts), because that's the format this task's brief specifies.
 *
 * Exported (mirroring `uniqueOrderCode`'s own "exported so another crud file
 * can reuse it" precedent) so a future caller minting a preview candidate
 * outside `createTicket`'s own retry loop can reuse the same date/count
 * logic without duplicating it.
 *
 * On its own this does NOT guarantee uniqueness under concurrent writers — a
 * `count`-then-format candidate can race with a concurrent `createTicket`
 * call between this function's read and the caller's insert. That is fine:
 * `createTicket` is the only production caller, and it treats this as a
 * candidate to attempt, not a guarantee — see its own doc comment for the
 * actual safety net (retry-on-unique-constraint-violation, the same
 * `isUniqueViolation`-catch-and-retry shape `registerUser`/`generateReferralCode`
 * already use in users.ts, adapted here because a *sequential* number can't
 * just re-roll a fresh random string on collision the way a referral code
 * can — it has to re-derive the candidate from the now-updated count).
 */
export async function uniqueTicketNumberCandidate(db: Db, now: Date = new Date()): Promise<string> {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const prefix = `TCK-${y}${m}${d}-`;
  const countSoFar = await db.supportTicket.count({
    where: { ticketNumber: { startsWith: prefix } },
  });
  return `${prefix}${String(countSoFar + 1).padStart(5, "0")}`;
}

// Bounded generously above realistic contention (a burst of concurrent
// ticket creations arriving in the same UTC day) — see createTicket's doc
// comment for why a plain fixed retry count needs the jitter below to
// actually converge at this kind of concurrency, not just a bigger number.
const MAX_TICKET_NUMBER_ATTEMPTS = 25;

/** Creates the ticket (minting a unique `ticketNumber`, see
 * `uniqueTicketNumberCandidate`), then enqueues the shop owner's "new
 * ticket" email (no-op unless owner-email is configured — see
 * enqueueOwnerNewTicketEmail). Covers both the storefront and the bot's
 * ticket-creation paths from this one call site. `opts` (Task 10) lets a
 * caller set `subject`/`category`/`productId` at creation time — the /help
 * create form's customer-picked triage fields; every existing caller that
 * omits it keeps getting all three as null, exactly as before this param
 * existed. `category` can also still be set/changed later by an admin via
 * `classifyTicket`. `opts.category` flows into
 * `enqueueOwnerNewTicketEmail`'s payload too (previously always hardcoded to
 * `null` there, back when category was admin-only-post-creation).
 *
 * `ticketNumber` generation retries on a genuine unique-constraint collision
 * (concurrent callers racing for the same candidate) up to
 * `MAX_TICKET_NUMBER_ATTEMPTS` times, re-deriving a fresh candidate from the
 * DB's current count each attempt — see `uniqueTicketNumberCandidate`'s doc
 * comment for why a fresh `count` read (not a fixed offset) is what makes the
 * retry converge at all. A losing attempt also waits a small RANDOMIZED
 * backoff before retrying: without it, N callers that collided on the same
 * candidate would all re-read the same (now-updated) count and race for the
 * SAME next candidate again, converging only one-at-a-time per round instead
 * of spreading out — verified empirically against a 20-way concurrent
 * `Promise.all` burst in support.test.ts ("every ticket gets a UNIQUE
 * ticketNumber even when many are created concurrently"), which is what
 * surfaced the need for both the higher bound and the jitter (a fixed
 * retry-5 pre-check, mirroring `uniqueOrderCode`'s shape verbatim, reliably
 * failed that test). */
export async function createTicket(
  db: Db,
  userId: number,
  message: string,
  photoFileIds: string | null = null,
  attachmentUrls: string | null = null,
  orderId: number | null = null,
  // Task 10: subject/category/productId, all customer-set on the /help
  // create form (see subject's/category's/productId's own doc comments in
  // schema.prisma). Optional and last so every existing call site (2-6
  // positional args) keeps compiling unchanged.
  opts: { subject?: string | null; category?: TicketCategory | null; productId?: number | null } = {},
) {
  const subject = opts.subject ?? null;
  const category = opts.category ?? null;
  const productId = opts.productId ?? null;

  let ticket: SupportTicket | undefined;
  for (let attempt = 0; attempt < MAX_TICKET_NUMBER_ATTEMPTS; attempt++) {
    const ticketNumber = await uniqueTicketNumberCandidate(db);
    try {
      ticket = await db.supportTicket.create({
        data: { userId, message, photoFileIds, attachmentUrls, orderId, ticketNumber, subject, category, productId },
      });
      break;
    } catch (e) {
      if (isUniqueViolation(e) && attempt < MAX_TICKET_NUMBER_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 25)));
        continue;
      }
      throw e;
    }
  }
  if (!ticket) throw new Error("Could not generate a unique ticket number");
  await enqueueOwnerNewTicketEmail(db, { ticketId: ticket.id, userId, category, message });
  return ticket;
}

/** Fields of the linked customer surfaced in ticket JSON responses (web-admin
 * list/detail/CSV export) — NEVER `include: { user: true }` on a ticket
 * query: that pulls every User column (passwordHash, email, wallet
 * balances, bannedReason, …) into the response body the admin's browser
 * receives. Keep in sync with what SupportPage.tsx/TicketDetailPage.tsx
 * actually read off `ticket.user`. */
const TICKET_USER_SELECT = {
  id: true,
  fullName: true,
  username: true,
  telegramId: true,
  loginUsername: true,
} as const;

/** Same leak guard as `TICKET_USER_SELECT`, scoped to the smaller set of
 * fields the UI reads off `ticket.admin` (the assigned admin). */
const TICKET_ADMIN_SELECT = {
  id: true,
  fullName: true,
  username: true,
} as const;

export function getTicket(db: Db, ticketId: number) {
  return db.supportTicket.findUnique({
    where: { id: ticketId },
    include: { user: { select: TICKET_USER_SELECT }, admin: { select: TICKET_ADMIN_SELECT } },
  });
}

/** Ticket + its linked order (items with denomination, voucher) when one is
 * set — a single query, `order: null` when the ticket isn't linked. Used by
 * the storefront ticket detail page's Order/Product Summary sidebar; the
 * admin route and the reply/close/reopen ownership checks keep using the
 * lighter `getTicket` since they don't need the join. */
export async function getTicketWithOrder(db: Db, ticketId: number) {
  const ticket = await db.supportTicket.findUnique({
    where: { id: ticketId },
    include: {
      order: {
        include: { items: { include: { product: true } }, voucher: true },
      },
    },
  });
  // The admin ticket page spreads this order into JSON; it never needs the delivered secret.
  return ticket ? { ...ticket, order: ticket.order ? withoutDeliveredContent(ticket.order) : null } : ticket;
}

/** Returns the most recent open (still-active) ticket for an order — status
 * OPEN, WAITING_ADMIN, REPLIED, or WAITING_CUSTOMER — or null if none exists.
 * Used to detect duplicate ticket attempts — a customer cannot open a second
 * ticket for an order that already has one being worked on. Mirrors the
 * OPEN/WAITING_ADMIN and REPLIED/WAITING_CUSTOMER pairing used elsewhere in
 * this file (see `getTicketStats`, `listStaleRepliedTickets`): a ticket an
 * admin has already replied to (WAITING_CUSTOMER, or REPLIED for a
 * historical row) is still "being worked on", not fair game for a second
 * ticket — narrower than that would only catch a ticket in its first few
 * seconds of life. Distinct from `listOpenTickets` below, whose "open" means
 * "not CLOSED" (i.e. also includes RESOLVED) — this helper's "open" means
 * "still actively in the OPEN<->WAITING_ADMIN<->WAITING_CUSTOMER/REPLIED
 * cycle", so a RESOLVED ticket does NOT block a new one here.
 *
 * Plain read-then-write check, no transaction/row lock: two near-simultaneous
 * submissions for the same order (two browser tabs, or bot+storefront at
 * once) could each pass this check before either has created its ticket, so
 * in the rare case a duplicate could still slip through. Accepted tradeoff —
 * worst case is one extra ticket row, no data corruption — not a bug to fix
 * here.
 *
 * Does not itself check who owns `orderId` — both call sites (bot, storefront)
 * only ever pass an id already verified to belong to the requesting customer,
 * so the ticket this returns is always theirs. A future caller must verify
 * ownership the same way before using this helper's result. */
export function getOpenTicketForOrder(db: Db, orderId: number) {
  return db.supportTicket.findFirst({
    where: {
      orderId,
      status: {
        in: [
          TicketStatus.OPEN,
          TicketStatus.WAITING_ADMIN,
          TicketStatus.REPLIED,
          TicketStatus.WAITING_CUSTOMER,
        ],
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

/** All non-closed tickets (OPEN + REPLIED), newest first. Used by
 * apps/order-bot's admin ticket list — do not change its shape/behavior,
 * the web-admin queue uses `listTickets` instead. */
export function listOpenTickets(db: Db, limit = 50) {
  return db.supportTicket.findMany({
    where: { status: { not: TicketStatus.CLOSED } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** True count behind `listOpenTickets` (same predicate, no page-size cap). */
export function countOpenTickets(db: Db): Promise<number> {
  return db.supportTicket.count({ where: { status: { not: TicketStatus.CLOSED } } });
}

// ---- Operational queue (web-admin) ----------------------------------------

/**
 * Close a ticket; return the ticket owner's telegram_id (to notify) or null.
 * Atomic conditional claim — `count===1` means THIS call is the one that
 * actually flipped it, so a double-tap "Close" can never fire two DMs to the
 * buyer (Bot-3 fix, security audit 2026-06-23).
 */
export async function closeTicket(db: Db, ticketId: number): Promise<bigint | null> {
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: { not: TicketStatus.CLOSED } },
    data: { status: TicketStatus.CLOSED, closedAt: new Date(), lastStatusChangeAt: new Date() },
  });
  if (res.count === 0) return null;
  const ticket = await db.supportTicket.findUnique({ where: { id: ticketId } });
  if (!ticket) return null;
  const user = await db.user.findUnique({ where: { id: ticket.userId } });
  return user ? user.telegramId : null;
}

/** Customer self-close ("Issue Solved"). Same atomic conditional guard as
 * closeTicket, but the caller (the route) already verified ownership via
 * getTicket before calling this — this function only guards against a
 * double-tap / race with an admin closing the same ticket concurrently.
 * Returns false when there was nothing to close. */
export async function closeTicketByUser(db: Db, ticketId: number): Promise<boolean> {
  const now = new Date();
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: { not: TicketStatus.CLOSED } },
    data: { status: TicketStatus.CLOSED, closedAt: now, lastStatusChangeAt: now },
  });
  return res.count === 1;
}

/** Mark a ticket RESOLVED — distinct from CLOSED (still visible/reopenable,
 * just no longer needing staff attention). Same double-tap-safe conditional
 * claim shape as closeTicket. Returns true iff this call performed the
 * transition. */
export async function resolveTicket(db: Db, ticketId: number): Promise<boolean> {
  const now = new Date();
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: { notIn: [TicketStatus.RESOLVED, TicketStatus.CLOSED] } },
    data: { status: TicketStatus.RESOLVED, resolvedAt: now, lastStatusChangeAt: now },
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
    data: { status: TicketStatus.OPEN, closedAt: null, lastStatusChangeAt: new Date() },
  });
  return { ok: true };
}

/** Reopen a CLOSED ticket back to OPEN (admin action — no bot equivalent, no
 * time window; distinct from the customer-facing `reopenTicket` above).
 * Returns true iff this call performed the transition. */
export async function reopenTicketAdmin(db: Db, ticketId: number): Promise<boolean> {
  const res = await db.supportTicket.updateMany({
    where: { id: ticketId, status: TicketStatus.CLOSED },
    data: { status: TicketStatus.OPEN, closedAt: null, lastStatusChangeAt: new Date() },
  });
  return res.count === 1;
}

/** Admin triage: set priority and/or category. No status/timestamp side effects. */
export function classifyTicket(
  db: Db,
  ticketId: number,
  args: { priority?: string; category?: string | null },
) {
  const data: Prisma.SupportTicketUpdateInput = {};
  if (args.priority !== undefined) data.priority = args.priority;
  if (args.category !== undefined) data.category = args.category;
  return db.supportTicket.update({ where: { id: ticketId }, data });
}

/** Save admin reply; return customer's telegram_id (to DM) or null.
 *
 * Task 1 fix (review Finding 1/2): writes `WAITING_CUSTOMER`, not the
 * retired `REPLIED` — see `TICKET_LEGAL_TRANSITIONS`'s doc comment for the
 * full OPEN/REPLIED-vs-WAITING_ADMIN/WAITING_CUSTOMER resolution. This is a
 * bare, unconditional write, same shape as before (never gated by
 * `TICKET_LEGAL_TRANSITIONS` — it wasn't before this fix either): its one
 * production caller (`apps/order-bot/src/conversations/admin.ts`) always
 * calls `addTicketMessage` immediately afterward in the SAME transaction, so
 * whatever this write leaves the ticket at is a transient, never-externally-
 * visible intermediate state — `addTicketMessage`'s own ADMIN branch is what
 * performs the real, audited, legality-checked transition (and recognizes
 * "already at WAITING_CUSTOMER" as a no-op refresh rather than an error —
 * see that function's own comment). Kept deliberately un-gated/standalone
 * (M-29) so this function's repliedAt/firstResponseAt/lastStatusChangeAt
 * stamps stay correct even if called on its own, without `addTicketMessage`.
 */
export async function replyToTicket(
  db: Db,
  args: { ticketId: number; reply: string; adminDbId: number },
): Promise<bigint | null> {
  const ticket = await db.supportTicket.findUnique({
    where: { id: args.ticketId },
  });
  if (!ticket) return null;
  const now = new Date();
  await db.supportTicket.update({
    where: { id: args.ticketId },
    data: {
      adminReply: args.reply,
      adminId: args.adminDbId,
      status: TicketStatus.WAITING_CUSTOMER,
      repliedAt: now,
      lastStatusChangeAt: now,
      // Set once — true first-response time, unlike repliedAt (overwritten
      // on every admin reply). Mirrors addTicketMessage's ADMIN branch.
      firstResponseAt: ticket.firstResponseAt ?? now,
    },
  });
  const user = await db.user.findUnique({ where: { id: ticket.userId } });
  return user ? user.telegramId : null;
}

/** Add a thread message and update the ticket's status accordingly.
 *
 * `internal` (Task 1): when `true`, this message is an admin-only note.
 * Internal notes:
 *  - are stored with `TicketMessage.internal = true`, so `listTicketMessages`
 *    excludes them by default (see that function's `includeInternal` option)
 *    — an internal note must never appear in a customer-facing thread view;
 *  - never advance the ticket's customer-visible state: the ADMIN branch's
 *    `status -> REPLIED` / `repliedAt` / `firstResponseAt` writes are SKIPPED
 *    for an internal note, because those fields exist to tell the customer
 *    "an admin responded to you", which an internal note is not;
 *  - are still audited (`logAdminAction`) — adding an internal note is new,
 *    admin-only, ticket-affecting capability, so it gets its own audit
 *    action distinct from `ticket_reply` (which the route already logs)
 *    rather than trying to retrofit an existing action, and distinct from
 *    the caller possibly not touching audit itself at all today.
 * Only meaningful when `senderType` is `ADMIN` — a customer can never write
 * an internal note (the USER branch below never reads `internal`). Defaults
 * to `false`, so every existing call site's behavior is byte-for-byte
 * unchanged.
 *
 * Task 1 FIX (review Finding 1): this is the single universal choke point
 * for every real reply in the system (bot conversations, web-admin's reply
 * route, storefront's reply route) — so it's the one place that wires the
 * customer-reply -> `WAITING_ADMIN` / admin-reply -> `WAITING_CUSTOMER`
 * transitions via `transitionTicketStatus`, instead of the old hardcoded
 * `OPEN`/`REPLIED` bare writes. See `TICKET_LEGAL_TRANSITIONS`'s doc comment
 * for the full OPEN/REPLIED-vs-WAITING_ADMIN/WAITING_CUSTOMER resolution.
 * Each branch below carves out two cases that do NOT go through
 * `transitionTicketStatus`:
 *  - the ticket is already at the target status (WAITING_ADMIN for a second
 *    customer message before any admin responds; WAITING_CUSTOMER for a
 *    second consecutive admin reply, or because `replyToTicket` — this
 *    function's paired caller in the bot's admin-reply flow — already moved
 *    it there earlier in the SAME transaction): a same-status "transition"
 *    isn't a real state move, so it's a plain field refresh (wait-clock /
 *    reply timestamps only), not an audited transition. This is also why
 *    `TICKET_LEGAL_TRANSITIONS` deliberately has NO self-edges for these two
 *    states — adding one would make `OPEN`'s and `WAITING_ADMIN`'s (or
 *    `REPLIED`'s and `WAITING_CUSTOMER`'s) target lists byte-identical
 *    again, exactly Finding 2's redundancy.
 *  - the ticket is already `RESOLVED`/`CLOSED`: explicitly out of this fix's
 *    scope (brief: "CLOSED/RESOLVED handling ... unaffected") — a reply
 *    here still unconditionally reopens it via the OLD literal values
 *    (`OPEN`/`REPLIED`), byte-for-byte the pre-fix behavior, since neither
 *    of those two states' entries in `TICKET_LEGAL_TRANSITIONS` changed. */
export async function addTicketMessage(
  db: Db,
  args: {
    ticketId: number;
    senderType: SenderType;
    senderId: number;
    content: string;
    photoFileIds?: string | null;
    attachmentUrls?: string | null;
    /** Set to `false` ONLY when this call is mirroring a ticket's own
     * opening message into the thread (the bot's ticket-creation flow calls
     * `createTicket` then immediately `addTicketMessage` with the same
     * content, purely so it shows up in the `TicketMessage` thread table) —
     * `createTicket` already enqueued the "new ticket" owner email for that
     * same content, so the USER-sender branch below must not enqueue a
     * second "customer replied" email for it. Every genuine reply call site
     * omits this (defaults to `true`, i.e. notify as before). */
    notifyOwner?: boolean;
    /** Admin-only note — see this function's own doc comment. Defaults to
     * `false` (an ordinary customer-visible message, today's behavior). */
    internal?: boolean;
  },
) {
  const internal = args.internal ?? false;
  const msg = await db.ticketMessage.create({
    data: {
      ticketId: args.ticketId,
      senderType: args.senderType,
      senderId: args.senderId,
      content: args.content,
      photoFileIds: args.photoFileIds ?? null,
      attachmentUrls: args.attachmentUrls ?? null,
      internal,
    },
  });
  const ticket = await db.supportTicket.findUnique({
    where: { id: args.ticketId },
  });
  if (ticket) {
    const now = new Date();
    if (args.senderType === SenderType.USER) {
      // `notifyOwner === false` marks the bot's ticket-creation mirror call
      // (see that field's own doc comment) — NOT a real reply, so it must
      // not move the ticket off whatever createTicket left it at (OPEN).
      const isOpeningMirror = args.notifyOwner === false;
      if (!isOpeningMirror) {
        if (ticket.status === TicketStatus.RESOLVED || ticket.status === TicketStatus.CLOSED) {
          // Out of this fix's scope — see this function's own doc comment.
          await db.supportTicket.update({
            where: { id: args.ticketId },
            data: { status: TicketStatus.OPEN, lastStatusChangeAt: now },
          });
        } else if (ticket.status === TicketStatus.WAITING_ADMIN) {
          // Already waiting on admin — no real state move, just refresh the
          // wait-clock (see this function's own doc comment for why this
          // isn't a TICKET_LEGAL_TRANSITIONS self-edge instead).
          await db.supportTicket.update({
            where: { id: args.ticketId },
            data: { lastStatusChangeAt: now },
          });
        } else {
          await transitionTicketStatus(db, {
            ticketId: args.ticketId,
            from: ticket.status,
            to: TicketStatus.WAITING_ADMIN,
            adminId: null, // customer-driven — no acting admin (system actor)
            meta: "customer replied",
          });
        }
      }
      // Owner "customer replied" email — ONLY for the customer's own
      // messages. An admin's own reply (the `else` branch below) must never
      // reach this: that would mail the owner about their own admin's
      // action. No-op unless owner-email is configured (see
      // enqueueOwnerTicketReplyEmail). Also skipped when `notifyOwner` is
      // explicitly `false` — see that field's doc comment above.
      if (args.notifyOwner !== false) {
        await enqueueOwnerTicketReplyEmail(db, {
          ticketId: args.ticketId,
          userId: args.senderId,
          message: args.content,
        });
      }
    } else if (!internal) {
      // Customer-visible admin reply. repliedAt/firstResponseAt are stamped
      // in every branch below exactly as before `internal`/this fix existed;
      // an internal note (else branch below) skips all of this: no status
      // flip, no repliedAt/firstResponseAt advance, because none of that is
      // true of a note the customer never sees.
      const replyStamps = { repliedAt: now, firstResponseAt: ticket.firstResponseAt ?? now };
      if (ticket.status === TicketStatus.RESOLVED || ticket.status === TicketStatus.CLOSED) {
        // Out of this fix's scope — see this function's own doc comment.
        await db.supportTicket.update({
          where: { id: args.ticketId },
          data: { status: TicketStatus.REPLIED, lastStatusChangeAt: now, ...replyStamps },
        });
      } else if (ticket.status === TicketStatus.WAITING_CUSTOMER) {
        // Already waiting on customer (a second consecutive admin reply, or
        // `replyToTicket` already moved it here earlier in this same
        // transaction — see this function's own doc comment) — no real
        // state move, just refresh the reply timestamps/wait-clock.
        await db.supportTicket.update({
          where: { id: args.ticketId },
          data: { lastStatusChangeAt: now, ...replyStamps },
        });
      } else {
        await transitionTicketStatus(db, {
          ticketId: args.ticketId,
          from: ticket.status,
          to: TicketStatus.WAITING_CUSTOMER,
          adminId: args.senderId,
          meta: "admin replied",
          extraData: replyStamps,
        });
      }
    } else {
      await logAdminAction(db, {
        adminId: args.senderId,
        action: "ticket_internal_note",
        targetType: "ticket",
        targetId: args.ticketId,
        details: `Added an internal note to ticket #${args.ticketId} (not visible to the customer).`,
      });
    }
  }
  return msg;
}

/** Assign (or, with `adminId: null`, unassign) a ticket to an admin. Does
 * not touch `status` — assignment and reply/close are independent actions.
 * Does not touch `assignedAt`/`assignedBy` either — this is the original,
 * un-audited assign path used today by apps/web-admin's `/api/support/
 * :ticketId/assign` route (which logs its own `ticket_assign` audit entry
 * around this call). Left byte-for-byte unchanged so that route and its
 * tests keep working: `assignTicketWithAudit` below is the NEW, separate
 * function that also stamps the assignedAt/assignedBy audit trail — added
 * alongside rather than grafted onto this one so no existing caller's
 * behavior/signature changes under it. */
export function assignTicket(db: Db, ticketId: number, adminId: number | null) {
  return db.supportTicket.update({
    where: { id: ticketId },
    data: { adminId },
  });
}

/**
 * Assign (or, with `adminId: null`, unassign) a ticket to an admin AND
 * record who performed that assignment — `assignedAt`/`assignedBy`, distinct
 * from `adminId` (do not conflate the two): `adminId` is who is currently
 * working the ticket, `assignedBy` is who made that specific assignment
 * decision. E.g. a lead admin (`assignedByAdminId`) assigns a ticket to a
 * junior admin (`adminId`) — after this call, `adminId` is the junior
 * admin's id and `assignedBy` is the lead admin's id.
 *
 * On unassign (`adminId: null`), `assignedAt`/`assignedBy` are cleared back
 * to null too — there is no "assignment" left to attribute once nobody is
 * assigned, so leaving a stale assignedBy/assignedAt pointing at a past
 * assignment after the ticket is explicitly unassigned would be misleading.
 *
 * Audits the action via `logAdminAction` with a natural-language `details`
 * string (docs/LOGGING.md), same pattern `transitionRefundStatus`/
 * `transitionTicketStatus` use for their own state changes — CLAUDE.md:
 * "Audit every state change with the acting admin id".
 */
export async function assignTicketWithAudit(
  db: Db,
  ticketId: number,
  adminId: number | null,
  assignedByAdminId: number,
  // Task 3 review fix: the caller (the shared /assign route) already resolves
  // the assignee's display name via resolveAssigneeName for its own response
  // body — passing it through here means the audit log reads "Assigned
  // ticket #N to "Rina"." instead of a bare, developer-only "admin 7.",
  // matching docs/LOGGING.md's shop-admin-readability requirement. Optional
  // and defaults to the old bare-id wording so this stays backward-compatible
  // with any other/future caller that hasn't resolved a name.
  assigneeName?: string | null,
): Promise<SupportTicket> {
  const now = new Date();
  const ticket = await db.supportTicket.update({
    where: { id: ticketId },
    data:
      adminId !== null
        ? { adminId, assignedAt: now, assignedBy: assignedByAdminId }
        : { adminId: null, assignedAt: null, assignedBy: null },
  });

  const assigneeLabel =
    adminId !== null ? `"${assigneeName ?? `admin ${adminId}`}"` : "nobody (unassigned)";
  await logAdminAction(db, {
    adminId: assignedByAdminId,
    action: "ticket_assign",
    targetType: "ticket",
    targetId: ticketId,
    details: `Assigned ticket #${ticketId} to ${assigneeLabel}.`,
  });

  return ticket;
}

/**
 * Legal `TicketStatus` transitions — mirrors `REFUND_LEGAL_TRANSITIONS`'s
 * shape (packages/db/src/crud/refunds.ts): a lookup table
 * `transitionTicketStatus` validates against before attempting its atomic
 * claim.
 *
 * ## Task 1 FIX (review Findings 1 & 2) — OPEN/REPLIED vs WAITING_ADMIN/WAITING_CUSTOMER
 *
 * The original Task 1 commit added `WAITING_ADMIN`/`WAITING_CUSTOMER` to
 * this table but left them unreachable by any real code path, and their
 * target lists were byte-for-byte identical to `OPEN`'s/`REPLIED`'s — two
 * exactly-synonymous pairs (review Findings 1 and 2). This fix wires
 * `addTicketMessage` (the single choke point for every real reply in the
 * system) to actually produce `WAITING_ADMIN`/`WAITING_CUSTOMER`, and
 * resolves the redundancy as follows — **investigated every existing usage
 * of `OPEN`/`REPLIED` across the codebase first** (bot keyboards/handlers,
 * web-admin filters/badges/resolve-reopen visibility, the
 * `listStaleRepliedTickets` auto-close job, every `.test.ts`/`.test.tsx`
 * touching them):
 *
 *  - `OPEN` is kept as the state for a genuinely NEW ticket with zero real
 *    messages yet (written only by `createTicket`, and by
 *    `reopenTicket`/`reopenTicketAdmin` — unaffected, out of this fix's
 *    scope). A customer's FIRST-EVER follow-up (the second real message on
 *    the ticket) now moves it to `WAITING_ADMIN` instead of re-asserting
 *    `OPEN` — that's the new `OPEN -> WAITING_ADMIN` edge below. This is
 *    what genuinely differentiates `OPEN` from `WAITING_ADMIN` (Finding 2):
 *    `OPEN` is a strictly one-way "entry" state nothing but ticket
 *    creation/reopen ever produces; `WAITING_ADMIN` is the recurring
 *    "needs admin attention" state every subsequent customer reply produces.
 *  - `REPLIED` is RETIRED as a normal write target — `addTicketMessage`'s
 *    ADMIN branch and `replyToTicket` now write `WAITING_CUSTOMER` instead,
 *    since the review confirmed they mean exactly the same thing and only
 *    one should be live. `REPLIED` is NOT removed from the enum or this
 *    table: historical rows already sitting at `REPLIED` in production must
 *    keep working (this is a plain `String` column, not a native enum — see
 *    @app/core/enums's header comment — existing rows never get rewritten),
 *    `listStaleRepliedTickets`/`getTicketStats`/`isTicketOverdue`/
 *    `buildTicketConditions` (this file) all now match `WAITING_CUSTOMER`
 *    ALONGSIDE `REPLIED` rather than replacing it, and `addTicketMessage`'s
 *    ADMIN branch still writes the literal `REPLIED` in exactly one
 *    preserved edge case (replying to an already-RESOLVED/CLOSED ticket —
 *    see that function's own doc comment for why that edge is intentionally
 *    unchanged). The new `REPLIED -> WAITING_CUSTOMER` edge below exists so
 *    a fresh admin reply landing on one of those historical `REPLIED` rows
 *    (or a doubled-up admin reply — see `addTicketMessage`'s own comment)
 *    can still legally move forward under the modern vocabulary.
 *
 * `WAITING_ADMIN`/`WAITING_CUSTOMER` deliberately have NO self-edges (e.g.
 * no `WAITING_ADMIN -> WAITING_ADMIN`) even though `addTicketMessage` can
 * hit that exact "already there" case (a second customer message, or a
 * second admin reply, before the other side responds) — adding one would
 * make `OPEN`'s/`REPLIED`'s target lists byte-identical to `WAITING_ADMIN`'s/
 * `WAITING_CUSTOMER`'s again, the very redundancy Finding 2 flagged.
 * `addTicketMessage` handles that case itself as a plain field refresh
 * instead of a `transitionTicketStatus` call — see its own doc comment.
 *
 * `RESOLVED`/`CLOSED` reachability mirrors the ACTUAL guards `resolveTicket`/
 * `closeTicket` already enforce today (any non-terminal status may resolve
 * or close), and `CLOSED -> OPEN` mirrors `reopenTicket`/`reopenTicketAdmin`
 * exactly (the only two functions that move a ticket OUT of CLOSED today).
 * `RESOLVED` has no outgoing edge back to an active state because no current
 * crud function reopens a RESOLVED ticket without closing it first — that
 * gap is left for a future task if such an action is ever added. Per this
 * fix's own brief, `RESOLVED`/`CLOSED` handling is UNAFFECTED — see
 * `addTicketMessage`'s doc comment for the one deliberate carve-out where a
 * reply lands on an already-RESOLVED/CLOSED ticket.
 */
export const TICKET_LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  [TicketStatus.OPEN]: [
    TicketStatus.REPLIED,
    TicketStatus.WAITING_CUSTOMER,
    TicketStatus.RESOLVED,
    TicketStatus.CLOSED,
    TicketStatus.WAITING_ADMIN,
  ],
  [TicketStatus.WAITING_ADMIN]: [
    TicketStatus.REPLIED,
    TicketStatus.WAITING_CUSTOMER,
    TicketStatus.RESOLVED,
    TicketStatus.CLOSED,
  ],
  [TicketStatus.REPLIED]: [
    TicketStatus.OPEN,
    TicketStatus.WAITING_ADMIN,
    TicketStatus.RESOLVED,
    TicketStatus.CLOSED,
    TicketStatus.WAITING_CUSTOMER,
  ],
  [TicketStatus.WAITING_CUSTOMER]: [
    TicketStatus.OPEN,
    TicketStatus.WAITING_ADMIN,
    TicketStatus.RESOLVED,
    TicketStatus.CLOSED,
  ],
  [TicketStatus.RESOLVED]: [TicketStatus.CLOSED],
  [TicketStatus.CLOSED]: [TicketStatus.OPEN],
};

/**
 * Move a SupportTicket from `from` to `to`: validates the shape against
 * `TICKET_LEGAL_TRANSITIONS`, atomically claims the row (`updateMany` with
 * the expected current status in the WHERE clause — same pattern as
 * `transitionRefundStatus`/`transitionOrderStatus`) so a stale/duplicate
 * caller fails safely instead of overwriting a ticket that already moved on,
 * stamps `resolvedAt`/`closedAt` the moment the row reaches that specific
 * status (mirroring `resolveTicket`/`closeTicket`'s own stamps), and audits
 * the move via `logAdminAction` with a natural-language sentence
 * (docs/LOGGING.md).
 *
 * Task 1 fix: now called by `addTicketMessage` for the real
 * customer-reply/admin-reply transitions — see `TICKET_LEGAL_TRANSITIONS`'s
 * and `addTicketMessage`'s own doc comments.
 */
export async function transitionTicketStatus(
  db: Db,
  args: {
    ticketId: number;
    from: string;
    to: string;
    /** Acting admin id, or `null` for a system/customer-driven transition
     * (e.g. `addTicketMessage`'s own customer-reply -> `WAITING_ADMIN`
     * move) — same `adminId: null` = system-actor convention already used
     * elsewhere for non-admin-initiated audit rows (see digiflazz.ts/
     * orders.ts/wallet_topup.ts in this same directory). */
    adminId: number | null;
    meta?: string | null;
    /** Extra fields to stamp in the SAME atomic update as the status move —
     * e.g. `addTicketMessage`'s ADMIN branch also needs `repliedAt`/
     * `firstResponseAt` written in lockstep with the status flip, not as a
     * second, unguarded write after the claim already succeeded. */
    extraData?: { repliedAt?: Date; firstResponseAt?: Date };
  },
): Promise<SupportTicket> {
  const { ticketId, from, to, adminId, meta, extraData } = args;

  if (!TICKET_LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new ValidationError("error.illegal_ticket_status_transition", { from, to });
  }

  const now = new Date();
  const claim = await db.supportTicket.updateMany({
    where: { id: ticketId, status: from },
    data: {
      status: to,
      lastStatusChangeAt: now,
      ...(to === TicketStatus.RESOLVED ? { resolvedAt: now } : {}),
      ...(to === TicketStatus.CLOSED ? { closedAt: now } : {}),
      ...(extraData ?? {}),
    },
  });
  if (claim.count !== 1) {
    // Either the ticket doesn't exist, or its actual current status no
    // longer matches `from` (race/staleness) — same error either way, since
    // both mean "this transition cannot be applied as requested" (mirrors
    // transitionRefundStatus's own reasoning).
    throw new ValidationError("error.illegal_ticket_status_transition", { from, to });
  }

  const ticket = await db.supportTicket.findUniqueOrThrow({ where: { id: ticketId } });

  await logAdminAction(db, {
    adminId,
    action: "ticket_status_change",
    targetType: "ticket",
    targetId: ticketId,
    details: `Ticket #${ticketId} moved from ${from} to ${to}${meta ? ` (${meta})` : ""}.`,
  });

  return ticket;
}

/** Set a single ticket's priority. Task 2 only added the bulk version
 * (bulkSetTicketPriority) — this is the one-ticket counterpart used by the
 * detail page's priority dropdown. */
export function setTicketPriority(db: Db, ticketId: number, priority: TicketPriority) {
  return db.supportTicket.update({
    where: { id: ticketId },
    data: { priority },
  });
}

/**
 * Last N messages for a ticket, chronological order.
 *
 * `includeInternal` defaults to `false` — SAFE BY DEFAULT: an internal note
 * (`TicketMessage.internal = true`, see `addTicketMessage`'s doc comment) is
 * excluded unless the caller explicitly opts in. This function is the one
 * both the customer-facing views (apps/order-bot's ticket detail handler,
 * apps/storefront's account/ticket API route) AND the admin-facing view
 * (apps/web-admin's ticket detail route) currently call with identical
 * semantics — defaulting to exclude means every existing call site stays
 * customer-safe automatically, INCLUDING the admin route, until it's
 * explicitly updated to pass `includeInternal: true` (expected follow-up
 * work for whichever task wires the internal-note toggle into the admin UI,
 * since surfacing internal notes to admins is a UI concern, not a change to
 * this shared query's default). A customer-facing call site must NEVER pass
 * `includeInternal: true`.
 */
export async function listTicketMessages(
  db: Db,
  ticketId: number,
  limit = 10,
  opts: { includeInternal?: boolean } = {},
) {
  const rows = await db.ticketMessage.findMany({
    where: { ticketId, ...(opts.includeInternal ? {} : { internal: false }) },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse();
}

export function listUserTickets(db: Db, userId: number, limit = 10) {
  return db.supportTicket.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/** Real total behind `listUserTickets`'s capped page — UserDetailPage's
 *  Support Tickets card title must show this, not `.length` of the capped
 *  list it renders. */
export function countUserTickets(db: Db, userId: number): Promise<number> {
  return db.supportTicket.count({ where: { userId } });
}

/** How many of one buyer's tickets are not closed (the ticket detail page's "other open tickets" figure). */
export function countOpenUserTickets(db: Db, userId: number): Promise<number> {
  return db.supportTicket.count({ where: { userId, status: { not: TicketStatus.CLOSED } } });
}

/**
 * Task 10: the storefront /help page's own status-filter vocabulary — a
 * customer-facing grouping distinct from the admin queue's raw
 * `TicketStatus` values (see `TICKET_LEGAL_TRANSITIONS`'s doc comment for
 * why `OPEN`/`WAITING_ADMIN` and `REPLIED`/`WAITING_CUSTOMER` are separate
 * live statuses). Shared between `listUserTicketsPaged` and
 * `getUserTicketStats` below so the two can never disagree on which raw
 * statuses each bucket maps to — edit this one object, not two copies.
 */
const USER_TICKET_STATUS_SETS: Record<Exclude<SupportTicketStatusFilter, "all">, TicketStatus[]> = {
  waiting_for_you: [TicketStatus.WAITING_CUSTOMER],
  waiting_for_support: [TicketStatus.OPEN, TicketStatus.WAITING_ADMIN],
  in_progress: [TicketStatus.REPLIED],
  resolved: [TicketStatus.RESOLVED],
  closed: [TicketStatus.CLOSED],
};

export type SupportTicketListSort = "latest_update" | "created_desc" | "created_asc";
export type SupportTicketStatusFilter =
  | "all"
  | "waiting_for_you"
  | "waiting_for_support"
  | "in_progress"
  | "resolved"
  | "closed";

export interface ListUserTicketsPagedOpts {
  status?: SupportTicketStatusFilter;
  q?: string | null;
  sort?: SupportTicketListSort;
  /** 1-based. Default 1. */
  page?: number;
  /** Default 10, clamped to [1, 50] — no caller may request an unbounded page. */
  pageSize?: number;
}

/**
 * Paged, filtered, searched, sorted list of ONE customer's own tickets — the
 * storefront /help page's list view. Distinct from the admin-facing
 * `listTicketsPaged` above: user-scoped (always `where: { userId, ... }`,
 * never callable without a userId filter — there is no "all users" mode
 * here), and a much smaller filter/sort vocabulary
 * (`SupportTicketStatusFilter`/`SupportTicketListSort`) tailored to what a
 * customer, not an admin, needs to slice their own ticket list by. Do not
 * reuse/extend `TicketFilter`/`listTicketsPaged`/`countTickets` for this —
 * those carry admin-only concerns (raw-SQL priority sort, overdue tracking,
 * `assigned`/`adminId` filters) this user-scoped list has no business with.
 */
export async function listUserTicketsPaged(
  db: Db,
  userId: number,
  opts: ListUserTicketsPagedOpts = {},
) {
  const statusFilter = opts.status ?? "all";
  const statusIn = statusFilter === "all" ? undefined : USER_TICKET_STATUS_SETS[statusFilter];

  const q = opts.q?.trim();

  const where: Prisma.SupportTicketWhereInput = {
    userId,
    ...(statusIn ? { status: { in: statusIn } } : {}),
    ...(q
      ? {
          OR: [
            { subject: { contains: q, mode: "insensitive" as const } },
            { message: { contains: q, mode: "insensitive" as const } },
            { ticketNumber: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const sort = opts.sort ?? "latest_update";
  const orderBy: Prisma.SupportTicketOrderByWithRelationInput =
    sort === "created_desc"
      ? { createdAt: "desc" }
      : sort === "created_asc"
        ? { createdAt: "asc" }
        : { lastStatusChangeAt: "desc" };

  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? 10));
  const skip = (page - 1) * pageSize;

  const [total, rows] = await Promise.all([
    db.supportTicket.count({ where }),
    db.supportTicket.findMany({
      where,
      include: {
        order: { select: { orderCode: true } },
        product: { select: { name: true } },
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
      },
      orderBy,
      skip,
      take: pageSize,
    }),
  ]);

  return { rows, total };
}

export interface UserTicketStats {
  all: number;
  waiting_for_you: number;
  waiting_for_support: number;
  in_progress: number;
  resolved: number;
  closed: number;
}

/** Six status-bucket counts for ONE customer's own tickets — the /help page's
 * status-tab badges. Shares `USER_TICKET_STATUS_SETS` with
 * `listUserTicketsPaged` above so the tab counts and the filtered list can
 * never disagree on what each bucket means. */
export async function getUserTicketStats(db: Db, userId: number): Promise<UserTicketStats> {
  const [all, waiting_for_you, waiting_for_support, in_progress, resolved, closed] = await Promise.all([
    db.supportTicket.count({ where: { userId } }),
    db.supportTicket.count({ where: { userId, status: { in: USER_TICKET_STATUS_SETS.waiting_for_you } } }),
    db.supportTicket.count({ where: { userId, status: { in: USER_TICKET_STATUS_SETS.waiting_for_support } } }),
    db.supportTicket.count({ where: { userId, status: { in: USER_TICKET_STATUS_SETS.in_progress } } }),
    db.supportTicket.count({ where: { userId, status: { in: USER_TICKET_STATUS_SETS.resolved } } }),
    db.supportTicket.count({ where: { userId, status: { in: USER_TICKET_STATUS_SETS.closed } } }),
  ]);
  return { all, waiting_for_you, waiting_for_support, in_progress, resolved, closed };
}

/** REPLIED/WAITING_CUSTOMER tickets whose replied_at is older than cutoff
 * (auto-close job). Task 1 fix: matches BOTH values — `REPLIED` for
 * historical rows, `WAITING_CUSTOMER` for every admin reply going forward
 * (see `TICKET_LEGAL_TRANSITIONS`'s doc comment) — so a ticket that goes
 * stale after this fix ships is still caught. */
export function listStaleRepliedTickets(db: Db, cutoff: Date) {
  return db.supportTicket.findMany({
    where: {
      status: { in: [TicketStatus.REPLIED, TicketStatus.WAITING_CUSTOMER] },
      repliedAt: { not: null, lt: cutoff },
    },
  });
}

// ---- Admin Support/Tickets page: filtering, stats, bulk operations ----
// Additions only — listOpenTickets above is untouched (still used by the
// bot's own admin panel, apps/order-bot/src/handlers/admin.ts).

export interface TicketFilter {
  status?: TicketStatus | TicketStatus[] | null;
  priority?: TicketPriority | TicketPriority[] | null;
  category?: TicketCategory | TicketCategory[] | null;
  assigned?: "assigned" | "unassigned" | null;
  adminId?: number | null;
  overdue?: boolean | null;
  q?: string | null;
  /** Restrict to this exact set of ticket ids — the export route's "export
   * only the selected rows" path. */
  ids?: number[] | null;
}

/** How long an OPEN ticket can sit without its wait-clock (`lastStatusChangeAt`)
 * advancing before it counts as overdue. The one knob behind the overdue rule
 * below — change it here, not at any call site. */
const OVERDUE_MINUTES = 240;

/** Cutoff `Date` for the overdue rule: a ticket whose `lastStatusChangeAt` is
 * older than this instant (and is still OPEN) is overdue. Callers pass this
 * into `ticketWhere`/`getTicketStats` rather than each computing their own
 * `addMinutes(now, -240)`, so the 4h figure lives in exactly one place. */
export function overdueCutoff(now: Date = new Date()): Date {
  return addMinutes(now, -OVERDUE_MINUTES);
}

/** Same overdue predicate as the `{ overdue: true }` branch of `ticketWhere`,
 * but for a single already-fetched row rather than a `where` clause — used by
 * the paged-list route to stamp each item with `isOverdue` without a second
 * per-row query. Takes the same `cutoff` (from `overdueCutoff`) so the list
 * route and `getTicketStats` can never disagree on the threshold.
 *
 * Deliberately NOT folded into `buildTicketConditions` below: this operates
 * on a plain `{ status, lastStatusChangeAt }` object already in memory (the
 * per-row "Overdue" badge, stamped after the page's rows are fetched), not on
 * a query — there's no SQL/Prisma `where` fragment to share here, only the
 * same threshold value (`cutoff`, sourced from the one `overdueCutoff`
 * function), which this already takes as a parameter rather than
 * recomputing. Unifying it with the query-side predicate would mean wrapping
 * a two-line boolean check in the same {prisma, raw} condition shape for no
 * reduction in duplication — the "overdue" *rule* has one source
 * (`overdueCutoff`/`OVERDUE_MINUTES`); its three call sites just apply it in
 * three structurally different contexts (a Prisma filter, a raw-SQL filter, a
 * JS boolean).
 *
 * M-31 fix: keys on `lastStatusChangeAt` (the ticket's actual wait-clock
 * reset point — after Task 38, stamped on every status transition) rather
 * than `repliedAt`/`createdAt`. A customer follow-up on an already-answered
 * ticket flips it back to OPEN via `addTicketMessage` WITHOUT clearing
 * `repliedAt`, so the old `repliedAt IS NULL` term made such tickets
 * invisible here forever.
 *
 * Task 1 fix: also matches `WAITING_ADMIN` (see `TICKET_LEGAL_TRANSITIONS`'s
 * doc comment) — a ticket sitting on the "needs admin attention" side of the
 * modern vocabulary is exactly as overdue-eligible as one sitting at `OPEN`.
 * `buildTicketConditions`'s `{overdue: true}` branch below mirrors this
 * exact predicate — keep the two in sync (see that function's own comment). */
export function isTicketOverdue(
  ticket: { status: string; lastStatusChangeAt: Date },
  cutoff: Date,
): boolean {
  return (
    (ticket.status === TicketStatus.OPEN || ticket.status === TicketStatus.WAITING_ADMIN) &&
    ticket.lastStatusChangeAt < cutoff
  );
}

/** One `{ prisma, raw }` pair per active filter term — the single place a new
 * `TicketFilter` field gets translated into both a Prisma `where` fragment
 * and its parameterized raw-SQL equivalent. `ticketWhere` and
 * `ticketWhereRaw` are thin derivations of this list (AND-joined), so there
 * is exactly one function to edit when a filter changes, not two hand-kept-
 * in-sync copies — the M-36 audit finding: the two `where` builders had
 * already drifted (the `{overdue:true}` branch used to unconditionally
 * overwrite `where.status`/`where.lastStatusChangeAt` in the Prisma version
 * while the raw version just added an extra `AND`, so combining an explicit
 * `status` filter with `overdue: true` silently dropped the status filter on
 * one path and produced a contradiction — 0 rows — on the other; see
 * support.test.ts's "status filter + overdue" case, which fails against the
 * old two-copies code). Every value that can come from request input (`q`,
 * the CSV status/priority filters) is bound via Prisma's tagged-template
 * parameter binding on the raw side — never string-interpolated — so the raw
 * half can't become a SQL-injection vector. Raw-side column names are the
 * `support_tickets`/`users` table columns (see the `@map`s on
 * `SupportTicket`/`User` in schema.prisma), not the Prisma field names. */
function buildTicketConditions(
  f: TicketFilter,
  cutoff: Date,
): { prisma: Prisma.SupportTicketWhereInput; raw: Prisma.Sql }[] {
  const conditions: { prisma: Prisma.SupportTicketWhereInput; raw: Prisma.Sql }[] = [];
  if (f.status != null) {
    conditions.push({
      prisma: { status: Array.isArray(f.status) ? { in: f.status } : f.status },
      raw: Array.isArray(f.status)
        ? Prisma.sql`status IN (${Prisma.join(f.status)})`
        : Prisma.sql`status = ${f.status}`,
    });
  }
  if (f.priority != null) {
    conditions.push({
      prisma: { priority: Array.isArray(f.priority) ? { in: f.priority } : f.priority },
      raw: Array.isArray(f.priority)
        ? Prisma.sql`priority IN (${Prisma.join(f.priority)})`
        : Prisma.sql`priority = ${f.priority}`,
    });
  }
  if (f.category != null) {
    conditions.push({
      prisma: { category: Array.isArray(f.category) ? { in: f.category } : f.category },
      raw: Array.isArray(f.category)
        ? Prisma.sql`category IN (${Prisma.join(f.category)})`
        : Prisma.sql`category = ${f.category}`,
    });
  }
  if (f.assigned === "assigned") {
    conditions.push({ prisma: { adminId: { not: null } }, raw: Prisma.sql`admin_id IS NOT NULL` });
  } else if (f.assigned === "unassigned") {
    conditions.push({ prisma: { adminId: null }, raw: Prisma.sql`admin_id IS NULL` });
  }
  if (f.adminId != null) {
    conditions.push({ prisma: { adminId: f.adminId }, raw: Prisma.sql`admin_id = ${f.adminId}` });
  }
  if (f.ids != null) {
    conditions.push({ prisma: { id: { in: f.ids } }, raw: Prisma.sql`id IN (${Prisma.join(f.ids)})` });
  }
  if (f.overdue) {
    // AND'd as two independent conditions (not an overwrite) — combines
    // correctly with an explicit `f.status` filter above instead of silently
    // replacing it. See this function's doc comment (M-36). Task 1 fix:
    // OPEN-or-WAITING_ADMIN, mirroring isTicketOverdue's own predicate
    // exactly (see that function's doc comment) — keep both in sync.
    const overdueStatuses = [TicketStatus.OPEN, TicketStatus.WAITING_ADMIN];
    conditions.push({
      prisma: { status: { in: overdueStatuses } },
      raw: Prisma.sql`status IN (${Prisma.join(overdueStatuses)})`,
    });
    conditions.push({
      prisma: { lastStatusChangeAt: { lt: cutoff } },
      raw: Prisma.sql`last_status_change_at < ${cutoff}`,
    });
  }
  if (f.q) {
    const term = f.q.trim();
    const likeTerm = `%${term}%`;
    conditions.push({
      prisma: {
        OR: [
          { message: { contains: term, mode: "insensitive" } },
          { user: { fullName: { contains: term, mode: "insensitive" } } },
          { user: { username: { contains: term, mode: "insensitive" } } },
        ],
      },
      // ILIKE, not LIKE — Postgres's LIKE is case-sensitive, so this has to
      // match the Prisma side's `mode: "insensitive"`.
      raw: Prisma.sql`(message ILIKE ${likeTerm} OR user_id IN (SELECT id FROM users WHERE full_name ILIKE ${likeTerm} OR username ILIKE ${likeTerm}))`,
    });
  }
  return conditions;
}

/** Ticket filter predicate as a Prisma `where` — used by `countTickets` and
 * the default (newest/oldest) sort path of `listTicketsPaged`. Derived from
 * `buildTicketConditions` (see its doc comment for why) via an explicit `AND`
 * array rather than assigning to top-level keys, so two conditions on the
 * same field (e.g. an explicit `status` filter plus `overdue`'s implicit
 * `status: OPEN`) combine instead of the later one silently overwriting the
 * earlier one. */
function ticketWhere(f: TicketFilter, cutoff: Date): Prisma.SupportTicketWhereInput {
  const conditions = buildTicketConditions(f, cutoff);
  return conditions.length > 0 ? { AND: conditions.map((c) => c.prisma) } : {};
}

/** Same predicate as `ticketWhere`, as a parameterized raw-SQL `WHERE` clause
 * (no leading `WHERE` keyword) — used only by `sort: "priority"` below, which
 * needs a real `ORDER BY` across every matching row, not just the current
 * page (Prisma can't express a custom enum-rank `orderBy` directly, so
 * there's no way to do this through the query builder alone). Derived from
 * `buildTicketConditions`, same as `ticketWhere` — see its doc comment. */
function ticketWhereRaw(f: TicketFilter, cutoff: Date): Prisma.Sql {
  const conditions = buildTicketConditions(f, cutoff);
  return conditions.length > 0 ? Prisma.join(conditions.map((c) => c.raw), " AND ") : Prisma.sql`1=1`;
}

/** Ordered ticket ids for `sort: "priority"`, ranked URGENT→HIGH→MEDIUM→LOW
 * (ties broken newest-first) across ALL matching rows via a real `ORDER BY`
 * — not just the current page. Returns ids only; the caller re-fetches the
 * full rows (with the `user` relation) via a normal Prisma `findMany` and
 * re-sorts in memory to match this order, rather than hand-writing the
 * `user` join here — simpler and safer for the same result. */
async function listTicketIdsByPriorityRank(
  db: Db,
  opts: TicketFilter,
  cutoff: Date,
  limit: number,
  offset: number,
): Promise<number[]> {
  const whereSql = ticketWhereRaw(opts, cutoff);
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT id FROM support_tickets
    WHERE ${whereSql}
    ORDER BY
      CASE priority
        WHEN 'URGENT' THEN 0
        WHEN 'HIGH' THEN 1
        WHEN 'MEDIUM' THEN 2
        WHEN 'LOW' THEN 3
        ELSE 4
      END,
      created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map((r) => r.id);
}

/** Paged, filtered, sorted ticket list for the admin Support/Tickets page —
 * unlike `listOpenTickets`, this actually populates `user` (the bug fix). */
export async function listTicketsPaged(
  db: Db,
  opts: TicketFilter & { limit?: number; offset?: number; sort?: "newest" | "oldest" | "priority" } = {},
) {
  const cutoff = overdueCutoff();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  if (opts.sort === "priority") {
    // A real global ORDER BY (via raw SQL — see ticketWhereRaw), not a
    // fetch-then-sort-within-the-page shortcut: an URGENT ticket on "page 2"
    // of newest-first must still surface here.
    const ids = await listTicketIdsByPriorityRank(db, opts, cutoff, limit, offset);
    if (ids.length === 0) return [];
    const rows = await db.supportTicket.findMany({
      where: { id: { in: ids } },
      include: { user: { select: TICKET_USER_SELECT }, admin: { select: TICKET_ADMIN_SELECT } },
    });
    const rowById = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => rowById.get(id)).filter((r): r is (typeof rows)[number] => r !== undefined);
  }

  return db.supportTicket.findMany({
    where: ticketWhere(opts, cutoff),
    include: { user: { select: TICKET_USER_SELECT }, admin: { select: TICKET_ADMIN_SELECT } },
    orderBy: { createdAt: opts.sort === "oldest" ? "asc" : "desc" },
    skip: offset,
    take: limit,
  });
}

export function countTickets(db: Db, opts: TicketFilter = {}) {
  return db.supportTicket.count({ where: ticketWhere(opts, overdueCutoff()) });
}

/** Five KPI counts for the Support/Tickets page header — each a real
 * `where`-clause count (not fetch-then-filter).
 *
 * Task 1 fix: `open` and `waitingCustomer` each match BOTH halves of their
 * pair (`OPEN`+`WAITING_ADMIN`, `REPLIED`+`WAITING_CUSTOMER`) — see
 * `TICKET_LEGAL_TRANSITIONS`'s doc comment for why both halves of each pair
 * are still live/readable values. */
export async function getTicketStats(
  db: Db,
  now: Date = new Date(),
): Promise<{ open: number; waitingCustomer: number; overdue: number; unassigned: number; resolvedToday: number }> {
  const cutoff = overdueCutoff(now);
  const todayStart = startOfDayUtc(now);
  const todayEnd = startOfDayUtc(addDays(now, 1));

  const [open, waitingCustomer, overdue, unassigned, resolvedToday] = await Promise.all([
    db.supportTicket.count({ where: { status: { in: [TicketStatus.OPEN, TicketStatus.WAITING_ADMIN] } } }),
    db.supportTicket.count({ where: { status: { in: [TicketStatus.REPLIED, TicketStatus.WAITING_CUSTOMER] } } }),
    // Routed through ticketWhere (the same function the {overdue:true} filter
    // path uses) rather than repeating the predicate inline — this is what
    // makes "overdue" an actual single source of truth instead of two copies
    // that happen to agree today.
    db.supportTicket.count({ where: ticketWhere({ overdue: true }, cutoff) }),
    db.supportTicket.count({ where: { status: { not: TicketStatus.CLOSED }, adminId: null } }),
    db.supportTicket.count({
      where: { status: TicketStatus.CLOSED, closedAt: { gte: todayStart, lt: todayEnd } },
    }),
  ]);

  return { open, waitingCustomer, overdue, unassigned, resolvedToday };
}

/** Which of the requested ids actually exist, split succeeded/failed — shared
 * by bulkAssignTickets/bulkSetTicketPriority so a nonexistent id in the batch
 * (which `updateMany` would otherwise silently no-op on) is reported back
 * honestly instead of echoed as succeeded. Mirrors bulkCloseTickets' shape
 * and failure wording exactly. */
async function splitExistingTicketIds(
  db: Db,
  ids: number[],
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const existing = await db.supportTicket.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const existingIds = new Set(existing.map((t) => t.id));
  const succeeded = ids.filter((id) => existingIds.has(id));
  const failed = ids
    .filter((id) => !existingIds.has(id))
    .map((id) => ({ id, error: "ticket not found" }));
  return { succeeded, failed };
}

/** Bulk (re)assign — or, with `adminId: null`, unassign — a batch of tickets.
 * Returns which ids actually existed (succeeded) vs didn't (failed) rather
 * than just an affected count, so a caller that echoes this back to an admin
 * (the bulk-action route) can't misreport a nonexistent id as a success. */
export async function bulkAssignTickets(
  db: Db,
  ids: number[],
  adminId: number | null,
  // Phase C whole-branch review fix: without this, a bulk assignment left
  // assignedAt/assignedBy permanently null — the same columns
  // assignTicketWithAudit (the single-ticket path) stamps — so the detail
  // page showed a named assignee in the picker while its own "Assigned by"
  // line read "Not yet assigned." for the exact same ticket. Optional and
  // defaults to leaving the columns untouched, matching the pre-fix
  // behavior for any caller that doesn't pass it.
  assignedByAdminId?: number,
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const { succeeded, failed } = await splitExistingTicketIds(db, ids);
  if (succeeded.length > 0) {
    const stamp = assignedByAdminId !== undefined;
    await db.supportTicket.updateMany({
      where: { id: { in: succeeded } },
      data:
        adminId !== null
          ? { adminId, ...(stamp ? { assignedAt: new Date(), assignedBy: assignedByAdminId } : {}) }
          : { adminId: null, ...(stamp ? { assignedAt: null, assignedBy: null } : {}) },
    });
  }
  return { succeeded, failed };
}

/** Bulk-set priority on a batch of tickets. Same succeeded/failed honesty as
 * bulkAssignTickets, for the same reason. */
export async function bulkSetTicketPriority(
  db: Db,
  ids: number[],
  priority: TicketPriority,
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const { succeeded, failed } = await splitExistingTicketIds(db, ids);
  if (succeeded.length > 0) {
    await db.supportTicket.updateMany({ where: { id: { in: succeeded } }, data: { priority } });
  }
  return { succeeded, failed };
}

/** Bulk-close a batch of tickets, reusing `closeTicket`'s atomic
 * conditional-update guard per id (mirrors `bulkDeleteVouchers`'s
 * loop-and-collect shape: check existence, then attempt, then collect). A
 * ticket already CLOSED is already-done — counted as succeeded, not
 * re-processed (closeTicket's own guard makes the re-attempt a safe no-op,
 * so this can never double-fire the buyer notification). */
export async function bulkCloseTickets(
  db: Db,
  ids: number[],
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const succeeded: number[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    const ticket = await db.supportTicket.findUnique({ where: { id } });
    if (!ticket) {
      failed.push({ id, error: "ticket not found" });
      continue;
    }
    await closeTicket(db, id); // no-op via the atomic guard if already CLOSED
    succeeded.push(id);
  }
  return { succeeded, failed };
}

/** Bulk resolve — unlike bulkCloseTickets, an already-RESOLVED-or-CLOSED
 * ticket in the batch is a real failure (not a silent no-op): resolving is a
 * one-way admin decision the caller should know didn't apply, not an idle
 * status refresh. Mirrors bulkAssignTickets/bulkCloseTickets' shape. */
export async function bulkResolveTickets(
  db: Db,
  ids: number[],
): Promise<{ succeeded: number[]; failed: { id: number; error: string }[] }> {
  const succeeded: number[] = [];
  const failed: { id: number; error: string }[] = [];
  for (const id of ids) {
    const ticket = await db.supportTicket.findUnique({ where: { id } });
    if (!ticket) {
      failed.push({ id, error: "ticket not found" });
      continue;
    }
    const ok = await resolveTicket(db, id);
    if (!ok) {
      failed.push({ id, error: "already resolved or closed" });
      continue;
    }
    succeeded.push(id);
  }
  return { succeeded, failed };
}
