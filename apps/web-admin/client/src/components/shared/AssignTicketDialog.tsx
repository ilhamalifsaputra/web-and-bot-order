import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

/** Radix Select needs string item values — this sentinel maps to `null`
 *  (unassigned) at the component boundary so callers only ever deal in
 *  `number | null` adminId. */
const UNASSIGNED = "_unassigned_";

export interface AssignableAdmin {
  id: number;
  /** Pre-resolved display name (name, else "Telegram ID {id}" — callers
   *  already do this resolution for their own admin lists). */
  name: string;
}

interface AssignTicketDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many tickets this assignment targets — drives singular vs plural
   *  dialog copy ("Assign this ticket?" vs "Assign N tickets?"). */
  ticketCount: number;
  admins: AssignableAdmin[];
  /** Currently selected admin id, or null for "Unassigned". */
  value: number | null;
  onValueChange: (adminId: number | null) => void;
  onConfirm: () => void;
  isPending?: boolean;
}

/**
 * Assign-ticket-to-admin dialog shared by SupportPage (bulk selection and
 * single-row action, one or many ticket ids) and TicketDetailPage (always
 * exactly one ticket) — promoted here per 09_CODE_STYLE.md's reuse-vs-colocate
 * rule once a second call site needed the identical Select-and-Confirm shape.
 */
export function AssignTicketDialog({
  open,
  onOpenChange,
  ticketCount,
  admins,
  value,
  onValueChange,
  onConfirm,
  isPending = false,
}: AssignTicketDialogProps): JSX.Element {
  const stringValue = value !== null ? String(value) : UNASSIGNED;
  const nameById = React.useMemo(() => new Map(admins.map((a) => [a.id, a.name])), [admins]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {ticketCount > 1 ? `Assign ${ticketCount} tickets?` : "Assign this ticket?"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-soft">Admin</label>
          <Select
            value={stringValue}
            onValueChange={(v) => onValueChange(v === UNASSIGNED ? null : Number(v))}
          >
            <SelectTrigger aria-label="Assignee">
              <SelectValue>
                {value !== null ? (nameById.get(value) ?? `Admin #${value}`) : "Unassigned"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
              {admins.map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Back
          </Button>
          <Button disabled={isPending} onClick={onConfirm}>
            {isPending ? "Assigning…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
