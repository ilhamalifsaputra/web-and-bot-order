/**
 * TSX port of apps/storefront/views/support.njk. Submitting the new-ticket
 * form posts + refetches (mirroring the old 303-back-to-self flow) and
 * clears the textarea, matching what a full page reload would have done.
 * Markup/classes copied verbatim — no v3→v4 renames apply to this page.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { apiGet, apiPost, apiPostFormWithProgress } from "../api/client";
import type { AccountOrdersData, SupportData } from "../api/types";
import { t } from "../lib/i18n";
import { Inbox } from "lucide-react";
import { useIsDesktop } from "../lib/useMediaQuery";
import EmptyState from "../components/shop/EmptyState";
import ErrorPage from "./ErrorPage";
import Skeleton from "../components/shop/Skeleton";
import Spinner from "../components/shop/Spinner";
import StatusBadge from "../components/shop/StatusBadge";
import Toast from "../components/shop/Toast";
import AttachmentPicker from "../components/shop/AttachmentPicker";
import ProgressBar from "../components/shop/ProgressBar";

const SKELETON_ROWS = Array.from({ length: 3 }, (_, i) => i);

export default function SupportPage() {
  // Pre-filled skeleton so customers know what info to include — they edit
  // it in place rather than starting from a blank box.
  const [message, setMessage] = useState(() => t("web.support_template"));
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [toastText, setToastText] = useState<string | null>(null);
  const [toastKind, setToastKind] = useState<"success" | "error">("success");
  const isDesktop = useIsDesktop();
  const { data, error, refetch } = useQuery({
    queryKey: ["account-support"],
    queryFn: () => apiGet<SupportData>("/api/v1/account/support"),
    retry: false,
  });
  const [orderCode, setOrderCode] = useState("");
  const { data: ordersData } = useQuery({
    queryKey: ["account-orders"],
    queryFn: () => apiGet<AccountOrdersData>("/api/v1/account/orders"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/account/support"));
    }
  }, [error]);

  // STO-020: submitting a ticket used to just clear the textbox and silently
  // add a table row, with no confirmation at all.
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

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setToastKind("success");
    setUploadProgress(0);
    createMutation.mutate({ message, files, orderCode });
  }

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-8 w-48" />
        <Skeleton className="mb-6 h-48 w-full" />
        <div className="space-y-3">
          {SKELETON_ROWS.map((i) => (
            <div key={i} className="card space-y-3 p-4">
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-4 w-16" />
                <Skeleton className="h-5 w-20" />
              </div>
              <Skeleton className="h-4 w-2/3" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <Toast text={toastText} onDismiss={() => setToastText(null)} kind={toastKind} />
      <h1 className="page-title mb-6">{t("web.account_support")}</h1>

      <form onSubmit={onSubmit} className="card card-pad mb-6">
        <div className="field-label">{t("web.support_new")}</div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={6}
          required
          className="field"
          placeholder={t("web.support_placeholder")}
        />
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
        <AttachmentPicker files={files} onChange={setFiles} disabled={createMutation.isPending} />
        {createMutation.isPending && files.length > 0 && (
          <div className="mt-2">
            <ProgressBar value={uploadProgress} />
          </div>
        )}
        <div className="mt-3 text-right">
          <button type="submit" className="btn btn-primary btn-sm" disabled={createMutation.isPending}>
            {createMutation.isPending && <Spinner />}
            <Send className="w-3.5 h-3.5" /> {t("web.support_send")}
          </button>
        </div>
      </form>

      {/* Same treatment as the orders list: cards on a phone, the table from md
          up, one or the other. The ticket form above is already the forward
          action, so the empty state doesn't repeat it as a button. */}
      {data.tickets.length === 0 ? (
        <EmptyState icon={Inbox} title={t("web.no_tickets")} description={t("web.no_tickets_desc")} />
      ) : isDesktop ? (
        <div className="card">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("web.ticket")}</th>
                <th>{t("web.order_status")}</th>
                <th>{t("web.order_date")}</th>
              </tr>
            </thead>
            <tbody>
              {data.tickets.map((tk) => (
                <tr key={tk.id}>
                  <td>
                    <Link to={`/account/support/${tk.id}`} className="link">
                      #{tk.id}
                    </Link>
                    <div className="text-xs text-ink-soft max-w-[20rem] truncate">{tk.message}</div>
                  </td>
                  <td>
                    <StatusBadge value={tk.status} />
                  </td>
                  <td className="text-ink-soft text-xs">{tk.created_at_display}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="space-y-3">
          {data.tickets.map((tk) => (
            <li key={tk.id}>
              <Link
                to={`/account/support/${tk.id}`}
                aria-label={`#${tk.id}`}
                className="card block p-4 transition-colors hover:bg-sand/40"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold text-pine">#{tk.id}</span>
                  <StatusBadge value={tk.status} />
                </div>
                <p className="mt-2 line-clamp-2 text-sm text-ink-soft">{tk.message}</p>
                <p className="mt-3 border-t border-line pt-3 text-xs text-ink-soft">{tk.created_at_display}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
