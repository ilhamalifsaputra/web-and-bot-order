/**
 * Business-agnostic design-system placeholder for a product with no real
 * photo (Fase 12) — a lucide icon in a tinted well, rendered client-side.
 * Replaces the old hardcoded Unsplash stock-photo fallback
 * (apps/storefront/src/images.ts, pre-Fase-12): zero external image
 * request, zero third-party dependency, and the icon it shows is resolved
 * server-side by `defaultThumbKind()` (same file) — admin override first,
 * then a category heuristic, with PREMIUM_APPS categories always forced to
 * the neutral "generic" icon.
 */
import { Gamepad2, Ticket, KeyRound, Clapperboard, AppWindow, Package, type LucideIcon } from "lucide-react";

/** Mirrors the server's ThumbnailKind union (apps/storefront/src/images.ts)
 * and the client's own local alias (api/types.ts) verbatim. */
export type ThumbnailKind = "game" | "voucher" | "steam" | "entertainment" | "app" | "generic";

const ICONS: Record<ThumbnailKind, LucideIcon> = {
  game: Gamepad2,
  voucher: Ticket,
  steam: KeyRound,
  entertainment: Clapperboard,
  app: AppWindow,
  generic: Package,
};

export interface DefaultThumbProps {
  kind: ThumbnailKind;
  /** Product name shown under the icon — omit to show the icon alone
   * (e.g. a small avatar-sized well with no room for a label). */
  name?: string;
  className?: string;
}

export default function DefaultThumb({ kind, name, className }: DefaultThumbProps) {
  const Icon = ICONS[kind] ?? Package;
  return (
    <div
      className={`flex h-full w-full flex-col items-center justify-center gap-2 bg-pine-tint ${className ?? ""}`}
    >
      <Icon className="h-8 w-8 shrink-0 text-pine md:h-10 md:w-10" aria-hidden="true" />
      {name && (
        <span className="line-clamp-2 px-3 text-center text-xs font-medium text-ink-soft">{name}</span>
      )}
    </div>
  );
}
