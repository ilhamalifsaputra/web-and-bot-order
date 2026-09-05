/**
 * Expandable ticket-conversation panel shown below the /help cards once a
 * ticket row is selected — full inline parity with the standalone
 * /account/support/:id page (thread + reply composer + close/reopen), but
 * as a controlled child: the parent (HelpPage) owns the `?ticket=` URL
 * param and passes `ticketId`/`summary`/`onClose`/`onMutated` down. This
 * component owns only its own fetch + the three mutations.
 *
 * The reply/close/reopen mutation wiring mirrors TicketDetailPage.tsx's
 * own blocks (not imported from there — this panel lives one level below
 * /account/support in the URL tree and is deliberately a separate,
 * self-contained component).
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, ExternalLink, RotateCcw } from "lucide-react";
import { apiGet, apiPost, apiPostFormWithProgress } from "../../api/client";
import type { SupportTicketSummary, TicketDetailData } from "../../api/types";
import { t } from "../../lib/i18n";
import { formatRelativeTime } from "../../lib/formatRelativeTime";
import { buildTicketTimeline } from "../../lib/ticketTimeline";
import { loadTicketDraft, clearTicketDraft } from "../../lib/ticketDraft";
import Button from "../ui/Button";
import TicketStatusBadge from "./TicketStatusBadge";
import TicketMessageThread from "./TicketMessageThread";
import TicketComposer from "./TicketComposer";
import Skeleton from "./Skeleton";
import Spinner from "./Spinner";
import Toast from "./Toast";

const SUBJECT_MAX = 80;

/** First line of `message`, trimmed and clipped to ~80 chars with an
 * ellipsis — same idea as TicketRow.tsx's `firstLine`, kept as a small
 * local helper rather than imported (Task 16's file is a different layer). */
function firstLine(message: string): string {
  const line = (message.split("\n")[0] ?? "").trim();
  return line.length > SUBJECT_MAX ? `${line.slice(0, SUBJECT_MAX).trimEnd()}…` : line;
}

export interface InlineTicketPanelProps {
  ticketId: number;
  /** The selected ticket's list-row summary, if it's in the parent's current
   * list page — supplies subject / order_code / updated_at_iso for the header.
   * When absent (rare: selected ticket not on the current filtered page),
   * the panel derives a subject from the fetched ticket's message first line
   * and omits the relative "last updated" line. */
  summary?: SupportTicketSummary;
  /** Clears the selection (parent removes `?ticket=` and scrolls the list
   * back into view). */
  onClose: () => void;
  /** Called after any mutation that changes ticket state (reply/close/reopen)
   * so the parent can refetch the list + stats. */
  onMutated: () => void;
}

export default function InlineTicketPanel({ ticketId, summary, onClose, onMutated }: InlineTicketPanelProps) {
  const [message, setMessage] = useState(() => loadTicketDraft(ticketId));
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);

  const { data, error, refetch } = useQuery({
    queryKey: ["account-ticket", ticketId],
    queryFn: () => apiGet<TicketDetailData>(`/api/v1/account/support/${ticketId}`),
    retry: false,
  });

  useEffect(() => {
    if ((error as (Error & { status?: number }) | null)?.status === 401) {
      window.location.assign("/login?next=" + encodeURIComponent("/help"));
    }
  }, [error]);

  const replyMutation = useMutation({
    mutationFn: (vars: { message: string; files: File[] }) => {
      if (vars.files.length === 0) {
        return apiPost<{ ok: boolean }>(`/api/v1/account/support/${ticketId}/reply`, { message: vars.message });
      }
      const form = new FormData();
      form.append("message", vars.message);
      for (const file of vars.files) form.append("attachments", file);
      return apiPostFormWithProgress<{ ok: boolean }>(`/api/v1/account/support/${ticketId}/reply`, form, setUploadProgress);
    },
    onSuccess: () => {
      setMessage("");
      setFiles([]);
      clearTicketDraft(ticketId);
      refetch();
      onMutated();
    },
    onError: (err) => setErrorText(t(err instanceof Error ? err.message : "error.generic")),
  });

  const closeMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>(`/api/v1/account/support/${ticketId}/close`, {}),
    onSuccess: () => {
      refetch();
      onMutated();
    },
    onError: (err) => {
      setErrorText(t(err instanceof Error ? err.message : "error.generic"));
      // A 409 here means the ticket was already closed out from under this
      // tap — refetch so the panel re-renders into the real (closed) state
      // instead of leaving a stale "not yet closed" view next to the toast.
      refetch();
    },
  });

  const reopenMutation = useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>(`/api/v1/account/support/${ticketId}/reopen`, {}),
    onSuccess: () => {
      refetch();
      onMutated();
    },
    onError: (err) => setErrorText(t(err instanceof Error ? err.message : "error.generic")),
  });

  function submitReply() {
    setErrorText(null);
    setUploadProgress(0);
    replyMutation.mutate({ message, files });
  }

  const timeline = useMemo(() => (data ? buildTicketTimeline(data.ticket, data.messages) : []), [data]);

  const backLink = (
    <Button variant="ghost" size="sm" onClick={onClose}>
      <ArrowLeft className="w-3.5 h-3.5" /> {t("web.help_back_to_tickets")}
    </Button>
  );

  return (
    // Element-locked: a <section> landmark, and the <Card> primitive renders a
    // <div>. The raw `.card card-pad` classes are the sanctioned usage here —
    // do NOT convert this to <Card>, it would drop the landmark semantics.
    // `enter-rise` (app.css): fade + 8px rise on mount, .15s / --gg-ease, and
    // only under `prefers-reduced-motion: no-preference`. The panel mounts the
    // moment `?ticket=` is set, and HelpPage keys it by ticket id, so switching
    // tickets replays it.
    <section id="inline-ticket-panel" className="card card-pad enter-rise">
      <Toast text={errorText} onDismiss={() => setErrorText(null)} kind="error" />

      <div className="mb-4">{backLink}</div>

      {!data && !error && (
        <div aria-busy="true" aria-label={t("web.loading")} className="space-y-3">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-3/4" />
        </div>
      )}

      {error && (error as Error & { status?: number }).status !== 401 && !data && (
        <p className="text-sm text-ink-soft">{t(error instanceof Error ? error.message : "error.generic")}</p>
      )}

      {data && (
        <>
          <TicketHeader ticketId={ticketId} summary={summary} data={data} />

          <div className="mt-4">
            <TicketMessageThread entries={timeline} />
          </div>

          <TicketActions
            ticketId={ticketId}
            data={data}
            message={message}
            onMessageChange={setMessage}
            files={files}
            onFilesChange={setFiles}
            onSubmit={submitReply}
            replyPending={replyMutation.isPending}
            uploadProgress={uploadProgress}
            closeMutation={closeMutation}
            reopenMutation={reopenMutation}
          />
        </>
      )}
    </section>
  );
}

