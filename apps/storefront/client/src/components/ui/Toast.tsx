/**
 * Toast — a fixed-position, auto-dismissing status banner (`components.md`
 * "Toast / notifications").
 *
 * Promoted from `components/shop/Toast.tsx` to `components/ui/` in Fase 6
 * Task 7 as a business-agnostic primitive; `components/shop/Toast.tsx` now
 * re-exports this. API and behaviour are unchanged from the original.
 *
 * Controlled, not a context/provider system: the page owns a `text | null`
 * piece of state and renders `<Toast text={...} onDismiss={...} />` once.
 * That's the smallest primitive that covers today's need (a support-ticket-
 * created confirmation) without a global toast queue no page yet needs.
 */
import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle, AlertTriangle, Info } from "lucide-react";
import { fadeUp } from "../../lib/motion";

export interface ToastProps {
  text: string | null;
  onDismiss: () => void;
  kind?: "success" | "error" | "info";
  durationMs?: number;
}

export default function Toast({ text, onDismiss, kind = "success", durationMs = 3000 }: ToastProps) {
  useEffect(() => {
    if (!text) return undefined;
    const id = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(id);
  }, [text, durationMs, onDismiss]);

  const toneClass =
    kind === "error"
      ? "bg-rust-tint text-rust-dark border-rust/30"
      : kind === "info"
        ? "bg-sand text-ink border-line"
        : "bg-grass-tint text-grass-dark border-grass/30";
  const Icon = kind === "error" ? AlertTriangle : kind === "info" ? Info : CheckCircle;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 pointer-events-none"
    >
      <AnimatePresence>
        {text && (
          <motion.div
            variants={fadeUp}
            initial="initial"
            animate="animate"
            exit="exit"
            className={`pointer-events-auto flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium shadow-lift ${toneClass}`}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span>{text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
