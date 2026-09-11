/**
 * Spinner — a small inline "working…" ring, prepended to a submitting button
 * while its mutation is pending (in addition to disabling the button).
 *
 * Promoted from `components/shop/` to `components/ui/` in Fase 6 as a
 * business-agnostic primitive; `components/shop/Spinner.tsx` re-exports this.
 *
 * The optical baseline nudge uses `-0.125em` (the same value app.css's
 * `svg.lucide` rule uses) rather than the old hard-coded `-2px`, so it tracks
 * font size and clears the ESLint gate's px ban without an allowlist entry.
 */
export default function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="mr-1.5 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent align-[-0.125em]"
    />
  );
}
