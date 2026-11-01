import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { apiPost } from "../../api/client";
import { bulkFailureLines, toastBulkOutcome, withoutSucceeded, type BulkFailedItem, type BulkFailureLine } from "../../lib/bulkOutcome";
import { describeError } from "../../lib/errorMessages";

export interface BulkActionResult {
  succeeded: number[];
  failed: BulkFailedItem[];
}

/** What an approval did. Only "delivered" reached the buyer; "processing" is an
 * order someone or a supplier still has to fulfil. */
interface ApproveResult {
  settled?: "delivered" | "processing";
}

/** The orders a Deliver confirmation is about, snapshotted when it opened. */
export interface DeliverTarget {
  rows: { id: number; orderCode: string }[];
  /** Came from the bulk bar rather than a row's own menu. */
  bulk: boolean;
  /** Selected orders left out because they cannot be delivered. */
  skipped: number;
}

interface ActionableOrder {
  id: number;
  orderCode: string;
  eligibility: { canAct: boolean; canResend: boolean };
}

/** Everything the Orders list does to orders, and the dialogs that guard it. */
export function useOrderActions({ orders, setSelected, setBulkFailures }: {
  orders: readonly ActionableOrder[];
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  setBulkFailures: Dispatch<SetStateAction<BulkFailureLine[]>>;
}) {
  const queryClient = useQueryClient();
  const [cancelTarget, setCancelTarget] = useState<{ ids: number[] } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [deliverTarget, setDeliverTarget] = useState<DeliverTarget | null>(null);

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ["orders"] });
  }

  function orderCodeOf(id: number): string {
    return orders.find((o) => o.id === id)?.orderCode ?? `Order #${id}`;
  }

  /** The one reading of a bulk answer: only what worked leaves the selection,
   * and what did not is named with its reason. */
  function settleBulk(result: BulkActionResult, done: string, allDone?: string) {
    invalidateAll();
    setSelected((current) => withoutSucceeded(current, result.succeeded));
    setBulkFailures(bulkFailureLines(result.failed, orderCodeOf));
    toastBulkOutcome({ done, noun: "order", succeeded: result.succeeded.length, failed: result.failed.length, allDone });
  }

  const deliverMutation = useMutation({
    mutationFn: (orderId: number) => apiPost<ApproveResult>(`/api/orders/${orderId}/approve`, {}),
    onSuccess: (result) => {
      invalidateAll();
      toast.success(result.settled === "processing"
        ? "Payment approved. The order is queued for fulfilment."
        : "Order approved and delivered.");
    },
    onError: (e: Error) => {
      // A refused or unanswered approval still means the row may be stale.
      invalidateAll();
      toast.error(describeError(e));
    },
  });

  const resendRequests = useRef(new Set<number>());
  const [resendingIds, setResendingIds] = useState<number[]>([]);
  useEffect(() => {
    const requests = resendRequests.current;
    return () => { requests.clear(); };
  }, []);
  async function resendDelivery(orderId: number) {
    if (resendRequests.current.has(orderId)) return;
    resendRequests.current.add(orderId);
    setResendingIds(current => [...current, orderId]);
    try {
      await apiPost(`/api/orders/${orderId}/resend`, {});
      if (resendRequests.current.has(orderId)) toast.success("Delivery credentials resent.");
    } catch (error) {
      if (resendRequests.current.has(orderId)) toast.error(describeError(error as Error));
    } finally {
      if (resendRequests.current.delete(orderId)) setResendingIds(current => current.filter(id => id !== orderId));
    }
  }

  const bulkMutation = useMutation({
    mutationFn: (vars: { ids: number[]; action: "deliver" | "resend" }) =>
      apiPost<BulkActionResult>("/api/orders/bulk-action", vars),
    onSuccess: (result, vars) => settleBulk(result, vars.action === "deliver" ? "Approved" : "Resent"),
    onError: (e: Error) => {
      invalidateAll();
      toast.error(describeError(e));
    },
  });

  // Row cancel (single id) uses the dedicated /cancel route so the audit log
  // reads "cancel_order"; a multi-id selection goes through /bulk-action
  // (logs one "order_bulk_cancel" summary row instead) — same Dialog drives
  // both, the response is normalized to the bulk shape either way so the
  // toast copy doesn't need to branch.
  const cancelMutation = useMutation({
    mutationFn: async (vars: { ids: number[]; reason: string }): Promise<BulkActionResult> => {
      if (vars.ids.length === 1) {
        await apiPost(`/api/orders/${vars.ids[0]}/cancel`, { reason: vars.reason });
        return { succeeded: vars.ids, failed: [] };
      }
      return apiPost<BulkActionResult>("/api/orders/bulk-action", {
        ids: vars.ids,
        action: "cancel",
        reason: vars.reason,
      });
    },
    onSuccess: (result) => {
      // The dialog closes even when something failed: what remains is the
      // selection and the reasons beside it, and resubmitting this dialog would
      // re-send the orders that were already cancelled.
      setCancelTarget(null);
      setCancelReason("");
      settleBulk(result, "Cancelled", result.succeeded.length === 1 ? "Order cancelled." : undefined);
    },
    onError: (e: Error) => toast.error(describeError(e)),
  });

  /** Bulk deliver asks first: it cannot be undone, and the selection may hold
   * orders it will leave out. */
  function askBulkDeliver(selectedRows: readonly ActionableOrder[]) {
    const rows = selectedRows.filter((row) => row.eligibility.canAct);
    if (rows.length === 0) {
      toast.error("None of the selected orders can be delivered.");
      return;
    }
    setDeliverTarget({ rows, bulk: true, skipped: selectedRows.length - rows.length });
  }

  function resendRows(selectedRows: readonly ActionableOrder[]) {
    const ids = selectedRows.filter((row) => row.eligibility.canResend).map((row) => row.id);
    if (ids.length === 0) {
      toast.error("None of the selected orders can be resent.");
      return;
    }
    bulkMutation.mutate({ ids, action: "resend" });
  }

  function confirmDeliver({ rows, bulk }: DeliverTarget) {
    if (bulk) bulkMutation.mutate({ ids: rows.map((row) => row.id), action: "deliver" });
    else deliverMutation.mutate(rows[0]!.id);
  }

  function openCancelDialog(ids: number[]) {
    setCancelTarget({ ids });
    setCancelReason("");
  }

  function confirmCancel() {
    if (!cancelTarget) return;
    if (!cancelReason.trim()) {
      toast.error("A cancellation reason is required.");
      return;
    }
    cancelMutation.mutate({ ids: cancelTarget.ids, reason: cancelReason.trim() });
  }

  return {
    deliverPending: deliverMutation.isPending || bulkMutation.isPending,
    bulkMutation,
    cancelMutation,
    resendingIds,
    resendDelivery,
    deliverTarget,
    setDeliverTarget,
    askBulkDeliver,
    confirmDeliver,
    resendRows,
    cancelTarget,
    setCancelTarget,
    cancelReason,
    setCancelReason,
    openCancelDialog,
    confirmCancel,
  };
}
