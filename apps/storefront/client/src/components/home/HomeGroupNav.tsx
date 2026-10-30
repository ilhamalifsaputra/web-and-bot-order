/**
 * The home page's sticky group pill bar: one jump link per product group,
 * stuck under the navbar. A scrollspy marks the group on screen as current
 * (`aria-current`) and, on a narrow screen where the pills overflow, scrolls
 * that pill into view sideways — never the page itself.
 */
import { useEffect, useRef, useState } from "react";
import type { HomeGroup } from "../../api/types";
import { t } from "../../lib/i18n";
import { preferredScrollBehavior } from "../../lib/scrollBehavior";
import { onHomeAnchorClick } from "./homeAnchors";
import { GROUP_NAV_ID, HIDDEN_SCROLLBAR_ROW, groupAnchor, jumpPillClass } from "./homeLayout";

/** A section is "on screen" while it crosses the band from just below the two
 * sticky bars (128px) down to 45% of the viewport. */
const SPY_ROOT_MARGIN = "-128px 0px -55% 0px";

/** The first of `ids` (space-separated, in page order) whose element is in the
 * spy band, or null. No-op where IntersectionObserver is missing (jsdom). */
function useScrollspy(idsKey: string): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver !== "function") return;
    const ids = idsKey.split(" ");
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        setActive(ids.find((id) => visible.has(id)) ?? null);
      },
      { rootMargin: SPY_ROOT_MARGIN },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [idsKey]);
  return active;
}

export default function HomeGroupNav({ groups }: { groups: readonly HomeGroup[] }) {
  const active = useScrollspy(groups.map((g) => groupAnchor(g.slug)).join(" "));
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Keep the current pill visible when the row overflows (phones). Only the
  // row scrolls horizontally; scrollIntoView could also nudge the page.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!active || !scroller || typeof scroller.scrollTo !== "function") return;
    const pill = scroller.querySelector<HTMLElement>(`a[href="#${active}"]`);
    if (!pill) return;
    const left = pill.offsetLeft - (scroller.clientWidth - pill.offsetWidth) / 2;
    scroller.scrollTo({ left: Math.max(0, left), behavior: preferredScrollBehavior() });
  }, [active]);

  const label = t("web.group_nav_label");
  return (
    <div
      id={GROUP_NAV_ID}
      className="sticky top-16 z-20 -mx-4 scroll-mt-16 border-b border-line bg-paper/95 px-4 py-2 backdrop-blur-sm lg:-mx-6 lg:px-6"
    >
      <nav aria-label={label}>
        <div ref={scrollerRef} className={`relative ${HIDDEN_SCROLLBAR_ROW}`}>
          {groups.map((g) => {
            const id = groupAnchor(g.slug);
            const isActive = active === id;
            return (
              <a key={g.key} href={`#${id}`} onClick={(e) => onHomeAnchorClick(e, id)} aria-current={isActive ? "true" : undefined} className={jumpPillClass(isActive)}>
                {`${g.emoji} ${t(g.label_key)}`}
              </a>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
