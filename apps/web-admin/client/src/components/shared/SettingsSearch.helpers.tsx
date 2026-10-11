import { Fragment } from "react";

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