function TicketHeader({
  ticketId,
  summary,
  data,
}: {
  ticketId: number;
  summary: SupportTicketSummary | undefined;
  data: TicketDetailData;
}) {
  const subject = summary?.subject?.trim() || firstLine(data.ticket.message);
  const orderCode = data.order?.code ?? summary?.order_code;

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-ink">#TK-{ticketId}</span>
          <span className="text-sm text-ink-soft">{subject}</span>
        </div>
        {orderCode && <p className="text-xs text-ink-faint">Order #{orderCode}</p>}
        <Link to={`/account/support/${ticketId}`} className="link text-sm">
          {t("web.help_open_full_ticket")} <ExternalLink className="w-3.5 h-3.5 inline" />
        </Link>
      </div>
      <div className="text-right text-xs text-ink-faint">
        <div>
          <TicketStatusBadge value={data.ticket.status} />
        </div>
        {summary?.updated_at_iso && (
          <p className="mt-1">{t("web.help_ticket_last_updated", { rel: formatRelativeTime(summary.updated_at_iso) })}</p>
        )}
        <p>{t("web.help_ticket_created_on", { date: data.ticket.created_at_display })}</p>
      </div>
    </div>
  );
}

function TicketActions({
  ticketId,
  data,
  message,
  onMessageChange,
  files,
  onFilesChange,
  onSubmit,
  replyPending,
  uploadProgress,
  closeMutation,
  reopenMutation,
}: {
  ticketId: number;
  data: TicketDetailData;
  message: string;
  onMessageChange: (v: string) => void;
  files: File[];
  onFilesChange: (files: File[]) => void;
  onSubmit: () => void;
  replyPending: boolean;
  uploadProgress: number;
  closeMutation: { mutate: () => void; isPending: boolean };
  reopenMutation: { mutate: () => void; isPending: boolean };
}) {
  const { ticket } = data;
  const hasSupportReplied = data.messages.some((m) => !m.from_user) || Boolean(ticket.admin_reply);

  if (ticket.closed) {
    return (
      // L2 nested surface: a recessed sand panel inside the L1 `card card-pad`
      // section above (was a `.card` whose white fill was immediately undone by
      // a `bg-sand` utility — same intent, said once). See app.css `.card-2`.
      <div className="mt-4 card-2 card-pad-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-ink-soft">
          <CheckCircle2 className="w-4 h-4 text-grass" />
          {ticket.reopenable ? t("web.ticket_closed_reopenable") : t("web.ticket_closed_expired")}
        </div>
        {ticket.reopenable && (
          <Button
            variant="soft"
            size="sm"
            disabled={reopenMutation.isPending}
            onClick={() => reopenMutation.mutate()}
          >
            {reopenMutation.isPending && <Spinner />}
            <RotateCcw className="w-3.5 h-3.5" /> {t("web.ticket_reopen_btn")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      {hasSupportReplied && (
        <div className="mt-4">
          <Button
            variant="soft"
            size="sm"
            disabled={closeMutation.isPending}
            onClick={() => closeMutation.mutate()}
          >
            {closeMutation.isPending && <Spinner />}
            <CheckCircle2 className="w-3.5 h-3.5" /> {t("web.ticket_quick_issue_solved")}
          </Button>
        </div>
      )}
      <TicketComposer
        ticketId={ticketId}
        message={message}
        onMessageChange={onMessageChange}
        files={files}
        onFilesChange={onFilesChange}
        onSubmit={onSubmit}
        pending={replyPending}
        uploadProgress={uploadProgress}
      />
    </>
  );
}
