import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Dialog } from "radix-ui";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "motion/react";
import { DURATION, fadeIn, scrim, slideInLeft } from "@/lib/motion";
import { cn } from "@/lib/utils";

interface MotionDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  drawer?: boolean;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

// Radix owns focus, Escape, outside dismissal and scroll lock. Motion owns
// presence only; forceMount lets Radix retain its lifecycle until exit ends.
function Content({ onOpenAutoFocus, onCloseAutoFocus, ...props }: MotionDialogProps & {
  onOpenAutoFocus: (event: Event) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const wasPresent = useRef(true);
  useLayoutEffect(() => {
    // A quick reopen can reuse the exiting portal, so Radix's mount autofocus
    // does not run again. Re-enter focus without replacing its focus trap.
    if (present && !wasPresent.current) {
      (props.initialFocusRef?.current ?? panelRef.current)?.focus({ preventScroll: true });
    }
    wasPresent.current = present;
  }, [present, props.initialFocusRef]);
  const variants = reduced ? undefined : props.drawer ? slideInLeft : fadeIn;
  return (
    <>
      <Dialog.Overlay forceMount asChild>
        <motion.div
          className="fixed inset-0 z-50 bg-ink/40"
          variants={reduced ? undefined : scrim}
          initial="initial" animate="animate" exit="exit"
          style={{ pointerEvents: present ? "auto" : "none" }}
        />
      </Dialog.Overlay>
      <Dialog.Content
        forceMount asChild aria-describedby={undefined}
        onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}
      >
        <motion.div
          ref={panelRef}
          variants={variants} initial="initial" animate="animate" exit="exit"
          transition={{ duration: reduced ? 0 : DURATION.base }}
          aria-hidden={!present || undefined}
          {...(!present ? { inert: "" } : {})}
          style={{ pointerEvents: present ? "auto" : "none" }}
          className={cn(
            "fixed z-50 border border-line bg-card shadow-lift outline-none",
            props.drawer
              ? "inset-y-0 left-0 w-56"
              : "left-1/2 top-[15vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-lg",
            props.className,
          )}
        >
          <Dialog.Title className="sr-only">{props.title}</Dialog.Title>
          {props.children}
        </motion.div>
      </Dialog.Content>
    </>
  );
}

export function MotionDialog(props: MotionDialogProps) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const openRef = useRef(props.open);
  openRef.current = props.open;
  return (
    <Dialog.Root open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <AnimatePresence>
        {props.open && (
          <Dialog.Portal forceMount key="dialog">
            <Content
              {...props}
              onOpenAutoFocus={(event) => {
                previousFocus.current = document.activeElement as HTMLElement | null;
                if (props.initialFocusRef?.current) {
                  event.preventDefault();
                  props.initialFocusRef.current.focus();
                }
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                // Radix may finish an old focus-scope cleanup after a reopen.
                if (openRef.current) return;
                const target = props.restoreFocusRef?.current ?? previousFocus.current;
                if (target?.isConnected) target.focus({ preventScroll: true });
              }}
            />
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
