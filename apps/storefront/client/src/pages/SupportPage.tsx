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
import { apiGet, apiPost, apiPostForm } from "../api/client";
import type { SupportData } from "../api/types";
import { t } from "../lib/i18n";
import StatusBadge from "../components/shop/StatusBadge";
import Toast from "../components/shop/Toast";
import AttachmentPicker from "../components/shop/AttachmentPicker";

/** base.njk's `data-submit-once` double-submit guard, ported: prepended to a
 * submitting button while its mutation is pending (in addition to disabling
 * the button itself). */
function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 mr-1.5 align-[-2px] rounded-full border-2 border-current border-r-transparent animate-spin" />
  );
}

export default function SupportPage() {
  // Pre-filled skeleton so customers know what info to include — they edit
  // it in place rather than starting from a blank box.
  const [message, setMessage] = useState(() => t("web.support_template"));
  const [files, setFiles] = useState<File[]>([]);
  const [toastText, setToastText] = useState<string | null>(null);
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

  // STO-020: submitting a ticket used to just clear the textbox and silently
  // add a table row, with no confirmation at all.
  const createMutation = useMutation({
    mutationFn: (vars: { message: string; files: File[] }) => {
      if (vars.files.length === 0) {
        return apiPost<{ ok: boolean; ticket_id: number | null }>("/api/v1/account/support", {
          message: vars.message,
        });
      }
      const form = new FormData();
      form.append("message", vars.message);
      for (const file of vars.files) form.append("attachments", file);
      return apiPostForm<{ ok: boolean; ticket_id: number | null }>("/api/v1/account/support", form);
    },
    onSuccess: (resp) => {
      setMessage(t("web.support_template"));
      setFiles([]);
      refetch();
      if (resp.ticket_id != null) setToastText(t("web.support_ticket_created", { id: resp.ticket_id }));
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate({ message, files });
  }

  if (!data) return null;

  return (
    <>
      <Toast text={toastText} onDismiss={() => setToastText(null)} kind="success" />
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
        <AttachmentPicker files={files} onChange={setFiles} disabled={createMutation.isPending} />
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
