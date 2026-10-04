/**
 * Admin API for provider settlement batches (task F1) — the manual-entry path
 * that finally gives `postSettlementPosting` a caller.
 *
 * WIRING ONLY. Every amount check, every write and the audit line live in
 * `packages/db/src/crud/settlements.ts`: `recordSettlement` validates the three
 * figures, writes the `Settlement` row, its `SettlementTransaction` lines, the
 * `SETTLEMENT` ledger posting and the audit row inside ONE transaction, and
 * `listSettlements` reads them back. Nothing here recomputes a fee, decides a
 * status, or writes to either settlement table — and this file deliberately does
 * NOT audit again, for the same reason stockReplacements.ts does not: the
 * service already wrote the one row the admin's single action deserves.
 *
 * ## RBAC: super only, on purpose
 *
 * `/api/settlements` is in `CONFIG_PREFIXES` (plugins/auth.ts), so the POST is
 * super-admin only — `support` and `readonly` are refused. A settlement entry is
 * the shop telling its own books that a gateway paid out, which is the same
 * tier of authority as adjusting a wallet by hand (`/api/users/:id/wallet`) and
 * a different one from resolving an order (`/api/orders/…`, an OPS prefix
 * support shares). The GET uses `currentAdmin`, matching `/api/payments` and
 * `/api/wallet-transactions`: this repo's documented posture is that reads are
 * open to every authenticated admin unless they expose credentials or a bulk
 * export, and a settlement list is neither.
 *
 * ## No Idempotency-Key here
 *
 * Unlike the payment mutations (routes/api/payments.ts), a replayed POST must
 * NOT be collapsed into the first one's response, and this is a deliberate
 * difference rather than an omission. Two identical batches are a legitimate
 * thing to record: `Settlement.batchReference` is admin-typed free text the
 * schema leaves non-unique precisely because a provider can reuse its own
 * statement id, so "the same details twice" cannot be assumed to be a retry.
 * Each batch is posted exactly once under `settlement:{id}` — its own row id —
 * so a duplicate ENTRY is a visible, deletable-by-nobody bookkeeping record an
 * admin can see in the list and dispute, never a double posting of one batch.
 */
import type { FastifyInstance } from "fastify";
import { ValidationError } from "@app/core/errors";
import { errorBody } from "@app/core/errorBody";
import { logger } from "@app/core/logger";
import { parseMoneyInput } from "@app/core/moneyFormat";
import { prisma, listSettlements, recordSettlement, type SettlementLineInput } from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDate, displayDateTime } from "../../dateDisplay";
import { moneyFieldError } from "../../lib/moneyField";

const PAGE_SIZE_OPTIONS = [20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;

/** Trimmed string body field, or null when absent/blank — an admin's optional
 *  free text should never be stored as `""` or as the string "undefined". */
function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Thrown by {@link amountField} for a typed amount whose shape cannot be read without guessing. */
class AmountShapeError extends Error {}

/**
 * A money field as a canonical decimal STRING for the service to parse.
 *
 * Typed text is read BY ITS SHAPE in the batch's currency (`1.000.000` is a
 * million rupiah, never 1 — CLAUDE.md "Typed money is read by its shape"); a
 * shape that cannot be read without guessing (`1.2.3`, USDT `1.000`) throws
 * {@link AmountShapeError} so the route answers 400 naming the field.
 *
 * Two things still pass through for `recordSettlement`'s own `money()` to judge,
 * so they keep their named error key: blank (the service's "missing" case) and
 * text that is no number at all — letters, NaN, Infinity — which `money()`
 * refuses as `error.settlement_amount_not_a_number`. A numeric JSON value is
 * stringified, never re-read by shape (its value is already fixed) and never
 * arithmetic'd as a float.
 */
function amountField(value: unknown, currency: string, label: string): string {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text === "" || !/^[\d.,]+$/.test(text)) return text;
  const shapeCurrency = currency.toUpperCase() === "IDR" ? "IDR" : "USDT";
  const amount = parseMoneyInput(text, shapeCurrency);
  if (amount === null) throw new AmountShapeError(moneyFieldError(label, shapeCurrency));
  return amount.toFixed();
}

/**
 * The statement lines an admin entered, shaped for the service. A missing or
 * non-array `lines` means "no breakdown", which is a normal batch, not an error.
 * Line amounts are read by shape like the batch totals; references pass through
 * verbatim. The service refuses a line that is not a positive amount and
 * resolves (or fails to resolve) the match itself.
 */
