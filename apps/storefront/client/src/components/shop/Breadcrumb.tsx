/**
 * TSX port of `breadcrumb(crumbs, lang)` in apps/storefront/views/_shop.njk —
 * Home > Category > Product for the product detail page. `items` is a list of
 * {label, href} where the LAST item is the current page (no link). Internal
 * hrefs are SPA routes, so they render as <Link>.
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
    <nav className="text-xs text-ink-faint mb-2 flex items-center flex-wrap gap-x-1" aria-label="breadcrumb">
      {items.map((c, i) => {
        const isLast = i === items.length - 1;
        return (
          <Fragment key={i}>
            {c.href && !isLast ? (
              <Link to={c.href} className="hover:text-pine">
                {c.label}
              </Link>
            ) : (
              <span className="text-ink-soft">{c.label}</span>
            )}
            {!isLast && <span className="mx-0.5">/</span>}
          </Fragment>
        );
      })}
    </nav>
  );
}
