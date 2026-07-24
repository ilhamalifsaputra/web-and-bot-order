/** Renders a merged ticket timeline (see lib/ticketTimeline.ts) as chat
 * bubbles: customer right-aligned/tinted, support left-aligned/neutral,
 * system events centered. Groups consecutive entries under a date divider
 * ("Today"/"Yesterday" when the entry's date matches the browser's local
 * date — an intentional approximation near a midnight boundary versus the
 * shop's own timezone; this is display grouping only, not business logic). */
import { PlusCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { t } from "../../lib/i18n";
import AttachmentGallery from "./AttachmentGallery";
import type { TicketTimelineEntry } from "../../lib/ticketTimeline";

const SYSTEM_ICON: Record<string, LucideIcon> = {
  created: PlusCircle,
  closed: CheckCircle2,
};

function dateGroupLabel(datePart: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (datePart === toKey(now)) return t("web.date_today");
  if (datePart === toKey(yesterday)) return t("web.date_yesterday");
  return datePart;
}

export default function TicketMessageThread({ entries }: { entries: TicketTimelineEntry[] }) {
  let lastDateKey = "";
  return (
    <div className="space-y-3">
      {entries.map((entry, idx) => {
        const datePart = entry.created_at_display.slice(0, 10);
        const timePart = entry.created_at_display.slice(11);
        const showDivider = datePart !== lastDateKey;
        lastDateKey = datePart;
        return (
          <div key={idx}>
            {showDivider && (
              <div className="my-4 flex items-center gap-3 text-xs font-semibold text-ink-faint">
                <span className="h-px flex-1 bg-line" /> {dateGroupLabel(datePart)} <span className="h-px flex-1 bg-line" />
              </div>
            )}
            {entry.kind === "system" ? (
              <SystemEventRow entry={entry} timePart={timePart} />
            ) : (
              <MessageBubble entry={entry} timePart={timePart} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SystemEventRow({ entry, timePart }: { entry: Extract<TicketTimelineEntry, { kind: "system" }>; timePart: string }) {
  const Icon = SYSTEM_ICON[entry.key] ?? PlusCircle;
  return (
    <div className="flex items-center justify-center gap-1.5 text-xs text-ink-faint">
      <Icon className="w-3.5 h-3.5" /> <span>{t(entry.labelKey)}</span> · {timePart}
    </div>
  );
}

function MessageBubble({
  entry,
  timePart,
}: {
  entry: Extract<TicketTimelineEntry, { kind: "message" }>;
  timePart: string;
}) {
  const senderLabel = entry.from_user ? t("web.ticket_sender_you") : t("web.ticket_sender_support");
  return (
    <div className={`card card-pad max-w-lg ${entry.from_user ? "ml-auto bg-pine-tint/30" : "mr-auto"}`}>
      <div className="mb-1 flex items-center gap-2 text-xs text-ink-faint">
        <span
          className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
            entry.from_user ? "bg-pine text-white" : "bg-sand text-ink-soft"
          }`}
        >
          {senderLabel.charAt(0).toUpperCase()}
        </span>
        <span className="font-semibold text-ink-soft">{senderLabel}</span>
        <span className="ml-auto" title={entry.created_at_display}>
          {timePart}
        </span>
      </div>
      <p className="text-sm whitespace-pre-line">{entry.content}</p>
      <AttachmentGallery urls={entry.attachments} />
    </div>
  );
}
