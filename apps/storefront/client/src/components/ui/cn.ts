/**
 * Tiny class-name joiner — the storefront has no `clsx` / `tailwind-merge`
 * and this task must not add one. Drops falsy entries so callers can write
 * `cn("btn", cond && "btn-sm", className)` without stray spaces or the
 * literal strings "false" / "undefined" leaking into `class`.
 *
 * It does NOT de-duplicate or resolve Tailwind conflicts (no `tailwind-merge`);
 * order the arguments so the caller's `className` comes last and wins by
 * source order where it matters.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