function parseLines(raw: unknown, currency: string): SettlementLineInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, i) => {
    const line = (entry ?? {}) as Record<string, unknown>;
    return {
      amount: amountField(line.amount, currency, `Line ${i + 1}'s amount`),
      providerTransactionId: optionalText(line.providerTransactionId),
    };
  });
}

/**
 * One batch as the list page reads it. Amounts go out as Decimal strings and are
 * formatted client-side by `CurrencyAmount`, per this repo's money rule; the two
 * timestamps carry a pre-formatted display string in the shop's `TIMEZONE`
 * beside nothing else, so the browser never renders a UTC value in its own zone.
 */
function serializeSettlement(row: Awaited<ReturnType<typeof listSettlements>>["rows"][number]) {
  return {
    id: row.id,
    provider: row.provider,
    batchReference: row.batchReference,
    settlementDateDisplay: displayDate(row.settlementDate),
    currency: row.currency,
    grossAmount: row.grossAmount.toString(),
    feeAmount: row.feeAmount.toString(),
    netAmount: row.netAmount.toString(),
    status: row.status,
    lineCount: row.lineCount,
    matchedLineCount: row.matchedLineCount,
    // Null means the batch was recorded but never posted to the ledger — the one
    // state on this page that needs acting on, so the client renders it as a
    // warning rather than hiding it behind an id nobody reads.
    postingId: row.postingId,
    recordedAtDisplay: displayDateTime(row.createdAt),
    recordedBy: row.createdBy,
  };
}

export default async function settlementsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settlements", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page) || 1, 1);
    const requestedPageSize = Number(q.pageSize);
    const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    const { rows, total, providers, currencies } = await listSettlements(prisma, {
      provider: q.provider || null,
      currency: q.currency || null,
      limit: pageSize,
      offset,
    });

    return reply.send({
      settlements: rows.map(serializeSettlement),
      total,
      page,
      pageSize,
      hasNext: offset + rows.length < total,
      providers,
      currencies,
    });
  });

  app.post("/api/settlements", { preHandler: csrfProtect }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const provider = optionalText(body.provider);
    if (!provider) return reply.code(400).send({ error: "Choose the provider that paid this batch out." });
    const currency = optionalText(body.currency);
    if (!currency) return reply.code(400).send({ error: "Choose the batch's currency." });

    // A date-only string from the form's date input. Parsed as UTC midnight, the
    // same way orders.ts's own `parseDate` does, so a batch settled on the 1st
    // never lands on the 31st because the server's clock sits west of UTC.
    const rawDate = optionalText(body.settlementDate);
    if (!rawDate) return reply.code(400).send({ error: "Enter the date the provider settled this batch." });
    const settlementDate = new Date(/^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? `${rawDate}T00:00:00Z` : rawDate);
    if (Number.isNaN(settlementDate.getTime())) {
      return reply.code(400).send({ error: "That settlement date is not a real date." });
    }

    let amounts: { grossAmount: string; feeAmount: string; netAmount: string; lines: SettlementLineInput[] };
    try {
      amounts = {
        grossAmount: amountField(body.grossAmount, currency, "Gross amount"),
        feeAmount: amountField(body.feeAmount ?? "0", currency, "Fee amount"),
        netAmount: amountField(body.netAmount, currency, "Net amount"),
        lines: parseLines(body.lines, currency),
      };
    } catch (e) {
      if (e instanceof AmountShapeError) return reply.code(400).send({ error: e.message });
      throw e;
    }

    try {
      const { settlement, posting } = await recordSettlement(prisma, {
        provider,
        batchReference: optionalText(body.batchReference),
        settlementDate,
        currency,
        ...amounts,
        adminId: req.admin!.userId,
      });
      logger.info(
        `Admin ${req.admin!.userId} recorded ${settlement.provider} settlement batch ${settlement.id} via the web panel, worth ${settlement.grossAmount.toString()} ${settlement.currency} gross`,
      );
      return reply.send({
        ok: true,
        settlementId: settlement.id,
        // Reported separately from `ok` so the panel can warn rather than claim
        // the books were updated: a batch recorded while the chart of accounts is
        // unseeded saves its row and posts nothing.
        posted: posting !== null,
      });
    } catch (e) {
      if (e instanceof ValidationError) {
        return reply.code(422).send(errorBody(e));
      }
      throw e;
    }
  });
}
