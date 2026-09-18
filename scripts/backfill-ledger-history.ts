/**
 * Historical ledger backfill (Financial Ledger M10) — post the double-entry
 * record of every financial event this shop handled BEFORE the ledger started
 * recording, so the books describe the shop's whole life rather than only the
 * part that happened after M3 shipped.
 *
 *   pnpm run backfill-ledger-history
 *   pnpm run backfill-ledger-history -- --batch-size 200
 *
 * **This is a hand-run tool and must stay one.** It is deliberately not
 * registered in any cron, not called from any deploy step, and not imported by
 * anything that runs at process startup: it is invoked by a person who has
 * decided to run it, against a database they have decided to run it on. The
 * `main()` at the bottom is guarded so importing this file (the test does) opens
 * no connection and exits no process.
 *
 * ## Why a separate script exists at all
 *
 * `crud/ledgerPostings.ts` posts in real time, at the moment money moves.
 * Everything that moved before that code shipped has no `FinancialTransaction`
 * row at all, and `reconcileLedger` (M5) knows it: its cutover boundary is the
 * earliest `occurredAt` in the whole ledger, precisely so its missing-posting
 * checks do not fire on pre-ledger history. Running this script back-dates
 * postings over that history, which moves the boundary back with them — so
 * afterwards reconciliation covers the period the books now claim to describe.
 * That is the point, and it is also why an INCOMPLETE run is worse than no run:
 * it widens what reconciliation checks without giving it the rows to check
 * against. Hence the per-category reporting below, and hence the instruction to
 * run `reconcileLedger` afterwards.
 *
 * ## The one rule: reuse the real-time posting functions, never reinvent them
 *
 * Every posting function in `crud/ledgerPostings.ts` is a pure ledger-writer.
 * Each reads state that has ALREADY settled (the `Order` row, the
 * `WalletTransaction` row, the `RefundExecution` row) and its only side effect
 * is `postFinancialTransaction`: none of them moves a balance, changes a status,
 * sends a notification or writes a wallet movement. Calling one against a
 * historical row therefore re-moves no money and re-triggers no business event —
 * it only writes the ledger rows that should have existed all along.
 *
 * So this file contains NO account codes, NO debit/credit directions, NO
 * idempotency-key strings and NO amounts. It finds historical rows and hands
 * them to the same function the live path hands them to. A copy of the
 * accounting rules here would be a second, unreviewed copy that drifts — which
 * is the exact failure `crud/ledgerPostings.ts`' own module comment exists to
 * prevent.
 *
 * ## Why it is safe to interrupt and re-run
 *
 * `postFinancialTransaction` looks its `idempotencyKey` up FIRST and returns the
 * existing row without writing when it finds one, so every posting below is a
 * no-op the second time it is asked for. Each posting also opens its own
 * transaction (nothing here wraps the run in one), so a Ctrl-C leaves the
 * postings made so far committed and a re-run continues from there. Resumability
 * is therefore a property of the ledger service, not of bookkeeping in this
 * script — there is no progress file and no resume flag.
 *
 * ## Order is load-bearing
 *
 * `order_payment` is backfilled FIRST, before anything wallet-rooted, because
 * three later postings branch on whether an `order:{id}:payment` exists
 * (`hasPostedOrderPayment`): a credit back to the buyer reverses recognised
 * revenue when it does and recognises arriving cash for the first time when it
 * does not, and a released checkout hold posts nothing at all when it does not.
 * In real time chronology guarantees the payment came first. Here the categories
 * are ordered to guarantee it instead — running the wallet categories first
 * would book real sales against `provider_clearing` instead of `sales_revenue`,
 * balanced and wrong.
 *
 * ## What it refuses to do
 *
 * - **It never invents an `occurredAt`.** Every posting is dated from the
 *   historical row's own timestamp: `Order.paidAt` for a settlement (the exact
 *   value all three settlement paths pass as the posting's `occurredAt`),
 *   `WalletTransaction.createdAt` for a wallet movement, and
 *   `RefundExecution.executedAt` for a payout. A row with no such timestamp is
 *   REPORTED, not dated from the clock — see `unprocessable` below.
 * - **It never guesses at a shape no production path writes.** An `admin_adjust`
 *   movement on a product order, a movement pointing at an order that does not
 *   exist, a movement with no acting admin where the posting's own back-pointer
 *   is that admin: each is reported with enough detail to investigate rather
 *   than forced through a posting function it does not truly fit.
 * - **It never materialises a table.** Every category pages by ascending id in
 *   bounded batches, so this is safe to point at a shop with years of history.
 * - **It refuses to start on an incomplete chart of accounts.** Without that
 *   check a run against an unseeded database would look like a success:
 *   `postOrSkipMissingAccount` would skip every posting, the report would say
 *   "nothing to post", and an operator would conclude their history held no
 *   financial events.
 *
 * Reporting is `console.log`/`console.error` (an offline admin tool read in a
 * terminal), matching `scripts/parity-check-kind-filter.ts`. The posting
 * functions themselves still log through Pino, which is where a skipped posting
 * explains itself.
 */
