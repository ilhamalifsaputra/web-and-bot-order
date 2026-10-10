import { useState } from "react";
import type { ShopContext } from "../api/types";

/** Owner-configured identity shared by shop chrome and auth. No invented logo. */
export default function BrandLogo({ ctx, inverse = false }: { ctx: ShopContext | undefined; inverse?: boolean }) {
  const src = ctx?.logo_url ?? "";
  const name = ctx?.shop_name ?? "";
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span data-brand-logo className={`inline-flex min-w-0 items-center gap-2 font-display text-lg font-semibold ${inverse ? "text-white" : "text-ink"}`}>
      {src && failedSrc !== src && (
        <img src={src} alt={name} width={44} height={44} onError={() => setFailedSrc(src)} className="h-11 w-11 shrink-0 rounded-md object-contain" />
      )}
      <span className="truncate">{name}</span>
    </span>
  );
}
