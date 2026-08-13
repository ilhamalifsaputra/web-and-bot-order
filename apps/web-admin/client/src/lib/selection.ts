/** The part of a page-owned row selection that is still on screen.
 *
 *  Selection is keyed by row id and is only cleared when filters or the page
 *  change, so a row that leaves the result set some other way — a refetch, a
 *  poll, another admin acting on it — would otherwise keep counting toward the
 *  bulk bar and stay reachable by the bulk handlers. Rather than trying to keep
 *  the state in sync with the rows, derive the usable selection from the rows
 *  actually rendered: an off-screen id then cannot be in it by construction.
 *
 *  Iterates `rows`, so the result is in row order — bulk payloads stay stable
 *  regardless of the order the admin clicked the checkboxes in.
 *
 *  Pass the rows the page actually offers a checkbox for, which is not always
 *  every row it renders (PaymentsPage only lets unmatched Binance transfers be
 *  selected, StockProductPage only the active tab's items). */
export function visibleSelection<T>(
  selected: ReadonlySet<number>,
  rows: readonly T[],
  getId: (row: T) => number,
): Set<number> {
  const visible = new Set<number>();
  if (selected.size === 0) return visible;
  for (const row of rows) {
    const id = getId(row);
    if (selected.has(id)) visible.add(id);
  }
  return visible;
}
