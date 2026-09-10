/**
 * Compact "your data is safe" reassurance strip, shown inside NewTicketCard
 * beside the submit button. Deliberately understated — a light pine tint, a
 * small shield glyph in a white circle, no bright fill and no oversized icon
 * (project constraint) — it is reassurance, not a callout.
 *
 * Standalone and prop-less so a later task can reuse it elsewhere.
 */
import { ShieldCheck } from "lucide-react";
import { t } from "../../lib/i18n";

export default function DataSafetyNotice() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-pine/20 bg-pine-tint p-3 sm:p-4">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-card text-pine">
        <ShieldCheck className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="font-semibold text-ink text-sm">{t("web.support_safety_title")}</p>
        <p className="text-xs text-ink-soft">{t("web.support_safety_body")}</p>
      </div>
    </div>
  );
}