import { pathToFileURL } from "node:url";
import { OrderKind, OrderStatus, RefundExecutionStatus } from "@app/core/enums";
import type { FinancialTransaction } from "@prisma/client";
import {
  CHART_OF_ACCOUNTS,
  initDb,
  postOrderHoldReleasePosting,
  postOrderPaymentPosting,
  postOrderWalletCreditPosting,
  postReferralCommissionPosting,
  postRefundExecutionPosting,
  postUnderpaidTopupCreditPosting,
  postWalletAdjustmentPosting,
  postWalletTopupPosting,
  prisma,
  type Db,
} from "@app/db";

/** How many historical rows one category reads per round trip. */
const DEFAULT_BATCH_SIZE = 500;

/** How many unprocessable rows the printed report lists before summarising the
 *  rest by count. All of them are always present in the returned object. */
const MAX_LISTED_UNPROCESSABLE = 50;

/** One historical row this script would not post, and why. */
export interface UnprocessableRow {
  /** Which category examined it. */
  category: string;
  /** "order" | "wallet_transaction" | "refund_execution". */
  entity: string;
  entityId: number;
  /** Something an admin can search for without opening a database client. */
  reference: string;
  /** What is missing or contradictory, in a sentence. */
  problem: string;
}

/** What one category of historical event did. */
export interface CategoryResult {
  /** Stable machine name, safe to grep for in a pasted report. */
  category: string;
  /** What this category posts, for the report's own header. */
  describes: string;
  /** Historical rows this category looked at. */
  examined: number;
  /** Rows whose posting this run wrote. */
  posted: number;
  /** Rows that already had their posting — a re-run, or an event the real-time
   *  path had already recorded. Nothing was written for these. */
  alreadyPosted: number;
  /** Rows the posting function itself declined to post: no posting is required
   *  (a released hold on an order that never settled), or none could be made
   *  (a zero-value movement, an account the chart does not have). The posting
   *  service's own log lines say which. */
  postedNothing: number;
  /** Rows this script would not post — see `UnprocessableRow`. */
  unprocessable: UnprocessableRow[];
}

export interface BackfillReport {
  startedAt: Date;
  finishedAt: Date;
  /**
   * The earliest `occurredAt` in the ledger before and after this run — the
   * boundary `reconcileLedger` self-configures its missing-posting checks from.
   * `null` means the ledger held no postings at all. Seeing this move back is
   * what "the books now describe that history" looks like.
   */
  cutoverBefore: Date | null;
  cutoverAfter: Date | null;
  /**
   * COMPLETED refund payouts recorded before the ledger's first posting.
   * Expected to be empty: `RefundExecution` was introduced by this ledger
   * build's own first commit, so no payout can predate the ledger. A non-empty
   * list is something to investigate — a restored dump, or a row written around
   * the application — not something this script quietly backfills differently.
   *
   * Capped at 100 rows so a truly pathological database cannot make this
   * report unbounded; `refundPayoutsPredatingLedgerCount` carries the TRUE
   * total, since a capped list would otherwise understate how bad the finding
   * is in the one report whose entire purpose is "this should be impossible".
   */
  refundPayoutsPredatingLedger: Array<{ id: number; createdAt: Date }>;
  refundPayoutsPredatingLedgerCount: number;
  /**
   * Wallet movements whose reason implies an order (`referral`,
   * `underpaid_refund`, `unfulfilled_credit`, `order_refund`) but whose
   * `orderId` is null. No current writer produces this shape — every call
   * site for these four reasons passes an `orderId` — so a non-empty list
   * here is a hand-written or restored-dump row, not something the four
   * categories above silently skipped: their own paging queries filter on
   * `orderId: { not: null }` for exactly these reasons (see `movementsPage`),
   * so a row like this would otherwise never be examined OR reported by
   * anything in this script.
   */
  orderlessOrderMovements: Array<{ id: number; reason: string }>;
  orderlessOrderMovementsCount: number;
  categories: CategoryResult[];
  totals: {
    examined: number;
    posted: number;
    alreadyPosted: number;
    postedNothing: number;
    unprocessable: number;
  };
}

export interface BackfillOptions {
  /** Rows per round trip, per category. Defaults to 500. */
  batchSize?: number;
  /** Where progress lines go. Defaults to `console.log`. */
  log?: (line: string) => void;
}

/**
 * What one attempt to post a historical row produced.
 *
 * `posted` carries whatever `postFinancialTransaction` returned, which is the
 * EXISTING row when the event was already recorded — telling the two apart is
 * the runner's job, not the category's (see `runCategory`).
 */
