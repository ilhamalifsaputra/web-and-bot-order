/**
 * Two-column support workspace: conversation thread (merged via
 * lib/ticketTimeline.ts) + composer on the left, order/trust/recent-tickets/
 * help sidebar on the right. Collapses to a single column at <1024px via the
 * grid's own responsive class — no separate mobile layout branch needed
 * (unlike OrderDetailPage's item table, nothing here needs a structurally
 * different mobile markup, just a narrower column).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, RotateCcw } from "lucide-react";
import { apiGet, apiPost, apiPostFormWithProgress } from "../api/client";
import type { SupportData, TicketDetailData } from "../api/types";
import { t } from "../lib/i18n";
import { useShopContext } from "../components/Layout";
import { buildTicketTimeline } from "../lib/ticketTimeline";
import { loadTicketDraft, clearTicketDraft } from "../lib/ticketDraft";
import TicketStatusBadge from "../components/shop/TicketStatusBadge";
import TicketMessageThread from "../components/shop/TicketMessageThread";
import TicketComposer from "../components/shop/TicketComposer";
import TicketSidebar from "../components/shop/TicketSidebar";
import EmptyState from "../components/shop/EmptyState";
import ErrorPage from "./ErrorPage";
import Spinner from "../components/shop/Spinner";
import Skeleton from "../components/shop/Skeleton";
import Toast from "../components/shop/Toast";

const QUICK_REPLY_TEMPLATES: Array<{ key: string; labelKey: string; templateKey: string }> = [
  { key: "still_not_working", labelKey: "web.ticket_quick_still_not_working", templateKey: "web.ticket_template_still_not_working" },
  { key: "request_refund", labelKey: "web.ticket_quick_request_refund", templateKey: "web.ticket_template_request_refund" },
  { key: "replace_credentials", labelKey: "web.ticket_quick_replace_credentials", templateKey: "web.ticket_template_replace_credentials" },
];

export default function TicketDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const ticketId = Number(id);
  const { data: ctx } = useShopContext();
  const [message, setMessage] = useState(() => loadTicketDraft(ticketId));
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);

  const { data, error, refetch } = useQuery({
    queryKey: ["account-ticket", id],
    queryFn: () => apiGet<TicketDetailData>(`/api/v1/account/support/${id}`),
    retry: false,
  });
  const { data: ticketList } = useQuery({
    queryKey: ["account-support"],
    queryFn: () => apiGet<SupportData>("/api/v1/account/support"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent(`/account/support/${id}`));
    }
  }, [error, id]);

  const replyMutation = useMutation({
    mutationFn: (vars: { message: string; files: File[] }) => {
      if (vars.files.length === 0) {
        return apiPost<{ ok: boolean }>(`/api/v1/account/support/${id}/reply`, { message: vars.message });
      }
      const form = new FormData();
      form.append("message", vars.message);
      for (const file of vars.files) form.append("attachments", file);
      return apiPostFormWithProgress<{ ok: boolean }>(`/api/v1/account/support/${id}/reply`, form, setUploadProgress);
    },
    onSuccess: () => {
      setMessage("");
      setFiles([]);
      clearTicketDraft(ticketId);
      refetch();
    },
    onError: (err) => setErrorText(t(err instanceof Error ? err.message : "error.generic")),
  });

  const closeMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>(`/api/v1/account/support/${id}/close`, {}),
    onSuccess: () => refetch(),
    onError: (err) => {
      setErrorText(t(err instanceof Error ? err.message : "error.generic"));
      // A 409 here means the ticket was already closed out from under this
      // tap (double-click, or an admin closed it concurrently) — refetch so
      // the page re-renders into the real (closed) state instead of leaving
      // a stale "not yet closed" view up next to the error toast.
      refetch();
    },
  });

  const reopenMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>(`/api/v1/account/support/${id}/reopen`, {}),
    onSuccess: () => refetch(),
    onError: (err) => setErrorText(t(err instanceof Error ? err.message : "error.generic")),
  });

  function submitReply() {
    setErrorText(null);
    setUploadProgress(0);
    replyMutation.mutate({ message, files });
  }

  function applyTemplate(templateKey: string) {
    setMessage((prev) => prev || t(templateKey));
  }

  const timeline = useMemo(() => (data ? buildTicketTimeline(data.ticket, data.messages) : []), [data]);

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label={t("web.loading")}>
        <Skeleton className="mb-6 h-16 w-full" />
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <div className="space-y-3">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-3/4" />
          </div>
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const { ticket, order } = data;
  const telegramSupportUrl = ctx?.bot_username ? `https://t.me/${ctx.bot_username}` : null;
  const hasSupportReplied = data.messages.some((m) => !m.from_user) || Boolean(ticket.admin_reply);

  return (
    <>
      <Toast text={errorText} onDismiss={() => setErrorText(null)} kind="error" />

      <div className="mb-6">
        <div className="text-xs text-ink-faint mb-1">
          <Link to="/account/support" className="hover:text-pine">
            {t("web.account_support")}
          </Link>
          <span className="mx-1">/</span> #{ticket.id}
        </div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="page-title text-2xl!">
            {t("web.ticket")} #{ticket.id}
          </h1>
          <TicketStatusBadge value={ticket.status} />
        </div>
        {order && (
          <p className="mt-1 text-sm text-ink-soft">
            {t("web.ticket_re_order")}{" "}
            <Link to={`/account/orders/${order.code}`} className="link font-mono">
              #{order.code}
            </Link>
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-faint">
          <span>{t("web.ticket_created_at", { date: ticket.created_at_display })}</span>
          {!hasSupportReplied && <span>{t("web.ticket_estimated_reply")}</span>}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div>
          <div className="card card-pad mb-4">
            <TicketMessageThread entries={timeline} />
            {!hasSupportReplied && (
              <div className="mt-4">
                <EmptyState icon={Clock} title={t("web.ticket_waiting_title")} description={t("web.ticket_waiting_desc")} />
              </div>
            )}
          </div>

          {ticket.closed ? (
            <div className="card card-pad flex items-center justify-between gap-3 flex-wrap bg-sand">
              <div className="flex items-center gap-2 text-sm text-ink-soft">
                <CheckCircle2 className="w-4 h-4 text-grass" />
                {ticket.reopenable ? t("web.ticket_closed_reopenable") : t("web.ticket_closed_expired")}
              </div>
              {ticket.reopenable && (
                <button
                  type="button"
                  className="btn btn-soft btn-sm"
                  disabled={reopenMutation.isPending}
                  onClick={() => reopenMutation.mutate()}
                >
                  {reopenMutation.isPending && <Spinner />}
                  <RotateCcw className="w-3.5 h-3.5" /> {t("web.ticket_reopen_btn")}
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                {hasSupportReplied && (
                  <button
                    type="button"
                    className="btn btn-soft btn-sm"
                    disabled={closeMutation.isPending}
                    onClick={() => closeMutation.mutate()}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> {t("web.ticket_quick_issue_solved")}
                  </button>
                )}
                {QUICK_REPLY_TEMPLATES.map((qr) => (
                  <button key={qr.key} type="button" className="btn btn-soft btn-sm" onClick={() => applyTemplate(qr.templateKey)}>
                    {t(qr.labelKey)}
                  </button>
                ))}
              </div>
              <TicketComposer
                ticketId={ticketId}
                message={message}
                onMessageChange={setMessage}
                files={files}
                onFilesChange={setFiles}
                onSubmit={submitReply}
                pending={replyMutation.isPending}
                uploadProgress={uploadProgress}
              />
            </>
          )}
        </div>

        <TicketSidebar
          order={order}
          recentTickets={ticketList?.tickets ?? []}
          currentTicketId={ticket.id}
          telegramSupportUrl={telegramSupportUrl}
        />
      </div>
    </>
  );
}
