/**
 * Product description with a mobile-only "read more" toggle.
 *
 * Below `md` the text is clamped to three lines so a long description cannot
 * push the plan / denomination picker far down the page; the toggle appears
 * only when the clamped text is really cut off. From `md` up the text is never
 * clamped and the toggle is hidden. Expanded state is local; the parent keys
 * this component by the text so a different description starts collapsed.
 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";

export interface ProductDescriptionProps {
  text: string;
  className?: string;
}

export default function ProductDescription({ text, className }: ProductDescriptionProps) {
  const textId = useId();
  const textRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);

  // Measure only while collapsed: once expanded the clamp is gone and the
  // measurement would read "not truncated", hiding the "Show less" button.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setTruncated(el.scrollHeight > el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (!next) textRef.current?.scrollIntoView?.({ block: "nearest" });
  };

  const textClasses = [
    "text-sm leading-relaxed text-ink-soft whitespace-pre-line",
    expanded ? "" : "line-clamp-3 md:line-clamp-none",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div>
      <div id={textId} ref={textRef} className={textClasses}>
        {text}
      </div>
      {(truncated || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={toggle}
          className="md:hidden inline-flex min-h-11 items-center rounded-sm text-sm font-medium text-pine hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pine"
        >
          {expanded ? t("web.read_less") : t("web.read_more")}
        </button>
      )}
    </div>
  );
}
