/**
 * TSX port of `stars(rating, cls)` in apps/storefront/views/_shop.njk (design.md
 * §4.7) — 5 lucide stars, filled amber when the rating clears the star's
 * threshold (i - 0.5), plain line otherwise. No dedicated half-star glyph —
 * the threshold check is the only "half" behavior the macro has.
 */
import { Star } from "lucide-react";

export interface StarsProps {
  rating: number;
  cls?: string;
}

export default function Stars({ rating, cls = "w-3.5 h-3.5" }: StarsProps) {
  const rounded = Math.round(rating * 10) / 10;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rounded}/5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`${cls} ${rating >= i - 0.5 ? "text-amber-400 fill-amber-400" : "text-line"}`}
        />
      ))}
    </span>
  );
}
