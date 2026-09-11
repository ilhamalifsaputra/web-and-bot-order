/**
 * The modal-dialog a11y contract, extracted so `Modal` and `AlertDialog`
 * share ONE implementation of it. It is the exact behaviour already proven in
 * `components/layout/MobileDrawer.tsx` (Task 5):
 *
 *   - body scroll lock while open, with scrollbar-width compensation so the
 *     page behind does not reflow;
 *   - Esc closes (calls `onClose`);
 *   - Tab / Shift+Tab wrap focus inside the panel (focus trap);
 *   - focus moves into the panel on open — to `initialFocusRef` if given,
 *     else the first focusable child, else the panel itself;
 *   - focus is restored on close to `restoreFocusRef` if given, else to
 *     whatever was focused when the dialog opened.
 *
 * `prefers-reduced-motion` is NOT handled here — it rides on the app-wide
 * `<MotionConfig reducedMotion="user">` in `main.tsx`, same as MobileDrawer.
 *
 * MobileDrawer itself is intentionally left on its own inline copy of this
 * logic: it is already-reviewed Task 5 code with drawer-specific focusable
 * selectors, and rewiring it onto this hook would be a risky change to a
 * shipped component for no functional gain. This hook removes the duplication
 * between the two NEW dialog primitives, which is where it actually matters.
 */
import { useEffect, type RefObject } from "react";

/** Same intent as MobileDrawer's `DRAWER_FOCUSABLE`, widened to the controls a
 * generic modal body can contain (inputs, selects, explicit tabindex). */
export const DIALOG_FOCUSABLE =
  'a[href], button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface DialogA11yOptions {
  open: boolean;
  onClose: () => void;
  /** The dialog panel — the focus-trap boundary. Give it `tabIndex={-1}`. */
  panelRef: RefObject<HTMLElement | null>;
  /** Focus this on open instead of the first focusable child (AlertDialog → Cancel). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Restore focus here on close instead of the element focused when it opened. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

export function useDialogA11y({
  open,
  onClose,
  panelRef,
  initialFocusRef,
  restoreFocusRef,
}: DialogA11yOptions): void {
  // Lock body scroll while open, compensating for the scrollbar's width so the
  // page doesn't shift under the fixed overlay.
  useEffect(() => {
    if (!open) return;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    const { overflow, paddingRight } = document.body.style;
    document.body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }
    return () => {
      document.body.style.overflow = overflow;
      document.body.style.paddingRight = paddingRight;
    };
  }, [open]);

  // Initial focus + Esc-to-close + Tab focus-trap + focus restore on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = (restoreFocusRef?.current ??
      (document.activeElement as HTMLElement | null)) ?? null;

    const focusTarget =
      initialFocusRef?.current ??
      panelRef.current?.querySelector<HTMLElement>(DIALOG_FOCUSABLE) ??
      panelRef.current;
    focusTarget?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        // Nothing focusable (e.g. AlertDialog mid-pending, both buttons
        // disabled) — keep focus on the panel rather than letting it escape.
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, panelRef, initialFocusRef, restoreFocusRef]);
}
