/**
 * Right-column "My tickets" card of the /help page.
 *
 * Fully controlled: the parent (HelpPage, a later task) owns the query state
 * — status filter, search text, sort, page, and the selected ticket — plus
 * all data fetching and debouncing. This card renders the toolbar, the
 * status-filter pills, the list (a `.data-table` on desktop, a stack of cards
 * on a phone — one or the other, per useIsDesktop, matching OrdersPage /
 * SupportPage), and the pager footer, and calls the `on*Change` /
 * `onSelectTicket` callbacks. It never fetches.
 *
 * DATE column: shows `created_at_display` as-is (option (a) from the task
 * brief) — it is the "YYYY-MM-DD HH:mm" shop-timezone string the server
 * already formats and that the rest of the site displays; the only ISO field
 * on the row is `updated_at_iso` ("last update", not "created"), so the
 * mockup's friendlier "Sep 3, 2025" form would need a backend change.
 */
import { FileText, Inbox, Search } from "lucide-react";
import { t } from "../../lib/i18n";
import { useIsDesktop } from "../../lib/useMediaQuery";
import type { SupportTicketSummary, SupportTicketStats } from "../../api/types";
import EmptyState from "./EmptyState";
import Skeleton from "./Skeleton";
import TicketStatusFilterPills, { type TicketStatusFilterKey } from "./TicketStatusFilterPills";
import TicketListFooter from "./TicketListFooter";
import { TicketTableRow, TicketCard } from "./TicketRow";

export type TicketSortKey = "latest_update" | "created_desc" | "created_asc";

const SORT_OPTIONS: { value: TicketSortKey; labelKey: string }[] = [
  { value: "latest_update", labelKey: "web.help_sort_latest" },
  { value: "created_desc", labelKey: "web.help_sort_created_new" },
  { value: "created_asc", labelKey: "web.help_sort_created_old" },
];

export interface MyTicketsCardProps {
  tickets: SupportTicketSummary[];
  stats: SupportTicketStats;
  total: number;
  page: number;
  pageSize: number;
  statusFilter: TicketStatusFilterKey;
  sort: TicketSortKey;
  search: string;
  isLoading?: boolean;
  selectedTicketId: number | null;
  onStatusFilterChange: (key: TicketStatusFilterKey) => void;
  onSortChange: (sort: TicketSortKey) => void;
  onSearchChange: (value: string) => void;
  onPageChange: (page: number) => void;
  onSelectTicket: (id: number) => void;
}

const SKELETON_ROWS = Array.from({ length: 3 }, (_, i) => i);

export default function MyTicketsCard({
  tickets,
  stats,
  total,
  page,
  pageSize,
  statusFilter,
  sort,
  search,
  isLoading = false,
  selectedTicketId,
  onStatusFilterChange,
  onSortChange,
  onSearchChange,
  onPageChange,
  onSelectTicket,
}: MyTicketsCardProps) {
  const isDesktop = useIsDesktop();

  return (
    // min-w-0: this section IS the grid item in HelpPage.tsx's lg:grid-cols-2
    // track (repeat(2, minmax(0, 1fr))). A grid item's automatic minimum size
    // defaults to its content's min-content width unless the item's own
    // min-width is overridden — without this, the table's ~837px intrinsic
    // width (6 columns) beat the track's minmax(0, ...) floor and grew this
    // card past its 1fr share regardless of the table's own overflow-x-auto
    // wrapper below (that wrapper only ever gets a chance to scroll once
    // ITS parent's width is actually constrained). The page's outer
    // overflow-x-clip then silently clipped — not scrolled — whatever still
    // didn't fit, hiding the DATE column entirely instead of offering a way
    // to reach it.
    <section className="card card-pad min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-pine" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-ink">{t("web.help_my_tickets")}</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
              aria-hidden="true"
            />
            <input
              type="search"
              className="field !min-h-0 h-9 w-40 !pl-8 text-sm sm:w-52"
              placeholder={t("web.help_search_tickets")}
              aria-label={t("web.help_search_tickets")}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
          <select
            className="field !min-h-0 h-9 w-auto text-sm"
            value={sort}
            aria-label={t("web.sort_label")}
            onChange={(e) => onSortChange(e.target.value as TicketSortKey)}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {t(opt.labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4">
        <TicketStatusFilterPills active={statusFilter} counts={stats} onChange={onStatusFilterChange} />
      </div>

      <div className="mt-4">
        {isLoading ? (
          <div className="space-y-3" aria-busy="true" aria-label={t("web.loading")}>
            {SKELETON_ROWS.map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : tickets.length === 0 ? (
          <EmptyState
            bare
            icon={Inbox}
            title={t("web.no_tickets")}
            description={t("web.no_tickets_desc")}
          />
        ) : isDesktop ? (
          // This card sits in a two-column grid (~650px available, not the
          // ~1100px a full-width page gives OrdersPage/SupportPage's own
          // data-table) — six columns don't comfortably fit that budget, so
          // unlike those pages this one needs its own scroll boundary: without
          // it, the table's min-content width forces the grid track (and the
          // page) wider instead of scrolling in place.
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th scope="col">{t("web.help_col_ticket")}</th>
                  <th scope="col">{t("web.help_col_subject")}</th>
                  <th scope="col">{t("web.help_col_status")}</th>
                  <th scope="col">{t("web.help_col_last_update")}</th>
                  <th scope="col">{t("web.help_col_date")}</th>
                  <th aria-hidden="true" />
                </tr>
              </thead>
              <tbody>
                {tickets.map((ticket) => (
                  <TicketTableRow
                    key={ticket.id}
                    ticket={ticket}
                    onSelect={onSelectTicket}
                    selected={ticket.id === selectedTicketId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ul className="space-y-3">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <TicketCard
                  ticket={ticket}
                  onSelect={onSelectTicket}
                  selected={ticket.id === selectedTicketId}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {!isLoading && (tickets.length > 0 || page > 1) && (
        <TicketListFooter page={page} pageSize={pageSize} total={total} onPageChange={onPageChange} />
      )}
    </section>
  );
}