type PostAttempt =
  | { kind: "posted"; transaction: FinancialTransaction }
  | { kind: "nothing" }
  | { kind: "unprocessable"; problem: string };

const nothing = (): PostAttempt => ({ kind: "nothing" });
const cannot = (problem: string): PostAttempt => ({ kind: "unprocessable", problem });
const from = (transaction: FinancialTransaction | null): PostAttempt =>
  transaction === null ? nothing() : { kind: "posted", transaction };

/** Everything `runCategory` needs to page one category and post its rows. */
interface CategorySpec<T> {
  category: string;
  describes: string;
  /** "order" | "wallet_transaction" | "refund_execution". */
  entity: string;
  /** One page of historical rows with `id > afterId`, ascending, at most `take`
   *  of them — already joined to whatever context `post` needs. */
  page: (afterId: number, take: number) => Promise<T[]>;
  idOf: (row: T) => number;
  referenceOf: (row: T) => string;
  /** Hand this row to the same posting function the live path calls. */
  post: (row: T) => Promise<PostAttempt>;
}

/**
 * Page through one category and post each row, counting outcomes.
 *
 * Keyset pagination (`id > afterId` + `orderBy id asc`) rather than
 * `skip`/`take`: the ledger grows as this runs, and an offset-based walk over a
 * growing table can skip rows. Ids are immutable here, so a keyset walk cannot.
 *
 * One row's failure never stops the run. A posting that throws is recorded as
 * unprocessable with its message and the walk continues — a backfill that
 * abandoned a shop's remaining history because of one malformed row would be
 * worse than one that reports it.
 */
