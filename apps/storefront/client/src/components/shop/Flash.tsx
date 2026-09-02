/**
 * Compat shim — `Flash` is now `<Alert variant="banner">` (Fase 6 Task 7).
 * Kept so the existing page importers (Login/Register/Forgot/Reset/Settings)
 * keep working unchanged; new code imports `Alert` from `components/ui/Alert`
 * directly.
 *
 * Emits byte-identical DOM to the old hand-rolled Flash — same wrapper classes
 * (incl. `mb-5`), same lucide icon per `kind`, same `<span>` text node, and no
 * ARIA role (`role={false}`), matching its historical output. The pages gain
 * the spec `role="alert"` when they migrate to `<Alert>` in Fase 7.
 *
 * Renders nothing when `text` is empty/null, same as before.
 */
import Alert from "../ui/Alert";

export interface FlashProps {
  text?: string | null;
  kind?: "info" | "success" | "error";
}

export default function Flash({ text, kind = "info" }: FlashProps) {
  if (!text) return null;
  return (
    <Alert variant="banner" tone={kind} role={false}>
      {text}
    </Alert>
  );
}
