import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CircleCheckIcon } from "lucide-react";
import * as React from "react";

type Phase = "confirm" | "saving" | "error" | "success";

interface SaveConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** Label for the confirm button. Default: "Save". */
  confirmLabel?: string;
  /** Label for the cancel button. Default: "Cancel". */
  cancelLabel?: string;
  /** Shown in the success phase. A message resolved by `onConfirm` overrides this. Default: "Saved successfully". */
  successMessage?: string;
  /** shadcn Button variant applied to the confirm button. Default: "default". */
  variant?: "default" | "destructive";
  onConfirm: () => Promise<string | void>;
}

/**
 * Confirm → saving → success (checkmark, auto-closes) or error (stays open,
 * retryable) — for settings-style mutations where ConfirmDialog's
 * fire-and-forget "always close in finally" behavior isn't enough. Fully
 * controlled (no `trigger` prop) since callers include a Switch, a form
 * submit, and other non-button triggers.
 */
export function SaveConfirmDialog(props: SaveConfirmDialogProps): JSX.Element {
  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <SaveSession key={String(props.open)} {...props} />
  </Dialog>;
}

function SaveSession({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Save",
  cancelLabel = "Cancel",
  successMessage = "Saved successfully",
  variant = "default",
  onConfirm,
}: SaveConfirmDialogProps): JSX.Element {
  const [phase, setPhase] = React.useState<Phase>("confirm");
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [resolvedMessage, setResolvedMessage] = React.useState<string | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = React.useRef(true);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  async function handleConfirm() {
    setPhase("saving");
    setErrorMessage(null);
    try {
      const result = await onConfirm();
      if (!mounted.current) return;
      setResolvedMessage(result || successMessage);
      setPhase("success");
      closeTimer.current = setTimeout(() => {
        onOpenChange(false);
      }, 900);
    } catch (e) {
      if (!mounted.current) return;
      setErrorMessage(e instanceof Error ? e.message : "Failed to save");
      setPhase("error");
    }
  }

  const busy = phase === "saving" || phase === "success";

  return (
    <DialogContent showCloseButton={false}
      onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
      onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>

      {phase === "success" ? (
        <>
          <DialogHeader className="items-center text-center">
            <div className="mb-1 flex size-16 items-center justify-center rounded-full bg-grass-tint">
              <CircleCheckIcon className="size-10 text-grass-dark motion-safe:animate-checkmark-pop" />
            </div>
            <DialogTitle>Saved</DialogTitle>
          </DialogHeader>
          <p role="status" aria-live="polite" className="text-center text-sm text-ink-soft">
            {resolvedMessage}
          </p>
        </>
      ) : (
        <>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {phase === "error" && errorMessage && (
            <p className="text-sm text-rust">{errorMessage}</p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button variant={variant} disabled={busy} onClick={() => void handleConfirm()}>
              {phase === "saving" ? "Saving…" : confirmLabel}
            </Button>
          </DialogFooter>
        </>
      )}
    </DialogContent>
  );
}
