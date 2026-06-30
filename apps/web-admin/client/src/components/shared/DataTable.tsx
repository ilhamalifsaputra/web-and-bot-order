import * as React from "react"
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
  return (
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
              {empty ?? <EmptyState title="No results found." />}
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
  )
}
