import * as React from "react"
import { useState, useEffect } from "react"
import type { ReactNode } from "react"
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { SkeletonRow } from "./SkeletonRow"
import { EmptyState } from "./EmptyState"

/** Returns true once mounted on a viewport narrower than `breakpoint` px.
 *  Defaults to false in SSR / test environments (no matchMedia). */
function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    setIsMobile(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);

  return isMobile;
}

interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Optional class applied to each `<td>` in this column. */
  className?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  /** When true, renders skeleton placeholder rows instead of data. */
  isLoading?: boolean;
  /** Number of skeleton rows shown while loading. Default: 5. */
  skeletonRows?: number;
  /** Custom empty-state slot. Falls back to a default message when omitted. */
  empty?: ReactNode;
  keyExtractor: (row: T) => string | number;
  /** Makes rows clickable and applies hover styles. */
  onRowClick?: (row: T) => void;
}

export function DataTable<T>({
  columns,
  data,
  isLoading,
  skeletonRows = 5,
  empty,
  keyExtractor,
  onRowClick,
}: DataTableProps<T>): JSX.Element {
  const isMobile = useIsMobile();
  const emptyNode = empty ?? <EmptyState title="No results found." />

  // Columns with a visible header label are data columns; empty-header
  // columns (action buttons) are rendered in a footer row on mobile cards.
  const dataColumns = columns.filter((col) => col.header !== "")
  const actionColumns = columns.filter((col) => col.header === "")

  if (isMobile) {
    /* ── Mobile: card stack ──────────────────────────────────────────── */
    return (
      <div className="flex flex-col gap-3">
        {isLoading ? (
          Array.from({ length: skeletonRows }).map((_, i) => (
            <div
              key={i}
              className="animate-pulse rounded-lg border border-line bg-card p-4 h-24"
            />
          ))
        ) : data.length === 0 ? (
          emptyNode
        ) : (
          data.map((row) => (
            <div
              key={keyExtractor(row)}
              className={cn(
                "rounded-lg border border-line bg-card p-4",
                onRowClick && "cursor-pointer active:bg-sand"
              )}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {dataColumns.map((col) => (
                <div
                  key={col.key}
                  className="flex items-start justify-between gap-3 py-1.5 border-b border-line last:border-0"
                >
                  <span className="text-xs font-medium text-ink-soft shrink-0 pt-0.5">
                    {col.header}
                  </span>
                  <div className="text-sm text-ink text-right min-w-0">
                    {col.render(row)}
                  </div>
                </div>
              ))}
              {actionColumns.length > 0 && (
                <div className="flex justify-end gap-2 pt-2">
                  {actionColumns.map((col) => (
                    <div key={col.key}>{col.render(row)}</div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    );
  }

  /* ── Desktop: table ─────────────────────────────────────────────── */
  return (
    <div className="w-full max-w-[1100px]">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key}>{col.header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            Array.from({ length: skeletonRows }).map((_, i) => (
              <SkeletonRow key={i} columns={columns.length} />
            ))
          ) : data.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="p-0">
                {emptyNode}
              </TableCell>
            </TableRow>
          ) : (
            data.map((row) => (
              <TableRow
                key={keyExtractor(row)}
                className={cn(onRowClick && "cursor-pointer hover:bg-sand")}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <TableCell key={col.key} className={col.className}>
                    {col.render(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
