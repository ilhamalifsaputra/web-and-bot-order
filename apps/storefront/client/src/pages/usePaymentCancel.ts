import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiPost } from "../api/client";

/** POST .../cancel. `cancelled` is absent from an older server during rollout,
 * which keeps that server's meaning: any success counted as cancelled. */
export type CancelResult = { ok: boolean; cancelled?: boolean };

/** Cancelling from the pay page: the confirm dialog, the request, and what the
 * buyer is told when it did not end the record. */
export function usePaymentCancel({ apiBase, code, isTopup, productSlug, retryHref }: {
  apiBase: string;
  code: string;
  isTopup: boolean;
  productSlug: string | null | undefined;
  retryHref: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // The one logic addition Task 14 makes: the cancel button no longer fires
  // cancelMutation directly (Global Constraints / Task 1 audit §F item 3) —
  // it opens this dialog first. onConfirm in PayPage calls the exact same
  // mutate() call the old onClick did.
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  // A cancel that did not end the record leaves the page standing: the payment
  // may have landed, so the buyer is shown the real state rather than sent off
  // to buy again. Both reads matter: the big card ignores a polled `expired`
  // until /pay itself says so. A session that went stale is caught by the /pay
  // read's own 401 redirect (usePaymentStatus).
  const stayAndReread = () => {
    setCancelDialogOpen(false);
    void queryClient.refetchQueries({ queryKey: ["pay", apiBase, code], exact: true });
    void queryClient.refetchQueries({ queryKey: ["pay-status", apiBase, code], exact: true });
  };

  const cancelMutation = useMutation({
    mutationFn: () => apiPost<CancelResult>(`/api/v1${apiBase}/${code}/cancel`, {}),
    onError: stayAndReread,
    onSuccess: ({ cancelled }) => {
      if (cancelled === false) {
        stayAndReread();
        return;
      }
      // Retire the payable invoice snapshots; revisiting must read the backend
      // rather than briefly offering the cancelled invoice again.
      queryClient.removeQueries({ queryKey: ["pay", apiBase, code], exact: true });
      queryClient.removeQueries({ queryKey: ["pay-status", apiBase, code], exact: true });
      if (!isTopup) {
        void queryClient.invalidateQueries({ queryKey: ["account-order", code] });
        void queryClient.invalidateQueries({ queryKey: ["account-orders"] });
        void queryClient.invalidateQueries({ queryKey: ["account-orders-preview"] });
        if (productSlug) {
          void queryClient.invalidateQueries({ queryKey: ["product", productSlug] });
        }
      }
      navigate(retryHref);
    },
  });

  // Derived from the mutation, so a new attempt clears the last outcome.
  const cancelNoticeKey = cancelMutation.isError
    ? (isTopup ? "web.cancel_topup_unknown" : "web.cancel_order_unknown")
    : cancelMutation.data?.cancelled === false
      ? (isTopup ? "web.cancel_topup_status_changed" : "web.cancel_order_status_changed")
      : null;

  return { cancelMutation, cancelDialogOpen, setCancelDialogOpen, cancelNoticeKey };
}
