import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

interface StarsProps {
  /** Star rating, 1-5. Values are rendered as a whole-star fill/outline
   *  toggle (no half-star glyph) — matches ReviewsPage.tsx's/ReplyDialog.tsx's
   *  previous per-file copies this component consolidates. */
  rating: number;
  /** Icon size class, applied to each star. Default: 16px (`h-4 w-4`),
   *  matching the standard icon scale (01_DESIGN_SYSTEM.md §9). */
  className?: string;
}

/** Shared 5-star rating display — used by ReviewsPage.tsx's table rows and
 *  ReplyDialog.tsx's review preview, so both read the same rating the same
 *  way instead of carrying two near-identical local components. */
export function Stars({ rating, className = "h-4 w-4" }: StarsProps): JSX.Element {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={cn(className, i <= rating ? "fill-amberx text-amberx" : "text-ink-faint")}
        />
      ))}
    </span>
  );
}
