/**
 * Prisma-backed grammY session storage — a real `StorageAdapter<SessionData>`
 * (grammy/out/convenience/session.d.ts) replacing `boundedSessionStorage.ts`'s
 * in-memory LRU `Map`. Nav/checkout state now survives a bot restart instead
 * of silently resetting to `initialSession()` for every chat — grammY's own
 * `session()` middleware writes back through this adapter on essentially
 * every update (it writes whenever `ctx.session` was read OR written during
 * that update, per `session.js`'s `finish()` — no equality check), so this
 * is genuinely on the hot path of every bot update, not just checkout ones.
 *
 * ## The Phase B landmine this file's write() is the real boundary for
 *
 * `@grammyjs/conversations` persists every `conversation.wait()`/
 * `conversation.external()` op INSIDE `ctx.session` (under a key the plugin
 * manages), so a conversation can be replayed after a restart. Whatever
 * `conversation.external(fn)` returns gets embedded there verbatim. With the
 * old in-memory Map storage, an object carrying a function/closure (e.g. a
 * nickname provider adapter whose entry has a `checkNickname` method) could
 * flow through `conversation.external()` and "work" only because a `Map`
 * stores the actual JS object reference — nothing ever tried to serialize
 * it. The moment session data crosses a REAL boundary — this file's
 * `JSON.stringify`/`JSON.parse` round trip through Postgres — a
 * function-valued property silently vanishes (`JSON.stringify` drops
 * function-typed properties without erroring) and any later conversation
 * step that expected it to still be there breaks in production, with no
 * exception raised anywhere near the actual bug. That exact bug class was
 * found and fixed elsewhere in this project's history (see
 * `prisma/schema.prisma`'s `BotSession` doc comment) — landing THIS adapter
 * is the first time it would have detonated for real, which is why wiring it
 * in required an explicit audit of every current
 * `conversation.external()` call site in `apps/order-bot/src/conversations/*`
 * (see task-2-report.md for the results: every current call site returns
 * either a primitive or a Prisma query result — plain data, no methods —
 * so nothing needed fixing at audit time). Nothing about THIS file can catch
 * a *future* violation structurally — `JSON.stringify` drops a function
 * silently rather than throwing — so it stays a correctness contract at the
 * conversation call sites, not something this storage layer enforces.
 *
 * ## TTL split (24h nav / 15min checkout)
 *
 * `classifySessionKind` decides "nav" vs. "checkout" per write, purely from
 * the session's own content — this bot's session shape has no dedicated
 * "checkout in progress" flag to key off (`BotState.WAIT_PAYMENT` exists in
 * the enum but nothing in the codebase ever assigns it — confirmed by
 * grepping every `session.state = ` assignment before relying on it). See
 * that function's doc comment for exactly which fields it checks and why
 * each one is a reliable "checkout draft is active" signal.
 */
import type { StorageAdapter } from "grammy";
import { prisma, readBotSession, writeBotSession, deleteBotSession, type BotSessionKind } from "@app/db";
import type { SessionData } from "../context";

/** "Just browsing" — no in-progress checkout draft. Generous on purpose:
 * losing nav bookkeeping (last screen, menu bubble id) just means the next
 * tap re-renders from scratch, same as today's LRU eviction. */
export const NAV_TTL_MS = 24 * 3_600_000;

/** An in-progress checkout draft (payment anchor, applied voucher, an
 * awaited free-text reply, ...) expires much sooner: abandoned checkout
 * state has real (if minor) consequences if it lingers — see
 * `util/paymentAnchor.ts`'s header comment on `paymentAnchorMsgId` — and 15
 * minutes is far longer than any buyer plausibly needs mid-checkout, so this
 * never truncates a live purchase, only a genuinely abandoned one. */
export const CHECKOUT_TTL_MS = 15 * 60_000;

/** Scratch keys that exist ONLY for the duration of an active checkout
 * draft, and are unconditionally cleared the moment it completes or is
 * abandoned — see each one's own doc comment in context.ts / where it's set
 * and cleared in handlers/checkout.ts, conversations/customerInfo.ts,
 * conversations/editCustomerInfo.ts, conversations/checkout.ts. */
const CHECKOUT_SCRATCH_KEYS = [
  "pendingInfoProductId",
  "pendingInfoQuantity",
  "editInfoOrderId",
  "appliedVoucherCode",
  "customerData",
  "useWalletIdr",
  "useWalletUsdt",
] as const;

/**
 * True if `session` carries any state that only exists while a checkout
 * draft (or an equivalent short-lived, typed-input-awaiting flow) is active:
 *   - `paymentAnchorMsgId` — set while a payment screen is anchored to this
 *     chat's menu bubble (util/paymentAnchor.ts), cleared when the buyer
 *     navigates away or the order settles.
 *   - `qrMsgId` — set while a QRIS QR-code photo is shown alongside payment
 *     instructions (handlers/checkout.ts).
 *   - `awaitingQtyDenomId` / `awaitingTopupCurrency` — set while a free-text
 *     reply (a buy quantity / a wallet top-up amount) is expected next.
 *   - the `CHECKOUT_SCRATCH_KEYS` above.
 */
function isCheckoutInProgress(session: SessionData): boolean {
  if (session.paymentAnchorMsgId !== undefined) return true;
  if (session.qrMsgId !== undefined) return true;
  if (session.awaitingQtyDenomId !== undefined) return true;
  if (session.awaitingTopupCurrency !== undefined) return true;
  const scratch = session.scratch ?? {};
  return CHECKOUT_SCRATCH_KEYS.some((k) => scratch[k] !== undefined);
}

/** Decide the `kind` (and therefore TTL) a session's current content earns. */
export function classifySessionKind(session: SessionData): BotSessionKind {
  return isCheckoutInProgress(session) ? "checkout" : "nav";
}

/**
 * grammY `StorageAdapter<SessionData>` backed by the `BotSession` table.
 * Only `read`/`write`/`delete` are implemented — `has`/`readAllKeys`/
 * `readAllValues`/`readAllEntries` are optional per grammY's `StorageAdapter`
 * interface and nothing in this codebase calls them on session storage
 * (confirmed by grep before dropping them from the old
 * `boundedSessionStorage`, which only implemented that trio because a bare
 * `Map` made them free — not because anything used them).
 */
export function prismaSessionStorage(): StorageAdapter<SessionData> {
  return {
    async read(key) {
      const raw = await readBotSession(prisma, key);
      if (raw === undefined) return undefined;
      try {
        return JSON.parse(raw) as SessionData;
      } catch {
        // A corrupt/foreign row (should never happen from this adapter's
        // own writes) — treat it like a miss so session() falls back to
        // `initial` instead of crashing the update on a parse error.
        return undefined;
      }
    },
    async write(key, value) {
      const kind = classifySessionKind(value);
      const ttlMs = kind === "checkout" ? CHECKOUT_TTL_MS : NAV_TTL_MS;
      await writeBotSession(prisma, key, JSON.stringify(value), kind, new Date(Date.now() + ttlMs));
    },
    async delete(key) {
      await deleteBotSession(prisma, key);
    },
  };
}
