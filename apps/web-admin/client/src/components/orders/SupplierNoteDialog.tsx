import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useId, useState } from "react";
import { describeError } from "../../lib/errorMessages";

/** What the admin typed: the private reconciliation note, plus the supplier's
 * serial number when the dialog asks for one. */
export interface SupplierNoteInput {
  note: string;
  sn?: string;
}

interface SupplierNoteDialogProps {
  /** The button that opens the dialog. */
  trigger: ReactNode;
  title: string;
  /** When to use this action and what it changes. */
  helper: string;
  confirmLabel: string;
  confirmVariant?: "default" | "destructive";
  /** Ask for the supplier's serial number or reference, which the buyer sees
   * as their receipt (Mark delivered only). */
  withSerial?: boolean;
  /** Posts the action. A rejection keeps the dialog open with its message. */
  onSubmit: (input: SupplierNoteInput) => Promise<unknown>;
  onSuccess: () => void;
}

/** Longest serial the server keeps (the route trims it to 200 characters). */
const SERIAL_MAX_LENGTH = 200;

/**
 * Confirm dialog for an admin override on an order unresolved at Digiflazz
 * (Mark delivered / Mark failed). Unlike `ConfirmDialog`, it requires a note
 * before the confirm button enables, and it stays open on a refusal so the
 * admin can read why and retry without retyping.
 */
export function SupplierNoteDialog({
  trigger,
  title,
  helper,
  confirmLabel,
  confirmVariant = "default",
  withSerial = false,
  onSubmit,
  onSuccess,
}: SupplierNoteDialogProps) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [serial, setSerial] = useState("");
  const submit = useMutation({
    mutationFn: onSubmit,
    onSuccess: () => {
      setOpen(false);
      setNote("");
      setSerial("");
      onSuccess();
    },
  });

  function handleOpenChange(next: boolean) {
    if (submit.isPending) return;
    setOpen(next);
    if (!next) submit.reset();
  }

  function confirm() {
    const trimmedNote = note.trim();
    if (!trimmedNote || submit.isPending) return;
    const trimmedSerial = serial.trim();
    submit.mutate(withSerial && trimmedSerial ? { note: trimmedNote, sn: trimmedSerial } : { note: trimmedNote });
  }

  const noteId = `${fieldId}-note`;
  const serialId = `${fieldId}-serial`;
  const errorId = `${fieldId}-error`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{helper}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={noteId}>What did Digiflazz confirm? (required)</Label>
          <Textarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example: Digiflazz support confirmed it in ticket 4411."
            rows={3}
            aria-describedby={submit.isError ? errorId : undefined}
            autoFocus
          />
          <p className="text-xs text-ink-soft">Saved to the audit log only. The buyer never sees it.</p>
        </div>
        {withSerial && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={serialId}>Serial number or reference (optional)</Label>
            <Input
              id={serialId}
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              maxLength={SERIAL_MAX_LENGTH}
            />
            <p className="text-xs text-ink-soft">Shown to the buyer as their receipt. Leave it empty if Digiflazz gave none.</p>
          </div>
        )}
        {submit.isError && (
          <p id={errorId} role="alert" className="text-sm text-rust">
            {describeError(submit.error)}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={submit.isPending} onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={confirmVariant}
            disabled={!note.trim() || submit.isPending}
            aria-busy={submit.isPending}
            onClick={confirm}
          >
            {submit.isPending ? "Saving…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
