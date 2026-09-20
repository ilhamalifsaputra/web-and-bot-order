import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DataTable } from "../shared/DataTable";
import { EmptyState } from "../shared/EmptyState";
import { StatusBadge } from "../shared/StatusBadge";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardAction, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatCurrencyDisplay } from "../shared/CurrencyAmount";
import { TriangleAlert, RefreshCw, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { apiPost } from "../../api/client";
import { describeError } from "../../lib/errorMessages";
import { visibleSelection } from "../../lib/selection";

/** The currencies this shop's money ever comes back as — same union
 *  api/types.ts uses, and the only ones `formatCurrencyDisplay` accepts. */
type MoneyCurrency = "IDR" | "USDT" | "USD";

/** One purchased UNIT of an order. A bulk purchase is stored as one OrderItem
 *  row per unit (see the StockReplacement schema comment), which is why every
 *  action below is keyed by an OrderItem id and needs no quantity or index. */
export interface OrderUnit {
  id: number;
  quantity: number;
  unitPrice: string;
  product: { id: number; name: string };
  stockItem: { id: number; credentials: string } | null;
}

/** One replacement request, as GET /api/orders/:orderId serializes it
 *  (`serializeStockReplacement`, apps/web-admin/src/routes/api/orders.ts). */
export interface StockReplacementRow {
  id: number;
  orderItemId: number;
  status: string;
  reason: string;
  replacementStockItemId: number | null;
  supportTicketId: number | null;
  requestedAtDisplay: string | null;
  resolvedAtDisplay: string | null;
  /** Set only on a REFUNDED_INSTEAD request. `currency` is narrowed to the
   *  three values `formatCurrencyDisplay` knows, the same way api/types.ts
   *  types every other money-bearing response. */
  refund: { id: number; amount: string; currency: MoneyCurrency; status: string } | null;
}

/** The slice of GET /api/orders/:orderId this card needs — the real response is
 *  a superset, so either page can hand its own query's data straight over. */
export interface OrderUnitsData {
  order: { id: number; orderCode: string; items: OrderUnit[] };
  isDelivered: boolean;
  stockReplacements: StockReplacementRow[];
}

/** Mirrors TERMINAL_STOCK_REPLACEMENT_STATUSES (@app/core/enums) rather than
 *  importing it: the SPA keeps its own copies of server enums (same convention
 *  as api/types.ts's mirrored types), and the authoritative list is the one the
 *  service enforces, never this one. */
const TERMINAL_STATUSES = ["COMPLETED", "REFUNDED_INSTEAD", "CANCELLED", "FAILED"];

interface OrderUnitsCardProps {
  /** The order these units belong to, as the route param spells it — also the
   *  `["order", orderId]` query key both pages cache this order under, which is
   *  what a successful action invalidates. */
  orderId: string;
  units: OrderUnit[];
  replacements: StockReplacementRow[];
  /** Only a DELIVERED order has anything to replace; the service refuses
   *  anything else, and the UI simply doesn't offer it. */
  isDelivered: boolean;
  /** Card heading. Defaults to the Items (N) heading the order detail page has
   *  always used. */
  title?: string;
  /** Whether to render the delivered credential. True on the order detail page
   *  (which has always shown it, and is gated to non-readonly roles); false on
   *  the support ticket page, which needs the units and their replacement state
   *  but has no reason to put account credentials on screen. */
  showCredentials?: boolean;
  /** Set when the complaint arrived on a support ticket, so the request records
   *  which ticket it came in on (StockReplacement.supportTicketId). */
  supportTicketId?: number;
  /** Plaintext credentials by OrderItem id once an admin has used the audited
   *  Reveal on the order page; undefined while still masked (the GET response
   *  carries only a mask, never the credential). An id missing from the map shows
   *  "—" — the reveal skipped that unit. */
  revealedCredentials?: Map<number, string>;
  /** The Show/Hide button the order page renders in this card's header. */
  headerAction?: ReactNode;
  /** Called whenever this card re-reads the order after an action: a replacement
   *  changes which credential a unit holds, so the page drops any revealed text
   *  rather than keep showing the retired account. */
  onRefetched?: () => void;
}

/** A unit plus everything known about complaints against it. */
interface UnitRow extends OrderUnit {
  /** "1 of 5" — the same way the service's own audit line names a unit. */
  unitLabel: string;
  history: StockReplacementRow[];
  /** The one non-terminal request, if this unit has one. At most one can exist
   *  at a time (the service refuses a second). */
  openRequest: StockReplacementRow | null;
}

/** Plain-English "what did this request resolve to", for the history column. */
function outcomeText(row: StockReplacementRow): string {
  if (row.status === "COMPLETED") return "A fresh account was issued and sent to the buyer.";
  if (row.status === "REFUNDED_INSTEAD" && row.refund) {
    // Formatted client-side through the shared display helper, never
    // re-computed: the service already decided this amount to the last digit.
    return `Refunded ${formatCurrencyDisplay(row.refund.amount, row.refund.currency)} to the buyer instead.`;
  }
  if (row.status === "AWAITING_STOCK") return "Waiting for a restock — nothing has been handed over yet.";
  if (row.status === "REQUESTED") return "Just opened.";
  return "Closed without a replacement.";
}

/**
 * The per-unit list of an order: what was bought, which credential it holds,
 * and every "this account is dead" request ever opened against it — plus the
 * actions that resolve one (Financial Ledger M20).
 *
 * Shared by the order detail page and the support ticket detail page so a
 * ticket can be resolved against the specific unit it is about rather than the
 * whole order, instead of the ticket page growing a second copy of this table.
 * The ticket page passes `supportTicketId`, which is the only behavioural
 * difference between the two: the request it opens records the ticket it came
 * in on.
 *
 * Every guard lives in the service (`packages/db/src/crud/stockReplacement.ts`)
 * — this component only avoids OFFERING an action that would certainly be
 * refused (an undelivered order, a unit holding no stock account, a unit whose
 * request is still open). Anything it does offer can still come back 422, which
 * is surfaced as a toast rather than hidden.
 *
 * "Report all" is N independent calls of the SAME per-unit route, one per
 * selected unit, run in sequence — deliberately not a bulk endpoint: one unit's
 * request must never be able to fail (or succeed) because of another's, and
 * there is no second code path for it to drift away from.
 */
export function OrderUnitsCard({
  orderId,
  units,
  replacements,
  isDelivered,
  title,
  showCredentials = true,
  supportTicketId,
  revealedCredentials,
  headerAction,
  onRefetched,
}: OrderUnitsCardProps): JSX.Element {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  /** The units a not-yet-submitted report is about — one row's, or the current
   *  selection's. Null when the dialog is closed. */
  const [reportTarget, setReportTarget] = useState<number[] | null>(null);
  const [reason, setReason] = useState("");
  const [refundTarget, setRefundTarget] = useState<StockReplacementRow | null>(null);

  const rows: UnitRow[] = units.map((unit, i) => {
    const history = replacements.filter((r) => r.orderItemId === unit.id);
    return {
      ...unit,
      unitLabel: `${i + 1} of ${units.length}`,
      history,
      openRequest: history.find((r) => !TERMINAL_STATUSES.includes(r.status)) ?? null,
    };
  });

  /** A unit is worth offering "Report Issue" for when the order really was
   *  delivered, the unit really holds a delivered account (hand-fulfilled
   *  orders never reserve one), and no request is already open for it. */
  const canReport = (row: UnitRow) => isDelivered && row.stockItem !== null && row.openRequest === null;
  const reportable = rows.filter(canReport);
  const selectedIds = visibleSelection(selected, reportable, (row) => row.id);
  /** Re-read the order after any action: a replacement changes which credential
   *  each unit holds and what its request history says, and the service wrote
   *  an audit row the ticket page renders in "Order Activity" — so when this
   *  card is rendered inside a ticket, that ticket is refreshed too. */
  const refresh = () => {
    onRefetched?.();
    void qc.invalidateQueries({ queryKey: ["order", orderId] });
    if (supportTicketId != null) {
      void qc.invalidateQueries({ queryKey: ["ticket", String(supportTicketId)] });
    }
  };

  const report = useMutation({
    mutationFn: async (args: { orderItemIds: number[]; reason: string }) => {
      let issued = 0;
      let awaiting = 0;
      /** Of the `issued` units, how many the shop could not tell the buyer
       *  about — see the `buyerNotified` note on the toasts below. */
      let unannounced = 0;
      const failures: string[] = [];
      // Sequential, one request per unit: each call opens its own
      // StockReplacement and hands over its own credential, and the service
      // locks the OrderItem row for the duration — firing them all at once
      // would only queue behind each other with a worse failure story.
      for (const orderItemId of args.orderItemIds) {
        try {
          const res = await apiPost<{
            status: string;
            credentialIssued: boolean;
            buyerNotified: boolean;
          }>(
            `/api/orders/${orderId}/items/${orderItemId}/replace`,
            supportTicketId != null
              ? { reason: args.reason, supportTicketId }
              : { reason: args.reason },
          );
          if (res.credentialIssued) {
            issued += 1;
            if (!res.buyerNotified) unannounced += 1;
          } else awaiting += 1;
        } catch (e) {
          failures.push(describeError((e as Error).message));
        }
      }
      return { issued, awaiting, unannounced, failures };
    },
    onSuccess: ({ issued, awaiting, unannounced, failures }) => {
      refresh();
      setSelected(new Set());
      // Two separate facts, and the toast must not merge them: the swap always
      // happened, but a buyer with no Telegram id and no guest email address has
      // nowhere for the shop to send the news, so the panel says "issued" for
      // those units and leaves telling them to the admin.
      const announced = issued - unannounced;
      if (announced > 0) {
        toast.success(
          announced === 1
            ? "A fresh account has been sent to the buyer."
            : `Fresh accounts have been sent to the buyer for ${announced} units.`,
        );
      }
      if (unannounced > 0) {
        toast.warning(
          unannounced === 1
            ? "A fresh account is on the buyer's order page, but they have no Telegram or email contact — nobody has told them, so please reach out."
            : `Fresh accounts are on the buyer's order page for ${unannounced} units, but they have no Telegram or email contact — nobody has told them, so please reach out.`,
        );
      }
      if (awaiting > 0) {
        toast.warning(
          awaiting === 1
            ? "The bad account was retired, but there is no spare in stock — retry after a restock, or refund the unit."
            : `${awaiting} bad accounts were retired, but there are no spares in stock — retry after a restock, or refund those units.`,
        );
      }
      // One toast per distinct failure, so an admin reporting several units at
      // once can see which reason each rejection gave rather than a count.
      for (const failure of new Set(failures)) toast.error(failure);
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const retry = useMutation({
    mutationFn: (replacementId: number) =>
      apiPost<{ credentialIssued: boolean; buyerNotified: boolean }>(
        `/api/orders/${orderId}/replacements/${replacementId}/retry`,
        {},
      ),
    onSuccess: (res) => {
      refresh();
      if (res.credentialIssued && res.buyerNotified) {
        toast.success("A replacement account has been sent to the buyer.");
      } else if (res.credentialIssued) {
        toast.warning(
          "A replacement account is on the buyer's order page, but they have no Telegram or email contact — nobody has told them, so please reach out.",
        );
      } else toast.warning("Still nothing in stock for that account — the buyer is still waiting.");
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  const refund = useMutation({
    mutationFn: (replacementId: number) =>
      apiPost<{ refunded: string; currency: MoneyCurrency }>(
        `/api/orders/${orderId}/replacements/${replacementId}/refund`,
        {},
      ),
    onSuccess: (res) => {
      refresh();
      toast.success(
        `Refunded ${formatCurrencyDisplay(res.refunded, res.currency)} to the buyer's wallet balance.`,
      );
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  function openReportDialog(orderItemIds: number[]) {
    setReason("");
    setReportTarget(orderItemIds);
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allReportableSelected = reportable.length > 0 && reportable.every((row) => selected.has(row.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{title ?? `Items (${units.length})`}</CardTitle>
        {headerAction && <CardAction>{headerAction}</CardAction>}
      </CardHeader>
      <CardContent>
        {selectedIds.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-sand px-3 py-2 text-sm">
            <span className="text-ink-soft">{selectedIds.size} selected</span>
            <Button
              size="sm"
              variant="outline"
              disabled={report.isPending}
              onClick={() => openReportDialog(Array.from(selectedIds))}
            >
              <TriangleAlert className="h-4 w-4" />
              Report Issue ({selectedIds.size} {selectedIds.size === 1 ? "unit" : "units"})
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}
        <DataTable
          nested
          columns={[
            // The checkbox column only appears once there is more than one unit
            // an admin could report — on a single-unit order it would be a
            // column of one checkbox next to the row's own button.
            ...(reportable.length > 1
              ? [
                  {
                    key: "select",
                    kind: "selection" as const,
                    header: (
                      <Checkbox
                        checked={allReportableSelected}
                        onCheckedChange={() =>
                          setSelected(allReportableSelected ? new Set() : new Set(reportable.map((r) => r.id)))
                        }
                        aria-label="Select every replaceable unit"
                      />
                    ),
                    render: (row: UnitRow) =>
                      canReport(row) ? (
                        <Checkbox
                          checked={selected.has(row.id)}
                          onCheckedChange={() => toggleSelected(row.id)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Select unit ${row.unitLabel}`}
                        />
                      ) : null,
                  },
                ]
              : []),
            {
              key: "product",
              header: "Product",
              render: (row: UnitRow) => (
                <span className="block max-w-[240px] truncate text-sm" title={row.product.name}>
                  {row.product.name}
                </span>
              ),
            },
            { key: "qty", header: "Qty", render: (row: UnitRow) => <span className="text-sm text-center">{row.quantity}</span> },
            { key: "price", header: "Unit Price", render: (row: UnitRow) => <span className="text-sm font-mono">{row.unitPrice}</span> },
            ...(showCredentials
              ? [
                  // Credentials are email:password blobs an admin must read in
                  // full, so they wrap instead of truncating. TableCell is
                  // whitespace-nowrap by default, hence the explicit override —
                  // without it break-all has nothing to act on.
                  {
                    key: "credentials",
                    header: "Credentials",
                    render: (row: UnitRow) => (
                      <span className="block max-w-[280px] font-mono text-xs break-all whitespace-normal text-ink-soft">
                        {row.stockItem
                          ? revealedCredentials
                            ? (revealedCredentials.get(row.id) ?? "—")
                            : row.stockItem.credentials
                          : "—"}
                      </span>
                    ),
                  },
                ]
              : []),
            {
              key: "replacement",
              header: "Replacement",
              render: (row: UnitRow) =>
                row.history.length === 0 ? (
                  <span className="text-xs text-ink-soft">—</span>
                ) : (
                  <div className="flex max-w-[280px] flex-col gap-1.5">
                    {row.history.map((request) => (
                      <div key={request.id} className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <StatusBadge status={request.status} />
                          <span className="text-xs text-ink-soft">
                            {request.resolvedAtDisplay ?? request.requestedAtDisplay ?? "—"}
                          </span>
                        </div>
                        <span className="text-xs break-words whitespace-normal text-ink-soft">
                          {outcomeText(request)}
                        </span>
                        {/* The buyer's own account of what was wrong, as the
                            admin recorded it — unbounded free text, so it
                            wraps rather than being clipped by the card. */}
                        <span className="text-xs break-words whitespace-normal text-ink-faint">
                          Reported: {request.reason}
                        </span>
                      </div>
                    ))}
                  </div>
                ),
            },
            {
              key: "actions",
              header: "",
              render: (row: UnitRow) => (
                <div className="flex flex-col items-end gap-2">
                  {canReport(row) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={report.isPending}
                      onClick={() => openReportDialog([row.id])}
                    >
                      <TriangleAlert className="h-4 w-4" />
                      Report Issue
                    </Button>
                  )}
                  {row.openRequest?.status === "AWAITING_STOCK" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retry.isPending}
                        onClick={() => retry.mutate(row.openRequest!.id)}
                      >
                        <RefreshCw className="h-4 w-4" />
                        Retry now
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={refund.isPending}
                        onClick={() => setRefundTarget(row.openRequest)}
                      >
                        <Undo2 className="h-4 w-4" />
                        Refund instead
                      </Button>
                    </>
                  )}
                </div>
              ),
            },
          ]}
          data={rows}
          keyExtractor={(row) => row.id}
          empty={<EmptyState title="No items" />}
        />
      </CardContent>

      {/* Reporting a bad account needs a reason (the service requires one), so
          this is a small form rather than the plain ConfirmDialog the
          no-input actions on this page use. */}
      <Dialog
        open={reportTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReportTarget(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {reportTarget && reportTarget.length > 1
                ? `Report ${reportTarget.length} bad accounts?`
                : "Report a bad account?"}
            </DialogTitle>
            <DialogDescription>
              The delivered account is retired and a spare is sent to the buyer straight away. If none is in
              stock, the request waits here until you retry it or refund the unit.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What was wrong with the account? (required)"
            rows={3}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setReportTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={!reason.trim() || report.isPending}
              onClick={() => {
                if (!reportTarget || !reason.trim()) return;
                report.mutate({ orderItemIds: reportTarget, reason: reason.trim() });
                setReportTarget(null);
              }}
            >
              {report.isPending ? "Reporting…" : "Report"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {refundTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRefundTarget(null);
          }}
          title="Refund this unit instead of replacing it?"
          description="The buyer gets this one unit's money back as wallet balance, and the request is closed. The rest of the order is unaffected, and this cannot be undone."
          confirmLabel="Refund unit"
          variant="default"
          onConfirm={() => {
            refund.mutate(refundTarget.id);
            setRefundTarget(null);
          }}
        />
      )}
    </Card>
  );
}