async function runCategory<T>(
  spec: CategorySpec<T>,
  args: { batchSize: number; ledgerWatermark: number; log: (line: string) => void },
): Promise<CategoryResult> {
  const result: CategoryResult = {
    category: spec.category,
    describes: spec.describes,
    examined: 0,
    posted: 0,
    alreadyPosted: 0,
    postedNothing: 0,
    unprocessable: [],
  };

  let afterId = 0;
  let pages = 0;
  for (;;) {
    const rows = await spec.page(afterId, args.batchSize);
    if (rows.length === 0) break;
    pages += 1;

    for (const row of rows) {
      const id = spec.idOf(row);
      afterId = Math.max(afterId, id);
      result.examined += 1;

      let attempt: PostAttempt;
      try {
        attempt = await spec.post(row);
      } catch (e) {
        attempt = cannot(
          `posting it raised an error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      if (attempt.kind === "unprocessable") {
        result.unprocessable.push({
          category: spec.category,
          entity: spec.entity,
          entityId: id,
          reference: spec.referenceOf(row),
          problem: attempt.problem,
        });
      } else if (attempt.kind === "nothing") {
        result.postedNothing += 1;
      } else if (attempt.transaction.id > args.ledgerWatermark) {
        // Every id above the watermark taken before the run is a row this run
        // wrote — the ledger is append-only with an autoincrement key, so
        // nothing below it can be new. (A real-time posting landing DURING the
        // run would also be above it; that miscounts one line of this report
        // and never any money, and this is an offline tool run by hand.)
        result.posted += 1;
      } else {
        result.alreadyPosted += 1;
      }
    }

    if (rows.length < args.batchSize) break;
    args.log(
      `  ${spec.category}: ${result.examined} row(s) examined so far (${result.posted} posted), continuing…`,
    );
  }

  if (pages > 0 || result.examined > 0) {
    args.log(
      `  ${spec.category}: ${result.examined} examined, ${result.posted} posted, ` +
        `${result.alreadyPosted} already posted, ${result.postedNothing} needed no posting, ` +
        `${result.unprocessable.length} could not be processed`,
    );
  } else {
    args.log(`  ${spec.category}: no historical rows`);
  }
  return result;
}

/**
 * Chart-of-accounts codes the seed defines that this database does not have.
 *
 * Checked against `CHART_OF_ACCOUNTS` rather than "are there any accounts at
 * all", because a partially-seeded chart fails in the same silent way a
 * completely unseeded one does: `postOrSkipMissingAccount` logs and returns
 * `null` for exactly the events whose accounts are missing, which reads as
 * "nothing to post" in this script's own report.
 */
async function missingAccountCodes(db: Db): Promise<string[]> {
  const codes = CHART_OF_ACCOUNTS.map((account) => account.code);
  const present = new Set(
    (
      await db.ledgerAccount.findMany({
        where: { code: { in: codes } },
        select: { code: true },
      })
    ).map((account) => account.code),
  );
  return codes.filter((code) => !present.has(code));
}

/** The earliest instant the ledger records, or null if it records nothing. */
async function ledgerCutover(db: Db): Promise<Date | null> {
  const earliest = await db.financialTransaction.aggregate({ _min: { occurredAt: true } });
  return earliest._min.occurredAt ?? null;
}

/** The subset of an order the two settlement categories read. */
interface HistoricalOrder {
  id: number;
  orderCode: string;
  currency: string;
  totalAmount: import("@prisma/client").Prisma.Decimal;
  paidAt: Date | null;
  status: string;
}

/**
 * Orders whose payment the ledger should record: settled (`paidAt` is set —
 * every settlement path stamps it in the same transaction as the posting, and
 * passes that same value as the posting's `occurredAt`), or DELIVERED, which is
 * what `reconcileLedger` looks for and therefore what this has to cover for its
 * checks to come out clean.
 *
 * A DELIVERED order with no `paidAt` is included so it is REPORTED rather than
 * silently left for reconciliation to flag later; `post` refuses it, because
 * there is no honest instant to date a posting from.
 */
const settledOrdersPage =
  (db: Db, kind: "product" | "topup") =>
  async (afterId: number, take: number): Promise<HistoricalOrder[]> =>
    db.order.findMany({
      where: {
        id: { gt: afterId },
        // "Product" is everything that is not a top-up, matching both
        // `settlePaidOrder` (which posts an ORDER_PAYMENT for any non-top-up
        // order) and `reconcileLedger`'s own split, so a third `kind` added
        // later cannot fall between this script and the check that grades it.
        kind: kind === "topup" ? OrderKind.WALLET_TOPUP : { not: OrderKind.WALLET_TOPUP },
        OR: [{ paidAt: { not: null } }, { status: OrderStatus.DELIVERED }],
      },
      select: {
        id: true,
        orderCode: true,
        currency: true,
        totalAmount: true,
        paidAt: true,
        status: true,
      },
      orderBy: { id: "asc" },
      take,
    });

const undatedOrder = (order: HistoricalOrder): PostAttempt =>
  cannot(
    `it is ${order.status} but has no paid_at, so there is no recorded instant its payment ` +
      `can be dated from — every settlement path in this codebase stamps paid_at in the same ` +
      `transaction as the posting, so a settled order without one was written around the ` +
      `application and needs a human decision before it is booked`,
  );

/** One historical wallet movement, joined to the order it belongs to (if any). */
interface HistoricalMovement {
  id: number;
  reason: string;
  currency: string;
  delta: import("@prisma/client").Prisma.Decimal;
  adminId: number | null;
  createdAt: Date;
  orderId: number | null;
  order: { id: number; orderCode: string; kind: string } | null;
}

/**
 * Wallet movements of the given reasons, each joined to its order.
 *
 * The join is done here rather than per row because `WalletTransaction` has no
 * Prisma relation to `Order` (its `orderId` is a plain column), so the only
 * alternative would be one query per movement.
 */
const movementsPage =
  (db: Db, reasons: readonly string[], opts: { withOrder: boolean }) =>
  async (afterId: number, take: number): Promise<HistoricalMovement[]> => {
    const rows = await db.walletTransaction.findMany({
      where: {
        id: { gt: afterId },
        reason: { in: [...reasons] },
        orderId: opts.withOrder ? { not: null } : null,
      },
      select: {
        id: true,
        reason: true,
        currency: true,
        delta: true,
        adminId: true,
        createdAt: true,
        orderId: true,
      },
      orderBy: { id: "asc" },
      take,
    });
    if (rows.length === 0 || !opts.withOrder) {
      return rows.map((row) => ({ ...row, order: null }));
    }
    const orders = await db.order.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.orderId!))] } },
      select: { id: true, orderCode: true, kind: true },
    });
    const byId = new Map(orders.map((order) => [order.id, order] as const));
    return rows.map((row) => ({ ...row, order: byId.get(row.orderId!) ?? null }));
  };

const movementReference = (movement: HistoricalMovement): string =>
  `wallet movement #${movement.id} (${movement.reason}, ${movement.delta.toString()} ` +
  `${movement.currency}${movement.order ? `, order ${movement.order.orderCode}` : ""})`;

const orphanedMovement = (movement: HistoricalMovement): PostAttempt =>
  cannot(
    `it points at order ${movement.orderId}, which does not exist — the posting for this ` +
      `movement is booked against an order, so there is nothing to book it against`,
  );

/** One historical refund payout, joined to the order it paid out against. */
interface HistoricalPayout {
  id: number;
  executedAt: Date | null;
  refundId: number;
  refund: { order: { id: number; orderCode: string } };
}

export async function backfillLedgerHistory(
  db: Db,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const log = options.log ?? ((line: string) => console.log(line));
  const startedAt = new Date();

  const missing = await missingAccountCodes(db);
  if (missing.length > 0) {
    // Refused before a single posting, because every posting would be skipped
    // for a missing account and the run would report an empty history rather
    // than a broken one.
    throw new Error(
      `Refusing to backfill the ledger: this database is missing ${missing.length} of the ` +
        `chart-of-accounts rows the postings need (${missing.join(", ")}). Every posting would ` +
        `be skipped for a missing account and this run would report a shop with no financial ` +
        `history instead of a database that was never seeded. Run "pnpm run ` +
        `seed-chart-of-accounts" against this database first, then run this again.`,
    );
  }

  const cutoverBefore = await ledgerCutover(db);
  const refundPayoutsPredatingLedgerWhere = { status: RefundExecutionStatus.COMPLETED, createdAt: { lt: cutoverBefore! } };
  const refundPayoutsPredatingLedger =
    cutoverBefore === null
      ? []
      : await db.refundExecution.findMany({
          where: refundPayoutsPredatingLedgerWhere,
          select: { id: true, createdAt: true },
          orderBy: { id: "asc" },
          take: 100,
        });
  const refundPayoutsPredatingLedgerCount =
    cutoverBefore === null ? 0 : await db.refundExecution.count({ where: refundPayoutsPredatingLedgerWhere });

  // Must list exactly the reasons categories 5, 6a, 6b and 7 below page with
  // `withOrder: true` — those queries filter `orderId: { not: null }`, so a
  // row of one of these reasons with a null orderId is invisible to every
  // category and needs its own check to be reported at all.
  const orderlessOrderMovementsWhere = {
    reason: { in: ["referral", "underpaid_refund", "unfulfilled_credit", "order_refund"] },
    orderId: null,
  };
  const orderlessOrderMovements = await db.walletTransaction.findMany({
    where: orderlessOrderMovementsWhere,
    select: { id: true, reason: true },
    orderBy: { id: "asc" },
    take: 100,
  });
  const orderlessOrderMovementsCount = await db.walletTransaction.count({
    where: orderlessOrderMovementsWhere,
  });

  // Every FinancialTransaction id at or below this existed before the run, so
  // anything above it is a posting this run wrote. Read once; see `runCategory`.
  const watermark = (await db.financialTransaction.aggregate({ _max: { id: true } }))._max.id ?? 0;
  const runArgs = { batchSize, ledgerWatermark: watermark, log };

  log(
    `Backfilling the ledger from historical rows, ${batchSize} at a time. The ledger's ` +
      `earliest posting right now is ${cutoverBefore?.toISOString() ?? "(none — the ledger is empty)"}.`,
  );

  const categories: CategoryResult[] = [];

  // ── 1. Order payments ────────────────────────────────────────────────────
  // FIRST, always: three later categories branch on whether this posting
  // exists. See this file's "Order is load-bearing" note.
  categories.push(
    await runCategory<HistoricalOrder>(
      {
        category: "order_payment",
        describes: "a product order's payment, recognised as revenue when it settled",
        entity: "order",
        page: settledOrdersPage(db, "product"),
        idOf: (order) => order.id,
        referenceOf: (order) =>
          `order ${order.orderCode} (${order.status}, ${order.totalAmount.toString()} ${order.currency})`,
        post: async (order) =>
          order.paidAt === null
            ? undatedOrder(order)
            : from(await postOrderPaymentPosting(db, order, order.paidAt)),
      },
      runArgs,
    ),
  );

  // ── 2. Wallet top-ups ────────────────────────────────────────────────────
  categories.push(
    await runCategory<HistoricalOrder>(
      {
        category: "wallet_topup",
        describes: "a wallet top-up that settled in full, becoming credit the shop owes the buyer",
        entity: "order",
        page: settledOrdersPage(db, "topup"),
        idOf: (order) => order.id,
        referenceOf: (order) =>
          `top-up order ${order.orderCode} (${order.status}, ${order.totalAmount.toString()} ${order.currency})`,
        post: async (order) =>
          order.paidAt === null
            ? undatedOrder(order)
            : from(await postWalletTopupPosting(db, order, order.paidAt)),
      },
      runArgs,
    ),
  );

  // ── 3. Underpaid top-ups credited short ──────────────────────────────────
  // `admin_adjust` WITH an order is written by exactly one path
  // (`creditUnderpaidTopupAnyway`), and only ever against a WALLET_TOPUP order.
  // That is the discriminator against category 4, whose two call sites attach
  // no order at all.
  categories.push(
    await runCategory<HistoricalMovement>(
      {
        category: "underpaid_topup_credit",
        describes: "a top-up whose money arrived short, credited to the buyer anyway",
        entity: "wallet_transaction",
        page: movementsPage(db, ["admin_adjust"], { withOrder: true }),
        idOf: (movement) => movement.id,
        referenceOf: movementReference,
        post: async (movement) => {
          if (movement.order === null) return orphanedMovement(movement);
          if (movement.order.kind !== OrderKind.WALLET_TOPUP) {
            return cannot(
              `it is an admin_adjust movement attached to order ${movement.order.orderCode}, ` +
                `which is not a top-up — no path in this codebase writes that shape, and the two ` +
                `postings it could plausibly be disagree about where the money came from ` +
                `(the shop's own equity, or a payment gateway), so it needs a human decision`,
            );
          }
          if (movement.adminId === null) {
            return cannot(
              `no acting admin is recorded on it, and this posting names the admin who resolved ` +
                `the underpaid top-up — the only path that writes this shape always records one, ` +
                `so this movement came from somewhere else`,
            );
          }
          return from(
            await postUnderpaidTopupCreditPosting(db, {
              walletTransactionId: movement.id,
              orderId: movement.order.id,
              orderCode: movement.order.orderCode,
              adminId: movement.adminId,
              occurredAt: movement.createdAt,
            }),
          );
        },
      },
      runArgs,
    ),
  );

  // ── 4. Hand-made wallet adjustments ──────────────────────────────────────
  categories.push(
    await runCategory<HistoricalMovement>(
      {
        category: "admin_wallet_adjustment",
        describes: "an admin moving a buyer's balance by hand, out of the shop's own equity",
        entity: "wallet_transaction",
        page: movementsPage(db, ["admin_adjust"], { withOrder: false }),
        idOf: (movement) => movement.id,
        referenceOf: movementReference,
        post: async (movement) => {
          if (movement.adminId === null) {
            return cannot(
              `no acting admin is recorded on it, and this posting's own back-pointer IS the ` +
                `acting admin — booking it would either put a name on a money decision nobody ` +
                `made or leave the posting pointing at nothing`,
            );
          }
          return from(
            await postWalletAdjustmentPosting(db, {
              walletTransactionId: movement.id,
              adminId: movement.adminId,
              occurredAt: movement.createdAt,
            }),
          );
        },
      },
      runArgs,
    ),
  );

  // ── 5. Referral commissions ──────────────────────────────────────────────
  categories.push(
    await runCategory<HistoricalMovement>(
      {
        category: "referral_commission",
        describes: "a referral commission paid into the referrer's wallet",
        entity: "wallet_transaction",
        page: movementsPage(db, ["referral"], { withOrder: true }),
        idOf: (movement) => movement.id,
        referenceOf: movementReference,
        post: async (movement) => {
          if (movement.order === null) return orphanedMovement(movement);
          return from(
            await postReferralCommissionPosting(db, {
              walletTransactionId: movement.id,
              orderId: movement.order.id,
              orderCode: movement.order.orderCode,
              occurredAt: movement.createdAt,
            }),
          );
        },
      },
      runArgs,
    ),
  );

  // ── 6. Money the buyer sent, turned into wallet credit ───────────────────
  // One posting function, two genuinely different business events, so two
  // categories: a crypto deposit that fell short of the order's price
  // (`refundUnderpaidOrder`) and an order the shop could not fulfil
  // (`creditOrderToBalance`). Counting them separately is what lets a report
  // reader tell "we could not fulfil eleven orders" from "eleven buyers
  // underpaid".
  for (const [category, reason, describes] of [
    [
      "underpaid_order_credit",
      "underpaid_refund",
      "a crypto deposit that fell short of the order's price, handed back as wallet credit",
    ],
    [
      "unfulfilled_order_credit",
      "unfulfilled_credit",
      "an order the shop could not fulfil, its payment handed back as wallet credit",
    ],
  ] as const) {
    categories.push(
      await runCategory<HistoricalMovement>(
        {
          category,
          describes,
          entity: "wallet_transaction",
          page: movementsPage(db, [reason], { withOrder: true }),
          idOf: (movement) => movement.id,
          referenceOf: movementReference,
          post: async (movement) => {
            if (movement.order === null) return orphanedMovement(movement);
            return from(
              await postOrderWalletCreditPosting(db, {
                walletTransactionId: movement.id,
                orderId: movement.order.id,
                orderCode: movement.order.orderCode,
                occurredAt: movement.createdAt,
              }),
            );
          },
        },
        runArgs,
      ),
    );
  }

  // ── 7. Checkout wallet holds released ────────────────────────────────────
  // Most of these post NOTHING and that is correct, not a gap: the ledger never
  // recorded the checkout debit on an order that did not settle, so there is
  // nothing to reverse. `postOrderHoldReleasePosting` decides that itself from
  // the order's own posting history — which is why this category hands it every
  // release rather than trying to pre-filter them here.
  categories.push(
    await runCategory<HistoricalMovement>(
      {
        category: "order_hold_release",
        describes:
          "a checkout wallet hold returned to the buyer (posted only where the order's revenue had been recognised)",
        entity: "wallet_transaction",
        page: movementsPage(db, ["order_refund"], { withOrder: true }),
        idOf: (movement) => movement.id,
        referenceOf: movementReference,
        post: async (movement) => {
          if (movement.order === null) return orphanedMovement(movement);
          return from(
            await postOrderHoldReleasePosting(db, {
              walletTransactionId: movement.id,
              orderId: movement.order.id,
              orderCode: movement.order.orderCode,
              occurredAt: movement.createdAt,
            }),
          );
        },
      },
      runArgs,
    ),
  );

  // ── 8. Refund payouts ────────────────────────────────────────────────────
  // `RefundExecution` was introduced by this ledger build's own first commit, so
  // nothing here can genuinely predate the ledger (see
  // `refundPayoutsPredatingLedger`, which reports it if something does). The
  // category runs anyway, because it is also the repair path for a payout whose
  // posting was skipped at the time for a chart-of-accounts row that had not
  // been seeded yet.
  categories.push(
    await runCategory<HistoricalPayout>(
      {
        category: "refund_payout",
        describes: "a refund actually paid out, into the buyer's wallet or out of the shop's funds",
        entity: "refund_execution",
        page: (afterId, take) =>
          db.refundExecution.findMany({
            where: { id: { gt: afterId }, status: RefundExecutionStatus.COMPLETED },
            select: {
              id: true,
              executedAt: true,
              refundId: true,
              refund: { select: { order: { select: { id: true, orderCode: true } } } },
            },
            orderBy: { id: "asc" },
            take,
          }),
        idOf: (payout) => payout.id,
        referenceOf: (payout) =>
          `refund payout #${payout.id} (refund #${payout.refundId}, order ${payout.refund.order.orderCode})`,
        post: async (payout) => {
          if (payout.executedAt === null) {
            return cannot(
              `it is recorded COMPLETED but carries no executed_at, so there is no instant the ` +
                `payout can be dated from — a completed payout with no timestamp is itself worth ` +
                `investigating in whichever path wrote it`,
            );
          }
          return from(
            await postRefundExecutionPosting(db, {
              refundExecutionId: payout.id,
              orderId: payout.refund.order.id,
              orderCode: payout.refund.order.orderCode,
              occurredAt: payout.executedAt,
            }),
          );
        },
      },
      runArgs,
    ),
  );

  const totals = categories.reduce(
    (sum, category) => ({
      examined: sum.examined + category.examined,
      posted: sum.posted + category.posted,
      alreadyPosted: sum.alreadyPosted + category.alreadyPosted,
      postedNothing: sum.postedNothing + category.postedNothing,
      unprocessable: sum.unprocessable + category.unprocessable.length,
    }),
    { examined: 0, posted: 0, alreadyPosted: 0, postedNothing: 0, unprocessable: 0 },
  );

  return {
    startedAt,
    finishedAt: new Date(),
    cutoverBefore,
    cutoverAfter: await ledgerCutover(db),
    refundPayoutsPredatingLedger,
    refundPayoutsPredatingLedgerCount,
    orderlessOrderMovements,
    orderlessOrderMovementsCount,
    categories,
    totals,
  };
}

/** The report as a plain-text summary, for a terminal or a pasted audit trail. */
export function formatBackfillReport(report: BackfillReport): string {
  const lines: string[] = [];
  lines.push("Historical ledger backfill (Financial Ledger M10)");
  lines.push("");
  lines.push(`Started:  ${report.startedAt.toISOString()}`);
  lines.push(`Finished: ${report.finishedAt.toISOString()}`);
  lines.push(
    `Earliest ledger posting before this run: ${report.cutoverBefore?.toISOString() ?? "(none — the ledger was empty)"}`,
  );
  lines.push(
    `Earliest ledger posting after this run:  ${report.cutoverAfter?.toISOString() ?? "(none — nothing was posted)"}`,
  );
  lines.push("");

  const header = ["category", "examined", "posted", "already posted", "no posting needed", "could not process"];
  const table = report.categories.map((category) => [
    category.category,
    String(category.examined),
    String(category.posted),
    String(category.alreadyPosted),
    String(category.postedNothing),
    String(category.unprocessable.length),
  ]);
  table.push([
    "TOTAL",
    String(report.totals.examined),
    String(report.totals.posted),
    String(report.totals.alreadyPosted),
    String(report.totals.postedNothing),
    String(report.totals.unprocessable),
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...table.map((row) => row[column]!.length)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  lines.push(render(header));
  lines.push(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of table) lines.push(render(row));
  lines.push("");

  lines.push("What each category posts:");
  for (const category of report.categories) {
    lines.push(`  ${category.category}: ${category.describes}`);
  }
  lines.push("");

  if (report.refundPayoutsPredatingLedgerCount > 0) {
    const shown = report.refundPayoutsPredatingLedger.length;
    const countClause =
      report.refundPayoutsPredatingLedgerCount > shown
        ? `${report.refundPayoutsPredatingLedgerCount} completed refund payout(s) (showing the first ${shown})`
        : `${report.refundPayoutsPredatingLedgerCount} completed refund payout(s)`;
    lines.push(
      `INVESTIGATE: ${countClause} were recorded BEFORE the ledger's earliest posting. ` +
        "RefundExecution was introduced alongside the ledger itself, so this should be impossible " +
        "— it suggests a restored dump or rows written around the application. They were posted " +
        "like any other payout; confirm each one really happened:",
    );
    for (const payout of report.refundPayoutsPredatingLedger) {
      lines.push(`  refund payout #${payout.id}, recorded ${payout.createdAt.toISOString()}`);
    }
    lines.push("");
  }

  if (report.orderlessOrderMovementsCount > 0) {
    const shown = report.orderlessOrderMovements.length;
    const countClause =
      report.orderlessOrderMovementsCount > shown
        ? `${report.orderlessOrderMovementsCount} wallet movement(s) (showing the first ${shown})`
        : `${report.orderlessOrderMovementsCount} wallet movement(s)`;
    lines.push(
      `INVESTIGATE: ${countClause} carry a reason that should always name an order (referral, ` +
        "underpaid_refund, unfulfilled_credit or order_refund) but have no order attached. No " +
        "code path in this repo writes that shape, and none of this run's categories can see " +
        "them either — they were NOT examined, NOT posted and NOT counted as unprocessable " +
        "above. This needs a human decision before anything is booked for them:",
    );
    for (const movement of report.orderlessOrderMovements) {
      lines.push(`  wallet movement #${movement.id} (${movement.reason})`);
    }
    lines.push("");
  }

  const unprocessable = report.categories.flatMap((category) => category.unprocessable);
  if (unprocessable.length > 0) {
    lines.push(
      `COULD NOT PROCESS ${unprocessable.length} row(s). Each one is a shape no code path in ` +
        "this repo writes, so it was reported rather than forced through a posting that may not " +
        "describe it. Nothing was written for any of them, and re-running after fixing the row " +
        "will pick it up:",
    );
    for (const row of unprocessable.slice(0, MAX_LISTED_UNPROCESSABLE)) {
      lines.push(`  [${row.category}] ${row.reference}: ${row.problem}`);
    }
    if (unprocessable.length > MAX_LISTED_UNPROCESSABLE) {
      lines.push(`  … and ${unprocessable.length - MAX_LISTED_UNPROCESSABLE} more.`);
    }
    lines.push("");
  }

  lines.push(
    `Posted ${report.totals.posted} historical event(s); ${report.totals.alreadyPosted} were ` +
      `already in the books and ${report.totals.postedNothing} needed no posting at all.`,
  );
  lines.push(
    "NEXT: run the ledger reconciliation now. This backfill moved the earliest posting in the " +
      "books backwards, and reconcileLedger measures drift from that instant — so it now checks " +
      "the whole period these postings describe. Anything it reports is either a category this " +
      "run could not process (listed above) or real drift.",
  );
  return lines.join("\n");
}

/** `--batch-size N`, or the default. */
function parseArgs(argv: string[]): { batchSize: number } {
  const index = argv.indexOf("--batch-size");
  if (index < 0) return { batchSize: DEFAULT_BATCH_SIZE };
  const raw = argv[index + 1];
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--batch-size must be a positive whole number, not "${raw ?? ""}"`);
  }
  return { batchSize: parsed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await initDb();
  const report = await backfillLedgerHistory(prisma, { batchSize: args.batchSize });
  console.log("");
  console.log(formatBackfillReport(report));
  // Non-zero when something was left unprocessed — a row a category examined and
  // could not post, OR a wallet movement no category's query can see at all
  // (`orderlessOrderMovementsCount`, which the report deliberately does not count
  // as "unprocessable") — so a run wired into anything that checks exit codes
  // cannot quietly report a partial backfill as done.
  // Set on `exitCode` and left to fall off the end (matching
  // scripts/seed-chart-of-accounts.ts), not a bare `process.exit`: this report
  // is the run's audit trail, and when stdout is redirected to a file rather
  // than a TTY, Node's write can still be in flight when `process.exit` tears
  // the process down, truncating it.
  process.exitCode =
    report.totals.unprocessable > 0 || report.orderlessOrderMovementsCount > 0 ? 1 : 0;
  await prisma.$disconnect();
}

// Guarded so `main()` only runs when this file is executed directly, not when
// the test imports the functions above — an unguarded call would open a database
// connection and `process.exit` as a side effect of that import. Same guard,
// same reason, as scripts/parity-check-kind-filter.ts.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
