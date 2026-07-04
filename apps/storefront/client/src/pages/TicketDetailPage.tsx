/**
 * TSX port of apps/storefront/views/ticket_detail.njk. The reply form is
 * gated on `!ticket.closed`, same as the template. Markup/classes copied
 * verbatim apart from the mechanical Tailwind v3→v4 rename
 * (docs/REACT_STOREFRONT_MIGRATION.md): `!text-2xl` → `text-2xl!`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { apiGet, apiPost } from "../api/client";
import type { TicketDetailData } from "../api/types";
import { t } from "../lib/i18n";
import StatusBadge from "../components/shop/StatusBadge";
import ErrorPage from "./ErrorPage";

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

export default function TicketDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [message, setMessage] = useState("");
  const { data, error, refetch } = useQuery({
    queryKey: ["account-ticket", id],
    queryFn: () => apiGet<TicketDetailData>(`/api/v1/account/support/${id}`),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent(`/account/support/${id}`));
    }
  }, [error, id]);

  const replyMutation = useMutation({
    mutationFn: (vars: { message: string }) => apiPost<{ ok: boolean }>(`/api/v1/account/support/${id}/reply`, vars),
    onSuccess: () => {
      setMessage("");
      refetch();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    replyMutation.mutate({ message });
  }

  if (error) {
    if ((error as Error & { status?: number }).status === 404) return <ErrorPage />;
    return null;
  }
  if (!data) return null;

  const { ticket, messages } = data;

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs text-ink-faint mb-1">
            <Link to="/account/support" className="hover:text-pine">
              {t("web.account_support")}
            </Link>
            <span className="mx-1">/</span> #{ticket.id}
          </div>
          <h1 className="page-title text-2xl!">
            {t("web.ticket")} #{ticket.id}
          </h1>
        </div>
        <StatusBadge value={ticket.status} />
      </div>

      <div className="space-y-3 max-w-2xl">
        <div className="card card-pad">
          <div className="text-xs text-ink-faint mb-1">{ticket.created_at_display}</div>
          <p className="text-sm whitespace-pre-line">{ticket.message}</p>
        </div>
        {ticket.admin_reply && (
          <div className="card card-pad bg-pine-tint/40 ml-6">
            <div className="text-xs text-pine-dark font-semibold mb-1">{t("web.account_support")}</div>
            <p className="text-sm whitespace-pre-line">{ticket.admin_reply}</p>
          </div>
        )}
        {messages.map((m, idx) => (
          <div key={idx} className={`card card-pad ${!m.from_user ? "bg-pine-tint/40 ml-6" : "mr-6"}`}>
            <div className="text-xs text-ink-faint mb-1">{m.created_at_display}</div>
            <p className="text-sm whitespace-pre-line">{m.content}</p>
          </div>
        ))}
      </div>

      {!ticket.closed && (
        <form onSubmit={onSubmit} className="card card-pad mt-5 max-w-2xl">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={2}
            required
            className="field"
            placeholder={t("web.support_placeholder")}
          />
          <div className="mt-3 text-right">
            <button type="submit" className="btn btn-primary btn-sm" disabled={replyMutation.isPending}>
              {replyMutation.isPending && <Spinner />}
              <Send className="w-3.5 h-3.5" /> {t("web.support_reply")}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
