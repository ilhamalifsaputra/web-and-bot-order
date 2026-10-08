import * as React from "react"
import type { ReactNode } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"

interface ConfirmDialogProps {
  /** The element that opens the dialog (e.g. a Button). Omit when driving the
   *  dialog from external state via `open`/`onOpenChange` (e.g. a row picked
   *  from a dropdown menu — Radix's dropdown-menu-closes-on-select doesn't
   *  compose with this component's own `DialogTrigger`). */
  trigger?: ReactNode;
  title: string;
  description: string;
  /** Label for the confirm button. Default: "Confirm". */
  confirmLabel?: string;
  /** Label for the cancel button. Default: "Cancel". */
  cancelLabel?: string;
  /** shadcn Button variant applied to the confirm button. Default: "destructive". */
  variant?: "default" | "destructive";
  onConfirm: () => void | Promise<void>;
  /** Extra body content rendered between the description and the buttons
   *  (e.g. a reason picker). */
  children?: ReactNode;
  /** Controlled mode: pass both to drive `open` from page-level state instead
   *  of the self-managed default (used together, `trigger` is typically omitted). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "destructive",
  onConfirm,
  children,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: ConfirmDialogProps): JSX.Element {
  const [openState, setOpenState] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const busyRef = React.useRef(false)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : openState
  const setOpen = isControlled ? (onOpenChangeProp ?? (() => {})) : setOpenState

  const handleConfirm = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      busyRef.current = false
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!busyRef.current) setOpen(value) }}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={busy}>{cancelLabel}</Button>
          </DialogClose>
          <Button variant={variant} onClick={handleConfirm} disabled={busy} aria-busy={busy}>
            {busy ? "Processing…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
