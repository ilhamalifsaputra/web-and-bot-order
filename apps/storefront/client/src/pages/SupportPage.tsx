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
import { apiGet, apiPost } from "../api/client";
import type { SupportData } from "../api/types";
import { t } from "../lib/i18n";
import StatusBadge from "../components/shop/StatusBadge";

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

export default function SupportPage() {
  const [message, setMessage] = useState("");
  const { data, error, refetch } = useQuery({
    queryKey: ["account-support"],
    queryFn: () => apiGet<SupportData>("/api/v1/account/support"),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/account/support"));
    }
  }, [error]);

  const createMutation = useMutation({
    mutationFn: (vars: { message: string }) => apiPost<{ ok: boolean }>("/api/v1/account/support", vars),
    onSuccess: () => {
      setMessage("");
      refetch();
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate({ message });
  }

  if (!data) return null;

  return (
    <>
      <h1 className="page-title mb-6">{t("web.account_support")}</h1>

      <form onSubmit={onSubmit} className="card card-pad mb-6">
        <div className="field-label">{t("web.support_new")}</div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          required
          className="field"
          placeholder={t("web.support_placeholder")}
        />
        <div className="mt-3 text-right">
          <button type="submit" className="btn btn-primary btn-sm" disabled={createMutation.isPending}>
            {createMutation.isPending && <Spinner />}
            <Send className="w-3.5 h-3.5" /> {t("web.support_send")}
          </button>
        </div>
      </form>

      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t("web.ticket")}</th>
              <th>{t("web.order_status")}</th>
              <th>{t("web.order_date")}</th>
            </tr>
          </thead>
          <tbody>
            {data.tickets.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-ink-faint">
                  {t("web.no_tickets")}
                </td>
              </tr>
            ) : (
              data.tickets.map((tk) => (
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
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
