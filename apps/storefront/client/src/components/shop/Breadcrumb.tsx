/**
 * TSX port of `breadcrumb(crumbs, lang)` in apps/storefront/views/_shop.njk —
 * e.g. Home › Category › Product on the detail page, Home › Category on the
 * listing pages. `items` is a list of {label, href} where the LAST item is the
 * current page (no link). Internal hrefs are SPA routes, so they render as
 * <Link>. Styled per components.md "Breadcrumb": 14px, non-current crumbs in
 * `ink-soft`, current page `font-semibold text-ink`, `›` separators `ink-faint`.
 */
import { Fragment } from "react";
import { Link } from "react-router-dom";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[];
}

export default function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav className="text-sm text-ink-soft mb-2 flex items-center flex-wrap gap-x-1" aria-label="breadcrumb">
      {items.map((c, i) => {
        const isLast = i === items.length - 1;
        return (
          <Fragment key={i}>
            {c.href && !isLast ? (
              <Link to={c.href} className="hover:text-pine">
                {c.label}
              </Link>
            ) : (
              <span className={`min-w-0 break-words ${isLast ? "font-semibold text-ink" : "text-ink-soft"}`}>
                {c.label}
              </span>
            )}
            {!isLast && <span className="mx-0.5 text-ink-faint">›</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}
