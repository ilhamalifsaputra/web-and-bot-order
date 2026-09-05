/**
 * Footer for the /help "My tickets" list: a "Showing x–y of n" summary on the
 * left and a minimal pager on the right (prev arrow · current page · next
 * arrow — not a full page-number strip, matching the mockup).
 *
 * Controlled: the parent owns `page` and refetches on `onPageChange`. The
 * summary line always renders (it reads fine even for a single page, or zero
 * tickets); only the pager hides itself when there is a single page.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "../../lib/i18n";

export interface TicketListFooterProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export default function TicketListFooter({ page, pageSize, total, onPageChange }: TicketListFooterProps) {
  // Out-of-range (a stale bookmark, or switching filters while parked on a
  // later page — see pageCount's own comment below): (page-1)*pageSize can
  // land past `total` entirely, which would otherwise render nonsense like
  // "Showing 41–3 of 3 tickets". Read as "no rows on this page" instead,
  // same as the total===0 case.
  const isPageInRange = total > 0 && (page - 1) * pageSize < total;
  const from = isPageInRange ? (page - 1) * pageSize + 1 : 0;
  const to = isPageInRange ? Math.min(page * pageSize, total) : 0;
  // Also folds in `page` itself (not just total/pageSize): a shareable URL
  // can carry a `page` beyond what the current filter/search actually has
  // (e.g. a stale bookmark, or switching filters while parked on page 5).
  // Without this, an out-of-range page whose filter only has one real page
  // of results would compute pageCount=1 and hide the prev/next controls
  // entirely, stranding the buyer with no in-page way back to page 1.
  const pageCount = Math.max(1, Math.ceil(total / pageSize), page);

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
      <p className="text-xs text-ink-soft">{t("web.help_showing_range", { from, to, total })}</p>

      {pageCount > 1 && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t("web.help_pager_prev")}
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className="grid h-8 w-8 place-items-center rounded-full border border-line text-ink-soft transition-colors hover:bg-sand disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="grid h-8 min-w-8 place-items-center rounded-full bg-pine px-2 text-xs font-semibold text-white">
            {page}
          </span>
          <button
            type="button"
            aria-label={t("web.help_pager_next")}
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
            className="grid h-8 w-8 place-items-center rounded-full border border-line text-ink-soft transition-colors hover:bg-sand disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
