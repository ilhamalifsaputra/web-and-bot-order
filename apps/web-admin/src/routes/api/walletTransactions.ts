import type { FastifyInstance } from "fastify";
import {
  prisma,
  listAllWalletTransactions,
  countAllWalletTransactions,
  WALLET_TX_REASONS,
} from "@app/db";
import { currentAdmin } from "../../plugins/auth";
import { displayDateTime } from "../../dateDisplay";

const PAGE_SIZE = 50;

/** `?since=`/`?until=` arrive as plain `yyyy-mm-dd`; the ledger stores UTC, so
 *  the day is anchored at UTC midnight — same parsing as the audit-log route. */
function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Shop-wide wallet ledger. Read-only: it mutates nothing, so there is no
 * `logAdminAction` and no `csrfProtect` here — only `currentAdmin`, which is
 * what gates every other GET on this surface.
 */
export default async function walletTransactionsApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/wallet-transactions", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page) || 1, 1);
    const offset = (page - 1) * PAGE_SIZE;
    // Unrecognized filter values are ignored rather than applied, so a stale
    // or hand-edited link shows the full ledger instead of an empty page.
    const reason = q.reason && (WALLET_TX_REASONS as readonly string[]).includes(q.reason) ? q.reason : null;
    const currency = q.currency === "IDR" || q.currency === "USDT" ? q.currency : null;
    const userId = q.user_id && /^\d+$/.test(q.user_id) ? Number(q.user_id) : null;

    const filter = {
      userId,
      reason,
      currency,
      from: parseDate(q.since),
      to: parseDate(q.until),
    };

    const [rows, total] = await Promise.all([
      listAllWalletTransactions(prisma, { ...filter, limit: PAGE_SIZE, offset }),
      countAllWalletTransactions(prisma, filter),
    ]);

    const rowsWithDisplay = rows.map((r) => ({ ...r, createdAtDisplay: displayDateTime(r.createdAt) }));
    return reply.send({
      rows: rowsWithDisplay,
      total,
      page,
      pageSize: PAGE_SIZE,
      hasNext: offset + rows.length < total,
      reasons: WALLET_TX_REASONS,
    });
  });
}
