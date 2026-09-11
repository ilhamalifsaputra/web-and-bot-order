/**
 * AlertDialog — `Modal` composed for the destructive-action confirmation the
 * Global Constraints require (logout, cancel order, …).
 *
 *   - `role="alertdialog"`;
 *   - focus starts on the CANCEL button (the safe default for a destructive
 *     prompt), via `Modal`'s `initialFocusRef`;
 *   - Esc = cancel (`Modal.onClose` is wired to `onCancel`);
 *   - `tone="danger"` renders the confirm button as `<Button variant="danger">`
 *     (rust); `tone="default"` renders it `variant="primary"`;
 *   - `confirmPending` disables BOTH buttons and shows a `<Spinner>` in the
 *     confirm button.
 *
 * Business-agnostic: caller supplies all copy and the two handlers.
 */
import { useRef, type ReactNode } from "react";
import Modal from "./Modal";
import Button from "./Button";
import Spinner from "./Spinner";

export interface AlertDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  tone?: "danger" | "default";
  /** Confirm is running: both buttons disabled, confirm shows a spinner. */
  confirmPending?: boolean;
}

export default function AlertDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "default",
  confirmPending = false,
}: AlertDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      open={open}
      onClose={onCancel}
      role="alertdialog"
      title={title}
      description={description}
      size="sm"
      hideCloseButton
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button
            ref={cancelRef}
            variant="ghost"
            onClick={onCancel}
            disabled={confirmPending}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={confirmPending}
          >
            {confirmPending && <Spinner />}
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
