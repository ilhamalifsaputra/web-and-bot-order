import * as React from "react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"

interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  breadcrumb?: { label: string; href?: string }[];
  actions?: ReactNode;
}

export function PageHeader({ title, description, breadcrumb, actions }: PageHeaderProps): JSX.Element {
  return (
    <div className="mb-6">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav className="mb-1 flex items-center gap-1 text-xs text-ink-soft">
          {breadcrumb.map((crumb, i) => (
            <React.Fragment key={i}>
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
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">
            {title}
          </h1>
          {description && (
            <p className="mt-0.5 text-sm text-ink-soft">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  )
}
