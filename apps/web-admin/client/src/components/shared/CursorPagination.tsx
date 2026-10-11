import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../ui/button";
/** Pagination for endpoints that return a next-page flag without a total count. */
export function CursorPagination({ page, hasNext, onPageChange }: { page: number; hasNext: boolean; onPageChange: (page: number) => void }) {
  return <div className="flex items-center gap-2">
    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}><ChevronLeft className="h-4 w-4" />Prev</Button>
    <span className="text-sm text-ink-soft">Page {page}</span>
    <Button variant="outline" size="sm" disabled={!hasNext} onClick={() => onPageChange(page + 1)}>Next<ChevronRight className="h-4 w-4" /></Button>
  </div>;
}
