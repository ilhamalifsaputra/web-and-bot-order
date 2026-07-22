import { Fragment } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

interface SettingsSearchProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * The Settings page's own instant filter (Settings refinement §1) — visually
 * close to `components/shared/SearchBar.tsx` but a separate component: it
 * filters settings sections/fields/gateways (a different, page-specific
 * target) rather than SearchBar's generic list-of-rows, and it ships
 * `highlightMatch` alongside it for the match-highlighting the brief asks
 * for, which SearchBar has no equivalent of. Purely a controlled input —
 * SettingsPage owns the actual filtering logic.
 */
export function SettingsSearch({ value, onChange }: SettingsSearchProps): JSX.Element {
  return (
    <div className="relative mb-3 w-full">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search settings…"
        aria-label="Search settings"
        className="pl-8"
      />
    </div>
  );
}

/** Renders `text` with every case-insensitive occurrence of `query` wrapped
 * in `<mark>` (Settings refinement §1 "Highlight matching results"). Returns
 * `text` unchanged (still wrapped in a Fragment for a stable return type)
 * when `query` is empty or doesn't occur. */
export function highlightMatch(text: string, query: string): JSX.Element {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: JSX.Element[] = [];
  let cursor = 0;
  let i = lower.indexOf(needle, cursor);
  let key = 0;
  while (i !== -1) {
    if (i > cursor) parts.push(<Fragment key={key++}>{text.slice(cursor, i)}</Fragment>);
    parts.push(
      <mark key={key++} className="rounded-xs bg-pine-tint text-ink">
        {text.slice(i, i + q.length)}
      </mark>,
    );
    cursor = i + q.length;
    i = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(<Fragment key={key++}>{text.slice(cursor)}</Fragment>);
  return <>{parts}</>;
}

/** Case-insensitive substring test — the single matching rule used
 * everywhere search decides visibility (nav links, field rows). */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}
