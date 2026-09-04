/**
 * Compat shim — `Callout` is now `<Alert variant="panel">` (Fase 6 Task 7).
 * Kept so the existing importers (StaticPage, HomePage, HowToOrderPage,
 * InstantBuyPage, PrivacyPage) keep working unchanged; new code imports
 * `Alert` from `components/ui/Alert` directly.
 *
 * Emits byte-identical DOM to the old hand-rolled Callout — same wrapper
 * classes (incl. `rounded-2xl`), same 36px icon well, same lucide icon per
 * variant, and no ARIA role (`role={false}`), matching its historical output.
 */
import Alert from "../ui/Alert";

export type CalloutVariant = "info" | "tip" | "warning";

export interface CalloutProps {
  variant: CalloutVariant;
  children: React.ReactNode;
}

export default function Callout({ variant, children }: CalloutProps) {
  return (
    <Alert variant="panel" tone={variant} role={false}>
      {children}
    </Alert>
  );
}
