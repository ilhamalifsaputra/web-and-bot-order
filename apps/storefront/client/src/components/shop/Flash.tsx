/**
 * TSX port of `flash(message, kind)` in packages/web-ui/views/_macros.njk —
 * the only admin macro the storefront needs. Renders nothing when `text` is
 * empty/null, same as the NJK `{% if message %}` guard.
 */
export interface FlashProps {
  text?: string | null;
  kind?: "info" | "success" | "error";
}

export default function Flash({ text, kind = "info" }: FlashProps) {
  if (!text) return null;
  const toneClass =
    kind === "error"
      ? "bg-rust-tint text-rust-dark border-rust/30"
      : kind === "success"
        ? "bg-grass-tint text-grass-dark border-grass/30"
        : "bg-sand text-ink border-line";
  const icon = kind === "error" ? "✕" : kind === "success" ? "✓" : "•";
  return (
    <div className={`flex items-start gap-2 rounded-xl px-4 py-3 mb-5 text-sm border ${toneClass}`}>
      <span className="mt-px">{icon}</span>
      <span>{text}</span>
    </div>
  );
}
