/**
 * Modal (Dialog) — the storefront's overlay-dialog primitive.
 *
 * `components.md` has no "Modal" section (the reverse-engineered storefront
 * barely uses them), so the VISUAL treatment is derived from `Card` — white
 * `.card` surface, `radius-lg`, `shadow-*` — behind an `ink/45` scrim, and the
 * A11Y machinery is the exact contract from `MobileDrawer` (Task 5), shared
 * via `useDialogA11y`: `role="dialog"` + `aria-modal`, focus trap, Esc, scrim
 * click, body scroll lock, focus restore, portal to `document.body` so it
 * escapes any `overflow` / stacking context. `prefers-reduced-motion` rides on
 * the app-wide `<MotionConfig reducedMotion="user">`.
 *
 * Logged as a §26.2 component-pattern exception in
 * `docs/archive/implementation/extensions.md`.
 *
 * Business-agnostic: no domain types, no routing, no i18n — the caller passes
 * `title` / `children` / `footer` content.
 */
import { useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "./cn";
import { fadeIn, scrim } from "../../lib/motion";
import IconButton from "./IconButton";
import { useDialogA11y } from "./useDialogA11y";

export type ModalSize = "sm" | "md" | "lg";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Labelled heading, wired to `aria-labelledby`. */
  title: ReactNode;
  /** Optional supporting line, wired to `aria-describedby`. */
  description?: ReactNode;
  size?: ModalSize;
  children?: ReactNode;
  /** Action row, right-aligned, below the body. */
  footer?: ReactNode;
  /** Hide the header ✕ (AlertDialog supplies its own Cancel/Confirm row). */
  hideCloseButton?: boolean;
  /** Focus this on open instead of the first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** "dialog" (default) or "alertdialog" (used by AlertDialog). */
  role?: "dialog" | "alertdialog";
  className?: string;
}

const SIZE: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
};

export default function Modal({
  open,
  onClose,
  title,
  description,
  size = "md",
  children,
  footer,
  hideCloseButton = false,
  initialFocusRef,
  role = "dialog",
  className,
}: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useDialogA11y({ open, onClose, panelRef, initialFocusRef });

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            variants={scrim}
            initial="initial"
            animate="animate"
            exit="exit"
            aria-hidden="true"
            className="absolute inset-0 bg-ink/45"
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            variants={fadeIn}
            initial="initial"
            animate="animate"
            exit="exit"
            tabIndex={-1}
            role={role}
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            className={cn(
              "card card-pad relative z-10 flex max-h-[85vh] w-full flex-col gap-4 overflow-y-auto outline-none",
              SIZE[size],
              className,
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 id={titleId} className="font-display text-lg font-semibold text-ink">
                  {title}
                </h2>
                {description != null && (
                  <p id={descId} className="mt-1 text-sm text-ink-soft">
                    {description}
                  </p>
                )}
              </div>
              {!hideCloseButton && (
                <IconButton
                  aria-label="Close"
                  size="sm"
                  onClick={onClose}
                  className="-mr-1 -mt-1 shrink-0"
                >
                  <X className="h-5 w-5" />
                </IconButton>
              )}
            </div>

            {children != null && children !== false && (
              <div className="text-sm leading-relaxed text-ink-soft">{children}</div>
            )}

            {footer != null && (
              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">{footer}</div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
