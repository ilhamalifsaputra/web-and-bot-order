import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import * as React from "react";
import { Link } from "react-router-dom";

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  breadcrumb?: { label: string; href?: string }[];
  actions?: ReactNode;
}

export function PageHeader({ title, description, breadcrumb, actions }: PageHeaderProps): JSX.Element {
  return (
    <div className="mb-6 sm:mb-8">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-2 flex flex-wrap items-center gap-1 text-xs text-ink-soft">
          {breadcrumb.map((crumb, i) => (
            <React.Fragment key={crumb.href ?? "current"}>
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-ink-faint" />}
              {crumb.href ? (
                <Link
                  to={crumb.href}
                  className="transition-colors hover:text-ink-soft"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span>{crumb.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold leading-tight tracking-tight text-ink sm:text-3xl">
            {title}
          </h1>
          {description && (
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  )
}
