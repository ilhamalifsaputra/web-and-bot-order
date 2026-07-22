import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

interface PaginationProps {
  /** 1-indexed. */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** Omit to hide the page-size control entirely. */
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

/** Min click-target size for the accessibility requirement — bigger than
 *  the `sm`/`icon-sm` Button sizes' own dimensions, so applied explicitly. */
const TAP_TARGET = "min-w-[44px] min-h-[44px]"

/**
 * Windows the page-number control to first, last, and current±2, with an
 * "ellipsis" marker filling any gap — e.g. page=7 of 20 becomes
 * `1 … 5 6 [7] 8 9 … 20`.
 */
function buildPageWindow(page: number, totalPages: number): (number | "ellipsis")[] {
  const pages = new Set<number>([1, totalPages]);
  for (let p = page - 2; p <= page + 2; p++) {
    if (p >= 1 && p <= totalPages) pages.add(p);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  const result: (number | "ellipsis")[] = [];
  let prev: number | null = null;
  for (const p of sorted) {
    if (prev !== null && p - prev > 1) result.push("ellipsis");
    result.push(p);
    prev = p;
  }
  return result;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100],
}: PaginationProps): JSX.Element {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  const hasPrev = page > 1;
  const hasNext = page * pageSize < total;
  const pageWindow = buildPageWindow(page, totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-ink-soft">
        {total === 0 ? "No results" : `Showing ${start}–${end} of ${total}`}
      </p>

      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon-sm"
          className={TAP_TARGET}
          aria-label="Previous page"
          disabled={!hasPrev}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        {pageWindow.map((entry, i) =>
          entry === "ellipsis" ? (
            <span key={`ellipsis-${i}`} className="px-1 text-sm text-ink-faint" aria-hidden="true">
              …
            </span>
          ) : (
            <Button
              key={entry}
              variant={entry === page ? "default" : "outline"}
              size="sm"
              className={cn(TAP_TARGET)}
              aria-label={`Go to page ${entry}`}
              aria-current={entry === page ? "page" : undefined}
              onClick={() => onPageChange(entry)}
            >
              {entry}
            </Button>
          )
        )}

        <Button
          variant="outline"
          size="icon-sm"
          className={TAP_TARGET}
          aria-label="Next page"
          disabled={!hasNext}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {onPageSizeChange && (
        <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
          <SelectTrigger className="w-28" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {pageSizeOptions.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} / page
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}
