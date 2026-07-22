import { useEffect, useRef, useState } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DURATION } from "@/lib/motion";

export interface SettingsNavLink {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Search-filtered visibility (Settings refinement §1) — computed by the
   * page (it knows each section's fields), not derived here. */
  visible: boolean;
}

export interface SettingsNavGroup {
  label: string;
  icon: LucideIcon;
  links: SettingsNavLink[];
}

interface SettingsNavProps {
  topLinks: SettingsNavLink[];
  /** The one collapsible group — Payment Gateways. Every other group in this
   * nav is a flat, always-expanded list of links; see
   * docs/ui/06_SETTINGS_GUIDELINES.md §1 for why only this group collapses. */
  group: SettingsNavGroup | null;
  bottomLinks: SettingsNavLink[];
}

const EXPANDED_STORAGE_KEY = "settings-nav-pay-expanded";
const NAV_LINK_CLASS =
  "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-sand hover:text-ink";
const NAV_LINK_ACTIVE_CLASS = "bg-pine-tint text-pine hover:bg-pine-tint hover:text-pine";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Reads/writes are wrapped defensively — private-browsing modes in some
 * browsers throw on `localStorage` access rather than leaving it undefined,
 * and some test/SSR environments have no `localStorage` at all. Either way,
 * the group simply falls back to its default (expanded) state. */
function readExpandedStorage(): boolean | null {
  try {
    const stored = window.localStorage?.getItem(EXPANDED_STORAGE_KEY);
    return stored === null || stored === undefined ? null : stored === "true";
  } catch {
    return null;
  }
}

function writeExpandedStorage(value: boolean): void {
  try {
    window.localStorage?.setItem(EXPANDED_STORAGE_KEY, String(value));
  } catch {
    // Ignore — nothing to persist to in this environment.
  }
}

/**
 * The Settings jump-nav (docs/ui/06_SETTINGS_GUIDELINES.md §1), extracted
 * from SettingsPage.tsx and extended with scrollspy active-section
 * highlighting and a single collapsible group (Settings refinement §2–3).
 * Sticky behavior and the mobile horizontal-scroll variant are unchanged
 * from the original inline nav — only data-driven now instead of hand-written
 * per section.
 */
export function SettingsNav({ topLinks, group, bottomLinks }: SettingsNavProps): JSX.Element {
  const [expanded, setExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const stored = readExpandedStorage();
    return stored ?? true;
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const linkRefs = useRef<Map<string, HTMLAnchorElement>>(new Map());

  const allLinks = [...topLinks, ...(group?.links ?? []), ...bottomLinks].filter((l) => l.visible);
  const allLinkIds = allLinks.map((l) => l.id).join(",");

  useEffect(() => {
    // Not implemented in some test/SSR environments — scrollspy simply stays
    // inactive there rather than crashing (a real browser always has this).
    if (allLinks.length === 0 || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost section whose heading has crossed just below the
        // sticky nav counts as "active" — matches the classic scrollspy
        // rootMargin trick (shrink the bottom so only the top strip counts).
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        const topMost = visible.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b));
        setActiveId(topMost.target.id);
      },
      { rootMargin: "-64px 0px -70% 0px", threshold: 0 },
    );
    for (const link of allLinks) {
      const el = document.getElementById(link.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLinkIds]);

  useEffect(() => {
    if (!activeId) return;
    const el = linkRefs.current.get(activeId);
    el?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeId]);

  function toggleExpanded() {
    setExpanded((prev) => {
      const next = !prev;
      writeExpandedStorage(next);
      return next;
    });
  }

  function renderLink(link: SettingsNavLink, opts: { indent?: boolean; collapsedOnDesktop?: boolean } = {}) {
    if (!link.visible) return null;
    const Icon = link.icon;
    const active = activeId === link.id;
    return (
      <a
        key={link.id}
        ref={(el) => {
          if (el) linkRefs.current.set(link.id, el);
          else linkRefs.current.delete(link.id);
        }}
        href={`#${link.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          NAV_LINK_CLASS,
          opts.indent && "lg:pl-6",
          // Collapse is a desktop-only nav-scan convenience — the group
          // never collapses on the mobile/tablet horizontal-scroll bar,
          // where there's no vertical list to shorten.
          opts.collapsedOnDesktop && "lg:hidden",
          active && NAV_LINK_ACTIVE_CLASS,
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {link.label}
      </a>
    );
  }

  const visibleGroupLinks = group?.links.filter((l) => l.visible) ?? [];

  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-0 z-10 -mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-line bg-paper px-4 py-2 sm:-mx-5 sm:px-5 lg:sticky lg:top-4 lg:z-auto lg:mx-0 lg:mb-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:border-0 lg:bg-transparent lg:px-0 lg:py-0"
    >
      {topLinks.map((l) => renderLink(l))}

      {group && visibleGroupLinks.length > 0 && (
        <>
          {/* Desktop-only collapse toggle for the group label. */}
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            className="hidden min-h-[44px] items-center gap-2 px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-ink-soft hover:text-ink lg:flex lg:min-h-0"
          >
            <group.icon className="h-4 w-4" />
            {group.label}
            <ChevronDown
              className="h-3.5 w-3.5 transition-transform"
              style={{
                transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
                transitionDuration: `${DURATION.fast}s`,
              }}
              aria-hidden="true"
            />
          </button>
          {/* Mobile/tablet label — same group, no collapse control. */}
          <div className="flex items-center gap-2 px-3 text-xs font-semibold uppercase tracking-wider text-ink-soft lg:hidden">
            <group.icon className="h-4 w-4" />
            {group.label}
          </div>
          {visibleGroupLinks.map((l) => renderLink(l, { indent: true, collapsedOnDesktop: !expanded }))}
        </>
      )}

      {bottomLinks.map((l) => renderLink(l))}
    </nav>
  );
}
