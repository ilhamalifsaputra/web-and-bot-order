

/** The exact wording `StatusBadge` renders for a raw code. Exported so a
 *  filter dropdown can label its options identically to the badges in the
 *  rows it filters, instead of title-casing the same codes a second time. */
export function statusLabel(status: string): string {
  return titleCase(status);
}

export function titleCase(status: string): string {
  return status
    .toLowerCase()
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
